import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Session } from "./types";
import type { CapRow, CapStore, WindowKey } from "./usage-limits";

type NewSession = Omit<
  Session,
  | "id"
  | "desig"
  | "status"
  | "lastState"
  | "createdAt"
  | "updatedAt"
  | "archivedAt"
  | "model"
  | "claudeSessionId"
> & { model?: string | null; claudeSessionId?: string };

const COLS = `id, desig, name, prompt, repoPath, baseBranch, branch, worktreePath,
  isolated, herdrSession, herdrAgentId, claudeSessionId, model, status, lastState, createdAt, updatedAt, archivedAt`;

export class SessionStore implements CapStore {
  private db: Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.run(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, desig TEXT NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL,
      repoPath TEXT NOT NULL, baseBranch TEXT NOT NULL, branch TEXT,
      worktreePath TEXT NOT NULL, isolated INTEGER NOT NULL,
      herdrSession TEXT NOT NULL, herdrAgentId TEXT NOT NULL,
      claudeSessionId TEXT NOT NULL DEFAULT '',
      model TEXT, status TEXT NOT NULL, lastState TEXT NOT NULL,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, archivedAt INTEGER)`);
    // migrate older DBs that predate later columns
    const cols = this.db.query(`PRAGMA table_info(sessions)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === "model")) {
      this.db.run(`ALTER TABLE sessions ADD COLUMN model TEXT`);
    }
    if (!cols.some((c) => c.name === "claudeSessionId")) {
      this.db.run(`ALTER TABLE sessions ADD COLUMN claudeSessionId TEXT NOT NULL DEFAULT ''`);
    }
    this.db.run(`CREATE TABLE IF NOT EXISTS usage_caps (
      window TEXT PRIMARY KEY, cap REAL NOT NULL, resetAt INTEGER NOT NULL,
      pct INTEGER NOT NULL, scrapedAt INTEGER NOT NULL)`);
    // small key/value store for runtime-configurable settings (e.g. repoRoot)
    this.db.run(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  }

  // ── settings (key/value) ──────────────────────────────────────────────────
  getSetting(key: string): string | null {
    const r = this.db.query(`SELECT value FROM settings WHERE key = ?`).get(key) as {
      value: string;
    } | null;
    return r ? r.value : null;
  }

  setSetting(key: string, value: string): void {
    this.db.run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }

  create(input: NewSession): Session {
    const now = Date.now();
    const n = (this.db.query(`SELECT COUNT(*) AS c FROM sessions`).get() as { c: number }).c;
    const s: Session = {
      ...input,
      model: input.model ?? null,
      claudeSessionId: input.claudeSessionId ?? "",
      id: randomUUID(),
      desig: `TASK-${String(n + 1).padStart(2, "0")}`,
      status: "running",
      lastState: "idle",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    this.db.run(`INSERT INTO sessions (${COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
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
      s.claudeSessionId,
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

  // ── usage limit caps (CapStore) ──────────────────────────────────────────
  getCaps(): CapRow[] {
    return this.db
      .query(`SELECT window, cap, resetAt, pct, scrapedAt FROM usage_caps`)
      .all() as CapRow[];
  }

  putCap(row: CapRow): void {
    this.db.run(
      `INSERT INTO usage_caps (window, cap, resetAt, pct, scrapedAt) VALUES (?,?,?,?,?)
       ON CONFLICT(window) DO UPDATE SET cap=excluded.cap, resetAt=excluded.resetAt,
         pct=excluded.pct, scrapedAt=excluded.scrapedAt`,
      [row.window as WindowKey, row.cap, row.resetAt, row.pct, row.scrapedAt],
    );
  }

  private hydrate(r: any): Session {
    return { ...r, isolated: !!r.isolated, claudeSessionId: r.claudeSessionId ?? "" } as Session;
  }
}
