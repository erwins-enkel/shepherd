import { buildWrappedArgv } from "./herdr";
import { hostArgvBudget, joinedElementBytes, spawnFootprintBytes } from "./argv-limit";

/** What a caller hands over: how to build the spawn inputs for a given prompt. Everything else
 *  about the argv must be INVARIANT in `prompt` — that is what makes the O(1) measurement below
 *  exact rather than approximate. */
export type SpawnAssembler = (prompt: string) => {
  wrapped: string[];
  spawnEnv?: Record<string, string> | undefined;
};

export interface SpawnBudget {
  /** Bytes a single argv element may occupy; `Infinity` off Linux, where nothing is clamped. */
  budget: number;
  /** Bytes the spawn would cost with this prompt — measured on the FINAL argv. */
  measure: (prompt: string) => number;
}

/**
 * Price a prompt in the bytes it will actually cost at `execve` (issue #1944).
 *
 * Two traps this exists to close:
 *
 *  1. **`herdr.start` wraps the argv a SECOND time.** Callers hand it a membrane-wrapped argv and
 *     it applies `buildWrappedArgv` (the `env` shim, ~150–250+ bytes) on top — and on the 0.7.5
 *     `pane run` path all of that ends up inside ONE argv element. Measuring the pre-shim argv
 *     would leave the real spawn `shimBytes` over the limit: the fix reproducing the bug.
 *  2. **Quoting inflates the prompt.** `posixShellJoin` adds two quotes and turns each `'` into
 *     `'\''`; `sanitizePromptArg` turns each NUL into `\0`. `joinedElementBytes` prices all of it.
 *
 * The measurement is O(1) per call and EXACT, not an estimate: the assembled argv is identical for
 * every prompt except the one element carrying it, so the fixed overhead is measured once against
 * a zero-length prompt and the variable part is priced per call. `measure("") ===` the real
 * footprint of the real assembly, by construction — there is no headroom fudge factor anywhere.
 */
export function spawnBudget(assemble: SpawnAssembler): SpawnBudget {
  const footprint = (prompt: string): number => {
    const { wrapped, spawnEnv } = assemble(prompt);
    return spawnFootprintBytes(buildWrappedArgv(wrapped, spawnEnv));
  };
  const overhead = footprint("") - joinedElementBytes("");
  return {
    budget: hostArgvBudget(),
    measure: (prompt) => overhead + joinedElementBytes(prompt),
  };
}
