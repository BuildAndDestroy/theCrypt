// Application-level encryption of sensitive fields (AES-256-GCM).
//
// Master key: 32 random bytes, base64, from the chat-data-key Secret
// (DATA_KEY_FILE). From it HKDF-SHA256 derives three independent subkeys,
// so no key is ever used for two purposes:
//   enc — AES-256-GCM encryption of field values
//   idx — HMAC-SHA256 blind index (lets login find a user by email without
//         the email being stored in the clear)
//   kid — a short public key id stored with each ciphertext (for rotation)
//
// Ciphertext format (ASCII, safe in any string field):
//   v1:<kid>:<iv>:<tag>:<ciphertext>          (base64url, 96-bit random IV)
//
// AAD binds every ciphertext to "<collection>|<_id>|<field>": a value copied
// into another document or another field fails authentication instead of
// decrypting. The plaintext is length-padded (see PAD) so ciphertext sizes
// reveal only a size bucket, not the exact length.
//
// Rotation: put the old key in DATA_KEY_PREVIOUS_FILE and a new one in
// DATA_KEY_FILE, then run `node src/migrate.js` (re-encrypts with the current
// key and rebuilds blind indexes). Both keys decrypt in the meantime.
//
// Threat model: protects data at rest (NAS, snapshots, backups, a stolen DB
// dump). It does NOT protect against someone in control of the chat-api Pod
// or able to read the cluster's Secrets — they hold the key.
import crypto from "node:crypto";
import { secret } from "./secrets.js";

const PREFIX = "v1";
const HKDF_SALT = Buffer.from("thecrypt/field-encryption/v1");

/** Padding block size (bytes) per field kind. */
export const PAD = { body: 256, label: 64, email: 64, phone: 32, totpSecret: 64 };

export class DecryptionError extends Error {
  constructor(message) {
    super(message);
    this.name = "DecryptionError";
  }
}

function derive(master, info) {
  return Buffer.from(crypto.hkdfSync("sha256", master, HKDF_SALT, Buffer.from(info), 32));
}

function parseMaster(value, name) {
  const raw = Buffer.from(String(value).trim(), "base64");
  if (raw.length !== 32) {
    throw new Error(`${name} must be 32 random bytes, base64-encoded (openssl rand -base64 32)`);
  }
  return raw;
}

function makeKey(master) {
  return {
    kid: derive(master, "kid").subarray(0, 4).toString("hex"),
    enc: derive(master, "enc"),
    idx: derive(master, "idx"),
  };
}

let keys = null; // { current, byKid: Map, previous? }

/**
 * Load the keys from DATA_KEY(_FILE) / DATA_KEY_PREVIOUS(_FILE). Called at
 * startup so a missing or malformed key stops the process immediately.
 */
export function loadKeys() {
  const cur = secret("DATA_KEY");
  if (!cur) throw new Error("DATA_KEY is not set (DATA_KEY_FILE -> chat-data-key Secret). Refusing to start.");
  const current = makeKey(parseMaster(cur, "DATA_KEY"));
  const byKid = new Map([[current.kid, current]]);
  let previous;
  const prev = secret("DATA_KEY_PREVIOUS");
  if (prev) {
    previous = makeKey(parseMaster(prev, "DATA_KEY_PREVIOUS"));
    if (previous.kid === current.kid) previous = undefined; // same key twice
    else byKid.set(previous.kid, previous);
  }
  keys = { current, previous, byKid };
  return { kid: current.kid, previousKid: previous?.kid ?? null };
}

function ks() {
  if (!keys) loadKeys();
  return keys;
}

/** Legacy plaintext accepted? Only while upgrading (STRICT_ENCRYPTION=false). */
export function strict() {
  return process.env.STRICT_ENCRYPTION !== "false";
}

export function currentKid() {
  return ks().current.kid;
}

const aadFor = (collection, id, field) => Buffer.from(`thecrypt|${collection}|${String(id)}|${field}`);

// [u32 BE length][utf8 bytes][zero fill to a multiple of block]
function pad(text, block) {
  const data = Buffer.from(text, "utf8");
  const total = Math.ceil((data.length + 4) / block) * block;
  const out = Buffer.alloc(total);
  out.writeUInt32BE(data.length, 0);
  data.copy(out, 4);
  return out;
}

