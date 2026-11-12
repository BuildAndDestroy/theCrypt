import mongoose from "mongoose";
import { User, userByEmail } from "./models/index.js";
import { encryptUserFields } from "./lib/fieldcrypto.js";
import { hashPassword, needsRehash, verifyPassword } from "./lib/crypto.js";
import { ROLES } from "./lib/rbac.js";
import { secret } from "./lib/secrets.js";

/**
 * The admin is predefined: ADMIN_EMAIL / ADMIN_PASSWORD come from a Secret,
 * and that Secret is the source of truth. Every boot creates the admin if
 * missing, and re-asserts its role, active flag, password and `builtin` flag
 * (which shields it from being disabled, deleted or demoted in the console).
 */
export async function ensureAdmin() {
  const email = secret("ADMIN_EMAIL")?.trim().toLowerCase();
  const password = secret("ADMIN_PASSWORD");
  if (!email || !password) {
    console.warn("ADMIN_EMAIL / ADMIN_PASSWORD not set: no admin account is managed.");
    return;
  }
  if (password.length < 16) {
    throw new Error("ADMIN_PASSWORD must be at least 16 characters");
  }
  if (!secret("ADMIN_TOTP_SECRET")) {
    console.warn("WARNING: ADMIN_TOTP_SECRET is not set; the operator login needs only a password.");
  }

  const existing = await User.findOne(userByEmail(email));
  if (!existing) {
    await User.updateMany({ builtin: true }, { $set: { builtin: false } });
    const _id = new mongoose.Types.ObjectId();
    await User.create({
      _id, ...encryptUserFields(_id, { email }), passwordHash: await hashPassword(password), role: ROLES.ADMIN, builtin: true,
    });
    console.log("Admin account created.");
    return;
  }

  // Exactly one builtin admin: the one named by the Secret. If ADMIN_EMAIL
  // changed, the old account loses the flag (and stays a normal admin).
  const demoted = await User.updateMany({ builtin: true, _id: mongoose.trusted({ $ne: existing._id }) }, { $set: { builtin: false } });
  if (demoted.modifiedCount) console.log("Previous predefined admin is no longer marked builtin.");

  let changed = false;
  if (!existing.builtin) { existing.builtin = true; changed = true; }
  if (existing.role !== ROLES.ADMIN) { existing.role = ROLES.ADMIN; changed = true; }
  if (!existing.active) { existing.active = true; changed = true; }
  if (!(await verifyPassword(password, existing.passwordHash)) || needsRehash(existing.passwordHash)) {
    existing.passwordHash = await hashPassword(password);
    changed = true;
  }
  if (changed) {
    existing.failedLogins = 0;
    existing.lockedUntil = undefined;
    await existing.save();
    console.log("Admin account updated from Secret.");
  }
}
