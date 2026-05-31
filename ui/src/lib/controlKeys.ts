// Control-key palette for the mobile steering bar. Each entry maps a button to
// the raw byte sequence injected into the PTY (same path as term.onData).
// Single source of truth — append here to add keys, no structural change.

import { m } from "$lib/paraglide/messages";

export interface ControlKey {
  label: string; // visible button text
  aria: string; // accessible name
  seq: string; // exact bytes sent to the PTY
}

export function controlKeys(): ControlKey[] {
  return [
    { label: "Esc", aria: m.controlkey_escape(), seq: "\x1b" },
    { label: "Tab", aria: m.controlkey_tab(), seq: "\x09" },
    { label: "⏎", aria: m.controlkey_enter(), seq: "\x0d" },
    { label: "←", aria: m.controlkey_arrow_left(), seq: "\x1b[D" },
    { label: "→", aria: m.controlkey_arrow_right(), seq: "\x1b[C" },
    { label: "↑", aria: m.controlkey_arrow_up(), seq: "\x1b[A" },
    { label: "↓", aria: m.controlkey_arrow_down(), seq: "\x1b[B" },
    { label: "^A", aria: m.controlkey_ctrl_a(), seq: "\x01" },
    { label: "^E", aria: m.controlkey_ctrl_e(), seq: "\x05" },
    { label: "^C", aria: m.controlkey_ctrl_c(), seq: "\x03" },
    { label: "^D", aria: m.controlkey_ctrl_d(), seq: "\x04" },
  ];
}
