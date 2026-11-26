/** Where the membrane's synced OAuth credential mirror lives (#4260) — pure, a leaf module so
 *  sandbox.ts can probe it without importing the sync loop (credential-mirror.ts). */

import { join } from "node:path";
import { shepherdRuntimeDir } from "./runtime-dir";

export function credentialMirrorRoot(): string {
  return shepherdRuntimeDir("membrane-creds");
}

/** The mirror file for `claudeDir` — whether it exists is the caller's question. The dir name is
 *  the path itself, base64url-encoded: injective, filename-safe, no hash. */
export function credentialMirrorPath(claudeDir: string, root = credentialMirrorRoot()): string {
  const id = Buffer.from(claudeDir).toString("base64url");
  return join(root, id, ".credentials.json");
}
