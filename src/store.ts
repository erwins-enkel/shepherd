import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Session } from "./types";

type NewSession = Omit<
  Session,
  "id" | "desig" | "status" | "lastState" | "createdAt" | "updatedAt" | "archivedAt" | "model"
> & { model?: string | null };

const COLS = `id, desig, name, prompt, repoPath, baseBranch, branch, worktreePath,
  isolated, herdrSession, herdrAgentId, model, status, lastState, createdAt, updatedAt, archivedAt`;

export class SessionStore {
  private db: Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.run(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, desig TEXT NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL,
      repoPath TEXT NOT NULL, baseBranch TEXT NOT NULL, branch TEXT,
      worktreePath TEXT NOT NULL, isolated INTEGER NOT NULL,
      herdrSession TEXT NOT NULL, herdrAgentId TEXT NOT NULL,
      model TEXT, status TEXT NOT NULL, lastState TEXT NOT NULL,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, archivedAt INTEGER)`);
    // migrate older DBs that predate the model column
    const cols = this.db.query(`PRAGMA table_info(sessions)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === "model")) {
      this.db.run(`ALTER TABLE sessions ADD COLUMN model TEXT`);
    }
  }

  create(input: NewSession): Session {
    const now = Date.now();
    const n = (this.db.query(`SELECT COUNT(*) AS c FROM sessions`).get() as { c: number }).c;
    const s: Session = {
      ...input,
      model: input.model ?? null,
      id: randomUUID(),
      desig: `UNIT-${String(n + 1).padStart(2, "0")}`,
      status: "running",
      lastState: "idle",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    this.db.run(`INSERT INTO sessions (${COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      s.id,
      s.desig,
      s.name,
      s.prompt,
      s.repoPath,
      s.baseBranch,
      s.branch,
      s.worktreePath,
      s.isolated ? 1 : 0,
      s.herdrSession,
      s.herdrAgentId,
      s.model,
      s.status,
      s.lastState,
      s.createdAt,
      s.updatedAt,
      s.archivedAt,
    ]);
    return s;
  }

  get(id: string): Session | null {
    const r = this.db.query(`SELECT ${COLS} FROM sessions WHERE id = ?`).get(id) as any;
    return r ? this.hydrate(r) : null;
  }

  list(opts?: { activeOnly?: boolean }): Session[] {
    const where = opts?.activeOnly ? `WHERE status != 'archived'` : ``;
    return (
      this.db.query(`SELECT ${COLS} FROM sessions ${where} ORDER BY createdAt`).all() as any[]
    ).map((r) => this.hydrate(r));
  }

  update(
    id: string,
    patch: Partial<Pick<Session, "status" | "lastState" | "branch" | "herdrAgentId">>,
  ) {
    const cur = this.get(id);
    if (!cur) return;
    const next = { ...cur, ...patch, updatedAt: Date.now() };
    this.db.run(
      `UPDATE sessions SET status=?, lastState=?, branch=?, herdrAgentId=?, updatedAt=? WHERE id=?`,
      [next.status, next.lastState, next.branch, next.herdrAgentId, next.updatedAt, id],
    );
  }

  /** Map of repoPath → most-recent session createdAt (across all sessions, incl. archived). */
  lastUsedByRepo(): Record<string, number> {
    const rows = this.db
      .query(`SELECT repoPath, MAX(createdAt) AS t FROM sessions GROUP BY repoPath`)
      .all() as { repoPath: string; t: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.repoPath] = r.t;
    return out;
  }

  archive(id: string) {
    const now = Date.now();
    this.db.run(`UPDATE sessions SET status='archived', archivedAt=?, updatedAt=? WHERE id=?`, [
      now,
      now,
      id,
    ]);
  }

  private hydrate(r: any): Session {
    return { ...r, isolated: !!r.isolated } as Session;
  }
}
