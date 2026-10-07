/**
 * Browser Attach config file (ADR 0001): how a session's token-bearing CDP URL reaches its agent
 * without ever touching argv. Env and argv of a spawned agent are both visible to other local
 * users (`/proc/<pid>/cmdline`: bwrap `--setenv`, herdr's env shim), so the URL lives in a 0600
 * JSON file `{"cdp": "<ws url>"}` and only its path rides the env. `agent-browser --config <path>`
 * reads it directly.
 *
 * The file sits in `~/.shepherd/browser-attach/<sessionId>.json` (`config.browserAttachDir`):
 * outside every working tree (never committed) and outside every path the sandbox membrane binds
 * (`$HOME` is a tmpfs there). A sandboxed session gets exactly its own file via a single-file RO
 * bind (`MembraneInputs.browserConfigFile`), so no session can read another's token — in
 * particular an autonomous session, which gets no file at all, cannot borrow a standard one's.
 * Async fs only — this runs on the server loop.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

/** `<dir>/<sessionId>.json`; throws on a non-path-safe session id. */
export function browserConfigPath(dir: string, sessionId: string): string {
  if (!SAFE_SESSION_ID.test(sessionId)) throw new Error(`unsafe session id: ${sessionId}`);
  return join(dir, `${sessionId}.json`);
}

/** Atomically (temp + rename) writes `{"cdp": cdpUrl}` with mode 0600 in a 0700 dir. */
export async function writeBrowserConfig(path: string, cdpUrl: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode only applies to dirs it creates; tighten a pre-existing one too.
  await chmod(dir, 0o700);
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify({ cdp: cdpUrl }), { mode: 0o600, flag: "wx" });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** Best-effort removal; a missing file is fine. */
export async function removeBrowserConfig(path: string): Promise<void> {
  await rm(path, { force: true });
}
