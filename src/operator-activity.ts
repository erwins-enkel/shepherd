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

/**
 * Frames this WS carries that nobody typed. The browser forwards everything xterm
 * emits, and with mouse tracking on (Claude Code runs that way) that includes a
 * report for every mouse move / click / drag / wheel, plus focus reports and the
 * terminal's replies to the app's own queries. Treating those as "the operator
 * typed" is wrong — it is the same defect that made the review banner claim
 * "You're typing" on mere pointer movement (issue #1022).
 *
 * Each alternative is anchored to its introducer and spelled out through its
 * terminator — no `.*` — so a reply cannot swallow real bytes batched after it in
 * the same frame. OSC accepts both terminators (BEL and ST).
 *
 * The client fixes the banner a better way (it counts input-origin DOM events, see
 * ui/src/lib/terminal-input.ts), which is not available here: the server sees only
 * bytes. One consequence is recorded and accepted — in an alt-buffer TUI that has
 * NOT negotiated wheel reporting (vim, less), xterm translates a wheel scroll into
 * `\x1b[A`/`\x1b[B`, byte-identical to a typed arrow key, so it still stamps here.
 * The seam has no read consumer yet, and those are the bytes the PTY genuinely
 * receives.
 */
const NON_TYPING = new RegExp(
  [
    "\\x1b\\[<\\d+;\\d+;\\d+[Mm]", // SGR (and SGR-pixels) mouse report
    "\\x1b\\[\\d+;\\d+;\\d+M", // urxvt (1015) mouse report
    "\\x1b\\[[IO]", // focus in / focus out
    "\\x1b\\[[?>]\\d*(?:;\\d+)*c", // Device Attributes reply
    "\\x1b\\[\\d+;\\d+R", // cursor-position (DSR) reply
    "\\x1b\\[\\?\\d+;\\d+\\$y", // DECRPM reply
    "\\x1b\\[\\d+;\\d+;\\d+t", // XTWINOPS report
    "\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)", // OSC reply (BEL- or ST-terminated)
    "\\x1bP[^\\x1b]*\\x1b\\\\", // DCS reply (XTGETTCAP, DECRQSS)
  ].join("|"),
  "g",
);

/** True iff `frame` is genuine operator input: not a resize control frame, and not
 *  purely terminal-generated chatter. A frame counts as typed if ANY byte survives
 *  stripping the known non-typing sequences — whitespace and control bytes included
 *  (a typed space, Enter or Ctrl-C is real input); only an empty residue is not. */
export function isOperatorKeystroke(frame: string): boolean {
  if (frame.startsWith(RESIZE_PREFIX)) return false;
  return frame.replace(NON_TYPING, "").length > 0;
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
