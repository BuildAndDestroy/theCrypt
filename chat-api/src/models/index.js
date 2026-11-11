import mongoose from "mongoose";
import { ROLES } from "../lib/rbac.js";
import { emailIndexCandidates, strict } from "../lib/fieldcrypto.js";

const { Schema, model } = mongoose;

// ------------------------------------------------------------------ User
// Admins are bootstrapped from a Secret; customers self-register with a key.
// `email` and `phone` hold AES-256-GCM ciphertext (lib/fieldcrypto.js); input
// is validated before encryption, so no length/case rules here (they would
// corrupt the ciphertext). `emailIdx` is the HMAC blind index that login
// looks up and that enforces one account per address. It is a partial index
// so pre-migration rows (no emailIdx yet) don't collide on null.
const userSchema = new Schema(
  {
    email: { type: String, required: true },
    emailIdx: {
      type: String,
      index: { unique: true, partialFilterExpression: { emailIdx: { $type: "string" } } },
    },
    phone: { type: String },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: Object.values(ROLES), required: true },
    active: { type: Boolean, default: true },
    accessKey: { type: Schema.Types.ObjectId, ref: "AccessKey" },
    // Per-account lockout. IP-based limits are useless here: over Tor every
    // visitor arrives from 127.0.0.1.
    failedLogins: { type: Number, default: 0 },
    lockedUntil: { type: Date },
    lastLoginAt: { type: Date },
  },
  { timestamps: true },
);

// ------------------------------------------------------------- AccessKey
// Only the SHA-256 of the key is stored. `hint` (last 4 chars) lets the admin
// tell keys apart in the list without keeping the secret. `label` is
// encrypted (operators may write a customer's name there).
const accessKeySchema = new Schema(
  {
    keyHash: { type: String, required: true, unique: true },
    hint: { type: String, required: true },
    label: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    redeemedBy: { type: Schema.Types.ObjectId, ref: "User" },
    redeemedAt: { type: Date },
    revokedAt: { type: Date },
  },
  { timestamps: true },
);

// --------------------------------------------------------------- Session
// Opaque random token in an HttpOnly cookie; only its hash is stored, and
// Mongo's TTL index deletes the row when it expires.
const sessionSchema = new Schema({
  tokenHash: { type: String, required: true, unique: true },
  user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  expiresAt: { type: Date, required: true },
});
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// --------------------------------------------------------------- Message
// One conversation per customer, keyed by `customer`. _id order (ObjectId)
// is creation order, which the polling cursor (`after=<id>`) relies on.
// `body` is AES-256-GCM ciphertext bound to the message _id, so the _id is
// chosen before encrypting (see newMessage in routes/chat.js).
const messageSchema = new Schema({
  customer: { type: Schema.Types.ObjectId, ref: "User", required: true },
  from: { type: String, enum: ["customer", "operator"], required: true },
  author: { type: Schema.Types.ObjectId, ref: "User", required: true },
  body: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  seenByOperator: { type: Boolean, default: false },
  seenByCustomer: { type: Boolean, default: false },
});
messageSchema.index({ customer: 1, _id: 1 });

export const User = model("User", userSchema);
export const AccessKey = model("AccessKey", accessKeySchema);
export const Session = model("Session", sessionSchema);
export const Message = model("Message", messageSchema);

/**
 * Query filter for "the user with this email": by blind index (current key,
 * then the previous one during a rotation) and — only while upgrading, with
 * STRICT_ENCRYPTION=false — by the legacy plaintext column.
 */
export function userByEmail(email) {
  const byIdx = { emailIdx: mongoose.trusted({ $in: emailIndexCandidates(email) }) };
  if (strict()) return byIdx;
  return mongoose.trusted({ $or: [byIdx, { email }] });
}
