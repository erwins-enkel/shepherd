import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Session, ReviewVerdict } from "./types";
import type { CapRow, CapStore, WindowKey } from "./usage-limits";

export interface RepoConfig {
  criticEnabled: boolean;
}

export interface PushSubInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  locale?: string;
}
export interface StoredPushSub {
  endpoint: string;
  p256dh: string;
  auth: string;
  ua: string;
  locale: string;
  createdAt: number;
  cats: PushPrefs;
}

/** Which notification categories a device wants (per-subscription, all-on by default). */
export interface PushPrefs {
  agent: boolean;
  reviews: boolean;
  ci: boolean;
}

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
  | "readyToMerge"
> & { model?: string | null; claudeSessionId?: string };

const COLS = `id, desig, name, prompt, repoPath, baseBranch, branch, worktreePath,
  isolated, herdrSession, herdrAgentId, claudeSessionId, model, readyToMerge, status, lastState, createdAt, updatedAt, archivedAt`;

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
    if (!cols.some((c) => c.name === "readyToMerge")) {
      this.db.run(`ALTER TABLE sessions ADD COLUMN readyToMerge INTEGER NOT NULL DEFAULT 0`);
    }
    this.db.run(`CREATE TABLE IF NOT EXISTS usage_caps (
      window TEXT PRIMARY KEY, cap REAL NOT NULL, resetAt INTEGER NOT NULL,
      pct INTEGER NOT NULL, scrapedAt INTEGER NOT NULL)`);
    // small key/value store for runtime-configurable settings (e.g. repoRoot)
    this.db.run(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS repo_config (
      repoPath TEXT PRIMARY KEY, criticEnabled INTEGER NOT NULL DEFAULT 1,
      updatedAt INTEGER NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS reviews (
      sessionId TEXT PRIMARY KEY, headSha TEXT NOT NULL, decision TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
      url TEXT, updatedAt INTEGER NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
      ua TEXT NOT NULL DEFAULT '', locale TEXT NOT NULL DEFAULT 'en',
      catAgent INTEGER NOT NULL DEFAULT 1, catReviews INTEGER NOT NULL DEFAULT 1,
      catCi INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER NOT NULL)`);
    // migrate push tables that predate per-device locale (drives notification language)
    const pushCols = this.db.query(`PRAGMA table_info(push_subscriptions)`).all() as {
      name: string;
    }[];
    if (!pushCols.some((c) => c.name === "locale")) {
      this.db.run(`ALTER TABLE push_subscriptions ADD COLUMN locale TEXT NOT NULL DEFAULT 'en'`);
    }
    // migrate push tables that predate per-category selection (default: all categories on,
    // preserving the prior all-or-nothing behavior for existing devices)
    for (const col of ["catAgent", "catReviews", "catCi"]) {
      if (!pushCols.some((c) => c.name === col)) {
        this.db.run(`ALTER TABLE push_subscriptions ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 1`);
      }
    }
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

  // ── per-repo config (critic on/off) ───────────────────────────────────────
  getRepoConfig(repoPath: string): RepoConfig {
    const r = this.db
      .query(`SELECT criticEnabled FROM repo_config WHERE repoPath = ?`)
      .get(repoPath) as { criticEnabled: number } | null;
    return { criticEnabled: r ? !!r.criticEnabled : true }; // absent → enabled
  }

  setRepoConfig(repoPath: string, cfg: RepoConfig): void {
    this.db.run(
      `INSERT INTO repo_config (repoPath, criticEnabled, updatedAt) VALUES (?,?,?)
       ON CONFLICT(repoPath) DO UPDATE SET criticEnabled = excluded.criticEnabled,
         updatedAt = excluded.updatedAt`,
      [repoPath, cfg.criticEnabled ? 1 : 0, Date.now()],
    );
  }

  // ── web push subscriptions ────────────────────────────────────────────────
  putPushSub(sub: PushSubInput, ua: string): void {
    this.db.run(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, ua, locale, createdAt)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(endpoint) DO UPDATE SET
         p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua, locale = excluded.locale`,
      [sub.endpoint, sub.keys.p256dh, sub.keys.auth, ua, sub.locale ?? "en", Date.now()],
    );
  }

  deletePushSub(endpoint: string): void {
    this.db.run(`DELETE FROM push_subscriptions WHERE endpoint = ?`, [endpoint]);
  }

  listPushSubs(): StoredPushSub[] {
    const rows = this.db
      .query(
        `SELECT endpoint, p256dh, auth, ua, locale, catAgent, catReviews, catCi, createdAt
         FROM push_subscriptions`,
      )
      .all() as (Omit<StoredPushSub, "cats"> & {
      catAgent: number;
      catReviews: number;
      catCi: number;
    })[];
    return rows.map(({ catAgent, catReviews, catCi, ...rest }) => ({
      ...rest,
      cats: { agent: !!catAgent, reviews: !!catReviews, ci: !!catCi },
    }));
  }

  getPushPrefs(endpoint: string): PushPrefs | null {
    const r = this.db
      .query(`SELECT catAgent, catReviews, catCi FROM push_subscriptions WHERE endpoint = ?`)
      .get(endpoint) as { catAgent: number; catReviews: number; catCi: number } | null;
    return r ? { agent: !!r.catAgent, reviews: !!r.catReviews, ci: !!r.catCi } : null;
  }

  /** Update a device's category selection; false when no such subscription exists. */
  setPushPrefs(endpoint: string, prefs: PushPrefs): boolean {
    const { changes } = this.db.run(
      `UPDATE push_subscriptions SET catAgent = ?, catReviews = ?, catCi = ? WHERE endpoint = ?`,
      [prefs.agent ? 1 : 0, prefs.reviews ? 1 : 0, prefs.ci ? 1 : 0, endpoint],
    );
    return changes > 0;
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
      readyToMerge: false,
      status: "running",
      lastState: "idle",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    this.db.run(`INSERT INTO sessions (${COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
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
      s.readyToMerge ? 1 : 0,
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
    patch: Partial<
      Pick<Session, "name" | "status" | "lastState" | "branch" | "herdrAgentId" | "readyToMerge">
    >,
  ) {
    const cur = this.get(id);
    if (!cur) return;
    const next = { ...cur, ...patch, updatedAt: Date.now() };
    this.db.run(
      `UPDATE sessions SET name=?, status=?, lastState=?, branch=?, herdrAgentId=?, readyToMerge=?, updatedAt=? WHERE id=?`,
      [
        next.name,
        next.status,
        next.lastState,
        next.branch,
        next.herdrAgentId,
        next.readyToMerge ? 1 : 0,
        next.updatedAt,
        id,
      ],
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

  // ── critic reviews ─────────────────────────────────────────────────────────
  private hydrateReview(r: any): ReviewVerdict {
    return { ...r, url: r.url ?? undefined } as ReviewVerdict;
  }

  getReview(sessionId: string): ReviewVerdict | null {
    const r = this.db
      .query(
        `SELECT sessionId, headSha, decision, summary, body, url, updatedAt
              FROM reviews WHERE sessionId = ?`,
      )
      .get(sessionId) as any;
    return r ? this.hydrateReview(r) : null;
  }

  putReview(v: ReviewVerdict): void {
    this.db.run(
      `INSERT INTO reviews (sessionId, headSha, decision, summary, body, url, updatedAt)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(sessionId) DO UPDATE SET headSha=excluded.headSha, decision=excluded.decision,
         summary=excluded.summary, body=excluded.body, url=excluded.url, updatedAt=excluded.updatedAt`,
      [v.sessionId, v.headSha, v.decision, v.summary, v.body, v.url ?? null, v.updatedAt],
    );
  }

  dropReview(sessionId: string): void {
    this.db.run(`DELETE FROM reviews WHERE sessionId = ?`, [sessionId]);
  }

  snapshotReviews(): Record<string, ReviewVerdict> {
    const rows = this.db
      .query(`SELECT sessionId, headSha, decision, summary, body, url, updatedAt FROM reviews`)
      .all() as any[];
    const out: Record<string, ReviewVerdict> = {};
    for (const r of rows) out[r.sessionId] = this.hydrateReview(r);
    return out;
  }

  private hydrate(r: any): Session {
    return {
      ...r,
      isolated: !!r.isolated,
      readyToMerge: !!r.readyToMerge,
      claudeSessionId: r.claudeSessionId ?? "",
    } as Session;
  }
}
