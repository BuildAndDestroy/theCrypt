// Encrypt legacy plaintext rows (and re-encrypt rows under a previous key).
//
//   node src/migrate.js            encrypt everything that needs it
//   node src/migrate.js --dry-run  count only, write nothing
//   node src/migrate.js --check    count only, and decrypt every encrypted
//                                  value; exit 1 if anything is plaintext,
//                                  under an old key, or fails to decrypt
//
// Run inside the chat-api container (it has the keys and DB credentials):
//   kubectl -n tor-hidden-ns exec deployment/thecrypt -c chat-api -- node src/migrate.js
//
// Idempotent and safe while the app is serving: each update is conditional on
// the value it read, so a row changed concurrently is skipped (re-run to pick
// it up). Ends with one machine-readable line:
//   MIGRATE_RESULT {"usersPlain":0,...}
// where *Plain / staleKeyRows are what remains AFTER this run.
import mongoose from "mongoose";
import { connect } from "./lib/db.js";
import {
  accessKeyField, currentKid, decrypt, emailIndex, encrypt, isEncrypted, kidOf, loadKeys,
  messageField, userField,
} from "./lib/fieldcrypto.js";
import { hashKind } from "./lib/crypto.js";
import { AccessKey, Message, User } from "./models/index.js";

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run") || args.has("--check");
const CHECK = args.has("--check");
const BATCH = 200;

// "plain" | "stale" (old key) | "ok" | "empty"
function state(value) {
  if (value === undefined || value === null || value === "") return "empty";
  if (!isEncrypted(value)) return "plain";
  return kidOf(value) === currentKid() ? "ok" : "stale";
}

// --check: prove every current-key value decrypts (tampering, wrong key).
function verify(value, where) {
  if (CHECK && state(value) === "ok") decrypt(value, where);
}

// Plaintext of a stored value regardless of STRICT_ENCRYPTION.
function reveal(value, where) {
  return isEncrypted(value) ? decrypt(value, where) : value;
}

/**
 * Walk a collection; for each doc, plan() returns {$set} (or null) plus the
 * fields whose current values the update is conditional on.
 */
async function sweep(model, projection, plan) {
  const stats = { plain: 0, stale: 0, written: 0, conflicts: 0, errors: 0 };
  let ops = [];
  const flush = async () => {
    if (!ops.length || DRY) return void (ops = []);
    try {
      const r = await model.collection.bulkWrite(ops, { ordered: false });
      stats.written += r.modifiedCount;
      stats.conflicts += ops.length - r.matchedCount;
    } catch (err) {
      // Partial success is still reported by the driver.
      const r = err.result;
      if (r) {
        stats.written += r.modifiedCount ?? 0;
        stats.errors += err.writeErrors?.length ?? 1;
      } else throw err;
      for (const we of err.writeErrors ?? []) console.error(`  write error ${model.modelName}: ${we.errmsg ?? we.err?.errmsg}`);
    }
    ops = [];
  };

  for await (const doc of model.collection.find({}, { projection })) {
    let p;
    try {
      p = plan(doc);
    } catch (err) {
      stats.errors++;
      console.error(`  ${model.modelName} ${doc._id}: ${err.message}`);
      continue;
    }
    if (p.plain) stats.plain++;
    if (p.stale) stats.stale++;
    if (!p.set) continue;
    const filter = { _id: doc._id };
    for (const f of p.guard) filter[f] = doc[f] ?? null;
    ops.push({ updateOne: { filter, update: { $set: p.set } } });
    if (ops.length >= BATCH) await flush();
  }
  await flush();
  return stats;
}

function planUser(doc) {
  const set = {};
  const guard = ["email", "phone", "emailIdx"];
  let plain = false, stale = false;
  for (const field of ["email", "phone"]) {
    verify(doc[field], userField(doc._id, field));
    const s = state(doc[field]);
    if (s === "plain" || s === "stale") {
      const where = userField(doc._id, field);
      set[field] = encrypt(reveal(doc[field], where), where);
      plain ||= s === "plain";
      stale ||= s === "stale";
    }
  }
  // Blind index: (re)build if missing or made with another key.
  const email = reveal(doc.email, userField(doc._id, "email"));
  const idx = emailIndex(email);
  if (doc.emailIdx !== idx) {
    set.emailIdx = idx;
    if (doc.emailIdx) stale = true;
    else plain = true;
  }
  return { set: Object.keys(set).length ? set : null, guard, plain, stale };
}

