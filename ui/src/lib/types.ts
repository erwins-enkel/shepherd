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
}
export interface TodoDoc {
  exists: boolean;
  content: string;
}

export type BlockShape = "menu" | "yes-no" | "awaiting-input";
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

export type WsEvent =
  | { event: "session:new"; data: Session }
  | { event: "session:status"; data: { id: string; status: SessionStatus } }
  | { event: "session:archived"; data: { id: string } }
  | { event: "usage:limits"; data: UsageLimits }
  | { event: "session:block"; data: { id: string; block: BlockReason | null } };

export interface CreateInput {
  repoPath: string;
  baseBranch: string;
  prompt: string;
  model: string | null;
  images?: string[]; // absolute staging paths from /api/uploads
}

/** Selectable claude model aliases; null = claude's own default. */
export const MODELS = ["opus", "sonnet", "haiku"] as const;