function unpad(buf) {
  if (buf.length < 4) throw new DecryptionError("bad padding");
  const len = buf.readUInt32BE(0);
  if (len > buf.length - 4) throw new DecryptionError("bad padding");
  return buf.subarray(4, 4 + len).toString("utf8");
}

export function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(`${PREFIX}:`);
}

/** Key id of a ciphertext (null if not one). */
export function kidOf(value) {
  return isEncrypted(value) ? value.split(":")[1] : null;
}

/**
 * Encrypt `plain` for (collection, _id, field). Empty / missing values are
 * returned unchanged (there's nothing to protect, and "" must stay falsy).
 */
export function encrypt(plain, { collection, id, field }) {
  if (plain === undefined || plain === null || plain === "") return plain;
  if (typeof plain !== "string") throw new TypeError(`encrypt: ${field} must be a string`);
  const { current } = ks();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", current.enc, iv);
  cipher.setAAD(aadFor(collection, id, field));
  const ct = Buffer.concat([cipher.update(pad(plain, PAD[field] ?? 32)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, current.kid, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(":");
}

/**
 * Decrypt a stored value. Plaintext (legacy, pre-migration) is passed through
 * only when STRICT_ENCRYPTION=false; otherwise it is an error — never shown.
 */
export function decrypt(stored, { collection, id, field }) {
  if (stored === undefined || stored === null || stored === "") return stored;
  if (!isEncrypted(stored)) {
    if (strict()) throw new DecryptionError(`plaintext ${collection}.${field} in strict mode (run migrate.js)`);
    return stored;
  }
  const parts = stored.split(":");
  if (parts.length !== 5) throw new DecryptionError("malformed ciphertext");
  const [, kid, ivB, tagB, ctB] = parts;
  const key = ks().byKid.get(kid);
  if (!key) throw new DecryptionError(`unknown key id ${kid}`);
  const iv = Buffer.from(ivB, "base64url");
  const tag = Buffer.from(tagB, "base64url");
  if (iv.length !== 12 || tag.length !== 16) throw new DecryptionError("malformed ciphertext");
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", key.enc, iv, { authTagLength: 16 });
    d.setAAD(aadFor(collection, id, field));
    d.setAuthTag(tag);
    return unpad(Buffer.concat([d.update(Buffer.from(ctB, "base64url")), d.final()]));
  } catch (err) {
    if (err instanceof DecryptionError) throw err;
    throw new DecryptionError(`authentication failed for ${collection}.${field}`);
  }
}

// ----------------------------------------------------------- blind index
const normEmail = (email) => String(email).trim().toLowerCase();

function hmac(key, value) {
  return crypto.createHmac("sha256", key.idx).update(value).digest("base64url");
}

/** Blind index of an email under the current key (what gets stored). */
export function emailIndex(email) {
  return hmac(ks().current, `email|${normEmail(email)}`);
}

/** Indexes to search on: current key first, then the previous one (rotation). */
export function emailIndexCandidates(email) {
  const { current, previous } = ks();
  const out = [hmac(current, `email|${normEmail(email)}`)];
  if (previous) out.push(hmac(previous, `email|${normEmail(email)}`));
  return out;
}

// ------------------------------------------------- per-collection helpers
export const userField = (id, field) => ({ collection: "users", id, field });
export const messageField = (id) => ({ collection: "messages", id, field: "body" });
export const accessKeyField = (id) => ({ collection: "accesskeys", id, field: "label" });

/** Plain {email, phone} of a user document / lean object. */
export function decryptUser(u) {
  return {
    email: decrypt(u.email, userField(u._id, "email")),
    phone: decrypt(u.phone, userField(u._id, "phone")),
  };
}

/** Encrypted email/phone/emailIdx for a new user with a pre-chosen _id. */
export function encryptUserFields(id, { email, phone }) {
  return {
    email: encrypt(email, userField(id, "email")),
    emailIdx: emailIndex(email),
    ...(phone ? { phone: encrypt(phone, userField(id, "phone")) } : {}),
  };
}
