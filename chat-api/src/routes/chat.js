import { Router } from "express";
import mongoose from "mongoose";
import { Message } from "../models/index.js";
import { PERMISSIONS } from "../lib/rbac.js";
import * as v from "../lib/validate.js";
import { requirePermission } from "../middleware/auth.js";
import { DecryptionError, decrypt, encrypt, messageField } from "../lib/fieldcrypto.js";

// Shared by the customer and admin routers.
export const PAGE_SIZE = 200;
export const MAX_MESSAGE = 4000;

// A message that fails to decrypt (tampered, wrong key, or plaintext in strict
// mode) is shown as unreadable on its own, so the rest of the conversation
// still loads. Its stored content is never sent.
export const UNREADABLE = "[message could not be decrypted]";

export function serializeMessage(m) {
  let body;
  let unreadable = false;
  try {
    body = decrypt(m.body, messageField(m._id));
  } catch (err) {
    if (!(err instanceof DecryptionError)) throw err;
    console.error(`Message ${m._id}: ${err.message}`);
    body = UNREADABLE;
    unreadable = true;
  }
  return { id: String(m._id), from: m.from, body, createdAt: m.createdAt, ...(unreadable ? { unreadable } : {}) };
}

/** Store a message with its body encrypted (bound to a pre-chosen _id). */
export async function newMessage({ customer, from, author, body, ...flags }) {
  const _id = new mongoose.Types.ObjectId();
  const m = await Message.create({ _id, customer, from, author, body: encrypt(body, messageField(_id)), ...flags });
  return { id: String(m._id), from: m.from, body, createdAt: m.createdAt };
}

/** Messages in one conversation, oldest first, strictly after the cursor. */
export async function listMessages(customerId, afterId) {
  const filter = { customer: customerId };
  if (afterId) filter._id = mongoose.trusted({ $gt: afterId }); // afterId is a validated ObjectId
  return Message.find(filter).sort({ _id: 1 }).limit(PAGE_SIZE).lean();
}

// Per-account send limit (sliding minute). In memory: fine for replicas: 1.
const SEND_LIMIT = 20;
const sendLog = new Map();
export function allowSend(userId) {
  const now = Date.now();
  const key = String(userId);
  const recent = (sendLog.get(key) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= SEND_LIMIT) {
    sendLog.set(key, recent);
    return false;
  }
  recent.push(now);
  sendLog.set(key, recent);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of sendLog) if (ts.every((t) => now - t >= 60_000)) sendLog.delete(k);
}, 60_000).unref();

// ------------------------------------------------------- customer routes
export const chatRouter = Router();
chatRouter.use(requirePermission(PERMISSIONS.CHAT_OWN));

// GET /api/chat/messages?after=<messageId>  — the poll endpoint.
chatRouter.get("/messages", async (req, res, next) => {
  try {
    const after = v.optionalObjectId(req.query.after, "after");
    const messages = await listMessages(req.user._id, after);
    const unseen = messages.filter((m) => m.from === "operator" && !m.seenByCustomer).map((m) => m._id);
    if (unseen.length) await Message.updateMany({ _id: mongoose.trusted({ $in: unseen }) }, { $set: { seenByCustomer: true } });
    res.json({ messages: messages.map(serializeMessage) });
  } catch (err) {
    next(err);
  }
});

chatRouter.post("/messages", async (req, res, next) => {
  try {
    const body = v.text(req.body, "body", { max: MAX_MESSAGE });
    if (!allowSend(req.user._id)) return res.status(429).json({ error: "Slow down." });
    const message = await newMessage({
      customer: req.user._id,
      from: "customer",
      author: req.user._id,
      body,
      seenByCustomer: true,
    });
    res.status(201).json({ message });
  } catch (err) {
    next(err);
  }
});
