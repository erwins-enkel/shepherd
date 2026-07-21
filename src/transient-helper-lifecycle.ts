import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/** mkdtemp under the OS tmpdir with the helper's prefix (e.g. `"shepherd-namer-"`). */
export function makeHelperTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Best-effort recursive removal of a helper's throwaway tmpdir. */
export function cleanupHelperDir(cwd: string): void {
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
