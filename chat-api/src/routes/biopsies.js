// Biopsy countdowns: public read, operator set/reset, and the internal
// release check nginx consults before serving a dump.
import { Router } from "express";
import { BiopsyDeadline } from "../models/index.js";
import { PERMISSIONS } from "../lib/rbac.js";
import * as v from "../lib/validate.js";
import { requirePermission } from "../middleware/auth.js";
import { isReleased, listBiopsies, manifest, resetManifestCache } from "../lib/biopsies.js";

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
// nginx `auth_request` for /biopsy-N/files/*: 204 = serve, 403 = refuse
// (nginx turns that into a 404). Mounted outside /api, so nginx never
// proxies it publicly; the API itself listens on the Pod loopback only.
export const internalBiopsiesRouter = Router();
internalBiopsiesRouter.get("/biopsies/release", async (req, res) => {
  try {
    const m = /^\/biopsy-(\d{1,4})\/files\/[^/?]+(?:\?.*)?$/.exec(req.get("x-original-uri") ?? "");
    if (!m) return res.sendStatus(403);
    res.sendStatus((await isReleased(Number(m[1]))) ? 204 : 403);
  } catch (err) {
    console.error("release check failed:", err?.message);
    res.sendStatus(403); // fail closed
  }
});

// -------------------------------------------------------------- admin
export const adminBiopsiesRouter = Router();
adminBiopsiesRouter.use(requirePermission(PERMISSIONS.BIOPSIES_MANAGE));

function serializeAdmin(b) {
  return {
    n: b.n,
    title: b.title,
    archive: b.archive,
    defaultDeadline: iso(b.defaultDeadline),
    deadline: iso(b.deadline),
    overridden: b.overridden,
    updatedAt: b.updatedAt ? iso(b.updatedAt) : null,
    released: b.released,
  };
}

adminBiopsiesRouter.get("/", async (_req, res, next) => {
  try {
    resetManifestCache(); // the operator should always see the deployed manifest
    res.json({ now: iso(Date.now()), biopsies: (await listBiopsies()).map(serializeAdmin) });
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
adminBiopsiesRouter.post("/:n", async (req, res, next) => {
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
    const b = (await listBiopsies()).find((x) => x.n === n);
    res.json({ biopsy: serializeAdmin(b) });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/biopsies/:n/reset — back to the generated default.
adminBiopsiesRouter.post("/:n/reset", async (req, res, next) => {
  try {
    const n = await knownBiopsy(req);
    await BiopsyDeadline.deleteOne({ n });
    const b = (await listBiopsies()).find((x) => x.n === n);
    res.json({ biopsy: serializeAdmin(b) });
  } catch (err) {
    next(err);
  }
});
