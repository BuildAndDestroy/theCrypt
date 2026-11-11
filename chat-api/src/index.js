// The Crypt — operator chat API.
//
// Listens on the Pod loopback only (127.0.0.1:3000). nginx proxies /api/* to
// it; Tor reaches nginx. Nothing here is reachable from the cluster network.
import express from "express";
import mongoose from "mongoose";
import { attachUser, requireApiRequest } from "./middleware/auth.js";
import { authRouter } from "./routes/auth.js";
import { chatRouter } from "./routes/chat.js";
import { adminRouter } from "./routes/admin.js";
import { ensureAdmin } from "./bootstrap.js";
import { connect } from "./lib/db.js";
import { loadKeys, strict } from "./lib/fieldcrypto.js";
import { globalLimiter, userLimiter } from "./middleware/limits.js";
import { Message, User } from "./models/index.js";

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.LISTEN_HOST || "127.0.0.1";

// Field-encryption keys: a missing or malformed DATA_KEY stops the process
// before it touches the database.
try {
  const { kid, previousKid } = loadKeys();
  console.log(`Field encryption: key ${kid}${previousKid ? ` (+ previous ${previousKid})` : ""}, strict=${strict()}`);
} catch (err) {
  console.error("Fatal:", err.message);
  process.exit(1);
}

const app = express();
app.disable("x-powered-by");
app.disable("etag");
app.set("trust proxy", false);

// Liveness for the in-Pod probe. Not under /api, so nginx never exposes it.
app.get("/healthz", (_req, res) => {
  res.status(mongoose.connection.readyState === 1 ? 200 : 503).type("text/plain").send("ok");
});

const api = express.Router();
api.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
api.use(express.json({ limit: "16kb" }));
api.use(globalLimiter);   // whole-API ceiling, before any database work
api.use(requireApiRequest);
api.use(attachUser);
api.use(userLimiter);     // per signed-in user (anonymous calls share one bucket)
api.use("/auth", authRouter);
api.use("/chat", chatRouter);
api.use("/admin", adminRouter);
api.use((_req, res) => res.status(404).json({ error: "Not found" }));
app.use("/api", api);

// Never leak stack traces, paths or driver errors to the client.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err?.expose && err.status) return res.status(err.status).json({ error: err.message });
  if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON" });
  if (err?.type === "entity.too.large") return res.status(413).json({ error: "Too large" });
  console.error("Unhandled error:", err?.name, err?.message);
  res.status(500).json({ error: "Internal error" });
});

// Rows not yet migrated. In strict mode they can't be read (and the legacy
// admin row couldn't be found, so a duplicate would be created): refuse to
// start rather than run half-broken.
async function checkPlaintext() {
  const plain = { $not: /^v1:/ };
  const [u, m] = await Promise.all([
    User.exists({ email: mongoose.trusted(plain) }),
    Message.exists({ body: mongoose.trusted(plain) }),
  ]);
  if (!u && !m) return;
  if (strict()) {
    throw new Error(
      "unencrypted (pre-upgrade) rows found while STRICT_ENCRYPTION=true. " +
      "Deploy with STRICT_ENCRYPTION=false, run `node src/migrate.js`, then re-enable strict mode " +
      "(kubernetes/scripts/upgrade-encryption.sh does this).",
    );
  }
  console.warn("Unencrypted (pre-upgrade) rows found. Run: node src/migrate.js, then set STRICT_ENCRYPTION=true.");
}

async function main() {
  await connect();
  await mongoose.syncIndexes();
  await checkPlaintext();
  await ensureAdmin();
  app.listen(PORT, HOST, () => console.log(`chat-api listening on ${HOST}:${PORT}`));
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    await mongoose.disconnect().catch(() => {});
    process.exit(0);
  });
}
