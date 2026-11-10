// Read a secret from a file (Kubernetes Secret volume) or, failing that, an
// environment variable. For NAME, a set NAME_FILE wins: its contents are used
// with one trailing newline stripped. Secret files keep credentials out of the
// process environment (/proc/<pid>/environ, crash dumps, child processes).
import { readFileSync } from "node:fs";

export function secret(name) {
  const file = process.env[`${name}_FILE`];
  if (file) {
    try {
      return readFileSync(file, "utf8").replace(/\r?\n$/, "") || undefined;
    } catch (err) {
      if (err.code === "ENOENT") return undefined; // optional key not present
      throw err;
    }
  }
  return process.env[name] || undefined;
}
