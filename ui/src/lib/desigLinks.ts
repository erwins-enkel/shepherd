// Recognize session designations (TASK-31) inside a rendered terminal line so the Operator
// Assistant's terminal can linkify the ones naming a live herd session — a tap selects that
// session. Pure + co-located tests, like slashLinks.ts, so the recognizer stays render-agnostic.

export interface DesigLink {
  /** Char index of the token's first char in the line. */
  start: number;
  /** Char index one past the token's last char (exclusive). */
  end: number;
  /** The id of the live session the token names. */
  id: string;
}

// Desigs are `TASK-` + a zero-padded sequence number (server store.ts DESIG_PREFIX). Case-insensitive
// like the server's getByDesig; the boundaries keep the token from matching inside a longer word,
// a path segment ("shepherd/task-31") or a longer number ("TASK-311" never links TASK-31).
const TOKEN = /(?<![A-Za-z0-9_/-])TASK-\d+(?![A-Za-z0-9_-])/gi;

/** Index the live herd by upper-cased desig for {@link findDesigLinks}. */
export function desigIndex(
  sessions: readonly { id: string; desig: string }[],
): Map<string, string> {
  return new Map(sessions.map((s) => [s.desig.toUpperCase(), s.id]));
}

/** Every desig token in `line` that names a session in `live` (upper-cased desig → id). */
export function findDesigLinks(line: string, live: ReadonlyMap<string, string>): DesigLink[] {
  const links: DesigLink[] = [];
  if (live.size === 0) return links;
  for (const m of line.matchAll(TOKEN)) {
    const id = live.get(m[0].toUpperCase());
    if (id !== undefined) links.push({ start: m.index, end: m.index + m[0].length, id });
  }
  return links;
}
