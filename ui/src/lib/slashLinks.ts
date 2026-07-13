// Recognize Claude slash-command tokens (/squad, /gsd-quick) inside a rendered
// terminal line so Viewport can linkify them — a tap pastes the command into Claude's
// live prompt. Pure + co-located tests so the recognizer is render-agnostic and
// reusable: the xterm link provider drives it today, and a DOM-chip fallback would
// reuse it unchanged if canvas link activation ever proves unworkable.

// Absolute-path first segments that read command-shaped but are filesystem paths in
// prose. Excluded from the speculative branch (B) so "/tmp", "/etc", "/usr" stay
// non-tappable. A name that IS an installed command still wins via branch (A).
const PATH_PREFIXES = new Set([
  "home",
  "root",
  "tmp",
  "etc",
  "var",
  "opt",
  "dev",
  "bin",
  "sbin",
  "usr",
  "lib",
  "lib64",
  "proc",
  "sys",
  "mnt",
  "media",
  "run",
  "boot",
  "srv",
]);

export interface CommandLink {
  /** Char index of the leading "/" in the line. */
  start: number;
  /** Char index one past the last char of the name (exclusive). */
  end: number;
  /** Command name without the leading slash, verbatim from the line. */
  name: string;
}

// Token = "/" + name. Captured broadly (incl. "_" and uppercase) because installed
// command names are built verbatim from skill/command dir names (server commands.ts)
// and can carry those — branch (A) membership must be able to see them. The name ends
// at the first char outside this class (whitespace, backtick, ")", "]", '"', ".", "/").
const TOKEN = /\/([A-Za-z][A-Za-z0-9:_-]*)/g;

// The canonical lowercase command shape eligible for speculative (B) linkifying.
const CANONICAL = /^[a-z][a-z0-9:-]*$/;

// Left boundary: char before "/" is line-start OR not alnum/":"/"."/"/". Excludes
// URLs ("http://" → "/" preceded by ":") and mid-word slashes ("a/foo").
function leftBoundaryOk(line: string, slash: number): boolean {
  const prev = slash > 0 ? line[slash - 1]! : "";
  return prev === "" || !/[A-Za-z0-9:./]/.test(prev);
}

// Right disambiguation on the FOLLOWING char (already outside the token): a "/" means
// a multi-segment path ("/home/moe"); a "." before an alnum means a file extension
// ("/foo.txt"). A trailing "." at a sentence end ("/squad.") is fine.
function rightBoundaryOk(line: string, end: number): boolean {
  const next = line[end] ?? "";
  if (next === "/") return false;
  if (next === "." && /[A-Za-z0-9]/.test(line[end + 1] ?? "")) return false;
  return true;
}

// Union: (A) a known installed command (case-insensitive — covers mixed-case/underscore
// names) OR (B) a canonical lowercase shape that is not an absolute-path prefix.
function nameOk(name: string, known: Set<string>): boolean {
  if (known.has(name.toLowerCase())) return true;
  return CANONICAL.test(name) && !PATH_PREFIXES.has(name);
}

/**
 * Find linkifiable slash-command tokens in a single rendered terminal line.
 *
 *   findCommandLinks("via /squad", new Set())      → [{ start: 4, end: 10, name: "squad" }]
 *   findCommandLinks("/home/moe/x", new Set())     → []   (followed by "/": path)
 *   findCommandLinks("/My_Skill", set(["my_skill"]))→ [{ ... name: "My_Skill" }] (A)
 */
export function findCommandLinks(
  line: string,
  known: Set<string>,
  provider: "claude" | "codex" = "claude",
): CommandLink[] {
  if (provider === "codex") return [];
  const out: CommandLink[] = [];
  for (const m of line.matchAll(TOKEN)) {
    const slash = m.index;
    const name = m[1]!;
    const end = slash + 1 + name.length;
    if (leftBoundaryOk(line, slash) && rightBoundaryOk(line, end) && nameOk(name, known)) {
      out.push({ start: slash, end, name });
    }
  }
  return out;
}
