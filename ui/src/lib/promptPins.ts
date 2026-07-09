// Pins the operator's own prompt to the top of the terminal, so a reader scrolled
// back through a long agent response can always see WHICH question produced it.
//
// There is no structured transcript to key off — the viewport is a live xterm.js
// grid fed raw PTY bytes (see Viewport.svelte). The one durable trace a prompt
// leaves is the agent's own echo of it into the scrollback. Claude Code commits
// each submitted prompt as a `❯ <text>` line at column 0, with hard-wrapped
// continuations indented two spaces:
//
//     ❯ Please explain in one short sentence why the sky appears blue, and also
//       mention Rayleigh scattering explicitly.
//
//     ● The sky appears blue because air molecules scatter shorter wavelengths…
//
// That shape is identical whether the operator typed the prompt or Shepherd
// bracket-pasted it as a steer, and it survives reload, pane re-attach and
// session switching — the buffer is the source of truth, so nothing has to be
// recorded at send time. Codex has no verified pattern yet, so it gets none and
// the feature stays dark for those sessions rather than guessing wrong.

import type { AgentProvider } from "./types";

/** Matches an agent's echo of an operator prompt; capture 1 is the text. */
const ECHO: Partial<Record<AgentProvider, RegExp>> = {
  // U+276F, then the separator. The committed echo uses a plain space while the live
  // input box happens to use U+00A0 — accept BOTH rather than lean on that quirk to
  // tell them apart, because a `\S` that silently rejects the box today would silently
  // start pinning half-typed text the day the agent switches it to a plain space. The
  // structural RULE guard below is the discriminator. The non-space first char still
  // rejects the *empty* box ("❯" with nothing after it).
  claude: /^❯[ \u00a0](\S.*)$/,
};

/** The agent draws its live input box between two full-width horizontal rules. That
 *  box's prompt row also begins with `❯` and carries whatever is being typed, so a
 *  `❯` line directly under a rule is the input box, never a submitted prompt. */
const RULE = /^─{3,}$/;

/** Continuation of a wrapped echo: the agent's own 2-space hanging indent. */
const CONT = /^ {2}(\S.*)$/;

/** How many continuation lines to fold into a pin's text. A pin renders on one
 *  truncated line collapsed and a few wrapped lines expanded; beyond this the
 *  extra text is never seen, so folding it only grows the string. */
const MAX_CONT_LINES = 4;

/** One operator prompt located in the terminal's normal buffer. */
export interface PromptPin {
  /** 0-based absolute index of the echo's first line in `buffer.normal`. */
  line: number;
  /** The prompt text, continuations folded in. */
  text: string;
}

/** True when this provider's prompt echo is known. Callers keep the affordance
 *  hidden otherwise — a wrong pin is worse than no pin. */
export function supportsPromptPins(provider: AgentProvider | null | undefined): boolean {
  return provider != null && ECHO[provider] != null;
}

/** Reads absolute line `i` of the buffer, or null past the end. */
export type LineReader = (i: number) => string | null;

/**
 * Scan `[0, end)` for this provider's prompt echoes. `end` spans the WHOLE normal
 * buffer — trimmed scrollback *and* the live screen rows (`baseY + rows`), not just
 * the committed scrollback: until a session has produced a screenful of output
 * nothing has scrolled at all (`baseY === 0`), and the newest prompt — the one most
 * worth pinning — is normally still on screen. The live input box is excluded
 * structurally instead (see RULE).
 *
 * Called on a debounce as output streams, and re-scanning from scratch each time
 * is deliberate: xterm trims the scrollback once it exceeds its limit, which
 * shifts every absolute line index down. A full rescan re-derives them from the
 * buffer's current truth instead of tracking the shift.
 */
