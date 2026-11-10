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

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.LISTEN_HOST || "127.0.0.1";
// Either a full MONGODB_URI, or the parts (as Kubernetes injects them from the
// mongo-auth Secret) — credentials are URL-encoded here, so any characters work.
function mongoUri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;
  const { MONGO_HOST, MONGO_DB = "thecrypt", MONGO_USERNAME, MONGO_PASSWORD } = process.env;
  if (!MONGO_HOST || !MONGO_USERNAME || !MONGO_PASSWORD) return null;
  const auth = `${encodeURIComponent(MONGO_USERNAME)}:${encodeURIComponent(MONGO_PASSWORD)}`;
  return `mongodb://${auth}@${MONGO_HOST}/${encodeURIComponent(MONGO_DB)}?authSource=${encodeURIComponent(MONGO_DB)}`;
}
const MONGODB_URI = mongoUri();

if (!MONGODB_URI) {
  console.error("Set MONGODB_URI, or MONGO_HOST + MONGO_USERNAME + MONGO_PASSWORD (+ MONGO_DB)");
  process.exit(1);
}

// Reject {"$ne": ...}-style operator objects anywhere in a query filter.
// Operators the server builds itself are wrapped in mongoose.trusted().
mongoose.set("sanitizeFilter", true);
mongoose.set("strictQuery", true);

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
api.use(requireApiRequest);
api.use(attachUser);
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

async function main() {
  for (let attempt = 1; ; attempt++) {
    try {
      await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
      break;
    } catch (err) {
      console.error(`MongoDB connect failed (attempt ${attempt}): ${err.message}`);
      if (attempt >= 30) process.exit(1);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  await mongoose.syncIndexes();
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
