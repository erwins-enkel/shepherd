// Pure helpers for the mobile compose bar. Kept out of the .svelte component so
// the input semantics are unit-testable without a DOM (matching the repo's
// pure-function test convention, e.g. controlKeys / pr-badge).

// Map a composed line to the bytes sent to the PTY. Empty → a bare CR (Enter
// passthrough, e.g. accept a y/n prompt). Otherwise wrap in bracketed-paste
// markers so multi-line content stays literal and the TUI ingests it atomically
// (same rationale as image-path injection), then a trailing CR submits.
export function composeKeystrokes(text: string): string {
  return text === "" ? "\r" : `\x1b[200~${text}\x1b[201~\r`;
}

// Insert a literal newline over [start, end) and report the new caret position.
export function insertNewlineAt(
  value: string,
  start: number,
  end: number,
): { value: string; caret: number } {
  return { value: value.slice(0, start) + "\n" + value.slice(end), caret: start + 1 };
}