export function scanPromptPins(
  provider: AgentProvider | null | undefined,
  end: number,
  readLine: LineReader,
): PromptPin[] {
  const echo = provider == null ? undefined : ECHO[provider];
  if (!echo) return [];
  // The agent pads rendered rows with real spaces, which xterm's trimRight does not
  // strip (it only drops never-written cells), so every row is trimmed here.
  const at = (i: number) => (readLine(i) ?? "").trimEnd();
  const pins: PromptPin[] = [];
  for (let i = 0; i < end; i++) {
    const m = echo.exec(at(i));
    if (!m) continue;
    if (i > 0 && RULE.test(at(i - 1))) continue; // the live input box, mid-typing
    const parts = [m[1]!.trimEnd()];
    // Fold the hanging-indent continuations. The agent separates the echo from
    // its answer with a blank line, so a non-continuation line ends the prompt.
    for (let j = i + 1; j < end && parts.length <= MAX_CONT_LINES; j++) {
      const cont = CONT.exec(at(j));
      if (!cont) break;
      parts.push(cont[1]!.trimEnd());
    }
    pins.push({ line: i, text: parts.join(" ") });
  }
  return pins;
}

export interface PinPosition {
  /** Absolute buffer line at the top of what the reader can see. */
  viewportY: number;
  /** Height of the viewport in lines, so the bottom visible row can be derived. */
  rows: number;
  /** The agent grabbed the wheel and repaints its own scrolled view, so xterm's
   *  viewport never moves and `viewportY` says nothing about where the reader is
   *  (see `agentOwnsScroll` in Viewport.svelte). */
  agentOwnsScroll: boolean;
  /** The reader is parked above the latest output. */
  scrolledUp: boolean;
}

export interface ResolvedPin {
  /** The prompt governing what the reader can see; null when none precedes it. */
  pin: PromptPin | null;
  /** We cannot know which prompt the reader is looking at. `pin` is null. */
  uncertain: boolean;
}

/**
 * The prompt governing the reader's position: the last one echoed at or above the
 * anchor row, which is the BOTTOM visible row when parked at the latest output and
 * the TOP visible row once the reader has scrolled back.
 *
 * The two anchors answer two different questions, and which one is being asked
 * depends entirely on `scrolledUp`:
 *
 *  • Parked at the bottom, the reader is watching the newest turn. `viewportY` equals
 *    `baseY`, yet that turn's echo sits *below* it among the screen rows — so a top
 *    anchor names the previous prompt, or, in a session under one screenful
 *    (`baseY === 0`), names nothing at all while the prompt and its answer are both
 *    plainly on screen. Anchor on the bottom row: the newest prompt asked.
 *
 *  • Scrolled back, the reader is reading down from the top of the view, and the bar
 *    is a sticky section header for it. Anchor on the top row. A bottom anchor here
 *    would label the top `rows - 1` lines of an older answer with the *next* prompt,
 *    the moment its echo crept onto the last visible row — the inverse of the bug the
 *    bottom anchor fixes.
 *
 * Note the two only ever disagree while an echo is visible on screen; once the reader
 * is deep inside one long answer, with no echo in the band, both name the same prompt.
 * That is the case the bar exists for.
 *
 * When the agent owns the scroll we genuinely cannot answer. xterm's viewport is
 * pinned to the bottom no matter where the agent has scrolled its own view, so
 * resolving against it would confidently name the *newest* prompt while the reader
 * stares at output from an old one. Say "unknown" instead of lying — but only once
 * they've actually scrolled up; sitting at the bottom, the newest prompt is right
 * either way. Callers must ALSO keep this away from the alternate screen, where the
 * pins index a different buffer entirely (see Viewport.svelte).
 */
export function resolvePinnedPrompt(pins: PromptPin[], pos: PinPosition): ResolvedPin {
  if (pos.agentOwnsScroll && pos.scrolledUp) return { pin: null, uncertain: true };
  const anchor = pos.scrolledUp ? pos.viewportY : pos.viewportY + pos.rows - 1;
  let found: PromptPin | null = null;
  for (const p of pins) {
    if (p.line > anchor) break; // pins are ascending by construction
    found = p;
  }
  return { pin: found, uncertain: false };
}
