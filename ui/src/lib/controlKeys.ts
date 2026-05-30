// Control-key palette for the mobile steering bar. Each entry maps a button to
// the raw byte sequence injected into the PTY (same path as term.onData).
// Single source of truth — append here to add keys, no structural change.

export interface ControlKey {
  label: string; // visible button text
  aria: string; // accessible name
  seq: string; // exact bytes sent to the PTY
}

export const CONTROL_KEYS: ControlKey[] = [
  { label: "Esc", aria: "Escape", seq: "\x1b" },
  { label: "Tab", aria: "Tab", seq: "\x09" },
  { label: "←", aria: "Arrow left", seq: "\x1b[D" },
  { label: "→", aria: "Arrow right", seq: "\x1b[C" },
  { label: "↑", aria: "Arrow up", seq: "\x1b[A" },
  { label: "↓", aria: "Arrow down", seq: "\x1b[B" },
  { label: "^A", aria: "Ctrl A, start of line", seq: "\x01" },
  { label: "^E", aria: "Ctrl E, end of line", seq: "\x05" },
  { label: "^C", aria: "Ctrl C, interrupt", seq: "\x03" },
  { label: "^D", aria: "Ctrl D, end of file", seq: "\x04" },
];
