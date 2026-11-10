// Abuse limits that work behind Tor, where every client is 127.0.0.1 and
// per-IP rate limiting would throttle all visitors as one.

// Password hashing is deliberately expensive (~32 MiB, ~100 ms on a Pi).
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
