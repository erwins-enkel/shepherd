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

/** Modifier keys that produce no input on their own — held Shift while reading
 *  output is not typing. */
const BARE_MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph"]);

/**
 * Count operator input that flows through xterm's helper textarea: keystrokes,
 * IME composition (mobile soft keyboards finalize this way — xterm's composition
 * helper emits data without a keydown), text paste (incl. middle-click primary
 * selection) and dropped text.
 *
 * `term.textarea` only exists once `term.open()` has run, so create the counter
 * after opening. Returns a disposer that removes every listener.
 */
export function createTypingCounter(term: Terminal, onInput: () => void): { destroy(): void } {
  const ta = term.textarea;
  if (!ta) return { destroy() {} };

  const onKeyDown = (e: KeyboardEvent) => {
    if (BARE_MODIFIERS.has(e.key)) return;
    onInput();
  };
  const bump = () => onInput();

  ta.addEventListener("keydown", onKeyDown);
  ta.addEventListener("input", bump);
  ta.addEventListener("compositionend", bump);
  ta.addEventListener("paste", bump);
  ta.addEventListener("drop", bump);

  return {
    destroy() {
      ta.removeEventListener("keydown", onKeyDown);
      ta.removeEventListener("input", bump);
      ta.removeEventListener("compositionend", bump);
      ta.removeEventListener("paste", bump);
      ta.removeEventListener("drop", bump);
    },
  };
}
