import { Session, User } from "../models/index.js";
import mongoose from "mongoose";
import { newSessionToken, sha256 } from "../lib/crypto.js";
import { can } from "../lib/rbac.js";

export const SESSION_COOKIE = "crypt_sid";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 h

// `Secure` is opt-in (COOKIE_SECURE=true). An onion has no http/https split
// for it to protect — Tor already encrypts end to end — and clients other
// than Tor Browser won't send a Secure cookie over http://*.onion at all.
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";

function cookieHeader(value, maxAgeSec) {
  return [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    COOKIE_SECURE ? "Secure" : null,
    `Max-Age=${maxAgeSec}`,
  ].filter(Boolean).join("; ");
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export async function startSession(res, user) {
  const token = newSessionToken();
  await Session.create({
    tokenHash: sha256(token),
    user: user._id,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  res.setHeader("Set-Cookie", cookieHeader(token, SESSION_TTL_MS / 1000));
}

export async function endSession(req, res) {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await Session.deleteOne({ tokenHash: sha256(token) });
  res.setHeader("Set-Cookie", cookieHeader("", 0));
}

/** Resolve the session cookie to an active user (or null) on every request. */
export async function attachUser(req, _res, next) {
  req.user = null;
  try {
    const token = readCookie(req, SESSION_COOKIE);
    if (token && token.length <= 64) {
      const session = await Session.findOne({ tokenHash: sha256(token), expiresAt: mongoose.trusted({ $gt: new Date() }) }).lean();
      if (session) {
        const user = await User.findById(session.user).select("-passwordHash").lean();
        if (user?.active) req.user = user;
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Sign in required" });
  next();
}

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required" });
    if (!can(req.user, permission)) return res.status(403).json({ error: "Forbidden" });
    next();
  };
}

/**
 * CSRF: the session cookie is SameSite=Strict, and every state-changing call
 * must also carry the X-Crypt-Request header.
 */
export function requireApiRequest(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  // A browser can't attach a custom header cross-site without a CORS
  // preflight, which this API never approves. Only JSON bodies are parsed
  // (express.json), so form posts arrive empty and fail validation anyway.
  if (req.get("x-crypt-request") !== "1") {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}
