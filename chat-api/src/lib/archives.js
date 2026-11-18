// Operator uploads attached to a biopsy, stored in GridFS:
//   archive — the leak .zip that replaces the generated default (bucket "archives")
//   key     — the matching decryption key file served beside it (bucket "keys")
//
// Both are exercise / simulated content for an authorised emulation, published
// only once the biopsy's deadline passes (routes/biopsies.js gates every
// download). We cap the size (and require a ZIP for archives) so the console
// can't be used to host arbitrary files, and stream in/out so nothing large
// ever sits in memory.
import crypto from "node:crypto";
import mongoose from "mongoose";
import { GridFSBucket } from "mongodb";
import { BiopsyArchive, BiopsyKey } from "../models/index.js";

// Size cap, in MiB, from ARCHIVE_MAX_MB (default 10 GiB). nginx's
// client_max_body_size on the upload location (20g) is the hard ceiling above it.
const DEFAULT_MAX_MB = 10 * 1024;
function maxMb() {
  const raw = process.env.ARCHIVE_MAX_MB;
  if (raw === undefined || raw === "") return DEFAULT_MAX_MB;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 20 * 1024) {
    throw new Error(`ARCHIVE_MAX_MB must be an integer from 1 to 20480 (got "${raw}")`);
  }
  return n;
}
export const MAX_ARCHIVE_BYTES = maxMb() * 1024 * 1024;
export const MAX_KEY_BYTES = 1024 * 1024; // keys are small: a PEM, PGP block, or passphrase file

function fmtLimit(bytes) {
  if (bytes < 1024 * 1024) return `${Math.floor(bytes / 1024)} KiB`;
  const mib = bytes / (1024 * 1024);
  return mib >= 1024 ? `${+(mib / 1024).toFixed(2)} GiB` : `${mib} MiB`;
}
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"

// The two upload kinds. `zip` requires the ZIP magic and keeps a .zip name;
// a key is any small file, always served back as an opaque download.
const KINDS = {
  archive: { bucketName: "archives", model: BiopsyArchive, maxBytes: MAX_ARCHIVE_BYTES, zip: true, fallback: "archive.zip", contentType: "application/zip" },
  key:     { bucketName: "keys",     model: BiopsyKey,     maxBytes: MAX_KEY_BYTES,     zip: false, fallback: "decryption.key", contentType: "application/octet-stream" },
};
function kindOf(kind) {
  const k = KINDS[kind];
  if (!k) throw new Error(`unknown upload kind: ${kind}`);
  return k;
}

export class UploadError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.expose = true;
  }
}

function bucket(kind) {
  return new GridFSBucket(mongoose.connection.db, { bucketName: kindOf(kind).bucketName });
}

// Keep a client-supplied name only as a tidy basename; the public URL never
// uses it (downloads serve at the biopsy's default filename).
function safeName(input, fallback, requireZip) {
  const base = String(input || "").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(-128);
  const name = base || fallback;
  if (!requireZip) return name;
  return /\.zip$/i.test(name) ? name : name + ".zip";
}
export function safeArchiveName(input) {
  return safeName(input, "archive.zip", true);
}

/**
 * Stream `source` into GridFS as biopsy `n`'s `kind` upload ("archive" or
 * "key"), enforcing the size cap (and ZIP magic for archives). Replaces any
 * existing upload of that kind for `n`. Returns the metadata doc.
 */
export async function storeUpload(kind, { n, filename, contentType, source, uploadedBy }) {
  const k = kindOf(kind);
  const id = new mongoose.Types.ObjectId();
  const hash = crypto.createHash("sha256");
  const name = safeName(filename, k.fallback, k.zip);
  // Archives keep the browser's type (still application/zip by default); keys
  // are always stored and served opaque, whatever the operator's browser sent.
  const storedType = k.zip ? (contentType || k.contentType) : k.contentType;
  let size = 0;
  let checkedMagic = !k.zip; // only archives gate on magic bytes
  let aborted = null;

  const upload = bucket(kind).openUploadStreamWithId(id, name, { contentType: storedType });

  await new Promise((resolve, reject) => {
    const fail = (err) => {
      if (aborted) return;
      aborted = err;
      source.unpipe?.(upload);
      upload.abort().catch(() => {});
      reject(err);
    };
    source.on("data", (chunk) => {
      if (aborted) return;
      if (!checkedMagic) {
        checkedMagic = true;
        const head = chunk.subarray(0, 4);
        if (head.length < 4 || !head.equals(ZIP_MAGIC)) {
          return fail(new UploadError("Upload must be a .zip archive"));
        }
      }
      size += chunk.length;
      if (size > k.maxBytes) {
        return fail(new UploadError(`Upload exceeds the ${fmtLimit(k.maxBytes)} limit`));
      }
      hash.update(chunk);
    });
    source.on("error", fail);
    upload.on("error", fail);
    upload.on("finish", resolve);
    source.pipe(upload);
  });

  if (size === 0) {
    await bucket(kind).delete(id).catch(() => {});
    throw new UploadError("Empty upload");
  }

  const doc = { filename: name, size, sha256: hash.digest("hex"), contentType: storedType, gridId: id, uploadedBy };
  const prev = await k.model.findOneAndUpdate({ n }, { $set: doc }, { upsert: true });
  if (prev?.gridId) await bucket(kind).delete(prev.gridId).catch(() => {}); // drop the old bytes
  return { n, ...doc };
}

/** Remove biopsy `n`'s upload of `kind` (archive: back to the generated default). */
export async function deleteUpload(kind, n) {
  const doc = await kindOf(kind).model.findOneAndDelete({ n });
  if (!doc) return false;
  await bucket(kind).delete(doc.gridId).catch(() => {});
  return true;
}

export function openDownload(kind, gridId) {
  return bucket(kind).openDownloadStream(gridId);
}

export async function uploadFor(kind, n) {
  return kindOf(kind).model.findOne({ n }).lean();
}

/** Map n -> upload meta for `kind`, for listing. */
export async function uploadMap(kind) {
  const all = await kindOf(kind).model.find().lean();
  return new Map(all.map((a) => [a.n, a]));
}
