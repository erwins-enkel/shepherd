import type { Terminal } from "@xterm/xterm";

// Operator-input origin detection for the ReviewInFlightBanner's escalation
// counter (issue #1022).
//
// The banner used to count xterm's `onData` frames, but onData is xterm's
// *outbound data* channel, not a typing signal: with mouse tracking on (Claude
// Code runs that way — see `agentOwnsScroll` in Viewport.svelte) every mouse
// move / click / drag / wheel is reported to the app as an escape sequence on
// that same channel, as are focus reports and the terminal's replies to app
// queries. Counting them made the banner claim "You're typing" whenever the
// pointer moved.
//
// So we count the *origin* instead of the payload: text can only enter xterm
// through its helper textarea, and every noise source above is synthesized
// inside xterm's own JS and never touches it. That excludes the noise by
// construction — no escape-sequence pattern matching, and no assumption about
// when xterm emits a frame relative to the DOM event that caused it.
//
// This covers only input that goes *through* xterm. Shepherd also injects
// operator input straight into the PTY (ComposeBar, the touch key bar, image
// paste, slash-command taps) — those call Viewport's bumpOperatorInput()
// directly, since they never reach this textarea.

/**
 * Count operator input that flows through xterm: keystrokes, IME composition,
 * text paste (incl. middle-click primary selection) and dropped text.
 *
 * Two signals, because neither covers the other:
 *
 *  - `term.onKey` for the keyboard. It fires only when a key actually RESOLVES TO
 *    INPUT for the PTY, which is the precision a raw `keydown` listener lacks:
 *    CapsLock, NumLock and locally-handled chords (Cmd/Ctrl+Shift+C to copy) put
 *    nothing into the terminal, and counting them would announce "You're typing"
 *    to someone who only copied a line of output. Keys that DO produce input —
 *    printable characters, Enter, arrows, F-keys, Ctrl+C — all fire it.
 *  - The textarea's `input` / `compositionend` / `paste` / `drop`, because those
 *    paths never reach `onKey`: a mobile soft keyboard finalizes through xterm's
 *    composition helper (no keydown at all), and paste/drop are not keys. This is
 *    why `onKey` alone was not usable as the signal.
 *
 * A key that both fires `onKey` and produces an `input` event would be counted
 * twice; that is harmless — the counter is monotonic and its consumer only asks
 * whether it went up.
 *
 * `term.textarea` only exists once `term.open()` has run, so create the counter
 * after opening. Returns a disposer that removes every listener.
 */
export function createTypingCounter(term: Terminal, onInput: () => void): { destroy(): void } {
  const keySub = term.onKey(() => onInput());

  const ta = term.textarea;
  if (!ta) return { destroy: () => keySub.dispose() };

  const bump = () => onInput();
  ta.addEventListener("input", bump);
  ta.addEventListener("compositionend", bump);
  ta.addEventListener("paste", bump);
  ta.addEventListener("drop", bump);

  return {
    destroy() {
      keySub.dispose();
      ta.removeEventListener("input", bump);
      ta.removeEventListener("compositionend", bump);
      ta.removeEventListener("paste", bump);
      ta.removeEventListener("drop", bump);
    },
  };
}