function planMessage(doc) {
  verify(doc.body, messageField(doc._id));
  const s = state(doc.body);
  if (s !== "plain" && s !== "stale") return { set: null, guard: [] };
  const where = messageField(doc._id);
  return { set: { body: encrypt(reveal(doc.body, where), where) }, guard: ["body"], plain: s === "plain", stale: s === "stale" };
}

function planAccessKey(doc) {
  verify(doc.label, accessKeyField(doc._id));
  const s = state(doc.label);
  if (s !== "plain" && s !== "stale") return { set: null, guard: [] };
  const where = accessKeyField(doc._id);
  return { set: { label: encrypt(reveal(doc.label, where), where) }, guard: ["label"], plain: s === "plain", stale: s === "stale" };
}

/** What remains after the run. */
async function remaining() {
  const notEnc = { $not: /^v1:/ };
  const nonEmptyPlain = (field) => ({ [field]: { $exists: true, $nin: [null, ""], ...notEnc } });
  const users = await User.collection.countDocuments({
    $or: [nonEmptyPlain("email"), nonEmptyPlain("phone"), { emailIdx: { $exists: false } }, { emailIdx: null }],
  });
  const messages = await Message.collection.countDocuments(nonEmptyPlain("body"));
  const accessKeys = await AccessKey.collection.countDocuments(nonEmptyPlain("label"));
  const curPrefix = new RegExp(`^v1:(?!${currentKid()}:)`);
  const stale =
    (await User.collection.countDocuments({ $or: [{ email: curPrefix }, { phone: curPrefix }] })) +
    (await Message.collection.countDocuments({ body: curPrefix })) +
    (await AccessKey.collection.countDocuments({ label: curPrefix }));
  return { users, messages, accessKeys, stale };
}

async function hashStats() {
  const out = { argon2id: 0, scrypt: 0, unknown: 0 };
  for await (const u of User.collection.find({}, { projection: { passwordHash: 1 } })) out[hashKind(u.passwordHash)]++;
  return out;
}

async function main() {
  const { kid, previousKid } = loadKeys();
  console.log(`Key ${kid}${previousKid ? ` (previous ${previousKid})` : ""}. Mode: ${CHECK ? "check" : DRY ? "dry-run" : "migrate"}`);
  await connect({ attempts: 3 });
  if (!DRY) await User.syncIndexes(); // emailIdx partial unique index; drops the old email_1 index

  const users = await sweep(User, { email: 1, phone: 1, emailIdx: 1 }, planUser);
  const messages = await sweep(Message, { body: 1 }, planMessage);
  const accessKeys = await sweep(AccessKey, { label: 1 }, planAccessKey);
  for (const [name, s] of Object.entries({ users, messages, accessKeys })) {
    console.log(
      `${name}: ${s.plain} plaintext, ${s.stale} under old key` +
      (DRY ? "" : `, ${s.written} written, ${s.conflicts} changed concurrently (re-run), ${s.errors} errors`) +
      (DRY && s.errors ? `, ${s.errors} failed to decrypt` : ""),
    );
  }

  const left = DRY
    ? { users: users.plain, messages: messages.plain, accessKeys: accessKeys.plain, stale: users.stale + messages.stale + accessKeys.stale }
    : await remaining();
  const hashes = await hashStats();
  const errors = users.errors + messages.errors + accessKeys.errors;
  const result = {
    usersPlain: left.users,
    messagesPlain: left.messages,
    accessKeysPlain: left.accessKeys,
    staleKeyRows: left.stale,
    usersEncrypted: DRY ? 0 : users.written,
    messagesEncrypted: DRY ? 0 : messages.written,
    accessKeysEncrypted: DRY ? 0 : accessKeys.written,
    errors,
    scryptHashes: hashes.scrypt,
    argon2Hashes: hashes.argon2id,
    unknownHashes: hashes.unknown,
    keyId: kid,
    dryRun: DRY,
  };
  if (hashes.scrypt) console.log(`${hashes.scrypt} password(s) still scrypt: upgraded to Argon2id at each user's next sign-in.`);
  console.log(`MIGRATE_RESULT ${JSON.stringify(result)}`);

  const clean = !left.users && !left.messages && !left.accessKeys && !left.stale && !errors;
  return CHECK ? (clean ? 0 : 1) : errors ? 2 : 0;
}

main()
  .then(async (code) => {
    await mongoose.disconnect().catch(() => {});
    process.exit(code);
  })
  .catch(async (err) => {
    console.error("migrate failed:", err.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(2);
  });
