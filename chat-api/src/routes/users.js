// Account management for the operator console: list, create, disable /
// re-enable, change role, delete. Reading needs users:read; every change needs
// users:manage (admins only).
//
// Guard rails:
//   * the predefined admin (`builtin`, from the chat-admin Secret) can't be
//     changed here — the Secret is its source of truth and boot re-asserts it;
//   * nobody can disable, demote or delete their own account (no self-lockout);
//   * every staff account (admin / readonly) gets its own TOTP secret, shown
//     ONCE to the admin who creates or promotes it.
import { Router } from "express";
import mongoose from "mongoose";
import { AccessKey, Message, Session, User, userByEmail } from "../models/index.js";
import { generateTotpSecret, hashPassword, totpUri } from "../lib/crypto.js";
import { accessKeyField, decrypt, decryptUser, encrypt, encryptUserFields, userField } from "../lib/fieldcrypto.js";
import { PERMISSIONS, ROLES, isStaff } from "../lib/rbac.js";
import * as v from "../lib/validate.js";
import { requirePermission } from "../middleware/auth.js";
import { limitHashing } from "../middleware/limits.js";

export const usersRouter = Router();
usersRouter.use(requirePermission(PERMISSIONS.USERS_READ));
const manage = requirePermission(PERMISSIONS.USERS_MANAGE);

const ROLE_VALUES = Object.values(ROLES);

function role(body) {
  const r = v.text(body, "role", { max: 20 });
  if (!ROLE_VALUES.includes(r)) throw new v.ValidationError(`role must be one of: ${ROLE_VALUES.join(", ")}`);
  return r;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

function serialize(u, me) {
  const { email, phone } = decryptUser(u);
  const key = u.accessKey && typeof u.accessKey === "object" && u.accessKey.hint ? u.accessKey : null;
  return {
    id: String(u._id),
    email,
    phone: phone ?? null,
    role: u.role,
    active: u.active !== false,
    builtin: Boolean(u.builtin),
    self: String(u._id) === String(me._id),
    twoFactor: u.builtin ? null : Boolean(u.totpSecret), // builtin: governed by the Secret
    keyHint: key?.hint ?? null,
    keyLabel: key ? decrypt(key.label, accessKeyField(key._id)) ?? "" : null,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt ?? null,
    lockedUntil: u.lockedUntil && u.lockedUntil > new Date() ? u.lockedUntil : null,
  };
}

/** A fresh TOTP secret: {stored (ciphertext), shown ({secret, uri})}. */
function newTotp(userId, email) {
  const secret = generateTotpSecret();
  return {
    stored: encrypt(secret, userField(userId, "totpSecret")),
    shown: { secret, uri: totpUri(secret, email) },
  };
}

/** Load a user another admin may change, or throw 400/403/404. */
async function changeable(req) {
  const id = v.objectId(req.params.id);
  const user = await User.findById(id);
  if (!user) throw httpError(404, "Not found");
  if (user.builtin) throw httpError(403, "The predefined admin is managed by its Secret and can't be changed here.");
  if (String(user._id) === String(req.user._id)) throw httpError(400, "You can't change your own account.");
  return user;
}

// ------------------------------------------------------------------- list
usersRouter.get("/", async (req, res, next) => {
  try {
    const users = await User.find()
      .select("-passwordHash")
      .populate("accessKey", "label hint")
      .sort({ createdAt: 1 })
      .lean();
    const order = { [ROLES.ADMIN]: 0, [ROLES.READONLY]: 1, [ROLES.CUSTOMER]: 2 };
    const out = users.map((u) => serialize(u, req.user));
    out.sort((a, b) => (b.builtin - a.builtin) || (order[a.role] - order[b.role]));
    res.json({ users: out, roles: ROLE_VALUES });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------------- create
// POST {email, password, role, phone?}. Customers made here need no access
// key. Staff get a TOTP secret, returned once in `totp`.
usersRouter.post("/", manage, limitHashing, async (req, res, next) => {
  try {
    const email = v.email(req.body);
    const phone = v.phone(req.body);
    const password = v.newPassword(req.body);
    const r = role(req.body);
    if (await User.exists(userByEmail(email))) throw httpError(409, "An account with that email already exists.");

    const _id = new mongoose.Types.ObjectId();
    const totp = isStaff(r) ? newTotp(_id, email) : null;
    const user = await User.create({
      _id,
      ...encryptUserFields(_id, { email, phone }),
      passwordHash: await hashPassword(password),
      role: r,
      createdBy: req.user._id,
      ...(totp ? { totpSecret: totp.stored } : {}),
    });
    res.status(201).json({ user: serialize(user.toObject(), req.user), totp: totp?.shown ?? null });
  } catch (err) {
    if (err?.code === 11000) return res.status(409).json({ error: "An account with that email already exists." });
    next(err);
  }
});

// ------------------------------------------------------- disable / enable
// Disabling also ends every session of that account.
usersRouter.post("/:id/active", manage, async (req, res, next) => {
  try {
    const user = await changeable(req);
    if (typeof req.body?.active !== "boolean") throw new v.ValidationError("active must be true or false");
    user.active = req.body.active;
    if (user.active) { user.failedLogins = 0; user.lockedUntil = undefined; }
    await user.save();
    if (!user.active) await Session.deleteMany({ user: user._id });
    res.json({ user: serialize(user.toObject(), req.user) });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------ change role
// Ends the account's sessions so it signs in again under the new role.
// Becoming staff without a TOTP secret issues one (returned once); going back
// to customer drops it.
usersRouter.post("/:id/role", manage, async (req, res, next) => {
  try {
    const user = await changeable(req);
    const r = role(req.body);
    let totp = null;
    if (user.role !== r) {
      user.role = r;
      if (isStaff(r) && !user.totpSecret) {
        totp = newTotp(user._id, decryptUser(user).email);
        user.totpSecret = totp.stored;
      }
      if (!isStaff(r)) user.totpSecret = undefined;
      await user.save();
      await Session.deleteMany({ user: user._id });
    }
    res.json({ user: serialize(user.toObject(), req.user), totp: totp?.shown ?? null });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------ reset 2FA secret
// For a staff member who lost their authenticator. Old codes stop working.
usersRouter.post("/:id/totp", manage, async (req, res, next) => {
  try {
    const user = await changeable(req);
    if (!isStaff(user.role)) throw new v.ValidationError("Only admin and readonly accounts use an authenticator.");
    const totp = newTotp(user._id, decryptUser(user).email);
    user.totpSecret = totp.stored;
    await user.save();
    await Session.deleteMany({ user: user._id });
    res.json({ user: serialize(user.toObject(), req.user), totp: totp.shown });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------------- delete
// Permanent: the account, its sessions and (for a customer) its whole
// conversation. The access key it redeemed stays burned (marked revoked) so
// it can't be re-used to register again.
usersRouter.delete("/:id", manage, async (req, res, next) => {
  try {
    const user = await changeable(req);
    await Session.deleteMany({ user: user._id });
    const { deletedCount: messages } = await Message.deleteMany({ customer: user._id });
    await AccessKey.updateMany({ redeemedBy: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    await User.deleteOne({ _id: user._id });
    res.json({ ok: true, messagesDeleted: messages });
  } catch (err) {
    next(err);
  }
});
