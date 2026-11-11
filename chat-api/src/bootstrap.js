import mongoose from "mongoose";
import { User, userByEmail } from "./models/index.js";
import { encryptUserFields } from "./lib/fieldcrypto.js";
import { hashPassword, needsRehash, verifyPassword } from "./lib/crypto.js";
import { ROLES } from "./lib/rbac.js";
import { secret } from "./lib/secrets.js";

/**
 * The admin is predefined: ADMIN_EMAIL / ADMIN_PASSWORD come from a Secret,
 * and that Secret is the source of truth. Every boot creates the admin if
 * missing, and re-asserts its role, active flag and password.
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
    const _id = new mongoose.Types.ObjectId();
    await User.create({ _id, ...encryptUserFields(_id, { email }), passwordHash: await hashPassword(password), role: ROLES.ADMIN });
    console.log("Admin account created.");
    return;
  }

  let changed = false;
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
