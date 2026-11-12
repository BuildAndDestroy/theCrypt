// Security audit log: one line per event on stdout, so `kubectl logs -c
// chat-api | grep AUDIT` shows who signed in, why a sign-in failed, and what
// admins changed.
//
//   AUDIT {"event":"login.fail","reason":"totp_missing","user":"6af6…","role":"admin","failures":4}
//
// Only account ids, roles and reason codes are logged — never emails, phone
// numbers, passwords, TOTP codes or secrets. Emails are encrypted at rest, and
// logs are not, so an email would leak there. Map an id to an account in the
// console's Users tab (or via the API). There is no client IP to log: over Tor
// every request comes from 127.0.0.1.
//
// The client still gets one generic "Invalid credentials" for every failure;
// the reason is for the operator only.

const id = (v) => (v === undefined || v === null ? undefined : String(v));

export function audit(event, fields = {}) {
  const entry = { event };
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    entry[k] = v instanceof Date ? v.toISOString() : typeof v === "object" ? id(v) : v;
  }
  console.log(`AUDIT ${JSON.stringify(entry)}`);
}
