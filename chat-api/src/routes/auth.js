import { Router } from "express";
import mongoose from "mongoose";
import { AccessKey, User, userByEmail } from "../models/index.js";
import { burnPasswordCheck, hashAccessKey, hashPassword, needsRehash, verifyPassword, verifyTotp } from "../lib/crypto.js";
import { decryptUser, encryptUserFields } from "../lib/fieldcrypto.js";
import { ROLES, permissionsFor } from "../lib/rbac.js";
import * as v from "../lib/validate.js";
import { endSession, requireAuth, startSession } from "../middleware/auth.js";
import { limitHashing } from "../middleware/limits.js";
import { secret } from "../lib/secrets.js";

export const authRouter = Router();

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function publicUser(user) {
  const { email, phone } = decryptUser(user);
  return {
    id: String(user._id),
    email,
    phone: phone ?? null,
    role: user.role,
    permissions: permissionsFor(user.role),
  };
}

// ---------------------------------------------------------------- register
// Customer creates an account with an admin-issued access key. The key is
// claimed atomically (redeemedBy: null -> this user) so it can be used once.
authRouter.post("/register", limitHashing, async (req, res, next) => {
  let claimedKeyId = null;
  try {
    const key = v.text(req.body, "key", { max: 64 });
    const email = v.email(req.body);
    const phone = v.phone(req.body);
    const password = v.newPassword(req.body);

    const userId = new mongoose.Types.ObjectId();
    const claimed = await AccessKey.findOneAndUpdate(
      { keyHash: hashAccessKey(key), redeemedBy: null, revokedAt: null },
      { $set: { redeemedBy: userId, redeemedAt: new Date() } },
      { new: true },
    );
    // One generic answer for bad key / used key / taken email: don't help
    // anyone enumerate keys or registered addresses.
    const refuse = () => res.status(400).json({ error: "Registration failed. Check your key and details." });
    if (!claimed) return refuse();
    claimedKeyId = claimed._id;

    if (await User.exists(userByEmail(email))) {
      await AccessKey.updateOne({ _id: claimedKeyId }, { $set: { redeemedBy: null, redeemedAt: null } });
      claimedKeyId = null;
      return refuse();
    }

    const user = await User.create({
      _id: userId,
      ...encryptUserFields(userId, { email, phone }),
      passwordHash: await hashPassword(password),
      role: ROLES.CUSTOMER,
      accessKey: claimed._id,
    });
    claimedKeyId = null;
    await startSession(res, user);
    res.status(201).json({ user: publicUser(user) });
  } catch (err) {
    // Release the key if anything after the claim failed (e.g. an email race).
    if (claimedKeyId) {
      await AccessKey.updateOne({ _id: claimedKeyId }, { $set: { redeemedBy: null, redeemedAt: null } }).catch(() => {});
    }
    if (err?.code === 11000) return res.status(400).json({ error: "Registration failed. Check your key and details." });
    next(err);
  }
});

// ------------------------------------------------------------------- login
authRouter.post("/login", limitHashing, async (req, res, next) => {
  try {
    const email = v.email(req.body);
    const password = v.password(req.body);
    const fail = () => res.status(401).json({ error: "Invalid credentials" });

    const user = await User.findOne(userByEmail(email));
    if (!user || !user.active) {
      await burnPasswordCheck(password);
      return fail();
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await burnPasswordCheck(password);
      return res.status(429).json({ error: "Too many attempts. Try again later." });
    }

    let ok = await verifyPassword(password, user.passwordHash);

    // Admin second factor (enforced whenever ADMIN_TOTP_SECRET is configured).
    // A missing/wrong code fails exactly like a wrong password and counts
    // toward lockout, so the response never confirms a correct password.
    const totpSecret = user.role === ROLES.ADMIN ? secret("ADMIN_TOTP_SECRET") : undefined;
    if (ok && totpSecret) {
      const totp = req.body?.totp;
      ok = typeof totp === "string" && verifyTotp(totpSecret, totp.trim());
    }

    if (!ok) {
      user.failedLogins = (user.failedLogins ?? 0) + 1;
      if (user.failedLogins >= MAX_FAILED_LOGINS) {
        user.lockedUntil = new Date(Date.now() + LOCKOUT_MS);
        user.failedLogins = 0;
      }
      await user.save();
      return fail();
    }

    // Transparent upgrade: legacy scrypt (or weaker Argon2id) hashes are
    // replaced now, while we hold the verified plaintext password.
    if (needsRehash(user.passwordHash)) user.passwordHash = await hashPassword(password);
    user.failedLogins = 0;
    user.lockedUntil = undefined;
    user.lastLoginAt = new Date();
    await user.save();
    await startSession(res, user);
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/logout", async (req, res, next) => {
  try {
    await endSession(req, res);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});
