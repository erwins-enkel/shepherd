export type HerdrState = "idle" | "working" | "blocked" | "done" | "unknown";
export type SessionStatus = "running" | "idle" | "blocked" | "done" | "archived";

export interface Session {
  id: string;
  desig: string; // "TASK-07"
  name: string;
  prompt: string;
  repoPath: string;
  baseBranch: string;
  branch: string | null; // null when cwd fallback
  worktreePath: string;
  isolated: boolean;
  herdrSession: string;
  herdrAgentId: string; // herdr terminal_id (attach target)
  claudeSessionId: string; // pinned via `claude --session-id`; "" for pre-feature sessions

  model: string | null; // claude --model alias; null = claude's own default (no flag)
  readyToMerge: boolean; // manually-toggled "parked / done" flag; orthogonal to status
  status: SessionStatus;
  lastState: HerdrState;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

/**
 * A GitHub/Gitea issue attached to a task by reference. The body rides along
 * out-of-band into the agent's prompt argv (like images) so it never counts
 * against the 8000-char human-prompt guard.
 */
export interface IssueRef {
  number: number;
  url: string;
  title: string;
  body: string;
}

export interface CreateSessionInput {
  repoPath: string;
  baseBranch: string;
  prompt: string;
  model: string | null; // null = claude default (no --model flag)
  images: string[]; // absolute paths to staged uploads (may be empty)
  issueRef?: IssueRef; // optional attached issue; body appended out-of-band
}

/** Selectable claude model aliases; absent/"default" means no --model flag. */
export const MODELS = ["opus", "sonnet", "haiku"] as const;

export interface Steer {
  id: string;
  label: string;
  text: string;
}

// ── git diff review panel ──────────────────────────────────────────────────
export type DiffLineKind = "add" | "del" | "ctx";

export interface DiffLine {
  kind: DiffLineKind;
  content: string; // line text WITHOUT the leading +/-/space marker
  oldNo?: number; // 1-based line number on the old side (absent for adds)
  newNo?: number; // 1-based line number on the new side (absent for dels)
}

export interface DiffHunk {
  header: string; // the raw "@@ -a,b +c,d @@ …" line
  lines: DiffLine[];
}

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffFile {
  path: string; // new path ("/dev/null" side resolved away)
  oldPath?: string; // set only when renamed
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  truncated?: boolean; // hunks dropped because the file exceeded the line cap
  hunks: DiffHunk[]; // empty when binary or truncated
}

export interface DiffResult {
  base: string; // logical base branch, e.g. "main"
  baseRef: string; // ref actually diffed against, e.g. "origin/main" or "main"
  head: string | null; // session branch; null for non-isolated sessions
  fetchFailed: boolean; // true when `git fetch` failed and we fell back to local base
  truncated: boolean; // true when any file was truncated
  files: DiffFile[];
}

// ── herdr version update check (informational only) ─────────────────────────
export interface HerdrUpdateStatus {
  /** installed herdr version (from `herdr --version`); null if unknown */
  current: string | null;
  /** latest published version from herdr.dev; null on error */
  latest: string | null;
  /** true when latest > current; never true on error */
  updateAvailable: boolean;
  /** release notes (markdown-ish) for the latest version; null on error/none */
  notes: string | null;
  checkedAt: number;
  /** set when the check itself failed (binary missing / network); badge stays hidden */
  error?: string;
}

// ── critic-on-PR review verdict ─────────────────────────────────────────────
export type ReviewDecision = "changes_requested" | "commented" | "error";

export interface ReviewVerdict {
  sessionId: string;
  headSha: string; // PR head this verdict applies to
  decision: ReviewDecision;
  summary: string; // <=100 char one-liner for the badge tooltip
  body: string; // full markdown findings (seeds the steer-back)
  url?: string; // posted PR-review URL, when the host returns one
  updatedAt: number;
}
