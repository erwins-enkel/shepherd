/**
 * Tolerant JSON parsing + spawn-liveness helpers, shared by the recap (src/recap.ts) and
 * critic (src/critic-core.ts + src/review.ts) verdict-read paths.
 *
 * Both pipelines spawn an unattended `claude` that hand-authors a JSON verdict file. The agent
 * occasionally writes malformed JSON — most commonly a bare unescaped `"` inside a string value
 * (#822) — which a raw `JSON.parse` rejects. Before #822 such a file was indistinguishable from a
 * not-yet-written one, so the row sat in `generating` until the hard timeout, then failed with an
 * empty body even though the agent had produced a complete, correct summary.
 *
 * `tolerantParseJson` recovers that content via a strict-first parse with a `jsonrepair` fallback,
 * and reports whether repair was needed (`repaired`) — because a repaired parse is NOT trustworthy
 * on its own: jsonrepair will also "close up" a TRUNCATED partial write into a shape-valid but
 * incomplete object. Callers therefore trust a repaired parse only once the spawn has finished
 * (or the hard timeout fires), which `isSpawnWorking` answers.
 */
import { jsonrepair } from "jsonrepair";

export type TolerantParse =
  | { status: "ok"; value: unknown; repaired: boolean } // repaired=false ⇒ strict JSON.parse succeeded
  | { status: "unparseable" };

/**
 * Parse `text` as JSON, tolerating the malformed-but-recoverable cases the unattended verdict
 * spawns produce (unescaped inner quotes, trailing commas, …). Strict `JSON.parse` is tried first
 * (well-formed input pays zero repair cost and reports `repaired: false`); on failure the text is
 * run through `jsonrepair` and re-parsed (`repaired: true`); if that also fails the input is
 * genuinely irreparable and `{ status: "unparseable" }` is returned.
 */
export function tolerantParseJson(text: string): TolerantParse {
  try {
    return { status: "ok", value: JSON.parse(text), repaired: false };
  } catch {
    try {
      return { status: "ok", value: JSON.parse(jsonrepair(text)), repaired: true };
    } catch {
      return { status: "unparseable" };
    }
  }
}

/**
 * 3-way verdict-read result, generic over the parsed shape (recap: `unknown`; critic: `RawVerdict`).
 * Distinguishes a not-yet-written file (`absent`) from a present-but-unrecoverable one
 * (`unparseable`) so the finalize loop can fail fast on the latter without waiting out the timeout,
 * while still retrying a genuine partial write. `repaired` is carried through so a repaired parse
 * can be gated on spawn-completion (see module docstring).
 */
export type VerdictRead<T> =
  | { status: "absent" }
  | { status: "parsed"; value: T; repaired: boolean }
  | { status: "unparseable"; raw?: string };

/**
 * Is the verdict spawn at `cwd` still actively producing output? Only `agentStatus === "working"`
 * keeps us waiting; an agent that is gone (not in `agents`) or in any finished/settled state
 * (idle / done / blocked / unknown) is treated as no-longer-writing, so a repaired or unparseable
 * verdict can be acted on immediately rather than after the hard timeout.
 *
 * NOTE (residual race): `agentStatus` can briefly flicker to a non-`working` value *during* a
 * partial write, which would let the gate fire early — finalizing a truncated repaired parse as a
 * false success, or an unparseable partial as a premature failure. This is mitigated (strict parses
 * are never gated; the verdict file is normally written atomically; the still-`working` retry
 * shrinks the window) but not eliminated. The hard timeout in each finalize loop is the true
 * backstop.
 */
export function isSpawnWorking(
  agents: { cwd: string; agentStatus: string }[],
  cwd: string,
): boolean {
  const a = agents.find((x) => x.cwd === cwd);
  return !!a && a.agentStatus === "working";
}

/** What a verdict finalize-loop should do this tick. */
export type VerdictAction = "finalize-value" | "finalize-null" | "wait";

/**
 * Boot grace before an absent-verdict spawn may be fail-fasted as finished-without-output. Covers
 * the window where a freshly-spawned agent reads as not-yet-working with no verdict file yet (it
 * hasn't taken its first turn), which is indistinguishable from one that died at startup. Well under
 * both the recap (5 min) and critic (10 min) hard timeouts, so the timeout still backstops a spawn
 * that finishes within the grace.
 */
export const STARTUP_GRACE_MS = 60_000;

/**
 * Shared finalize-gate decision for the recap (src/recap.ts) and critic (src/review.ts) verdict
 * loops, given the 3-way read plus the spawn/timeout state:
 *   - strict parse      → "finalize-value" now (a complete document; unchanged behavior).
 *   - repaired parse    → "finalize-value" only once the spawn is finished (or timed out); else
 *                         "wait" — a repaired parse may be a truncated partial write jsonrepair
 *                         closed up, so it isn't trusted while the agent may still be writing.
 *   - unparseable       → "finalize-null" (fail fast) once finished (or timed out); else "wait".
 *   - absent            → "finalize-null" at the hard timeout, OR once the spawn has finished AND
 *                         the startup grace has elapsed (`graceElapsed`); else "wait". A spawn that
 *                         exits without ever writing the verdict (e.g. the agent died at startup —
 *                         no usable account) is finished-with-an-absent-file from its first tick;
 *                         #822 left this class to the hard timeout, so it sat "working" for the full
 *                         window. The grace gate reclaims that wait while still protecting a
 *                         slow-booting agent: before its first turn an agent reads as not-working
 *                         with no file yet, indistinguishable from a dead one, so we only fail-fast
 *                         once it's both finished AND past the boot grace. A genuinely-hung agent
 *                         (alive, mid-turn) reads `working` → not finished → still waits the timeout.
 */
export function decideVerdictAction(
  read: VerdictRead<unknown>,
  spawnFinished: boolean,
  timedOut: boolean,
  graceElapsed = false,
): VerdictAction {
  if (read.status === "parsed") {
    if (!read.repaired) return "finalize-value";
    return spawnFinished || timedOut ? "finalize-value" : "wait";
  }
  if (read.status === "unparseable") {
    return spawnFinished || timedOut ? "finalize-null" : "wait";
  }
  return timedOut || (spawnFinished && graceElapsed) ? "finalize-null" : "wait"; // absent
}
