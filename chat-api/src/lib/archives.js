// Operator-uploaded leak archives, stored in GridFS (bucket "archives").
//
// These replace the generated default dump for a biopsy. They are exercise /
// simulated content for an authorised emulation, published only once the
// biopsy's deadline passes (routes/biopsies.js gates every download). We cap
// the size and require a ZIP so the console can't be used to host arbitrary
// large files, and stream in/out so a big file never sits in memory.
import crypto from "node:crypto";
import mongoose from "mongoose";
import { GridFSBucket } from "mongodb";
import { BiopsyArchive } from "../models/index.js";

export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024; // 64 MiB
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"

export class UploadError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.expose = true;
  }
}

function bucket() {
  return new GridFSBucket(mongoose.connection.db, { bucketName: "archives" });
}

// Keep a client-supplied name only as a tidy basename; the public URL never
// uses it (downloads serve at the biopsy's default filename).
export function safeArchiveName(input) {
  const base = String(input || "").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(-128);
  const name = base || "archive.zip";
  return /\.zip$/i.test(name) ? name : name + ".zip";
}

/**
 * Stream `req` into GridFS for biopsy `n`, enforcing the ZIP magic and size
 * cap. Replaces any existing archive for `n`. Returns the metadata doc.
 */
export async function storeArchive({ n, filename, contentType, source, uploadedBy }) {
  const id = new mongoose.Types.ObjectId();
  const hash = crypto.createHash("sha256");
  let size = 0;
  let checkedMagic = false;
  let aborted = null;

  const upload = bucket().openUploadStreamWithId(id, safeArchiveName(filename), {
    contentType: contentType || "application/zip",
  });

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
      if (size > MAX_ARCHIVE_BYTES) {
        return fail(new UploadError(`Archive exceeds the ${Math.floor(MAX_ARCHIVE_BYTES / (1024 * 1024))} MiB limit`));
      }
      hash.update(chunk);
    });
    source.on("error", fail);
    upload.on("error", fail);
    upload.on("finish", resolve);
    source.pipe(upload);
  });

  if (size === 0) {
    await bucket().delete(id).catch(() => {});
    throw new UploadError("Empty upload");
  }

  const doc = {
    filename: safeArchiveName(filename),
    size,
    sha256: hash.digest("hex"),
    contentType: contentType || "application/zip",
    gridId: id,
    uploadedBy,
  };
  const prev = await BiopsyArchive.findOneAndUpdate({ n }, { $set: doc }, { upsert: true });
  if (prev?.gridId) await bucket().delete(prev.gridId).catch(() => {}); // drop the old bytes
  return { n, ...doc };
}

/** Remove the override for biopsy `n` (back to the generated default). */
export async function deleteArchive(n) {
  const doc = await BiopsyArchive.findOneAndDelete({ n });
  if (!doc) return false;
  await bucket().delete(doc.gridId).catch(() => {});
  return true;
}

export function openArchiveDownload(gridId) {
  return bucket().openDownloadStream(gridId);
}

export async function archiveFor(n) {
  return BiopsyArchive.findOne({ n }).lean();
}

/** Map n -> archive meta, for listing. */
export async function archiveMap() {
  const all = await BiopsyArchive.find().lean();
  return new Map(all.map((a) => [a.n, a]));
}
