import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Root package.json version, read once at import. release-please bumps package.json, so this
 *  is the single source for "which Shepherd is this" (health endpoint, native client checks). */
export const SHEPHERD_VERSION: string = (() => {
  try {
    const raw = readFileSync(join(import.meta.dir, "..", "package.json"), "utf8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === "string" ? v : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
