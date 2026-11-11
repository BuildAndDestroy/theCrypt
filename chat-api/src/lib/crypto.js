// Password hashing, access keys, session tokens and TOTP — all on Node's
// built-in crypto (Argon2id needs Node >= 24.7), so the image has no native
// modules to compile for ARM.
import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
const argon2 = promisify(crypto.argon2);

// ---------------------------------------------------------------- passwords
// Argon2id, m=64 MiB, t=3, p=1 (OWASP-compliant; ~0.3-0.5 s on a Pi 4).
// limitHashing caps concurrency at 2, so hashing peaks at ~128 MiB.
// Stored in the standard PHC string format:
//   $argon2id$v=19$m=65536,t=3,p=1$<salt b64>$<hash b64>   (unpadded base64)
//
// Legacy hashes (`scrypt$N$r$p$salt$hash`) still verify; the login route
// re-hashes them with Argon2id on the next successful sign-in.
export const ARGON2 = { memory: 64 * 1024, passes: 3, parallelism: 1, tagLength: 32 };
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
// Refuse to verify hashes whose parameters would let a tampered record
// exhaust memory or CPU (m in KiB).
const ARGON2_LIMITS = { maxMemory: 256 * 1024, maxPasses: 10, maxParallelism: 4 };

const b64 = (buf) => buf.toString("base64").replace(/=+$/, "");

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await argon2("argon2id", { message: password, nonce: salt, ...ARGON2 });
  const { memory: m, passes: t, parallelism: p } = ARGON2;
  return `$argon2id$v=19$m=${m},t=${t},p=${p}$${b64(salt)}$${b64(hash)}`;
}

function parseArgon2(stored) {
  // ["", "argon2id", "v=19", "m=..,t=..,p=..", salt, hash]
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "" || parts[1] !== "argon2id" || parts[2] !== "v=19") return null;
  const params = Object.fromEntries(parts[3].split(",").map((kv) => kv.split("=")));
  const memory = Number(params.m), passes = Number(params.t), parallelism = Number(params.p);
  if (![memory, passes, parallelism].every(Number.isSafeInteger)) return null;
  if (memory > ARGON2_LIMITS.maxMemory || passes > ARGON2_LIMITS.maxPasses || parallelism > ARGON2_LIMITS.maxParallelism) return null;
  const salt = Buffer.from(parts[4], "base64");
  const hash = Buffer.from(parts[5], "base64");
  if (salt.length < 8 || hash.length < 16) return null;
  return { memory, passes, parallelism, salt, hash };
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== "string") return false;

  if (stored.startsWith("$argon2id$")) {
    const h = parseArgon2(stored);
    if (!h) return false;
    const actual = await argon2("argon2id", {
      message: password, nonce: h.salt, memory: h.memory, passes: h.passes,
      parallelism: h.parallelism, tagLength: h.hash.length,
    });
    return crypto.timingSafeEqual(actual, h.hash);
  }

  // Legacy scrypt.
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT_MAXMEM,
  });
  return crypto.timingSafeEqual(actual, expected);
}

/** True when a (verified) hash is legacy scrypt or weaker than today's Argon2id settings. */
export function needsRehash(stored) {
  const h = typeof stored === "string" && stored.startsWith("$argon2id$") ? parseArgon2(stored) : null;
  if (!h) return true;
  return h.memory < ARGON2.memory || h.passes < ARGON2.passes || h.hash.length < ARGON2.tagLength;
}

/** "argon2id" | "scrypt" | "unknown" — for the migration report. */
export function hashKind(stored) {
  if (typeof stored !== "string") return "unknown";
  if (stored.startsWith("$argon2id$")) return "argon2id";
  if (stored.startsWith("scrypt$")) return "scrypt";
  return "unknown";
}

// A real hash of a random password: verifying against it costs the same as a
// real account, so "no such email" and "wrong password" take equal time.
let dummyHash;
export async function burnPasswordCheck(password) {
  dummyHash ??= await hashPassword(crypto.randomBytes(16).toString("hex"));
  await verifyPassword(password, dummyHash);
  return false;
}

// ------------------------------------------------------------- access keys
// 20 Crockford-ish base32 chars = 100 bits, shown as XXXXX-XXXXX-XXXXX-XXXXX.
// Only a SHA-256 of the normalised key is stored; the plaintext is shown to
// the admin once, at creation.
const KEY_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ0123456789"; // no I, L, O, U

export function generateAccessKey() {
  const bytes = crypto.randomBytes(20);
  let out = "";
  for (let i = 0; i < 20; i++) out += KEY_ALPHABET[bytes[i] & 31];
  return out.match(/.{5}/g).join("-");
}

export function normalizeAccessKey(input) {
  return String(input).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function hashAccessKey(input) {
  return sha256(normalizeAccessKey(input));
}

// --------------------------------------------------------------- sessions
export function newSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

// ------------------------------------------------------------------ TOTP
// RFC 6238 (SHA-1, 30 s, 6 digits) — what every authenticator app speaks.
function base32Decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(input).toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totpAt(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", secret).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const code = (h.readUInt32BE(o) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, "0");
}

/** Accepts the current code and one step either side (clock drift). */
export function verifyTotp(base32Secret, code) {
  if (!/^\d{6}$/.test(String(code ?? ""))) return false;
  const secret = base32Decode(base32Secret);
  const step = Math.floor(Date.now() / 30_000);
  return [-1, 0, 1].some((d) =>
    crypto.timingSafeEqual(Buffer.from(totpAt(secret, step + d)), Buffer.from(String(code))),
  );
}
