export type SessionStatus = "running" | "idle" | "blocked" | "done" | "archived";

export interface RepoEntry {
  name: string;
  path: string;
  display: string;
  /** Most-recent session createdAt for this repo; undefined if never used. */
  lastUsedAt?: number;
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
  model: string | null;
  status: SessionStatus;
  lastState: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export type WsEvent =
  | { event: "session:new"; data: Session }
  | { event: "session:status"; data: { id: string; status: SessionStatus } }
  | { event: "session:archived"; data: { id: string } };

export interface CreateInput {
  repoPath: string;
  baseBranch: string;
  prompt: string;
  model: string | null;
}

/** Selectable claude model aliases; null = claude's own default. */
export const MODELS = ["opus", "sonnet", "haiku"] as const;
