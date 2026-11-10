import { Router } from "express";
import mongoose from "mongoose";
import { Message } from "../models/index.js";
import { PERMISSIONS } from "../lib/rbac.js";
import * as v from "../lib/validate.js";
import { requirePermission } from "../middleware/auth.js";

// Shared by the customer and admin routers.
export const PAGE_SIZE = 200;
export const MAX_MESSAGE = 4000;

export function serializeMessage(m) {
  return { id: String(m._id), from: m.from, body: m.body, createdAt: m.createdAt };
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
    const m = await Message.create({
      customer: req.user._id,
      from: "customer",
      author: req.user._id,
      body,
      seenByCustomer: true,
    });
    res.status(201).json({ message: serializeMessage(m) });
  } catch (err) {
    next(err);
  }
});
