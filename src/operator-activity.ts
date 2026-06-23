// Operator-activity seam: tracks the last time a human actually typed into a
// session's live PTY, so a future stage-and-apply guard can decide whether to
// hold an auto-steer behind an explicit "Apply" (issue #1022). This file lays
// only the seam — nothing consumes the read side yet.
//
// Lives in memory (no SQLite write per keystroke — that would hammer the single
// Bun event loop) and is deliberately non-durable: after a restart there is no
// recent keystroke, and "not busy" is the correct default.

/** A resize control frame (`\x00resize:<cols>:<rows>\n`, see ui/src/lib/pty.ts)
 *  travels the same PTY WebSocket as keystrokes and storms on mobile keyboard /
 *  URL-bar toggles. It is NOT operator typing, so it must not stamp the seam. */
const RESIZE_PREFIX = "\x00resize:";

/** True iff `frame` is genuine operator keystroke input (i.e. not a resize
 *  control frame). The only non-keystroke frame this WS carries is the resize
 *  frame above; everything else is real input. */
export function isOperatorKeystroke(frame: string): boolean {
  return !frame.startsWith(RESIZE_PREFIX);
}

/** Throttle window: at most one stamp per session per this many ms, so a fast
 *  typist can't turn the seam into a per-keystroke write storm. */
const THROTTLE_MS = 1000;

/**
 * Record that the operator typed into `id` at `now`, throttled to ~1/sec.
 * Returns true if the stamp was written, false if throttled (no-op). Callers
 * gate on isOperatorKeystroke() before calling this.
 */
export function stampOperatorKeystroke(map: Map<string, number>, id: string, now: number): boolean {
  if (now - (map.get(id) ?? 0) < THROTTLE_MS) return false;
  map.set(id, now);
  return true;
}

/** Last operator-keystroke timestamp for `id`, or undefined if none recorded.
 *  Read side of the seam — exported for the future guard (out of scope here),
 *  currently exercised only by the unit test. */
export function getLastOperatorKeystrokeAt(
  map: Map<string, number>,
  id: string,
): number | undefined {
  return map.get(id);
}
