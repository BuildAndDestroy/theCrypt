// MongoDB connection, shared by the server (index.js) and migrate.js.
import mongoose from "mongoose";
import { secret } from "./secrets.js";

// Either a full MONGODB_URI, or the parts. In Kubernetes the credentials are
// files from the mongo-auth Secret (MONGO_USERNAME_FILE / MONGO_PASSWORD_FILE).
// They are URL-encoded here, so any characters work.
export function mongoUri() {
  const uri = secret("MONGODB_URI");
  if (uri) return uri;
  const { MONGO_HOST, MONGO_DB = "thecrypt" } = process.env;
  const MONGO_USERNAME = secret("MONGO_USERNAME");
  const MONGO_PASSWORD = secret("MONGO_PASSWORD");
  if (!MONGO_HOST || !MONGO_USERNAME || !MONGO_PASSWORD) return null;
  const auth = `${encodeURIComponent(MONGO_USERNAME)}:${encodeURIComponent(MONGO_PASSWORD)}`;
  return `mongodb://${auth}@${MONGO_HOST}/${encodeURIComponent(MONGO_DB)}?authSource=${encodeURIComponent(MONGO_DB)}`;
}

// MONGO_TLS=true: TLS to mongod, server certificate verified against the
// private CA in MONGO_TLS_CA_FILE (hostname checking stays on).
export function mongoOptions() {
  const opts = { serverSelectionTimeoutMS: 10_000 };
  if (process.env.MONGO_TLS === "true") {
    const ca = process.env.MONGO_TLS_CA_FILE;
    if (!ca) throw new Error("MONGO_TLS=true needs MONGO_TLS_CA_FILE");
    Object.assign(opts, { tls: true, tlsCAFile: ca });
  }
  return opts;
}

// Reject {"$ne": ...}-style operator objects anywhere in a query filter.
// Operators the server builds itself are wrapped in mongoose.trusted().
mongoose.set("sanitizeFilter", true);
mongoose.set("strictQuery", true);

/** Connect, retrying while Mongo starts (up to ~2.5 min). */
export async function connect({ attempts = 30 } = {}) {
  const uri = mongoUri();
  if (!uri) throw new Error("Set MONGODB_URI, or MONGO_HOST + MONGO_USERNAME + MONGO_PASSWORD (+ MONGO_DB)");
  const opts = mongoOptions();
  for (let attempt = 1; ; attempt++) {
    try {
      await mongoose.connect(uri, opts);
      return;
    } catch (err) {
      console.error(`MongoDB connect failed (attempt ${attempt}): ${err.message}`);
      if (attempt >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}
