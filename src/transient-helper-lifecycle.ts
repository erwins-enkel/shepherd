import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeHelperScratch } from "./tmp-sweep";

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
