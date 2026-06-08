import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Session, ReviewVerdict, Signal, SignalKind, Learning, LearningStatus } from "./types";
import type { CapRow, CapStore, WindowKey } from "./usage-limits";

/** Tolerantly parse the persisted findings JSON back to a string[] (never throws). */
function parseFindings(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === "string") : [];
  } catch {
    return [];
  }
}

/** Allowed learning status transitions (spec §3). Terminal states have no exits. */
const LEARNING_TRANSITIONS: Record<LearningStatus, LearningStatus[]> = {
  proposed: ["active", "dismissed"],
  active: ["promoted", "dismissed"],
  promoted: [],
  dismissed: [],
};

export interface RepoConfig {
  criticEnabled: boolean;
  /** Auto-feed critic findings back to the task agent until clean or the round cap. */
  autoAddressEnabled: boolean;
  learningsEnabled: boolean;
  /** Pre-PR autopilot loop: drive procedural gates, surface real questions, lead to a PR. */
  autopilotEnabled: boolean;
  /** Per-repo master switch for the self-draining work queue (default OFF). */
  autoDrainEnabled: boolean;
  /** Full-auto: when on, the merge train lands ready PRs instead of handing off. */
  autoMergeEnabled: boolean;
  /** Concurrency cap on auto-spawned agents for this repo (default 1). */
  maxAuto: number;
  /** Issue label that opts an issue in for auto-spawning (default "shepherd:auto"). */
  autoLabel: string;
  /** Pause auto-spawns when usage % is at or above this threshold (default 80). */
  usageCeilingPct: number;
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
  | "mergingSince"
  | "mergingTrainId"
  | "autopilotEnabled"
  | "autopilotStepCount"
  | "autopilotPaused"
  | "autopilotComplete"
  | "autopilotQuestion"
  | "autoMergeEnabled"
  | "autoMergeRebaseCount"
  | "autoMergeRebaseHead"
  | "auto"
  | "issueNumber"
> & {
  model?: string | null;
  claudeSessionId?: string;
  auto?: boolean;
  issueNumber?: number | null;
};

const COLS = `id, desig, name, prompt, repoPath, baseBranch, branch, worktreePath,
  isolated, herdrSession, herdrAgentId, claudeSessionId, model, readyToMerge, status, lastState,
  autopilotEnabled, autopilotStepCount, autopilotPaused, autopilotComplete, autopilotQuestion,
  autoMergeEnabled, autoMergeRebaseCount, autoMergeRebaseHead,
  auto, issueNumber,
  createdAt, updatedAt, archivedAt, mergingSince, mergingTrainId`;

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
      auto INTEGER NOT NULL DEFAULT 0, issueNumber INTEGER,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, archivedAt INTEGER)`);
    this.migrateSessionColumns();
    this.db.run(`CREATE TABLE IF NOT EXISTS usage_caps (
      window TEXT PRIMARY KEY, cap REAL NOT NULL, resetAt INTEGER NOT NULL,
      pct INTEGER NOT NULL, scrapedAt INTEGER NOT NULL)`);
    // small key/value store for runtime-configurable settings (e.g. repoRoot)
    this.db.run(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS repo_config (
      repoPath TEXT PRIMARY KEY, criticEnabled INTEGER NOT NULL DEFAULT 1,
      learningsEnabled INTEGER NOT NULL DEFAULT 1,
      autoDrainEnabled INTEGER NOT NULL DEFAULT 0,
      autoMergeEnabled INTEGER NOT NULL DEFAULT 0,
      maxAuto INTEGER NOT NULL DEFAULT 1,
      autoLabel TEXT NOT NULL DEFAULT 'shepherd:auto',
      usageCeilingPct INTEGER NOT NULL DEFAULT 80,
      updatedAt INTEGER NOT NULL)`);
    this.migrateRepoConfigColumns();
    this.db.run(`CREATE TABLE IF NOT EXISTS reviews (
      sessionId TEXT PRIMARY KEY, headSha TEXT NOT NULL, patchId TEXT NOT NULL DEFAULT '',
      decision TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
      findings TEXT NOT NULL DEFAULT '[]', addressRound INTEGER NOT NULL DEFAULT 0,
      addressCap INTEGER NOT NULL DEFAULT 3, errorRound INTEGER NOT NULL DEFAULT 0,
      seenNoteIds TEXT NOT NULL DEFAULT '[]',
      finalRoundPending INTEGER NOT NULL DEFAULT 0,
      finalRoundTimeoutMs INTEGER NOT NULL DEFAULT 900000,
      url TEXT, updatedAt INTEGER NOT NULL)`);
    this.migrateReviewColumns();
    this.db.run(`CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY, repoPath TEXT NOT NULL, sessionId TEXT,
      kind TEXT NOT NULL, payload TEXT NOT NULL, ts INTEGER NOT NULL)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS signals_repo_ts ON signals (repoPath, ts)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS learnings (
  id TEXT PRIMARY KEY, repoPath TEXT NOT NULL, rule TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL, evidenceCount INTEGER NOT NULL DEFAULT 0,
  ineffectiveCount INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, lastEvidenceAt INTEGER, promotedPrUrl TEXT,
  ineffectiveSignalIds TEXT NOT NULL DEFAULT '[]')`);
    this.db.run(`CREATE INDEX IF NOT EXISTS learnings_repo_status ON learnings (repoPath, status)`);
    this.migrateLearningsColumns();
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
      .query(
        `SELECT criticEnabled, autoAddressEnabled, learningsEnabled, autopilotEnabled,
                autoDrainEnabled, autoMergeEnabled, maxAuto, autoLabel, usageCeilingPct
         FROM repo_config WHERE repoPath = ?`,
      )
      .get(repoPath) as {
      criticEnabled: number;
      autoAddressEnabled: number;
      learningsEnabled: number;
      autopilotEnabled: number;
      autoDrainEnabled: number;
      autoMergeEnabled: number;
      maxAuto: number;
      autoLabel: string;
      usageCeilingPct: number;
    } | null;
    // absent → critic on, learnings on, auto-address off (the spendier loop is explicit opt-in)
    // drain fields default OFF / cap-1 / default-label / ceiling-80
    return {
      criticEnabled: r ? !!r.criticEnabled : true,
      autoAddressEnabled: r ? !!r.autoAddressEnabled : false,
      learningsEnabled: r ? !!r.learningsEnabled : true,
      autopilotEnabled: r ? !!r.autopilotEnabled : false,
      autoDrainEnabled: r ? !!r.autoDrainEnabled : false,
      autoMergeEnabled: r ? !!r.autoMergeEnabled : false,
      maxAuto: r ? r.maxAuto : 1,
      autoLabel: r ? r.autoLabel : "shepherd:auto",
      usageCeilingPct: r ? r.usageCeilingPct : 80,
    };
  }

  setRepoConfig(repoPath: string, cfg: RepoConfig): void {
    this.db.run(
      `INSERT INTO repo_config
         (repoPath, criticEnabled, autoAddressEnabled, learningsEnabled, autopilotEnabled,
          autoDrainEnabled, autoMergeEnabled, maxAuto, autoLabel, usageCeilingPct, updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(repoPath) DO UPDATE SET criticEnabled = excluded.criticEnabled,
         autoAddressEnabled = excluded.autoAddressEnabled,
         learningsEnabled = excluded.learningsEnabled,
         autopilotEnabled = excluded.autopilotEnabled,
         autoDrainEnabled = excluded.autoDrainEnabled,
         autoMergeEnabled = excluded.autoMergeEnabled,
         maxAuto = excluded.maxAuto,
         autoLabel = excluded.autoLabel,
         usageCeilingPct = excluded.usageCeilingPct,
         updatedAt = excluded.updatedAt`,
      [
        repoPath,
        cfg.criticEnabled ? 1 : 0,
        cfg.autoAddressEnabled ? 1 : 0,
        cfg.learningsEnabled ? 1 : 0,
        cfg.autopilotEnabled ? 1 : 0,
        cfg.autoDrainEnabled ? 1 : 0,
        cfg.autoMergeEnabled ? 1 : 0,
        cfg.maxAuto,
        cfg.autoLabel,
        cfg.usageCeilingPct,
        Date.now(),
      ],
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
      autopilotEnabled: null,
      autopilotStepCount: 0,
      autopilotPaused: false,
      autopilotComplete: false,
      autopilotQuestion: null,
      autoMergeEnabled: null,
      autoMergeRebaseCount: 0,
      autoMergeRebaseHead: null,
      auto: input.auto ?? false,
      issueNumber: input.issueNumber ?? null,
      status: "running",
      lastState: "idle",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      mergingSince: null,
      mergingTrainId: null,
    };
    this.db.run(
      `INSERT INTO sessions (${COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
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
        null, // autopilotEnabled — inherit repo default
        0, // autopilotStepCount
        0, // autopilotPaused
        0, // autopilotComplete
        null, // autopilotQuestion
        null, // autoMergeEnabled — inherit repo default
        0, // autoMergeRebaseCount
        null, // autoMergeRebaseHead — none outstanding
        s.auto ? 1 : 0,
        s.issueNumber,
        s.createdAt,
        s.updatedAt,
        s.archivedAt,
        s.mergingSince,
        s.mergingTrainId,
      ],
    );
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
      Pick<
        Session,
        | "name"
        | "status"
        | "lastState"
        | "branch"
        | "herdrAgentId"
        | "readyToMerge"
        | "mergingSince"
        | "mergingTrainId"
      >
    >,
  ) {
    const cur = this.get(id);
    if (!cur) return;
    const next = { ...cur, ...patch, updatedAt: Date.now() };
    this.db.run(
      `UPDATE sessions SET name=?, status=?, lastState=?, branch=?, herdrAgentId=?, readyToMerge=?, mergingSince=?, mergingTrainId=?, updatedAt=? WHERE id=?`,
      [
        next.name,
        next.status,
        next.lastState,
        next.branch,
        next.herdrAgentId,
        next.readyToMerge ? 1 : 0,
        next.mergingSince,
        next.mergingTrainId,
        next.updatedAt,
        id,
      ],
    );
  }

  /** Patch a session's autopilot fields. Only the provided keys are written. */
  setAutopilotState(
    id: string,
    patch: {
      enabled?: boolean | null;
      stepCount?: number;
      paused?: boolean;
      complete?: boolean;
      question?: string | null;
    },
  ): void {
    const cur = this.get(id);
    if (!cur) return;
    const enabled = patch.enabled === undefined ? cur.autopilotEnabled : patch.enabled;
    const stepCount = patch.stepCount ?? cur.autopilotStepCount;
    const paused = patch.paused ?? cur.autopilotPaused;
    const complete = patch.complete ?? cur.autopilotComplete;
    const question = patch.question === undefined ? cur.autopilotQuestion : patch.question;
    this.db.run(
      `UPDATE sessions SET autopilotEnabled=?, autopilotStepCount=?, autopilotPaused=?, autopilotComplete=?, autopilotQuestion=?, updatedAt=? WHERE id=?`,
      [
        enabled === null ? null : enabled ? 1 : 0,
        stepCount,
        paused ? 1 : 0,
        complete ? 1 : 0,
        question,
        Date.now(),
        id,
      ],
    );
  }

  /** Update full-auto merge fields. `enabled`: override (boolean|null). `rebaseCount`: absolute.
   *  `rebaseHead`: the head SHA last steered for (string), or null to clear. */
  setAutoMergeState(
    id: string,
    patch: { enabled?: boolean | null; rebaseCount?: number; rebaseHead?: string | null },
  ): void {
    const cur = this.get(id);
    if (!cur) return;
    const enabled = patch.enabled === undefined ? cur.autoMergeEnabled : patch.enabled;
    const rebaseCount =
      patch.rebaseCount === undefined ? cur.autoMergeRebaseCount : patch.rebaseCount;
    const rebaseHead = patch.rebaseHead === undefined ? cur.autoMergeRebaseHead : patch.rebaseHead;
    this.db.run(
      `UPDATE sessions SET autoMergeEnabled=?, autoMergeRebaseCount=?, autoMergeRebaseHead=?, updatedAt=? WHERE id=?`,
      [enabled === null ? null : enabled ? 1 : 0, rebaseCount, rebaseHead, Date.now(), id],
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
    return {
      ...r,
      patchId: r.patchId ?? "",
      findings: parseFindings(r.findings),
      addressRound: r.addressRound ?? 0,
      addressCap: r.addressCap ?? 3,
      errorRound: r.errorRound ?? 0,
      finalRoundPending: !!r.finalRoundPending,
      finalRoundTimeoutMs: r.finalRoundTimeoutMs ?? 900_000,
      seenNoteIds: parseFindings(r.seenNoteIds), // same string[] JSON shape as findings
      url: r.url ?? undefined,
    } as ReviewVerdict;
  }

  getReview(sessionId: string): ReviewVerdict | null {
    const r = this.db
      .query(
        `SELECT sessionId, headSha, patchId, decision, summary, body, findings, addressRound,
                addressCap, errorRound, finalRoundPending, finalRoundTimeoutMs, seenNoteIds, url, updatedAt
              FROM reviews WHERE sessionId = ?`,
      )
      .get(sessionId) as any;
    return r ? this.hydrateReview(r) : null;
  }

  putReview(v: ReviewVerdict): void {
    this.db.run(
      `INSERT INTO reviews (sessionId, headSha, patchId, decision, summary, body, findings, addressRound,
         addressCap, errorRound, finalRoundPending, finalRoundTimeoutMs, seenNoteIds, url, updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(sessionId) DO UPDATE SET headSha=excluded.headSha, patchId=excluded.patchId,
         decision=excluded.decision,
         summary=excluded.summary, body=excluded.body, findings=excluded.findings,
         addressRound=excluded.addressRound, addressCap=excluded.addressCap,
         errorRound=excluded.errorRound, finalRoundPending=excluded.finalRoundPending,
         finalRoundTimeoutMs=excluded.finalRoundTimeoutMs, seenNoteIds=excluded.seenNoteIds,
         url=excluded.url, updatedAt=excluded.updatedAt`,
      [
        v.sessionId,
        v.headSha,
        v.patchId ?? "",
        v.decision,
        v.summary,
        v.body,
        JSON.stringify(v.findings ?? []),
        v.addressRound ?? 0,
        v.addressCap ?? 3,
        v.errorRound ?? 0,
        v.finalRoundPending ? 1 : 0,
        v.finalRoundTimeoutMs ?? 900_000,
        JSON.stringify(v.seenNoteIds ?? []),
        v.url ?? null,
        v.updatedAt,
      ],
    );
  }

  dropReview(sessionId: string): void {
    this.db.run(`DELETE FROM reviews WHERE sessionId = ?`, [sessionId]);
  }

  /** Re-point an existing verdict at a new head without re-reviewing. Used when a head
   *  change (rebase/force-push) leaves the reviewed diff content-identical (same patchId):
   *  the prior decision/findings/rounds still apply, so only headSha + updatedAt move. */
  bumpReviewHead(sessionId: string, headSha: string, updatedAt: number): void {
    this.db.run(`UPDATE reviews SET headSha = ?, updatedAt = ? WHERE sessionId = ?`, [
      headSha,
      updatedAt,
      sessionId,
    ]);
  }

  snapshotReviews(): Record<string, ReviewVerdict> {
    const rows = this.db
      .query(
        `SELECT sessionId, headSha, patchId, decision, summary, body, findings, addressRound,
                addressCap, errorRound, finalRoundPending, finalRoundTimeoutMs, seenNoteIds, url, updatedAt FROM reviews`,
      )
      .all() as any[];
    const out: Record<string, ReviewVerdict> = {};
    for (const r of rows) out[r.sessionId] = this.hydrateReview(r);
    return out;
  }

  // ── learning signals ─────────────────────────────────────────────────────────
  addSignal(input: {
    repoPath: string;
    sessionId: string | null;
    kind: SignalKind;
    payload: string;
  }): Signal {
    const sig: Signal = {
      id: randomUUID(),
      repoPath: input.repoPath,
      sessionId: input.sessionId,
      kind: input.kind,
      payload: input.payload,
      ts: Date.now(),
    };
    this.db.run(
      `INSERT INTO signals (id, repoPath, sessionId, kind, payload, ts) VALUES (?,?,?,?,?,?)`,
      [sig.id, sig.repoPath, sig.sessionId, sig.kind, sig.payload, sig.ts],
    );
    return sig;
  }

  listSignals(repoPath: string, opts?: { sinceTs?: number; limit?: number }): Signal[] {
    const since = opts?.sinceTs ?? 0;
    const limit = opts?.limit ?? 1000;
    const rows = this.db
      .query(
        `SELECT id, repoPath, sessionId, kind, payload, ts FROM signals
         WHERE repoPath = ? AND ts >= ? ORDER BY ts DESC LIMIT ?`,
      )
      .all(repoPath, since, limit) as Signal[];
    return rows;
  }

  pruneSignals(beforeTs: number): number {
    const n = (
      this.db.query(`SELECT COUNT(*) AS c FROM signals WHERE ts < ?`).get(beforeTs) as { c: number }
    ).c;
    this.db.run(`DELETE FROM signals WHERE ts < ?`, [beforeTs]);
    return n;
  }

  /**
   * Delete archived sessions beyond the retention window — those older than `maxAgeMs`
   * OR ranked past the newest `keepNewest` (global, union: whichever evicts first). Only
   * `status = 'archived'` rows are eligible; live sessions are never touched. Each victim's
   * `reviews` row is cascaded in the same transaction so it can't orphan. `signals` are left
   * to their own prune. Age and rank both key off COALESCE(archivedAt, updatedAt, createdAt)
   * so legacy archived rows predating the `archivedAt` column still sort/expire correctly.
   * Returns the number of sessions removed.
   */
  pruneArchivedSessions(opts: { maxAgeMs: number; keepNewest: number }): number {
    const cutoff = Date.now() - opts.maxAgeMs;
    const rank = `COALESCE(archivedAt, updatedAt, createdAt)`;
    // Victim set expressed as a predicate (re-used by the count + both deletes) rather
    // than a bound id list — a large first sweep could otherwise exceed SQLite's 32766
    // bound-parameter cap. Each use carries the same two params (cutoff, keepNewest).
    const victims = `status = 'archived' AND (
        ${rank} < ?
        OR id NOT IN (
          SELECT id FROM sessions WHERE status = 'archived' ORDER BY ${rank} DESC LIMIT ?
        )
      )`;
    const params = [cutoff, opts.keepNewest];
    return this.db.transaction(() => {
      const n = (
        this.db.query(`SELECT COUNT(*) AS c FROM sessions WHERE ${victims}`).get(...params) as {
          c: number;
        }
      ).c;
      if (n === 0) return 0;
      // reviews first (keyed by sessionId) so the cascade can't orphan; the sessions
      // subquery still resolves the same set afterward (deleting reviews doesn't touch it).
      this.db.run(
        `DELETE FROM reviews WHERE sessionId IN (SELECT id FROM sessions WHERE ${victims})`,
        params,
      );
      this.db.run(`DELETE FROM sessions WHERE ${victims}`, params);
      return n;
    })();
  }

  // migrate reviews that predate the auto-address loop columns
  // migrate older DBs that predate later sessions columns
  private migrateSessionColumns(): void {
    const cols = this.db.query(`PRAGMA table_info(sessions)`).all() as { name: string }[];
    const add = (name: string, ddl: string) => {
      if (!cols.some((c) => c.name === name)) this.db.run(`ALTER TABLE sessions ADD COLUMN ${ddl}`);
    };
    add("model", `model TEXT`);
    add("claudeSessionId", `claudeSessionId TEXT NOT NULL DEFAULT ''`);
    add("readyToMerge", `readyToMerge INTEGER NOT NULL DEFAULT 0`);
    // nullable: NULL = inherit repo default, 0/1 = explicit per-session override
    add("autopilotEnabled", `autopilotEnabled INTEGER`);
    add("autopilotStepCount", `autopilotStepCount INTEGER NOT NULL DEFAULT 0`);
    add("autopilotPaused", `autopilotPaused INTEGER NOT NULL DEFAULT 0`);
    add("autopilotComplete", `autopilotComplete INTEGER NOT NULL DEFAULT 0`);
    add("autopilotQuestion", `autopilotQuestion TEXT`);
    add("autoMergeEnabled", `autoMergeEnabled INTEGER`);
    add("autoMergeRebaseCount", `autoMergeRebaseCount INTEGER NOT NULL DEFAULT 0`);
    add("autoMergeRebaseHead", `autoMergeRebaseHead TEXT`);
    add("auto", `auto INTEGER NOT NULL DEFAULT 0`);
    add("issueNumber", `issueNumber INTEGER`);
    add("mergingSince", `mergingSince INTEGER`);
    add("mergingTrainId", `mergingTrainId TEXT`);
  }

  // migrate repo_config that predates these opt-in columns. auto-address defaults
  // OFF (the spendier loop — existing repos opt in explicitly); learnings defaults ON.
  private migrateRepoConfigColumns(): void {
    const cols = this.db.query(`PRAGMA table_info(repo_config)`).all() as { name: string }[];
    const add = (name: string, ddl: string) => {
      if (!cols.some((c) => c.name === name))
        this.db.run(`ALTER TABLE repo_config ADD COLUMN ${ddl}`);
    };
    add("autoAddressEnabled", `autoAddressEnabled INTEGER NOT NULL DEFAULT 0`);
    add("learningsEnabled", `learningsEnabled INTEGER NOT NULL DEFAULT 1`);
    add("autopilotEnabled", `autopilotEnabled INTEGER NOT NULL DEFAULT 0`);
    add("autoDrainEnabled", `autoDrainEnabled INTEGER NOT NULL DEFAULT 0`);
    add("autoMergeEnabled", `autoMergeEnabled INTEGER NOT NULL DEFAULT 0`);
    add("maxAuto", `maxAuto INTEGER NOT NULL DEFAULT 1`);
    add("autoLabel", `autoLabel TEXT NOT NULL DEFAULT 'shepherd:auto'`);
    add("usageCeilingPct", `usageCeilingPct INTEGER NOT NULL DEFAULT 80`);
  }

  private migrateReviewColumns(): void {
    const cols = this.db.query(`PRAGMA table_info(reviews)`).all() as { name: string }[];
    const add = (name: string, ddl: string) => {
      if (!cols.some((c) => c.name === name)) this.db.run(`ALTER TABLE reviews ADD COLUMN ${ddl}`);
    };
    add("findings", `findings TEXT NOT NULL DEFAULT '[]'`);
    add("addressRound", `addressRound INTEGER NOT NULL DEFAULT 0`);
    // addressCap's DEFAULT 3 only backfills pre-#247 rows; every live row carries
    // ReviewService's actual cap, so the literal here is a one-time migration value, not
    // an ongoing mirror. errorRound/seenNoteIds back the error-escalation + note dedup.
    add("addressCap", `addressCap INTEGER NOT NULL DEFAULT 3`);
    add("errorRound", `errorRound INTEGER NOT NULL DEFAULT 0`);
    add("seenNoteIds", `seenNoteIds TEXT NOT NULL DEFAULT '[]'`);
    // patchId backs rebase-skip: pre-existing rows backfill to '' (unknown), so the
    // next head change reviews once and records the fingerprint going forward.
    add("patchId", `patchId TEXT NOT NULL DEFAULT ''`);
    add("finalRoundPending", `finalRoundPending INTEGER NOT NULL DEFAULT 0`);
    // 900000ms = 15min; one-time backfill for pre-existing rows, not an ongoing mirror —
    // live rows carry ReviewService's DEFAULT_FINAL_ROUND_TIMEOUT_MS.
    add("finalRoundTimeoutMs", `finalRoundTimeoutMs INTEGER NOT NULL DEFAULT 900000`);
  }

  // ── learnings ─────────────────────────────────────────────────────────────
  /** Add columns laid after the original `learnings` table for existing DBs.
   *  Idempotent: each column is only added when PRAGMA shows it absent. */
  private migrateLearningsColumns(): void {
    const cols = this.db.query(`PRAGMA table_info(learnings)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === "promotedPrUrl")) {
      this.db.run(`ALTER TABLE learnings ADD COLUMN promotedPrUrl TEXT`);
    }
    // Signal ids already counted toward each rule's ineffectiveCount. Without this
    // the daily re-distill over the rolling 60-day window would re-increment the
    // same rule from the same stale signals every run, inflating "Not working (N)".
    if (!cols.some((c) => c.name === "ineffectiveSignalIds")) {
      this.db.run(
        `ALTER TABLE learnings ADD COLUMN ineffectiveSignalIds TEXT NOT NULL DEFAULT '[]'`,
      );
    }
  }

  private hydrateLearning(r: any): Learning {
    return {
      id: r.id,
      repoPath: r.repoPath,
      rule: r.rule,
      rationale: r.rationale,
      evidence: JSON.parse(r.evidence) as string[],
      status: r.status as LearningStatus,
      evidenceCount: r.evidenceCount,
      ineffectiveCount: r.ineffectiveCount,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      lastEvidenceAt: r.lastEvidenceAt,
      promotedPrUrl: r.promotedPrUrl ?? null,
    };
  }

  addLearning(input: {
    repoPath: string;
    rule: string;
    rationale: string;
    evidence: string[];
  }): Learning {
    const now = Date.now();
    const l: Learning = {
      id: randomUUID(),
      repoPath: input.repoPath,
      rule: input.rule,
      rationale: input.rationale,
      evidence: input.evidence,
      status: "proposed",
      evidenceCount: input.evidence.length,
      ineffectiveCount: 0,
      createdAt: now,
      updatedAt: now,
      lastEvidenceAt: input.evidence.length ? now : null,
      promotedPrUrl: null,
    };
    this.db.run(
      `INSERT INTO learnings
         (id, repoPath, rule, rationale, evidence, status, evidenceCount, ineffectiveCount, createdAt, updatedAt, lastEvidenceAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        l.id,
        l.repoPath,
        l.rule,
        l.rationale,
        JSON.stringify(l.evidence),
        l.status,
        l.evidenceCount,
        l.ineffectiveCount,
        l.createdAt,
        l.updatedAt,
        l.lastEvidenceAt,
      ],
    );
    return l;
  }

  listLearnings(repoPath: string, opts?: { status?: LearningStatus }): Learning[] {
    const rows = opts?.status
      ? this.db
          .query(
            `SELECT * FROM learnings WHERE repoPath = ? AND status = ? ORDER BY updatedAt DESC`,
          )
          .all(repoPath, opts.status)
      : this.db
          .query(`SELECT * FROM learnings WHERE repoPath = ? ORDER BY updatedAt DESC`)
          .all(repoPath);
    return (rows as any[]).map((r) => this.hydrateLearning(r));
  }

  /** Active + promoted rules for a repo, for prompt injection (spec §4a). Oldest-updated first. */
  listActiveLearnings(repoPath: string): Learning[] {
    const rows = this.db
      .query(
        `SELECT * FROM learnings WHERE repoPath = ? AND status IN ('active','promoted')
         ORDER BY updatedAt ASC`,
      )
      .all(repoPath);
    return (rows as any[]).map((r) => this.hydrateLearning(r));
  }

  /** Distinct repoPaths that have ≥1 active/promoted (injectable) rule, for the
   *  cross-repo injectable sweep (GET /api/learnings/injectable). */
  listRepoPathsWithInjectableLearnings(): string[] {
    const rows = this.db
      .query(`SELECT DISTINCT repoPath FROM learnings WHERE status IN ('active','promoted')`)
      .all() as { repoPath: string }[];
    return rows.map((r) => r.repoPath);
  }

  getLearning(id: string): Learning | null {
    const r = this.db.query(`SELECT * FROM learnings WHERE id = ?`).get(id) as any;
    return r ? this.hydrateLearning(r) : null;
  }

  setLearningStatus(id: string, status: LearningStatus, rule?: string): Learning | null {
    const cur = this.getLearning(id);
    if (!cur) return null;
    if (!LEARNING_TRANSITIONS[cur.status].includes(status)) return null;
    this.db.run(`UPDATE learnings SET status = ?, rule = ?, updatedAt = ? WHERE id = ?`, [
      status,
      rule ?? cur.rule,
      Date.now(),
      id,
    ]);
    return this.getLearning(id);
  }

  /** Bump ineffectiveCount for an active/promoted rule (self-audit, spec §5) by the
   *  number of `signalIds` not already counted against it, recording them so a later
   *  re-distill over the same rolling window can't re-count the same evidence. A
   *  no-op (returns null) for proposed/dismissed/missing rules, or when every cited
   *  signal was already counted — keeping "Not working (N)" honest. */
  incrementLearningIneffective(id: string, signalIds: string[]): Learning | null {
    const cur = this.getLearning(id);
    if (!cur || (cur.status !== "active" && cur.status !== "promoted")) return null;
    const row = this.db
      .query(`SELECT ineffectiveSignalIds FROM learnings WHERE id = ?`)
      .get(id) as { ineffectiveSignalIds?: string } | null;
    const counted = new Set(parseFindings(row?.ineffectiveSignalIds));
    const fresh = signalIds.filter((s) => typeof s === "string" && s && !counted.has(s));
    if (fresh.length === 0) return null;
    for (const s of fresh) counted.add(s);
    this.db.run(
      `UPDATE learnings SET ineffectiveCount = ineffectiveCount + ?, ineffectiveSignalIds = ?, updatedAt = ? WHERE id = ?`,
      [fresh.length, JSON.stringify([...counted]), Date.now(), id],
    );
    return this.getLearning(id);
  }

  /** active → promoted, recording the CLAUDE.md PR url (spec §4b). Returns null
   *  when the rule is missing or not in a state that allows promotion. */
  promoteLearning(id: string, prUrl: string): Learning | null {
    const cur = this.getLearning(id);
    if (!cur || !LEARNING_TRANSITIONS[cur.status].includes("promoted")) return null;
    this.db.run(
      `UPDATE learnings SET status = 'promoted', promotedPrUrl = ?, updatedAt = ? WHERE id = ?`,
      [prUrl, Date.now(), id],
    );
    return this.getLearning(id);
  }

  pendingLearningCount(): number {
    return (
      this.db.query(`SELECT COUNT(*) AS c FROM learnings WHERE status = 'proposed'`).get() as {
        c: number;
      }
    ).c;
  }

  listPendingLearnings(): Learning[] {
    const rows = this.db
      .query(`SELECT * FROM learnings WHERE status = 'proposed' ORDER BY updatedAt DESC`)
      .all();
    return (rows as any[]).map((r) => this.hydrateLearning(r));
  }

  /** Resolve cited evidence signal ids to their full rows (newest first), for the
   *  drawer's "where did this come from" view. Ids that no longer resolve (pruned
   *  signals) are silently dropped, so the result can be shorter than `ids`. Empty
   *  in, empty out. */
  getSignalsByIds(ids: string[]): Signal[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db
      .query(
        // rowid tiebreak keeps newest-inserted first when two signals share a ms.
        `SELECT id, repoPath, sessionId, kind, payload, ts FROM signals
         WHERE id IN (${placeholders}) ORDER BY ts DESC, rowid DESC`,
      )
      .all(...ids) as Signal[];
  }

  private hydrate(r: any): Session {
    return {
      ...r,
      isolated: !!r.isolated,
      readyToMerge: !!r.readyToMerge,
      claudeSessionId: r.claudeSessionId ?? "",
      autopilotEnabled:
        r.autopilotEnabled === null || r.autopilotEnabled === undefined
          ? null
          : !!r.autopilotEnabled,
      autopilotStepCount: r.autopilotStepCount ?? 0,
      autopilotPaused: !!r.autopilotPaused,
      autopilotComplete: !!r.autopilotComplete,
      autopilotQuestion: r.autopilotQuestion ?? null,
      autoMergeEnabled:
        r.autoMergeEnabled === null || r.autoMergeEnabled === undefined
          ? null
          : !!r.autoMergeEnabled,
      autoMergeRebaseCount: r.autoMergeRebaseCount ?? 0,
      autoMergeRebaseHead: r.autoMergeRebaseHead ?? null,
      auto: !!r.auto,
      issueNumber: r.issueNumber ?? null,
      mergingSince: r.mergingSince ?? null,
      mergingTrainId: r.mergingTrainId ?? null,
    } as Session;
  }
}
