// Control-key palette for the mobile steering bar. Each entry maps a button to
// the raw byte sequence injected into the PTY (same path as term.onData).
// Single source of truth — append here to add keys, no structural change.

import { m } from "$lib/paraglide/messages";

// Visual grouping for the bar: keys in the same group sit together in one
// "well" (Gestalt common-region), with a wider gap between groups so a glance
// tells which keys belong together. "cancel" (Esc) is frozen on the left edge;
// edit/nav/signal scroll in the middle (see ControlBar usage in Viewport).
export type ControlGroup = "cancel" | "edit" | "nav" | "signal";

// Optional colour accent carrying meaning (used sparingly so it stays a signal):
// escape = the odd-one-out cancel key, danger = interrupts the process.
export type ControlTone = "escape" | "danger" | "enter";

export interface ControlKey {
  label: string; // visible button text
  aria: string; // accessible name
  seq: string; // exact bytes sent to the PTY
  group?: ControlGroup; // visual grouping (omit for the pinned Enter)
  tone?: ControlTone; // optional colour accent
}

// The control palette, ordered by group (Esc frozen left, the rest scroll in
// the middle). Enter is intentionally absent — it's the primary affirmative
// action and lives pinned in the thumb zone, see enterKey().
export function controlKeys(): ControlKey[] {
  return [
    { label: "Esc", aria: m.controlkey_escape(), seq: "\x1b", group: "cancel", tone: "escape" },
    { label: "Tab", aria: m.controlkey_tab(), seq: "\x09", group: "edit" },
    { label: "␣", aria: m.controlkey_space(), seq: " ", group: "edit" },
    { label: "←", aria: m.controlkey_arrow_left(), seq: "\x1b[D", group: "nav" },
    { label: "→", aria: m.controlkey_arrow_right(), seq: "\x1b[C", group: "nav" },
    { label: "↑", aria: m.controlkey_arrow_up(), seq: "\x1b[A", group: "nav" },
    { label: "↓", aria: m.controlkey_arrow_down(), seq: "\x1b[B", group: "nav" },
    { label: "^A", aria: m.controlkey_ctrl_a(), seq: "\x01", group: "signal" },
    { label: "^E", aria: m.controlkey_ctrl_e(), seq: "\x05", group: "signal" },
    { label: "^C", aria: m.controlkey_ctrl_c(), seq: "\x03", group: "signal", tone: "danger" },
    { label: "^D", aria: m.controlkey_ctrl_d(), seq: "\x04", group: "signal" },
  ];
}

// Enter is the most-pressed key in a terminal and the affirmative "do it" — it's
// pinned bottom-right (the easiest one-thumb reach zone) next to attach, outside
// the scrolling palette so it's always visible and never scrolls off.
export function enterKey(): ControlKey {
  return { label: "⏎", aria: m.controlkey_enter(), seq: "\x0d", tone: "enter" };
}
