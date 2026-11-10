import mongoose from "mongoose";
import { ROLES } from "../lib/rbac.js";

const { Schema, model } = mongoose;

// ------------------------------------------------------------------ User
// Admins are bootstrapped from a Secret; customers self-register with a key.
const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    phone: { type: String, trim: true, maxlength: 25 },
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
// tell keys apart in the list without keeping the secret.
const accessKeySchema = new Schema(
  {
    keyHash: { type: String, required: true, unique: true },
    hint: { type: String, required: true },
    label: { type: String, trim: true, maxlength: 120 },
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
const messageSchema = new Schema({
  customer: { type: Schema.Types.ObjectId, ref: "User", required: true },
  from: { type: String, enum: ["customer", "operator"], required: true },
  author: { type: Schema.Types.ObjectId, ref: "User", required: true },
  body: { type: String, required: true, maxlength: 4000 },
  createdAt: { type: Date, default: Date.now },
  seenByOperator: { type: Boolean, default: false },
  seenByCustomer: { type: Boolean, default: false },
});
messageSchema.index({ customer: 1, _id: 1 });

export const User = model("User", userSchema);
export const AccessKey = model("AccessKey", accessKeySchema);
export const Session = model("Session", sessionSchema);
export const Message = model("Message", messageSchema);
