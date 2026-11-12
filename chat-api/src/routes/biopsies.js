// Biopsy countdowns: public read, operator set / reset, per-biopsy archive
// upload, and the internal download handler nginx hands every dump request to.
import { Router } from "express";
import { BiopsyDeadline } from "../models/index.js";
import { PERMISSIONS } from "../lib/rbac.js";
import * as v from "../lib/validate.js";
import { requirePermission } from "../middleware/auth.js";
import { isReleased, listBiopsies, manifest, resetManifestCache } from "../lib/biopsies.js";
import {
  archiveFor, archiveMap, deleteArchive, MAX_ARCHIVE_BYTES, openArchiveDownload, storeArchive, UploadError,
} from "../lib/archives.js";

const iso = (d) => new Date(d).toISOString();

// ------------------------------------------------------------- public
// GET /api/public/biopsies — what every visitor's countdown.js reads.
// `now` lets the page correct for a wrong client clock.
export const publicBiopsiesRouter = Router();
publicBiopsiesRouter.get("/biopsies", async (_req, res, next) => {
  try {
    const list = await listBiopsies();
    res.json({
      now: iso(Date.now()),
      biopsies: list.map((b) => ({ n: b.n, deadline: iso(b.deadline), released: b.released })),
    });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------- internal
// nginx hands every /biopsy-N/files/<file> request here (proxy_pass). This is
// the one place that decides locked-vs-released and default-vs-override:
//   locked or unknown  -> 404
//   released, default  -> X-Accel-Redirect to nginx's internal static dumps
//   released, override -> stream the uploaded archive from GridFS
// Mounted outside /api, so nginx never exposes it; the API listens on the Pod
// loopback only, and only nginx's internal locations reach it.
export async function downloadHandler(req, res) {
  try {
    const uri = req.get("x-original-uri") || req.originalUrl || "";
    const m = /^\/biopsy-(\d{1,4})\/files\/([A-Za-z0-9._-]+\.zip)(?:\?.*)?$/.exec(uri);
    if (!m) return res.sendStatus(404);
    const n = Number(m[1]);
    const requested = m[2];

    const b = (await manifest()).get(n);
    if (!b || !b.archive || requested !== b.archive) return res.sendStatus(404); // only the biopsy's own archive name
    if (!(await isReleased(n))) return res.sendStatus(404); // not published yet

    const override = await archiveFor(n);
    if (!override) {
      // Let nginx serve the generated default from the image (efficient, no body through Node).
      res.setHeader("X-Accel-Redirect", `/_dump_static/biopsy-${n}/${b.archive}`);
      return res.status(204).end();
    }

    res.setHeader("Content-Type", override.contentType || "application/zip");
    res.setHeader("Content-Length", String(override.size));
    res.setHeader("Content-Disposition", `attachment; filename="${b.archive}"`);
    res.setHeader("Cache-Control", "no-store");
    const stream = openArchiveDownload(override.gridId);
    stream.on("error", (err) => {
      console.error(`archive stream biopsy-${n}: ${err.message}`);
      if (!res.headersSent) res.sendStatus(404);
      else res.destroy();
    });
    stream.pipe(res);
  } catch (err) {
    console.error("download handler failed:", err?.message);
    if (!res.headersSent) res.sendStatus(404); // fail closed
  }
}

// -------------------------------------------------------------- admin
export const adminBiopsiesRouter = Router();
adminBiopsiesRouter.use(requirePermission(PERMISSIONS.BIOPSIES_READ));
const manageBiopsies = requirePermission(PERMISSIONS.BIOPSIES_MANAGE);

function serializeAdmin(b, upload) {
  return {
    n: b.n,
    title: b.title,
    defaultArchive: b.archive,     // generated default filename (served when no upload)
    defaultDeadline: iso(b.defaultDeadline),
    deadline: iso(b.deadline),
    overridden: b.overridden,      // deadline differs from the default
    updatedAt: b.updatedAt ? iso(b.updatedAt) : null,
    released: b.released,
    upload: upload
      ? { filename: upload.filename, size: upload.size, sha256: upload.sha256, uploadedAt: iso(upload.updatedAt ?? upload.createdAt) }
      : null,
  };
}

// One biopsy's admin view, after a change.
async function adminView(n) {
  const [b, upload] = await Promise.all([
    listBiopsies().then((l) => l.find((x) => x.n === n)),
    archiveFor(n),
  ]);
  return serializeAdmin(b, upload);
}

adminBiopsiesRouter.get("/", async (_req, res, next) => {
  try {
    resetManifestCache(); // the operator should always see the deployed manifest
    const [list, uploads] = await Promise.all([listBiopsies(), archiveMap()]);
    res.json({
      now: iso(Date.now()),
      maxUploadBytes: MAX_ARCHIVE_BYTES,
      biopsies: list.map((b) => serializeAdmin(b, uploads.get(b.n))),
    });
  } catch (err) {
    next(err);
  }
});

async function knownBiopsy(req) {
  const raw = String(req.params.n ?? "");
  if (!/^\d{1,4}$/.test(raw)) throw new v.ValidationError("n is not valid");
  const n = Number(raw);
  if (!(await manifest()).has(n)) {
    const err = new Error("Not found");
    err.status = 404;
    err.expose = true;
    throw err;
  }
  return n;
}

// Generous bounds: anything sane, nothing that overflows or is clearly a typo.
const MIN_DEADLINE = () => Date.now() - 10 * 365 * 86_400_000;
const MAX_DEADLINE = () => Date.now() + 5 * 365 * 86_400_000;

// POST /api/admin/biopsies/:n  {deadline: ISO-8601 with timezone}
adminBiopsiesRouter.post("/:n", manageBiopsies, async (req, res, next) => {
  try {
    const n = await knownBiopsy(req);
    const raw = v.text(req.body, "deadline", { max: 40 });
    // Require an explicit zone (Z or ±hh:mm) so nobody sets local time by accident.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
      throw new v.ValidationError("deadline must be ISO-8601 with a timezone, e.g. 2026-12-31T23:59:00Z");
    }
    const deadline = new Date(raw);
    const t = deadline.getTime();
    if (Number.isNaN(t) || t < MIN_DEADLINE() || t > MAX_DEADLINE()) {
      throw new v.ValidationError("deadline is out of range");
    }
    await BiopsyDeadline.updateOne(
      { n },
      { $set: { deadline, updatedBy: req.user._id } },
      { upsert: true },
    );
    res.json({ biopsy: await adminView(n) });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/biopsies/:n/reset — deadline back to the generated default.
adminBiopsiesRouter.post("/:n/reset", manageBiopsies, async (req, res, next) => {
  try {
    const n = await knownBiopsy(req);
    await BiopsyDeadline.deleteOne({ n });
    res.json({ biopsy: await adminView(n) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/biopsies/:n/archive — upload the leak archive served when the
// countdown expires (exercise / simulated content). Raw .zip body (not JSON),
// filename in X-Filename; replaces any previous upload. Still gated by the
// deadline, so it stays locked until then.
adminBiopsiesRouter.put("/:n/archive", manageBiopsies, async (req, res, next) => {
  try {
    const n = await knownBiopsy(req);
    await storeArchive({
      n,
      filename: req.get("x-filename"),
      contentType: req.get("content-type"),
      source: req,
      uploadedBy: req.user._id,
    });
    res.json({ biopsy: await adminView(n) });
  } catch (err) {
    if (err instanceof UploadError) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// DELETE /api/admin/biopsies/:n/archive — drop the upload (back to the default).
adminBiopsiesRouter.delete("/:n/archive", manageBiopsies, async (req, res, next) => {
  try {
    const n = await knownBiopsy(req);
    await deleteArchive(n);
    res.json({ biopsy: await adminView(n) });
  } catch (err) {
    next(err);
  }
});
