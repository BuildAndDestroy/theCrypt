import { Router } from "express";
import mongoose from "mongoose";
import { AccessKey, Message, Session, User } from "../models/index.js";
import { generateAccessKey, hashAccessKey } from "../lib/crypto.js";
import { PERMISSIONS, ROLES } from "../lib/rbac.js";
import * as v from "../lib/validate.js";
import { requirePermission } from "../middleware/auth.js";
import { allowSend, listMessages, MAX_MESSAGE, newMessage, serializeMessage } from "./chat.js";
import { accessKeyField, decrypt, decryptUser, encrypt } from "../lib/fieldcrypto.js";

export const adminRouter = Router();

// ------------------------------------------------------------ access keys
const keysRouter = Router();
keysRouter.use(requirePermission(PERMISSIONS.KEYS_MANAGE));

keysRouter.get("/", async (_req, res, next) => {
  try {
    const keys = await AccessKey.find().sort({ createdAt: -1 }).populate("redeemedBy", "email").lean();
    res.json({
      keys: keys.map((k) => ({
        id: String(k._id),
        hint: k.hint,
        label: decrypt(k.label, accessKeyField(k._id)) ?? "",
        createdAt: k.createdAt,
        redeemedAt: k.redeemedAt ?? null,
        redeemedBy: k.redeemedBy ? decryptUser(k.redeemedBy).email : null,
        revokedAt: k.revokedAt ?? null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// The plaintext key is returned ONCE, here. Only its hash is stored.
keysRouter.post("/", async (req, res, next) => {
  try {
    const label = v.text(req.body, "label", { required: false, max: 120 });
    const key = generateAccessKey();
    const _id = new mongoose.Types.ObjectId();
    const doc = await AccessKey.create({
      _id,
      keyHash: hashAccessKey(key),
      hint: key.slice(-4),
      label: encrypt(label, accessKeyField(_id)),
      createdBy: req.user._id,
    });
    res.status(201).json({ key, id: String(doc._id), hint: doc.hint, label: label ?? "" });
  } catch (err) {
    next(err);
  }
});

keysRouter.post("/:id/revoke", async (req, res, next) => {
  try {
    const id = v.objectId(req.params.id);
    const r = await AccessKey.updateOne({ _id: id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    if (!r.matchedCount) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

adminRouter.use("/keys", keysRouter);

// ---------------------------------------------------------- conversations
const convRouter = Router();
convRouter.use(requirePermission(PERMISSIONS.CHATS_ALL));

// Every customer, with their latest message and unread count — newest
// activity first. Customers who haven't written yet are listed too.
convRouter.get("/", async (_req, res, next) => {
  try {
    const customers = await User.find({ role: ROLES.CUSTOMER })
      .select("email phone active createdAt accessKey")
      .populate("accessKey", "label hint")
      .lean();
    const stats = await Message.aggregate([
      { $sort: { _id: 1 } },
      {
        $group: {
          _id: "$customer",
          last: { $last: "$$ROOT" },
          unread: { $sum: { $cond: [{ $and: [{ $eq: ["$from", "customer"] }, { $eq: ["$seenByOperator", false] }] }, 1, 0] } },
        },
      },
    ]);
    const byCustomer = new Map(stats.map((s) => [String(s._id), s]));
    const conversations = customers.map((c) => {
      const s = byCustomer.get(String(c._id));
      const { email, phone } = decryptUser(c);
      return {
        customerId: String(c._id),
        email,
        phone: phone ?? null,
        active: c.active,
        keyLabel: c.accessKey ? decrypt(c.accessKey.label, accessKeyField(c.accessKey._id)) ?? "" : "",
        keyHint: c.accessKey?.hint ?? "",
        registeredAt: c.createdAt,
        unread: s?.unread ?? 0,
        lastMessage: s ? serializeMessage(s.last) : null,
      };
    });
    const ts = (c) => new Date(c.lastMessage?.createdAt ?? c.registeredAt).getTime();
    conversations.sort((a, b) => ts(b) - ts(a));
    res.json({ conversations });
  } catch (err) {
    next(err);
  }
});

async function loadCustomer(req, res) {
  const id = v.objectId(req.params.customerId, "customerId");
  const customer = await User.findOne({ _id: id, role: ROLES.CUSTOMER }).lean();
  if (!customer) res.status(404).json({ error: "Not found" });
  return customer;
}

convRouter.get("/:customerId/messages", async (req, res, next) => {
  try {
    const customer = await loadCustomer(req, res);
    if (!customer) return;
    const after = v.optionalObjectId(req.query.after, "after");
    const messages = await listMessages(customer._id, after);
    const unseen = messages.filter((m) => m.from === "customer" && !m.seenByOperator).map((m) => m._id);
    if (unseen.length) await Message.updateMany({ _id: mongoose.trusted({ $in: unseen }) }, { $set: { seenByOperator: true } });
    res.json({ messages: messages.map(serializeMessage) });
  } catch (err) {
    next(err);
  }
});

convRouter.post("/:customerId/messages", async (req, res, next) => {
  try {
    const customer = await loadCustomer(req, res);
    if (!customer) return;
    const body = v.text(req.body, "body", { max: MAX_MESSAGE });
    if (!allowSend(req.user._id)) return res.status(429).json({ error: "Slow down." });
    const message = await newMessage({
      customer: customer._id,
      from: "operator",
      author: req.user._id,
      body,
      seenByOperator: true,
    });
    res.status(201).json({ message });
  } catch (err) {
    next(err);
  }
});

// Disable / re-enable a customer. Disabling also kills their sessions.
convRouter.post("/:customerId/active", requirePermission(PERMISSIONS.USERS_MANAGE), async (req, res, next) => {
  try {
    const customer = await loadCustomer(req, res);
    if (!customer) return;
    if (typeof req.body?.active !== "boolean") throw new v.ValidationError("active must be true or false");
    await User.updateOne({ _id: customer._id }, { $set: { active: req.body.active } });
    if (!req.body.active) await Session.deleteMany({ user: customer._id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

adminRouter.use("/conversations", convRouter);
