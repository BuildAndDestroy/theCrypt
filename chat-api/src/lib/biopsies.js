// Biopsy deadlines: the generated defaults (website/biopsies.json, written by
// tools/generate_biopsies.py) plus operator overrides (BiopsyDeadline).
//
// The manifest is fetched from nginx over the Pod loopback (WEBSITE_ORIGIN,
// default http://127.0.0.1:8080) and cached. If it can't be loaded, a biopsy
// with no override is treated as NOT released: the dump stays locked.
import { BiopsyDeadline } from "../models/index.js";

const ORIGIN = process.env.WEBSITE_ORIGIN || "http://127.0.0.1:8080";
const FRESH_MS = 60_000;       // re-read the manifest at most once a minute
const RETRY_MS = 10_000;       // after a failure, wait before trying again

let cache = { at: 0, failedAt: 0, list: null };

function parseManifest(json) {
  const list = Array.isArray(json?.biopsies) ? json.biopsies : [];
  const out = new Map();
  for (const b of list) {
    const n = Number(b?.n);
    const deadline = new Date(b?.deadline);
    if (!Number.isInteger(n) || n < 1 || n > 9999 || Number.isNaN(deadline.getTime())) continue;
    out.set(n, {
      n,
      title: typeof b.title === "string" ? b.title.slice(0, 200) : `Biopsy ${n}`,
      defaultDeadline: deadline,
      archive: b.archive && typeof b.archive.file === "string" ? b.archive.file : null,
    });
  }
  return out;
}

/** Map n -> {n, title, defaultDeadline, archive}. Never throws; may be empty. */
export async function manifest() {
  const now = Date.now();
  if (cache.list && now - cache.at < FRESH_MS) return cache.list;
  if (now - cache.failedAt < RETRY_MS) return cache.list ?? new Map();
  try {
    const res = await fetch(`${ORIGIN}/biopsies.json`, { signal: AbortSignal.timeout(3000), cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cache = { at: now, failedAt: 0, list: parseManifest(await res.json()) };
  } catch (err) {
    console.error(`biopsies.json: ${err.message} (dumps stay locked unless overridden)`);
    cache.failedAt = now;
  }
  return cache.list ?? new Map();
}

/** Every known biopsy with its effective deadline. */
export async function listBiopsies() {
  const [known, overrides] = await Promise.all([manifest(), BiopsyDeadline.find().lean()]);
  const byN = new Map(overrides.map((o) => [o.n, o]));
  const now = Date.now();
  return [...known.values()]
    .sort((a, b) => a.n - b.n)
    .map((b) => {
      const o = byN.get(b.n);
      const deadline = o ? o.deadline : b.defaultDeadline;
      return {
        ...b,
        deadline,
        overridden: Boolean(o),
        updatedAt: o?.updatedAt ?? null,
        released: deadline.getTime() <= now,
      };
    });
}

/**
 * Is biopsy n's dump downloadable now? Fail closed: unknown biopsy (no
 * manifest entry and no override) or an unreadable manifest => false.
 */
export async function isReleased(n) {
  const o = await BiopsyDeadline.findOne({ n }).lean();
  if (o) return o.deadline.getTime() <= Date.now();
  const b = (await manifest()).get(n);
  return b ? b.defaultDeadline.getTime() <= Date.now() : false;
}

/** For tests / the admin "reload" path. */
export function resetManifestCache() {
  cache = { at: 0, failedAt: 0, list: null };
}
