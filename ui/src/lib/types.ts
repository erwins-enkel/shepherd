export type SessionStatus = "running" | "idle" | "blocked" | "done" | "archived";

export interface RepoEntry {
  name: string;
  path: string;
  display: string;
  /** Most-recent session createdAt for this repo; undefined if never used. */
  lastUsedAt?: number;
}

export interface Settings {
  repoRoot: string;
  repoRootDisplay: string;
  remoteControlAtStartup: boolean;
}

export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListing {
  path: string;
  display: string;
  parent: string | null;
  entries: DirEntry[];
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  createdAt: number;
}

/** Subset of an Issue attached to a task by reference (body rides out-of-band). */
export interface IssueRef {
  number: number;
  url: string;
  title: string;
  body: string;
}
/** An installed slash command (skill or command file) surfaced in the New Task
 *  "Commands" tab; picking one seeds the prompt with `/<name> `. */
export interface SlashCommand {
  name: string;
  description: string;
  scope: "project" | "user";
}

export type BlockShape = "menu" | "yes-no" | "awaiting-input" | "stall";
export interface BlockOption {
  label: string;
  send: string;
}
export interface BlockReason {
  shape: BlockShape;
  options: BlockOption[];
  tail: string[];
}

export type ForgeKind = "github" | "gitea";
export type MergeMethod = "merge" | "squash" | "rebase";
export type ChecksState = "none" | "pending" | "success" | "failure";

export interface PrStatus {
  state: "none" | "open" | "merged" | "closed";
  number?: number;
  url?: string;
  title?: string;
  mergeable?: boolean | null;
  checks: ChecksState;
  deployConfigured: boolean;
  headSha?: string;
}

export type ReviewDecision = "changes_requested" | "commented" | "error";
export interface ReviewVerdict {
  sessionId: string;
  headSha: string;
  decision: ReviewDecision;
  summary: string;
  body: string;
  url?: string;
  updatedAt: number;
}
export interface RepoConfig {
  criticEnabled: boolean;
}

/** GET /api/sessions/:id/git payload: forge kind + current PR status. */
export interface GitState extends PrStatus {
  kind: ForgeKind;
}

export interface Session {
  id: string;
  desig: string;
  name: string;
  prompt: string;
  repoPath: string;
  baseBranch: string;
  branch: string | null;
  worktreePath: string;
  isolated: boolean;
  herdrSession: string;
  herdrAgentId: string;
  claudeSessionId: string;
  model: string | null;
  status: SessionStatus;
  lastState: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface SessionUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  messageCount: number;
  lastActivity: number | null;
  byModel: Record<string, number>;
}

export interface ActivityEntry {
  ts: number;
  tool: string;
  summary: string;
  status: "ok" | "error" | "pending";
}

export interface LimitWindow {
  pct: number;
  resetAt: number;
}
export interface UsageLimits {
  session5h: LimitWindow | null;
  week: LimitWindow | null;
  stale: boolean;
  calibratedAt: number | null;
}

export interface UpdateCommit {
  sha: string;
  subject: string;
}

export interface UpdateStatus {
  behind: number;
  current: string | null;
  latest: string | null;
  commits: UpdateCommit[];
  checkedAt: number;
  error?: string;
}

/** Live state of the detached deploy launched by an update apply. */
export type DeployPhase = "idle" | "running" | "done" | "failed";

export interface DeployState {
  phase: DeployPhase;
  exitCode: number | null;
  log: string;
}

/** Informational herdr-version update check (no auto-apply). */
export interface HerdrUpdateStatus {
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  notes: string | null;
  checkedAt: number;
  error?: string;
}

/** repoPath → emoji map for per-project icons. */
export type ProjectIcons = Record<string, string>;

// ── backlog ────────────────────────────────────────────────────────────────
export interface BacklogProject {
  path: string;
  display: string;
  slug: string | null;
  kind: "github" | "gitea";
  lastUsedAt?: number;
  openIssues: number | null;
  openPRs: number | null;
}
export interface BacklogPayload {
  pinnedPath: string | null;
  projects: BacklogProject[];
  totals: { openIssues: number; openPRs: number };
}

export type WsEvent =
  | { event: "session:new"; data: Session }
  | { event: "session:status"; data: { id: string; status: SessionStatus } }
  | { event: "session:archived"; data: { id: string } }
  | { event: "usage:limits"; data: UsageLimits }
  | { event: "session:block"; data: { id: string; block: BlockReason | null } }
  | { event: "session:git"; data: { id: string; git: GitState } }
  | { event: "update:status"; data: UpdateStatus }
  | { event: "herdr-update:status"; data: HerdrUpdateStatus }
  | { event: "herdr-update:log"; data: { line: string } }
  | { event: "project-icons:update"; data: ProjectIcons }
  | { event: "session:review"; data: { id: string; review: ReviewVerdict | null } }
  | { event: "session:reviewing"; data: { id: string; reviewing: boolean } };

export interface CreateInput {
  repoPath: string;
  baseBranch: string;
  prompt: string;
  model: string | null;
  images?: string[]; // absolute staging paths from /api/uploads
  issueRef?: IssueRef; // optional attached issue; body appended server-side
}

/** Selectable claude model aliases; null = claude's own default. */
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
