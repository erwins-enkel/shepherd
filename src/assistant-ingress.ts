/**
 * The Operator Assistant's ingress key (audit F08). The agent ingress is auth-exempt: for a task
 * session the per-session UUID in the path is the capability. That UUID rides the spawn argv
 * (`--mcp-config`, the `--settings` hook URLs), which any local user can read from
 * `/proc/<pid>/cmdline` — and the assistant's MCP endpoint runs operator actions. So the assistant
 * alone also needs `X-Shepherd-Ingress-Key: HMAC(key, sessionId)` on every ingress request, and
 * its `--settings` / `--mcp-config` reach claude as PATHS to 0600 files carrying that header, never
 * as argv JSON.
 *
 * The files sit in `~/.shepherd/assistant-spawn/` (`config.assistantSpawnDir`), not the assistant
 * dir: every assistant scope shares that dir, and a repo-scoped assistant must not read the global
 * one's key. Rewritten on every spawn and resume (claude reads them at startup), removed on archive.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { writePrivateFile } from "./browser-attach-config";

export const ASSISTANT_INGRESS_HEADER = "x-shepherd-ingress-key";

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

function spawnPaths(dir: string, sessionId: string): { settings: string; mcpConfig: string } {
  if (!SAFE_SESSION_ID.test(sessionId)) throw new Error(`unsafe session id: ${sessionId}`);
  return {
    settings: join(dir, `${sessionId}.settings.json`),
    mcpConfig: join(dir, `${sessionId}.mcp.json`),
  };
}

/** Write the assistant's `--settings` and `--mcp-config` JSON (0600, 0700 dir); returns the paths
 *  the argv carries instead. */
export async function writeAssistantSpawnFiles(
  dir: string,
  sessionId: string,
  content: { settings: string; mcpConfig: string },
): Promise<{ settings: string; mcpConfig: string }> {
  const paths = spawnPaths(dir, sessionId);
  await writePrivateFile(paths.settings, content.settings);
  await writePrivateFile(paths.mcpConfig, content.mcpConfig);
  return paths;
}

/** Best-effort removal; missing files are fine. */
export async function removeAssistantSpawnFiles(dir: string, sessionId: string): Promise<void> {
  const paths = spawnPaths(dir, sessionId);
  await Promise.all([rm(paths.settings, { force: true }), rm(paths.mcpConfig, { force: true })]);
}
