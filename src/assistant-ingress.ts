/**
 * The agent-ingress key (audit F08, extended to every session by #3337). The agent ingress is
 * exempt from the operator's auth gate, and the per-session UUID in its paths rides the spawn's
 * argv and env, which any local user can read from `/proc/<pid>/cmdline`. So every ingress request
 * also needs `X-Shepherd-Ingress-Key: HMAC(key, sessionId)`. A session's `--settings` /
 * `--mcp-config` carry that header, so they reach claude as PATHS to 0600 files, never as argv
 * JSON. A `<id>.header` file beside them holds the full header line for curl's `-H @file`
 * (`SHEPHERD_INGRESS_HEADER_FILE`, #3370), so the key never reaches curl's argv; a `<id>.key` file
 * holds the bare key for agent skills that predate it (`SHEPHERD_INGRESS_KEY_FILE`).
 *
 * The Operator Assistant's files sit in `~/.shepherd/assistant-spawn/` (`config.assistantSpawnDir`),
 * task sessions' in `~/.shepherd/agent-spawn/` (`config.agentSpawnDir`). A sandboxed session sees
 * only its own four files (file-level RO binds). Rewritten on every spawn and resume (claude reads
 * them at startup), removed on archive.
 */
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { writePrivateFile } from "./browser-attach-config";
import type { BrowserTokenSigner } from "./browser-token";

export const ASSISTANT_INGRESS_HEADER = "x-shepherd-ingress-key";

/** Bump when the spawn files' shape changes so live sessions carrying the old one get resumed. */
const INGRESS_SPAWN_VERSION = 1;

/** The stamp a Claude spawn records (#3341): format version + a fingerprint of the ingress key, so
 *  a key rotation or a version bump marks every live session stale. The fingerprint is a hash of
 *  the HMAC of a constant — it identifies the key without being a usable ingress credential.
 *  No signer → null (every ingress call is refused anyway; a resume cannot help). */
export function ingressStamp(signer: Pick<BrowserTokenSigner, "sign"> | undefined): string | null {
  if (!signer) return null;
  const fp = createHash("sha256").update(signer.sign("ingress-stamp")).digest("hex").slice(0, 16);
  return `v${INGRESS_SPAWN_VERSION}:${fp}`;
}

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

interface IngressSpawnPaths {
  settings: string;
  mcpConfig: string;
  key: string;
  header: string;
}

export function ingressSpawnPaths(dir: string, sessionId: string): IngressSpawnPaths {
  if (!SAFE_SESSION_ID.test(sessionId)) throw new Error(`unsafe session id: ${sessionId}`);
  return {
    settings: join(dir, `${sessionId}.settings.json`),
    mcpConfig: join(dir, `${sessionId}.mcp.json`),
    key: join(dir, `${sessionId}.key`),
    header: join(dir, `${sessionId}.header`),
  };
}

/** Write whichever of the session's `--settings` / `--mcp-config` JSON, key and header is given
 *  (0600, 0700 dir); returns the paths the argv / env carry instead. */
export async function writeIngressSpawnFiles(
  dir: string,
  sessionId: string,
  content: { settings?: string; mcpConfig?: string; key?: string; header?: string },
): Promise<IngressSpawnPaths> {
  const paths = ingressSpawnPaths(dir, sessionId);
  if (content.settings !== undefined) await writePrivateFile(paths.settings, content.settings);
  if (content.mcpConfig !== undefined) await writePrivateFile(paths.mcpConfig, content.mcpConfig);
  if (content.key !== undefined) await writePrivateFile(paths.key, content.key);
  if (content.header !== undefined) await writePrivateFile(paths.header, content.header);
  return paths;
}

/** Best-effort removal; missing files are fine. */
export async function removeIngressSpawnFiles(dir: string, sessionId: string): Promise<void> {
  const paths = ingressSpawnPaths(dir, sessionId);
  await Promise.all(Object.values(paths).map((p) => rm(p, { force: true })));
}
