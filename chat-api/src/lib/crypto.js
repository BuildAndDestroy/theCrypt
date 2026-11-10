// Password hashing, access keys, session tokens and TOTP — all on Node's
// built-in crypto, so the image has no native modules to compile for ARM.
import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);

// ---------------------------------------------------------------- passwords
// scrypt N=2^15, r=8, p=1 (~32 MiB, ~100 ms on a Pi). Format:
//   scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64 };
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT_MAXMEM,
  });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

export async function verifyPassword(password, stored) {
  const parts = typeof stored === "string" ? stored.split("$") : [];
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT_MAXMEM,
  });
  return crypto.timingSafeEqual(actual, expected);
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
