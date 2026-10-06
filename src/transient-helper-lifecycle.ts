import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRepoRootTrusted } from "./claude-trust";
import { agentTmpDir, removeHelperScratch } from "./tmp-sweep";

/**
 * Shared plumbing for the synchronous block-and-clean transient helpers (verify-key /
 * namer / autopilot stop-classifier / prompt-recommend): each spawns a short-lived agent
 * in a throwaway tmpdir, polls for its output file, and reaps pane + dir in a `finally`.
 * The four copies were byte-identical and drifting apart is exactly how teardown leaks
 * recur (#1852, and #1135 → #1136 → #1147 before it) — so the pattern lives once, here.
 * Each helper keeps its injectable seams (`sleep` / `makeTmpDir` / `cleanup`); these are
 * only the shared defaults behind them.
 */

export const realSleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The root helper cwds are created under: the dedicated disk `agentTmpDir()` (created 0700 here;
 * tightened + trusted by {@link ensureHelperTmpRootTrusted}). Falls back to `os.tmpdir()` when the
 * agent tmpdir is disabled — that fallback is never chmodded or trusted. Both are in
 * `helperTmpRootCandidates()`, so the #2304 scratch reclaim covers either.
 */
export function helperTmpRoot(): string {
  return agentTmpDir() ?? tmpdir();
}

/** mkdtemp under {@link helperTmpRoot} with the helper's prefix (e.g. `"shepherd-namer-"`). */
export function makeHelperTmpDir(prefix: string): string {
  const root = helperTmpRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(root, prefix));
}

/** Only a real dir owned by us and writable by no one else may be trusted: Claude extends trust to
 *  every descendant, so trusting a shared root (`/tmp`) would let anyone plant a dir there whose
 *  `.claude/` settings or MCP config run unprompted. A dir we OWN that is merely group/other-writable
 *  (a umask-002 mkdir) is tightened rather than refused; one owned by anyone else is never touched.
 *  A sticky-bit dir is a shared tmp by construction (`/tmp` is ours when running as root) — refused
 *  untouched, never chmodded. */
function makePrivateDir(root: string): boolean {
  try {
    const st = lstatSync(root);
    if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o1000) !== 0) {
      return false;
    }
    if ((st.mode & 0o022) !== 0) chmodSync(root, st.mode & 0o7755);
    return (lstatSync(root).mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/**
 * Pre-accept Claude Code's workspace-trust dialog for the ROOT every {@link makeHelperTmpDir} cwd
 * lives under. Claude inherits trust from an ancestor dir, so one entry covers every helper run —
 * no per-run `.claude.json` entry. Without it a helper sits on "do you trust this folder?" in a
 * pane no one watches until its timeout: the namer silently kept heuristic names after a
 * `.claude.json` reset dropped the `/tmp` trust helpers had been relying on. Only the dedicated
 * `agentTmpDir()` is ever trusted: refuses (false) when it is disabled (helpers then fall back to
 * an untrusted `os.tmpdir()`), or a root we don't own, a sticky-bit dir or a symlink — the helpers
 * then still time out, but nothing shared is trusted or chmodded.
 */
export async function ensureHelperTmpRootTrusted(
  configPath: string,
  root: string | null = agentTmpDir(),
): Promise<boolean> {
  if (!root || !makePrivateDir(root)) return false;
  await ensureRepoRootTrusted(configPath, root);
  return true;
}

/**
 * Best-effort recursive removal of a helper's throwaway tmpdir, AND of the claude-side scratch dir
 * the helper's agent derived from that cwd (#2304) — claude mirrors its cwd into its own tmp root,
 * and removing only the cwd leaked that mirror forever.
 *
 * The scratch removal is async and deliberately `void`ed: this stays a synchronous
 * `(cwd: string) => void` so none of the injected `cleanup` seams in the six helpers change, and
 * an `rm -rf` never runs synchronously on the single Bun event loop. `removeHelperScratch` never
 * throws, so the floating promise needs no `.catch`.
 */
export function cleanupHelperDir(cwd: string): void {
  void removeHelperScratch(cwd);
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * The shared `finally` body: stop the helper's pane — closing its spawn-recorded tab,
 * see `herdr.stop` (#1852) — then clean its tmpdir. Both steps tolerate an already-dead
 * pane / missing dir; `terminalId`/`cwd` are null/empty when the run failed before the
 * corresponding resource existed.
 */
export async function reapHelperRun(
  herdr: { stop(terminalId: string): Promise<void> },
  terminalId: string | null,
  cwd: string | null,
  cleanup: (cwd: string) => void,
): Promise<void> {
  if (terminalId) {
    try {
      await herdr.stop(terminalId);
    } catch {
      /* best-effort */
    }
  }
  if (cwd) cleanup(cwd);
}
