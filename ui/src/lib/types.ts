export type SessionStatus = "running" | "idle" | "blocked" | "done" | "archived";

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
}
