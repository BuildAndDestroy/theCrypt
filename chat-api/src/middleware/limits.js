import rateLimit from "express-rate-limit";

// Abuse limits that work behind Tor, where every client is 127.0.0.1 and
// per-IP rate limiting would throttle all visitors as one.

// Password hashing is deliberately expensive (Argon2id: 64 MiB, ~0.3-0.5 s on a Pi).
// Cap how many run at once and how many may queue, so a flood of logins
// can't exhaust the Pod's memory/CPU; overflow gets a fast 503.
const MAX_CONCURRENT = 2;
const MAX_QUEUED = 20;
let running = 0;
const queue = [];

function release() {
  running--;
  const nextWaiter = queue.shift();
  if (nextWaiter) {
    running++;
    nextWaiter();
  }
}

export function limitHashing(_req, res, next) {
  const start = () => {
    res.once("close", release);
    next();
  };
  if (running < MAX_CONCURRENT) {
    running++;
    return start();
  }
  if (queue.length >= MAX_QUEUED) {
    return res.status(503).json({ error: "Busy. Try again shortly." });
  }
  queue.push(start);
}

// Request-rate limits (express-rate-limit). Keys are NOT client IPs — behind
// Tor every request comes from 127.0.0.1 — so:
//   * globalLimiter caps the whole API (protects the Pi from floods), and runs
//     before any database work;
//   * userLimiter gives each signed-in user their own budget, so one account
//     can't starve the rest; unauthenticated calls (sign-in, register) share
//     one bucket. Normal use (polling every 3-5 s) is ~20 requests/min.
// Tunable with RATE_LIMIT_GLOBAL / RATE_LIMIT_USER / RATE_LIMIT_ANON (per minute).

const perMinute = (name, fallback) => Number(process.env[name]) || fallback;
const busy = { error: "Too many requests. Try again shortly." };
const common = {
  windowMs: 60_000,
  standardHeaders: false,
  legacyHeaders: false,
  message: busy,
  // We never key on IP, so the IP-related sanity checks don't apply.
  validate: false,
};

export const globalLimiter = rateLimit({
  ...common,
  limit: perMinute("RATE_LIMIT_GLOBAL", 1200),
  keyGenerator: () => "global",
});

export const userLimiter = rateLimit({
  ...common,
  limit: (req) => (req.user ? perMinute("RATE_LIMIT_USER", 120) : perMinute("RATE_LIMIT_ANON", 300)),
  keyGenerator: (req) => (req.user ? `user:${req.user._id}` : "anon"),
});
