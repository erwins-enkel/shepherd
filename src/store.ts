import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
  Session,
  ReviewVerdict,
  PlanGate,
  Recap,
  DiffFile,
  Signal,
  SignalKind,
  Learning,
  LearningStatus,
  BuildStep,
  BuildStepStatus,
  BuildQueue,
  BuildStepInput,
  ReviewerSpawnRow,
  PrReview,
  HerdDigest,
  RundownItem,
} from "./types";
import { parseVisualBlocks, type VisualBlock } from "./visual-blocks";
import type { CapRow, CapStore, CreditSnapshot, CreditStore, WindowKey } from "./usage-limits";
import { dominantModel, type SessionUsage } from "./usage";
import { type SandboxProfile, isSandboxProfile } from "./sandbox";
import { normalizeRepoDefaultModelSetting } from "./default-model";
import type { EpicRun } from "./epic-core";
import type { EpicLandingState } from "./completed-epic";

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

/** Coerce a persisted tri-state flag: null/undefined stays null (inherit), else a real boolean. */
function nullableBool(v: unknown): boolean | null {
  return v === null || v === undefined ? null : !!v;
}

/** Designation prefix for task sessions, e.g. "TASK-07". Single source for the prefix + its SUBSTR offset. */
const DESIG_PREFIX = "TASK-";

/** Allowed learning status transitions (spec §3). Terminal states have no exits. */
const LEARNING_TRANSITIONS: Record<LearningStatus, LearningStatus[]> = {
  proposed: ["active", "dismissed"],
  active: ["promoted", "dismissed"],
  promoted: [],
  dismissed: [],
};

export interface RepoConfig {
  criticEnabled: boolean;
  /** Standalone repo-level PR critic: review every open CI-green PR in the repo, not just session PRs (default OFF). */
  criticAllPrs: boolean;
  /** Auto-feed critic findings back to the task agent until clean or the round cap. */
  autoAddressEnabled: boolean;
  learningsEnabled: boolean;
  /** Pre-PR autopilot loop: drive procedural gates, surface real questions, lead to a PR. */
  autopilotEnabled: boolean;
  /** Pre-execution plan gate: grill + adversarial plan review before autonomous execution (default OFF). */
  planGateEnabled: boolean;
  /** Per-repo master switch for the self-draining work queue (default OFF). */
  autoDrainEnabled: boolean;
  /** Full-auto: when on, the merge train lands ready PRs instead of handing off. */
  autoMergeEnabled: boolean;
  /** Per-repo opt-in for the agent-authored build queue (default OFF). */
  buildQueueEnabled: boolean;
  /** Open PRs as GitHub drafts; holds them out of merge/retire until sign-off (default OFF). */
  draftMode: boolean;
  /** Who must sign off a draft PR before it enters the merge path (default "human"). */
  signoffAuthority: "human" | "critic" | "either";
  /** Concurrency cap on auto-spawned agents for this repo (default 1). */
  maxAuto: number;
  /** Issue label that opts an issue in for auto-spawning (default "shepherd:auto"). */
  autoLabel: string;
  /** Pause auto-spawns when usage % is at or above this threshold (default 80). */
  usageCeilingPct: number;
  /** OS-level sandbox membrane for spawned task agents (default "trusted" = unconfined). */
  sandboxProfile: SandboxProfile;
  /** Per-repo default-model override; "inherit" (default) defers to the global default setting. */
  defaultModel: string;
  /** Per-repo extra allowlisted hosts appended to the autonomous egress allowlist. */
  egressExtraHosts: string[];
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
  | "mergeTrainPrs"
  | "mergingPrNumber"
  | "autopilotEnabled"
  | "autopilotStepCount"
  | "autopilotPaused"
  | "autopilotComplete"
  | "autopilotQuestion"
  | "planGateEnabled"
  | "planPhase"
  | "autoMergeEnabled"
  | "autoMergeRebaseCount"
  | "autoMergeRebaseHead"
  | "auto"
  | "issueNumber"
  | "sandboxApplied"
  | "sandboxDegraded"
  | "egressApplied"
  | "egressDegraded"
  | "research"
> & {
  id?: string;
  model?: string | null;
  claudeSessionId?: string;
  auto?: boolean;
  issueNumber?: number | null;
  planGateEnabled?: boolean | null;
  autopilotEnabled?: boolean | null;
  planPhase?: Session["planPhase"];
  sandboxApplied?: SandboxProfile | null;
  sandboxDegraded?: boolean;
  egressApplied?: boolean;
  egressDegraded?: boolean;
  research?: boolean;
  mergeTrainPrs?: number[];
};

const COLS = `id, desig, name, prompt, repoPath, baseBranch, branch, worktreePath,
  isolated, herdrSession, herdrAgentId, claudeSessionId, model, readyToMerge, status, lastState,
  autopilotEnabled, autopilotStepCount, autopilotPaused, autopilotComplete, autopilotQuestion,
  planGateEnabled, planPhase,
  autoMergeEnabled, autoMergeRebaseCount, autoMergeRebaseHead,
  auto, issueNumber, sandboxApplied, sandboxDegraded, egressApplied, egressDegraded,
  research,
  createdAt, updatedAt, archivedAt, mergingSince, mergingTrainId, mergeTrainPrs, mergingPrNumber`;

// ── repo_config row type + helpers ────────────────────────────────────────────

type RepoCfgRow = {
  criticEnabled: number;
  criticAllPrs: number;
  autoAddressEnabled: number;
  learningsEnabled: number;
  autopilotEnabled: number;
  planGateEnabled: number;
  autoDrainEnabled: number;
  autoMergeEnabled: number;
  buildQueueEnabled: number;
  draftMode: number;
  signoffAuthority: string;
  maxAuto: number;
  autoLabel: string;
  usageCeilingPct: number;
  sandboxProfile: string;
  defaultModel: string;
  egressExtraHosts: string | null;
};

/** Tolerantly parse the persisted mergeTrainPrs JSON back to number[] | null (never throws). */
function parseMergeTrainPrsJson(raw: string | null | undefined): number[] | null {
  if (raw === null || raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    if (parsed.some((el) => typeof el !== "number")) return null;
    return parsed as number[];
  } catch {
    return null;
  }
}

/** Tolerantly parse the persisted egressExtraHosts JSON back to string[] (never throws). */
function parseEgressExtraHostsJson(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * Map a nullable repo_config row to a fully-defaulted RepoConfig.
 * absent → critic on, learnings on, auto-address off (the spendier loop is explicit opt-in).
 * drain fields default OFF / cap-1 / default-label / ceiling-80. Early-return for the absent
 * row keeps the present-row mapping branch-free (low complexity).
 */
function repoConfigFromRow(r: RepoCfgRow | null): RepoConfig {
  if (!r) {
    return {
      criticEnabled: true,
      criticAllPrs: false,
      autoAddressEnabled: false,
      learningsEnabled: true,
      autopilotEnabled: false,
      planGateEnabled: false,
      autoDrainEnabled: false,
      autoMergeEnabled: false,
      buildQueueEnabled: false,
      draftMode: false,
      signoffAuthority: "human",
      maxAuto: 1,
      autoLabel: "shepherd:auto",
      usageCeilingPct: 80,
      sandboxProfile: "trusted",
      defaultModel: "inherit",
      egressExtraHosts: [],
    };
  }
  return {
    criticEnabled: !!r.criticEnabled,
    criticAllPrs: !!r.criticAllPrs,
    autoAddressEnabled: !!r.autoAddressEnabled,
    learningsEnabled: !!r.learningsEnabled,
    autopilotEnabled: !!r.autopilotEnabled,
    planGateEnabled: !!r.planGateEnabled,
    autoDrainEnabled: !!r.autoDrainEnabled,
    autoMergeEnabled: !!r.autoMergeEnabled,
    buildQueueEnabled: !!r.buildQueueEnabled,
    draftMode: !!r.draftMode,
    signoffAuthority: r.signoffAuthority as RepoConfig["signoffAuthority"],
    maxAuto: r.maxAuto,
    autoLabel: r.autoLabel,
    usageCeilingPct: r.usageCeilingPct,
    sandboxProfile: isSandboxProfile(r.sandboxProfile) ? r.sandboxProfile : "trusted",
    defaultModel: normalizeRepoDefaultModelSetting(r.defaultModel) ?? "inherit",
    egressExtraHosts: parseEgressExtraHostsJson(r.egressExtraHosts),
  };
}

export class SessionStore implements CapStore, CreditStore {
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
    this.db.run(`CREATE TABLE IF NOT EXISTS task_seq (
      id INTEGER PRIMARY KEY CHECK (id = 1), next INTEGER NOT NULL)`);
    // Seed once from the high-water mark of existing desigs (TASK-NN) + 1, or 1 on a fresh DB.
    // SUBSTR offset strips the fixed DESIG_PREFIX; SQLite SUBSTR is 1-based so offset = prefix.length + 1.
    // INSERT OR IGNORE keeps this idempotent.
    // NB: this guarantees no *future* reuse but does not de-duplicate desig collisions a pre-fix
    // DB may already hold (the old COUNT(*) scheme reused numbers after a prune). We deliberately
    // don't renumber historical rows: a desig is stamped into that task's already-created branch
    // name + PR title, so rewriting it would desync the label from its real-world artifacts.
    this.db.run(`INSERT OR IGNORE INTO task_seq (id, next)
      VALUES (1, (SELECT COALESCE(MAX(CAST(SUBSTR(desig, ${DESIG_PREFIX.length + 1}) AS INTEGER)), 0) + 1 FROM sessions))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS usage_caps (
      window TEXT PRIMARY KEY, cap REAL NOT NULL, resetAt INTEGER NOT NULL,
      pct INTEGER NOT NULL, scrapedAt INTEGER NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS usage_credit (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      spent REAL NOT NULL, cap REAL NOT NULL, currency TEXT NOT NULL,
      pct INTEGER NOT NULL, resetAt INTEGER, scrapedAt INTEGER NOT NULL)`);
    // small key/value store for runtime-configurable settings (e.g. repoRoot)
    this.db.run(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS repo_config (
      repoPath TEXT PRIMARY KEY, criticEnabled INTEGER NOT NULL DEFAULT 1,
      criticAllPrs INTEGER NOT NULL DEFAULT 0,
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
      streakReviews INTEGER NOT NULL DEFAULT 0, reviewedPatchIds TEXT NOT NULL DEFAULT '[]',
      seenNoteIds TEXT NOT NULL DEFAULT '[]',
      finalRoundPending INTEGER NOT NULL DEFAULT 0,
      finalRoundTimeoutMs INTEGER NOT NULL DEFAULT 900000,
      url TEXT, updatedAt INTEGER NOT NULL)`);
    this.migrateReviewColumns();
    this.db.run(`CREATE TABLE IF NOT EXISTS pr_reviews (
      repoPath TEXT NOT NULL, prNumber INTEGER NOT NULL,
      headSha TEXT NOT NULL, patchId TEXT NOT NULL DEFAULT '',
      decision TEXT NOT NULL DEFAULT '',
      reviewedPatchIds TEXT NOT NULL DEFAULT '[]',
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (repoPath, prNumber))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS plan_gates (
      sessionId TEXT PRIMARY KEY, planHash TEXT NOT NULL DEFAULT '',
      decision TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
      findings TEXT NOT NULL DEFAULT '[]', round INTEGER NOT NULL DEFAULT 0,
      cap INTEGER NOT NULL DEFAULT 3, approved INTEGER NOT NULL DEFAULT 0,
      plan TEXT NOT NULL DEFAULT '', updatedAt INTEGER NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS recaps (
      sessionId TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      headSha TEXT NOT NULL DEFAULT '',
      verdict TEXT,
      headline TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      openItems TEXT NOT NULL DEFAULT '[]',
      changedFiles TEXT NOT NULL DEFAULT '[]',
      spawnSessionId TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '',
      model TEXT,
      spawnedAt INTEGER NOT NULL,
      generatedAt INTEGER,
      updatedAt INTEGER NOT NULL,
      blocks TEXT NOT NULL DEFAULT '[]',
      pendingDiff TEXT NOT NULL DEFAULT '[]')`);
    // migrate recaps that predate the changedFiles column (existing rows default to none)
    const recapCols = this.db.query(`PRAGMA table_info(recaps)`).all() as { name: string }[];
    if (!recapCols.some((c) => c.name === "changedFiles")) {
      this.db.run(`ALTER TABLE recaps ADD COLUMN changedFiles TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!recapCols.some((c) => c.name === "blocks")) {
      this.db.run(`ALTER TABLE recaps ADD COLUMN blocks TEXT NOT NULL DEFAULT '[]'`);
    }
    if (!recapCols.some((c) => c.name === "pendingDiff")) {
      this.db.run(`ALTER TABLE recaps ADD COLUMN pendingDiff TEXT NOT NULL DEFAULT '[]'`);
    }
    // Herd Rundown: one synthesized cross-session attention digest per calendar day.
    // Same lifecycle as recaps (generating → ready/failed); verdict columns empty until ready.
    this.db.run(`CREATE TABLE IF NOT EXISTS herd_digests (
      dayKey TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      overnight TEXT NOT NULL DEFAULT '',
      decisions TEXT NOT NULL DEFAULT '[]',
      ciRework TEXT NOT NULL DEFAULT '[]',
      train TEXT NOT NULL DEFAULT '',
      focusNext TEXT NOT NULL DEFAULT '[]',
      attentionFingerprint TEXT NOT NULL DEFAULT '{}',
      spawnSessionId TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '',
      model TEXT,
      spawnedAt INTEGER NOT NULL,
      generatedAt INTEGER,
      updatedAt INTEGER NOT NULL)`);
    // Exact reviewer-cost attribution. Keyed by the *reviewer's* forced --session-id (which
    // locates its transcript), NOT the task — and deliberately carries NO foreign key to
    // `sessions`. `reviews`/`plan_gates` are keyed by the task sessionId and get deleted on
    // archive + cascade-pruned, so reviewer (critic/plan-gate) token burn vanishes with the
    // task. This table is the separate, append-only, archive-decoupled record that survives
    // both, so post-hoc cost reports can still attribute that burn. Each spawn forces a fresh
    // UUID, so a plain INSERT never collides on the PK.
    this.db.run(`CREATE TABLE IF NOT EXISTS reviewer_spawns (
      reviewerSessionId TEXT PRIMARY KEY,
      taskSessionId     TEXT NOT NULL,
      kind              TEXT NOT NULL,
      worktreePath      TEXT NOT NULL,
      model             TEXT,
      spawnedAt         INTEGER NOT NULL,
      completedAt       INTEGER,
      inputTokens       INTEGER,
      outputTokens      INTEGER,
      cacheReadTokens   INTEGER,
      cacheWriteTokens  INTEGER,
      totalTokens       INTEGER)`);
    this.db.run(
      `CREATE INDEX IF NOT EXISTS reviewer_spawns_task ON reviewer_spawns (taskSessionId)`,
    );
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
    this.db.run(`CREATE TABLE IF NOT EXISTS build_queue_steps (
      id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, position INTEGER NOT NULL,
      title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`);
    this.db.run(
      `CREATE INDEX IF NOT EXISTS build_queue_steps_session ON build_queue_steps (sessionId, position)`,
    );
    this.db.run(`CREATE TABLE IF NOT EXISTS build_queue_state (
      sessionId TEXT PRIMARY KEY, approved INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL)`);
    // One stamp per workflow-protocol comment posted on a session's backlog issue
    // (issue-log: `waiting:<pr>` / `merged:<pr>`), so each transition comments exactly
    // once per PR across restarts and CI flaps.
    this.db.run(`CREATE TABLE IF NOT EXISTS issue_log (
      sessionId TEXT NOT NULL, key TEXT NOT NULL, createdAt INTEGER NOT NULL,
      PRIMARY KEY (sessionId, key))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS epic_run (
      repoPath TEXT PRIMARY KEY, parentIssueNumber INTEGER NOT NULL,
      mode TEXT NOT NULL DEFAULT 'auto', status TEXT NOT NULL DEFAULT 'idle', updatedAt INTEGER NOT NULL)`);
    // #645: the pinned integration-branch name, keyed PER EPIC (repoPath, parentIssueNumber)
    // — NOT on epic_run, which is one-row-per-repo and superseded when a new epic starts on that
    // repo, so a pin stored there would be inherited by the next epic and would outlive its own
    // epic's landing. A dedicated row per epic stays correct across supersession + into landing.
    this.db.run(`CREATE TABLE IF NOT EXISTS epic_branch (
      repoPath TEXT NOT NULL, parentIssueNumber INTEGER NOT NULL,
      branch TEXT NOT NULL,
      PRIMARY KEY (repoPath, parentIssueNumber))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS epic_integrated (
      repoPath TEXT NOT NULL, parentIssueNumber INTEGER NOT NULL, childNumber INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (repoPath, parentIssueNumber, childNumber))`);
    this.migrateEpicIntegratedColumns();
    this.db.run(`CREATE TABLE IF NOT EXISTS epic_completed (
      repoPath TEXT NOT NULL, parentIssueNumber INTEGER NOT NULL,
      parentTitle TEXT NOT NULL, completedAt INTEGER NOT NULL,
      dismissedAt INTEGER,
      childrenJson TEXT NOT NULL,
      landingPrNumber INTEGER,
      landingPrUrl TEXT,
      landingState TEXT NOT NULL DEFAULT 'pending',
      landingAttempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (repoPath, parentIssueNumber))`);
    this.migrateEpicCompletedColumns();
    // #645: a child whose PR targets a base other than the pinned epic branch is parked here at
    // retire (fail-closed: not merged, not integrated). Keyed per child; the row is the throttle
    // anchor (bounds prReviewMeta to ≤1/child/~60s while stuck) and the assembleEpic warning source.
    this.db.run(`CREATE TABLE IF NOT EXISTS epic_base_mismatch (
      repoPath TEXT NOT NULL, parentIssueNumber INTEGER NOT NULL, childNumber INTEGER NOT NULL,
      actualBase TEXT NOT NULL, prNumber INTEGER, checkedAt INTEGER NOT NULL,
      PRIMARY KEY (repoPath, parentIssueNumber, childNumber))`);
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

  // ── settings (key/value) ─────────────────────────────────────────────────
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
        `SELECT criticEnabled, criticAllPrs, autoAddressEnabled, learningsEnabled, autopilotEnabled, planGateEnabled,
                autoDrainEnabled, autoMergeEnabled, buildQueueEnabled, draftMode, signoffAuthority,
                maxAuto, autoLabel, usageCeilingPct, sandboxProfile, defaultModel, egressExtraHosts
         FROM repo_config WHERE repoPath = ?`,
      )
      .get(repoPath) as RepoCfgRow | null;
    return repoConfigFromRow(r);
  }

  setRepoConfig(repoPath: string, cfg: RepoConfig): void {
    this.db.run(
      `INSERT INTO repo_config
         (repoPath, criticEnabled, criticAllPrs, autoAddressEnabled, learningsEnabled, autopilotEnabled, planGateEnabled,
          autoDrainEnabled, autoMergeEnabled, buildQueueEnabled, draftMode, signoffAuthority,
          maxAuto, autoLabel, usageCeilingPct, sandboxProfile, defaultModel, egressExtraHosts, updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(repoPath) DO UPDATE SET criticEnabled = excluded.criticEnabled,
         criticAllPrs = excluded.criticAllPrs,
         autoAddressEnabled = excluded.autoAddressEnabled,
         learningsEnabled = excluded.learningsEnabled,
         autopilotEnabled = excluded.autopilotEnabled,
         planGateEnabled = excluded.planGateEnabled,
         autoDrainEnabled = excluded.autoDrainEnabled,
         autoMergeEnabled = excluded.autoMergeEnabled,
         buildQueueEnabled = excluded.buildQueueEnabled,
         draftMode = excluded.draftMode,
         signoffAuthority = excluded.signoffAuthority,
         maxAuto = excluded.maxAuto,
         autoLabel = excluded.autoLabel,
         usageCeilingPct = excluded.usageCeilingPct,
         sandboxProfile = excluded.sandboxProfile,
         defaultModel = excluded.defaultModel,
         egressExtraHosts = excluded.egressExtraHosts,
         updatedAt = excluded.updatedAt`,
      [
        repoPath,
        cfg.criticEnabled ? 1 : 0,
        cfg.criticAllPrs ? 1 : 0,
        cfg.autoAddressEnabled ? 1 : 0,
        cfg.learningsEnabled ? 1 : 0,
        cfg.autopilotEnabled ? 1 : 0,
        cfg.planGateEnabled ? 1 : 0,
        cfg.autoDrainEnabled ? 1 : 0,
        cfg.autoMergeEnabled ? 1 : 0,
        cfg.buildQueueEnabled ? 1 : 0,
        cfg.draftMode ? 1 : 0,
        cfg.signoffAuthority,
        cfg.maxAuto,
        cfg.autoLabel,
        cfg.usageCeilingPct,
        cfg.sandboxProfile,
        cfg.defaultModel,
        JSON.stringify(cfg.egressExtraHosts ?? []),
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

  // ── epic run (one active epic per repo) ──────────────────────────────────
  getEpicRun(repoPath: string): EpicRun | null {
    return (
      (this.db
        .query(`SELECT repoPath, parentIssueNumber, mode, status FROM epic_run WHERE repoPath = ?`)
        .get(repoPath) as EpicRun | null) ?? null
    );
  }

  /** All persisted epic_run rows (one per repo). Mirrors getEpicRun's row shape. */
  listEpicRuns(): EpicRun[] {
    return this.db
      .query(`SELECT repoPath, parentIssueNumber, mode, status FROM epic_run`)
      .all() as EpicRun[];
  }

  setEpicRun(r: EpicRun): void {
    this.db.run(
      `INSERT INTO epic_run (repoPath, parentIssueNumber, mode, status, updatedAt) VALUES (?,?,?,?,?)
      ON CONFLICT(repoPath) DO UPDATE SET parentIssueNumber=excluded.parentIssueNumber, mode=excluded.mode, status=excluded.status, updatedAt=excluded.updatedAt`,
      [r.repoPath, r.parentIssueNumber, r.mode, r.status, Date.now()],
    );
  }

  /** Single source of truth for an epic's pinned integration-branch name (#645), keyed
   *  PER EPIC `(repoPath, parentIssueNumber)`. The name derives from the parent title, but
   *  the title can be edited mid-run — re-deriving everywhere would re-point new spawns +
   *  the landing base and orphan children already merged on the old branch. So we pin it
   *  once on first sight and read it forever: an existing pin is returned as-is; otherwise
   *  `derived` is persisted for THIS epic and returned. Per-epic keying is load-bearing —
   *  `epic_run` is one-row-per-repo and superseded when a new epic starts, so a repo-scoped
   *  pin would be inherited by the next epic and would be wrong for a superseded epic's
   *  still-pending landing PR. */
  getOrInitEpicIntegrationBranch(
    repoPath: string,
    parentIssueNumber: number,
    derived: string,
  ): string {
    const row = this.db
      .query(`SELECT branch FROM epic_branch WHERE repoPath = ? AND parentIssueNumber = ?`)
      .get(repoPath, parentIssueNumber) as { branch: string } | null;
    if (row) return row.branch; // already pinned for this epic
    this.db.run(
      `INSERT INTO epic_branch (repoPath, parentIssueNumber, branch) VALUES (?,?,?)
       ON CONFLICT(repoPath, parentIssueNumber) DO NOTHING`,
      [repoPath, parentIssueNumber, derived],
    );
    return derived;
  }

  /** Record that a child PR was squash-merged into the epic integration branch.
   *  Idempotent (PK upsert) — the drain may re-observe a merge across pumps.
   *  On conflict, updates only PR columns (guarded by COALESCE so a null re-observe
   *  cannot clobber previously-recorded good values). createdAt is never overwritten. */
  recordEpicIntegrated(
    repoPath: string,
    parentIssueNumber: number,
    childNumber: number,
    pr?: { number: number; url: string },
    mergedBase?: string,
  ): void {
    this.db.run(
      `INSERT INTO epic_integrated (repoPath, parentIssueNumber, childNumber, createdAt, prNumber, prUrl, mergedBase)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT DO UPDATE SET
         prNumber = COALESCE(excluded.prNumber, epic_integrated.prNumber),
         prUrl = COALESCE(NULLIF(excluded.prUrl, ''), epic_integrated.prUrl),
         mergedBase = COALESCE(excluded.mergedBase, epic_integrated.mergedBase)`,
      [
        repoPath,
        parentIssueNumber,
        childNumber,
        Date.now(),
        pr?.number ?? null,
        pr?.url ?? null,
        mergedBase ?? null,
      ],
    );
  }

  /** Child #s squash-merged into the integration branch for one epic. */
  listEpicIntegrated(repoPath: string, parentIssueNumber: number): Set<number> {
    const rows = this.db
      .query(`SELECT childNumber FROM epic_integrated WHERE repoPath = ? AND parentIssueNumber = ?`)
      .all(repoPath, parentIssueNumber) as { childNumber: number }[];
    return new Set(rows.map((r) => r.childNumber));
  }

  /** All integrated child rows for one epic, with PR details and mergedAt timestamp. */
  listEpicIntegratedDetails(
    repoPath: string,
    parentIssueNumber: number,
  ): {
    childNumber: number;
    prNumber: number | null;
    prUrl: string | null;
    mergedBase: string | null;
    mergedAt: number;
  }[] {
    return this.db
      .query(
        `SELECT childNumber, prNumber, prUrl, mergedBase, createdAt AS mergedAt
         FROM epic_integrated WHERE repoPath = ? AND parentIssueNumber = ?
         ORDER BY childNumber`,
      )
      .all(repoPath, parentIssueNumber) as {
      childNumber: number;
      prNumber: number | null;
      prUrl: string | null;
      mergedBase: string | null;
      mergedAt: number;
    }[];
  }

  // ── epic base-mismatch markers (#645) ─────────────────────────────────────
  /** Park a child whose PR targets the wrong base. Upsert — refreshes actualBase/prNumber/checkedAt
   *  (checkedAt is the throttle anchor, so it must advance on every recheck). */
  recordEpicBaseMismatch(
    repoPath: string,
    parentIssueNumber: number,
    childNumber: number,
    m: { actualBase: string; prNumber: number | null; checkedAt: number },
  ): void {
    this.db.run(
      `INSERT INTO epic_base_mismatch (repoPath, parentIssueNumber, childNumber, actualBase, prNumber, checkedAt)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT DO UPDATE SET
         actualBase = excluded.actualBase,
         prNumber = excluded.prNumber,
         checkedAt = excluded.checkedAt`,
      [repoPath, parentIssueNumber, childNumber, m.actualBase, m.prNumber, m.checkedAt],
    );
  }

  /** Clear a child's base-mismatch marker (the PR was re-targeted / merged correctly). */
  clearEpicBaseMismatch(repoPath: string, parentIssueNumber: number, childNumber: number): void {
    this.db.run(
      `DELETE FROM epic_base_mismatch WHERE repoPath = ? AND parentIssueNumber = ? AND childNumber = ?`,
      [repoPath, parentIssueNumber, childNumber],
    );
  }

  /** A single child's marker (or null) — drives the doRetire throttle read. */
  getEpicBaseMismatch(
    repoPath: string,
    parentIssueNumber: number,
    childNumber: number,
  ): { actualBase: string; prNumber: number | null; checkedAt: number } | null {
    return this.db
      .query(
        `SELECT actualBase, prNumber, checkedAt FROM epic_base_mismatch
         WHERE repoPath = ? AND parentIssueNumber = ? AND childNumber = ?`,
      )
      .get(repoPath, parentIssueNumber, childNumber) as {
      actualBase: string;
      prNumber: number | null;
      checkedAt: number;
    } | null;
  }

  /** All parked children for one epic — fed into assembleEpic for the actionable warnings. */
  listEpicBaseMismatches(
    repoPath: string,
    parentIssueNumber: number,
  ): { childNumber: number; actualBase: string; prNumber: number | null }[] {
    return this.db
      .query(
        `SELECT childNumber, actualBase, prNumber FROM epic_base_mismatch
         WHERE repoPath = ? AND parentIssueNumber = ? ORDER BY childNumber`,
      )
      .all(repoPath, parentIssueNumber) as {
      childNumber: number;
      actualBase: string;
      prNumber: number | null;
    }[];
  }

  /** Record a completed epic (all children done-in-epic). Idempotent upsert.
   *  On conflict, refreshes parentTitle/completedAt/childrenJson but leaves dismissedAt untouched
   *  so a previously dismissed epic never resurrects. */
  recordEpicCompleted(row: {
    repoPath: string;
    parentIssueNumber: number;
    parentTitle: string;
    completedAt: number;
    childrenJson: string;
  }): void {
    this.db.run(
      `INSERT INTO epic_completed (repoPath, parentIssueNumber, parentTitle, completedAt, childrenJson)
       VALUES (?,?,?,?,?)
       ON CONFLICT DO UPDATE SET
         parentTitle = excluded.parentTitle,
         completedAt = excluded.completedAt,
         childrenJson = excluded.childrenJson`,
      [row.repoPath, row.parentIssueNumber, row.parentTitle, row.completedAt, row.childrenJson],
    );
  }

  /** True if an epic_completed row exists for this key, regardless of dismissedAt.
   *  Used by the backfill pre-check so a dismissed-but-idle run isn't re-backfilled. */
  hasEpicCompleted(repoPath: string, parentIssueNumber: number): boolean {
    return (
      this.db
        .query(`SELECT 1 FROM epic_completed WHERE repoPath = ? AND parentIssueNumber = ? LIMIT 1`)
        .get(repoPath, parentIssueNumber) !== null
    );
  }

  /** All non-dismissed completed epics, optionally filtered by repoPath, newest-completed first. */
  listEpicCompleted(repoPath?: string): {
    repoPath: string;
    parentIssueNumber: number;
    parentTitle: string;
    completedAt: number;
    childrenJson: string;
    landingPrNumber: number | null;
    landingPrUrl: string | null;
    landingState: EpicLandingState;
    landingAttempts: number;
    migrationPaths: string[];
    migrationsAckedAt: number | null;
  }[] {
    const sql = `SELECT repoPath, parentIssueNumber, parentTitle, completedAt, childrenJson,
                landingPrNumber, landingPrUrl, landingState, landingAttempts,
                migrationPathsJson, migrationsAckedAt
         FROM epic_completed WHERE dismissedAt IS NULL`;
    type Raw = {
      repoPath: string;
      parentIssueNumber: number;
      parentTitle: string;
      completedAt: number;
      childrenJson: string;
      landingPrNumber: number | null;
      landingPrUrl: string | null;
      landingState: EpicLandingState;
      landingAttempts: number;
      migrationPathsJson: string | null;
      migrationsAckedAt: number | null;
    };
    const rows =
      repoPath !== undefined
        ? (this.db
            .query(`${sql} AND repoPath = ? ORDER BY completedAt DESC`)
            .all(repoPath) as Raw[])
        : (this.db.query(`${sql} ORDER BY completedAt DESC`).all() as Raw[]);
    return rows.map(({ migrationPathsJson, ...rest }) => ({
      ...rest,
      migrationPaths: parseFindings(migrationPathsJson),
    }));
  }

  /** Write the Stage B (#635) landing-PR resolution onto a completed epic.
   *  Direct UPDATE (not part of recordEpicCompleted's preserve-by-omission upsert). */
  setEpicLandingPr(
    repoPath: string,
    parentIssueNumber: number,
    fields: {
      state: EpicLandingState;
      prNumber: number | null;
      prUrl: string | null;
      attempts: number;
    },
  ): void {
    this.db.run(
      `UPDATE epic_completed SET landingState = ?, landingPrNumber = ?, landingPrUrl = ?, landingAttempts = ?
       WHERE repoPath = ? AND parentIssueNumber = ?`,
      [fields.state, fields.prNumber, fields.prUrl, fields.attempts, repoPath, parentIssueNumber],
    );
  }

  /** Persist the migration paths detected in a completed epic's landing PR (#645). Stored as a
   *  JSON array; an empty array clears any prior detection. Direct UPDATE, mirroring
   *  {@link setEpicLandingPr}'s style. */
  setEpicMigrationPaths(repoPath: string, parentIssueNumber: number, paths: string[]): void {
    this.db.run(
      `UPDATE epic_completed SET migrationPathsJson = ? WHERE repoPath = ? AND parentIssueNumber = ?`,
      [JSON.stringify(paths), repoPath, parentIssueNumber],
    );
  }

  /** Acknowledge a completed epic's landing-PR migrations (#645): stamp `migrationsAckedAt` AND
   *  dismiss the row in one operator action. `migrationsAckedAt` is the durable audit record of
   *  WHEN the human acknowledged; the coupled `dismissedAt` is what actually clears the band and
   *  prevents a re-prompt (listEpicCompleted filters `dismissedAt IS NULL`). */
  ackEpicMigrations(repoPath: string, parentIssueNumber: number): void {
    const now = Date.now();
    this.db.run(
      `UPDATE epic_completed SET migrationsAckedAt = ?, dismissedAt = ?
       WHERE repoPath = ? AND parentIssueNumber = ?`,
      [now, now, repoPath, parentIssueNumber],
    );
  }

  /** Mark a completed epic as dismissed (hides it from listEpicCompleted).
   *  At land-time there's no explicit dismiss call: the aggregate landing PR's
   *  `Closes #<parent>` closes the parent on merge, and the autoDismissClosed
   *  reconcile (src/server.ts) then dismisses the band once the parent is
   *  confidently closed. */
  dismissEpicCompleted(repoPath: string, parentIssueNumber: number): void {
    this.db.run(
      `UPDATE epic_completed SET dismissedAt = ? WHERE repoPath = ? AND parentIssueNumber = ?`,
      [Date.now(), repoPath, parentIssueNumber],
    );
  }

  private nextDesignationSeq(): number {
    const row = this.db.query(`SELECT next FROM task_seq WHERE id = 1`).get() as { next: number };
    this.db.run(`UPDATE task_seq SET next = next + 1 WHERE id = 1`);
    return row.next;
  }

  /** Assemble a fresh Session row from creation input + the assigned seq/timestamp. */
  private buildSessionRow(input: NewSession, seq: number, now: number): Session {
    return {
      ...input,
      model: input.model ?? null,
      claudeSessionId: input.claudeSessionId ?? "",
      id: input.id ?? randomUUID(),
      desig: `${DESIG_PREFIX}${String(seq).padStart(2, "0")}`,
      readyToMerge: false,
      autopilotEnabled: input.autopilotEnabled ?? null,
      autopilotStepCount: 0,
      autopilotPaused: false,
      autopilotComplete: false,
      autopilotQuestion: null,
      planGateEnabled: input.planGateEnabled ?? null,
      planPhase: input.planPhase ?? null,
      autoMergeEnabled: null,
      autoMergeRebaseCount: 0,
      autoMergeRebaseHead: null,
      auto: input.auto ?? false,
      issueNumber: input.issueNumber ?? null,
      sandboxApplied: input.sandboxApplied ?? null,
      sandboxDegraded: input.sandboxDegraded ?? false,
      egressApplied: input.egressApplied ?? false,
      egressDegraded: input.egressDegraded ?? false,
      research: input.research ?? false,
      status: "running",
      lastState: "idle",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      mergingSince: null,
      mergingTrainId: null,
      mergeTrainPrs: input.mergeTrainPrs ?? null,
      mergingPrNumber: null,
    };
  }

  create(input: NewSession): Session {
    return this.db.transaction(() => {
      const now = Date.now();
      const seq = this.nextDesignationSeq();
      const s = this.buildSessionRow(input, seq, now);
      this.db.run(
        `INSERT INTO sessions (${COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
          s.autopilotEnabled === null ? null : s.autopilotEnabled ? 1 : 0, // autopilotEnabled
          0, // autopilotStepCount
          0, // autopilotPaused
          0, // autopilotComplete
          null, // autopilotQuestion
          s.planGateEnabled === null ? null : s.planGateEnabled ? 1 : 0, // planGateEnabled — inherit repo default
          s.planPhase, // planPhase — null = gate off
          null, // autoMergeEnabled — inherit repo default
          0, // autoMergeRebaseCount
          null, // autoMergeRebaseHead — none outstanding
          s.auto ? 1 : 0,
          s.issueNumber,
          s.sandboxApplied,
          s.sandboxDegraded ? 1 : 0,
          s.egressApplied ? 1 : 0,
          s.egressDegraded ? 1 : 0,
          s.research ? 1 : 0,
          s.createdAt,
          s.updatedAt,
          s.archivedAt,
          s.mergingSince,
          s.mergingTrainId,
          s.mergeTrainPrs !== null ? JSON.stringify(s.mergeTrainPrs) : null,
          null, // mergingPrNumber — always null at create
        ],
      );
      return s;
    })();
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

  /** Archived sessions retired since `sinceMs`, newest-first — drives the read-only
   *  "recently done" surface (recaps survive worktree teardown). */
  listRecentlyArchived(sinceMs: number): Session[] {
    return (
      this.db
        .query(
          `SELECT ${COLS} FROM sessions WHERE status = 'archived' AND archivedAt >= ? ORDER BY archivedAt DESC`,
        )
        .all(sinceMs) as any[]
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
        | "mergingPrNumber"
      >
    >,
  ) {
    const cur = this.get(id);
    if (!cur) return;
    const next = { ...cur, ...patch, updatedAt: Date.now() };
    this.db.run(
      `UPDATE sessions SET name=?, status=?, lastState=?, branch=?, herdrAgentId=?, readyToMerge=?, mergingSince=?, mergingTrainId=?, mergingPrNumber=?, updatedAt=? WHERE id=?`,
      [
        next.name,
        next.status,
        next.lastState,
        next.branch,
        next.herdrAgentId,
        next.readyToMerge ? 1 : 0,
        next.mergingSince,
        next.mergingTrainId,
        next.mergingPrNumber,
        next.updatedAt,
        id,
      ],
    );
  }

  /** Patch a session's applied sandbox state (set at spawn by the sandbox wrapper).
   *  Only the provided keys are written. */
  setSandboxState(
    id: string,
    patch: {
      applied?: SandboxProfile | null;
      degraded?: boolean;
      egressApplied?: boolean;
      egressDegraded?: boolean;
    },
  ): void {
    const cur = this.get(id);
    if (!cur) return;
    const applied = patch.applied === undefined ? cur.sandboxApplied : patch.applied;
    const degraded = patch.degraded === undefined ? cur.sandboxDegraded : patch.degraded;
    const egressApplied =
      patch.egressApplied === undefined ? cur.egressApplied : patch.egressApplied;
    const egressDegraded =
      patch.egressDegraded === undefined ? cur.egressDegraded : patch.egressDegraded;
    this.db.run(
      `UPDATE sessions SET sandboxApplied=?, sandboxDegraded=?, egressApplied=?, egressDegraded=?, updatedAt=? WHERE id=?`,
      [applied, degraded ? 1 : 0, egressApplied ? 1 : 0, egressDegraded ? 1 : 0, Date.now(), id],
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

  /**
   * Map of repoPath → count of sessions (agents) created since `since` (ms epoch).
   * Drives the "recently worked on" shortcut in the repo picker — a measure of how
   * many agents were run on each repo in the recent window, across all sessions.
   */
  recentSessionCountsByRepo(since: number): Record<string, number> {
    const rows = this.db
      .query(`SELECT repoPath, COUNT(*) AS n FROM sessions WHERE createdAt >= ? GROUP BY repoPath`)
      .all(since) as { repoPath: string; n: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.repoPath] = r.n;
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

  getCreditSnapshot(): CreditSnapshot | null {
    return (
      (this.db
        .query(
          `SELECT spent, cap, currency, pct, resetAt, scrapedAt FROM usage_credit WHERE id = 1`,
        )
        .get() as CreditSnapshot | null) ?? null
    );
  }

  putCreditSnapshot(row: CreditSnapshot): void {
    this.db.run(
      `INSERT INTO usage_credit (id, spent, cap, currency, pct, resetAt, scrapedAt) VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET spent=excluded.spent, cap=excluded.cap, currency=excluded.currency,
         pct=excluded.pct, resetAt=excluded.resetAt, scrapedAt=excluded.scrapedAt`,
      [row.spent, row.cap, row.currency, row.pct, row.resetAt, row.scrapedAt],
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
      streakReviews: r.streakReviews ?? 0,
      reviewedPatchIds: parseFindings(r.reviewedPatchIds), // same string[] JSON shape as seenNoteIds
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
                addressCap, streakReviews, reviewedPatchIds, errorRound, finalRoundPending, finalRoundTimeoutMs, seenNoteIds, url, updatedAt
              FROM reviews WHERE sessionId = ?`,
      )
      .get(sessionId) as any;
    return r ? this.hydrateReview(r) : null;
  }

  putReview(v: ReviewVerdict): void {
    this.db.run(
      `INSERT INTO reviews (sessionId, headSha, patchId, decision, summary, body, findings, addressRound,
         addressCap, streakReviews, reviewedPatchIds, errorRound, finalRoundPending, finalRoundTimeoutMs, seenNoteIds, url, updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(sessionId) DO UPDATE SET headSha=excluded.headSha, patchId=excluded.patchId,
         decision=excluded.decision,
         summary=excluded.summary, body=excluded.body, findings=excluded.findings,
         addressRound=excluded.addressRound, addressCap=excluded.addressCap,
         streakReviews=excluded.streakReviews, reviewedPatchIds=excluded.reviewedPatchIds,
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
        v.streakReviews ?? 0,
        JSON.stringify(v.reviewedPatchIds ?? []),
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

  // ── issue workflow log (one stamp per posted issue comment) ───────────────
  hasIssueLog(sessionId: string, key: string): boolean {
    return (
      this.db
        .query(`SELECT 1 FROM issue_log WHERE sessionId = ? AND key = ?`)
        .get(sessionId, key) != null
    );
  }

  markIssueLog(sessionId: string, key: string): void {
    this.db.run(`INSERT OR IGNORE INTO issue_log (sessionId, key, createdAt) VALUES (?, ?, ?)`, [
      sessionId,
      key,
      Date.now(),
    ]);
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
                addressCap, streakReviews, reviewedPatchIds, errorRound, finalRoundPending, finalRoundTimeoutMs, seenNoteIds, url, updatedAt FROM reviews`,
      )
      .all() as any[];
    const out: Record<string, ReviewVerdict> = {};
    for (const r of rows) out[r.sessionId] = this.hydrateReview(r);
    return out;
  }

  // ── pre-execution plan gates ─────────────────────────────────────────────────
  private hydratePlanGate(r: any): PlanGate {
    return {
      sessionId: r.sessionId,
      planHash: r.planHash ?? "",
      decision: r.decision,
      summary: r.summary ?? "",
      body: r.body ?? "",
      findings: parseFindings(r.findings),
      round: r.round ?? 0,
      cap: r.cap ?? 3,
      approved: !!r.approved,
      plan: r.plan ?? "",
      updatedAt: r.updatedAt,
    } as PlanGate;
  }

  getPlanGate(sessionId: string): PlanGate | null {
    const r = this.db
      .query(
        `SELECT sessionId, planHash, decision, summary, body, findings, round, cap, approved, plan, updatedAt
              FROM plan_gates WHERE sessionId = ?`,
      )
      .get(sessionId) as any;
    return r ? this.hydratePlanGate(r) : null;
  }

  putPlanGate(g: PlanGate): void {
    this.db.run(
      `INSERT INTO plan_gates (sessionId, planHash, decision, summary, body, findings, round, cap, approved, plan, updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(sessionId) DO UPDATE SET planHash=excluded.planHash, decision=excluded.decision,
         summary=excluded.summary, body=excluded.body, findings=excluded.findings,
         round=excluded.round, cap=excluded.cap, approved=excluded.approved,
         plan=excluded.plan, updatedAt=excluded.updatedAt`,
      [
        g.sessionId,
        g.planHash ?? "",
        g.decision,
        g.summary,
        g.body,
        JSON.stringify(g.findings ?? []),
        g.round ?? 0,
        g.cap ?? 3,
        g.approved ? 1 : 0,
        g.plan ?? "",
        g.updatedAt,
      ],
    );
  }

  dropPlanGate(sessionId: string): void {
    this.db.run(`DELETE FROM plan_gates WHERE sessionId = ?`, [sessionId]);
  }

  snapshotPlanGates(): Record<string, PlanGate> {
    const rows = this.db
      .query(
        `SELECT sessionId, planHash, decision, summary, body, findings, round, cap, approved, plan, updatedAt FROM plan_gates`,
      )
      .all() as any[];
    const out: Record<string, PlanGate> = {};
    for (const r of rows) out[r.sessionId] = this.hydratePlanGate(r);
    return out;
  }

  // ── session recaps ────────────────────────────────────────────────────────────
  private hydrateRecap(r: any): Recap {
    let openItems: string[] = [];
    try {
      const parsed = JSON.parse(r.openItems);
      if (Array.isArray(parsed))
        openItems = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      openItems = [];
    }
    let changedFiles: string[] = [];
    try {
      const parsed = JSON.parse(r.changedFiles);
      if (Array.isArray(parsed))
        changedFiles = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      changedFiles = [];
    }
    let blocks: VisualBlock[];
    try {
      blocks = parseVisualBlocks(JSON.parse(r.blocks));
    } catch {
      blocks = [];
    }
    return {
      sessionId: r.sessionId,
      state: r.state,
      headSha: r.headSha ?? "",
      verdict: r.verdict ?? null,
      headline: r.headline ?? "",
      body: r.body ?? "",
      openItems,
      changedFiles,
      blocks,
      spawnSessionId: r.spawnSessionId ?? "",
      cwd: r.cwd ?? "",
      model: r.model ?? null,
      spawnedAt: r.spawnedAt,
      generatedAt: r.generatedAt ?? null,
      updatedAt: r.updatedAt,
    } as Recap;
  }

  private parsePendingDiff(raw: unknown): DiffFile[] {
    try {
      const p = JSON.parse(raw as string);
      return Array.isArray(p) ? (p as DiffFile[]) : [];
    } catch {
      return [];
    }
  }

  getRecap(sessionId: string): Recap | null {
    const r = this.db
      .query(
        `SELECT sessionId, state, headSha, verdict, headline, body, openItems, changedFiles, blocks,
                spawnSessionId, cwd, model, spawnedAt, generatedAt, updatedAt
              FROM recaps WHERE sessionId = ?`,
      )
      .get(sessionId) as any;
    return r ? this.hydrateRecap(r) : null;
  }

  putRecap(recap: Recap): void {
    this.db.run(
      `INSERT INTO recaps (sessionId, state, headSha, verdict, headline, body, openItems, changedFiles,
         blocks, spawnSessionId, cwd, model, spawnedAt, generatedAt, updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(sessionId) DO UPDATE SET state=excluded.state, headSha=excluded.headSha,
         verdict=excluded.verdict, headline=excluded.headline, body=excluded.body,
         openItems=excluded.openItems, changedFiles=excluded.changedFiles,
         blocks=excluded.blocks,
         spawnSessionId=excluded.spawnSessionId,
         cwd=excluded.cwd, model=excluded.model, spawnedAt=excluded.spawnedAt,
         generatedAt=excluded.generatedAt, updatedAt=excluded.updatedAt`,
      [
        recap.sessionId,
        recap.state,
        recap.headSha ?? "",
        recap.verdict ?? null,
        recap.headline ?? "",
        recap.body ?? "",
        JSON.stringify(recap.openItems ?? []),
        JSON.stringify(recap.changedFiles ?? []),
        JSON.stringify(recap.blocks ?? []),
        recap.spawnSessionId ?? "",
        recap.cwd ?? "",
        recap.model ?? null,
        recap.spawnedAt,
        recap.generatedAt ?? null,
        recap.updatedAt,
      ],
    );
  }

  /** All recaps except `empty` ones — the UI never shows an empty recap. */
  snapshotRecaps(): Record<string, Recap> {
    const rows = this.db
      .query(
        `SELECT sessionId, state, headSha, verdict, headline, body, openItems, changedFiles, blocks,
                spawnSessionId, cwd, model, spawnedAt, generatedAt, updatedAt
              FROM recaps WHERE state != 'empty'`,
      )
      .all() as any[];
    const out: Record<string, Recap> = {};
    for (const r of rows) out[r.sessionId] = this.hydrateRecap(r);
    return out;
  }

  /** Rows currently in-flight — used by the service's finalize loop (restart-safe). */
  generatingRecaps(): Recap[] {
    const rows = this.db
      .query(
        `SELECT sessionId, state, headSha, verdict, headline, body, openItems, changedFiles, blocks,
                pendingDiff, spawnSessionId, cwd, model, spawnedAt, generatedAt, updatedAt
              FROM recaps WHERE state = 'generating'`,
      )
      .all() as any[];
    return rows.map((r) => ({
      ...this.hydrateRecap(r),
      pendingDiff: this.parsePendingDiff(r.pendingDiff),
    }));
  }

  /** Set/clear the transient diff carrier used by finalize's block-join. Server-only — never read by
   *  the client-facing getRecap/snapshotRecaps paths. Pass [] to clear. */
  setRecapPendingDiff(sessionId: string, files: DiffFile[]): void {
    this.db.run(`UPDATE recaps SET pendingDiff = ? WHERE sessionId = ?`, [
      JSON.stringify(files ?? []),
      sessionId,
    ]);
  }

  dropRecap(sessionId: string): void {
    this.db.run(`DELETE FROM recaps WHERE sessionId = ?`, [sessionId]);
  }

  // ── herd rundown (cross-session attention digest, per calendar day) ───────────
  private hydrateItems(raw: unknown): RundownItem[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === "string" ? raw : "[]");
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const out: RundownItem[] = [];
    for (const x of parsed) {
      if (!x || typeof x !== "object") continue;
      const o = x as Record<string, unknown>;
      if (typeof o.label !== "string") continue;
      const item: RundownItem = { label: o.label };
      if (typeof o.sessionId === "string") item.sessionId = o.sessionId;
      if (typeof o.pr === "number") item.pr = o.pr;
      out.push(item);
    }
    return out;
  }

  private hydrateHerdDigest(r: any): HerdDigest {
    let fingerprint: Record<string, string[]> = {};
    try {
      const parsed = JSON.parse(r.attentionFingerprint);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          if (Array.isArray(v))
            fingerprint[k] = v.filter((x): x is string => typeof x === "string");
        }
      }
    } catch {
      fingerprint = {};
    }
    return {
      dayKey: r.dayKey,
      state: r.state,
      overnight: r.overnight ?? "",
      decisions: this.hydrateItems(r.decisions),
      ciRework: this.hydrateItems(r.ciRework),
      train: r.train ?? "",
      focusNext: this.hydrateItems(r.focusNext),
      attentionFingerprint: fingerprint,
      spawnSessionId: r.spawnSessionId ?? "",
      cwd: r.cwd ?? "",
      model: r.model ?? null,
      spawnedAt: r.spawnedAt,
      generatedAt: r.generatedAt ?? null,
      updatedAt: r.updatedAt,
    } as HerdDigest;
  }

  private readonly HERD_COLS = `dayKey, state, overnight, decisions, ciRework, train, focusNext,
    attentionFingerprint, spawnSessionId, cwd, model, spawnedAt, generatedAt, updatedAt`;

  getHerdDigest(dayKey: string): HerdDigest | null {
    const r = this.db
      .query(`SELECT ${this.HERD_COLS} FROM herd_digests WHERE dayKey = ?`)
      .get(dayKey) as any;
    return r ? this.hydrateHerdDigest(r) : null;
  }

  getLatestHerdDigest(): HerdDigest | null {
    const r = this.db
      .query(`SELECT ${this.HERD_COLS} FROM herd_digests ORDER BY spawnedAt DESC LIMIT 1`)
      .get() as any;
    return r ? this.hydrateHerdDigest(r) : null;
  }

  putHerdDigest(d: HerdDigest): void {
    this.db.run(
      `INSERT INTO herd_digests (dayKey, state, overnight, decisions, ciRework, train, focusNext,
         attentionFingerprint, spawnSessionId, cwd, model, spawnedAt, generatedAt, updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(dayKey) DO UPDATE SET state=excluded.state, overnight=excluded.overnight,
         decisions=excluded.decisions, ciRework=excluded.ciRework, train=excluded.train,
         focusNext=excluded.focusNext, attentionFingerprint=excluded.attentionFingerprint,
         spawnSessionId=excluded.spawnSessionId, cwd=excluded.cwd, model=excluded.model,
         spawnedAt=excluded.spawnedAt, generatedAt=excluded.generatedAt, updatedAt=excluded.updatedAt`,
      [
        d.dayKey,
        d.state,
        d.overnight ?? "",
        JSON.stringify(d.decisions ?? []),
        JSON.stringify(d.ciRework ?? []),
        d.train ?? "",
        JSON.stringify(d.focusNext ?? []),
        JSON.stringify(d.attentionFingerprint ?? {}),
        d.spawnSessionId ?? "",
        d.cwd ?? "",
        d.model ?? null,
        d.spawnedAt,
        d.generatedAt ?? null,
        d.updatedAt,
      ],
    );
  }

  /** Rows currently in-flight — used by the service's finalize loop (restart-safe). */
  generatingHerdDigests(): HerdDigest[] {
    const rows = this.db
      .query(`SELECT ${this.HERD_COLS} FROM herd_digests WHERE state = 'generating'`)
      .all() as any[];
    return rows.map((r) => this.hydrateHerdDigest(r));
  }

  /** Overnight delta since `sinceTs`: PRs merged (from issue_log `merged:<pr>` stamps) and
   *  sessions archived after that instant. Feeds the rundown's "while you were away" summary. */
  overnightDelta(sinceTs: number): {
    mergedPrs: number[];
    archivedSessions: { id: string; desig: string }[];
  } {
    const mergedRows = this.db
      .query(`SELECT key FROM issue_log WHERE key LIKE 'merged:%' AND createdAt > ?`)
      .all(sinceTs) as { key: string }[];
    const mergedPrs: number[] = [];
    for (const row of mergedRows) {
      const n = Number(row.key.slice("merged:".length));
      if (Number.isFinite(n)) mergedPrs.push(n);
    }
    const archived = this.db
      .query(
        `SELECT id, desig FROM sessions WHERE archivedAt IS NOT NULL AND archivedAt > ? ORDER BY archivedAt`,
      )
      .all(sinceTs) as { id: string; desig: string }[];
    return { mergedPrs, archivedSessions: archived };
  }

  setPlanPhase(id: string, phase: Session["planPhase"]): void {
    this.db.run(`UPDATE sessions SET planPhase = ?, updatedAt = ? WHERE id = ?`, [
      phase,
      Date.now(),
      id,
    ]);
  }

  // ── reviewer spawn cost attribution ──────────────────────────────────────────
  /** Record a freshly-spawned reviewer session. Token/completed columns stay NULL until
   *  finalize (`completeReviewerSpawn`). A plain INSERT is correct — every spawn forces a
   *  fresh reviewerSessionId UUID, so the PK never collides. */
  recordReviewerSpawn(r: {
    reviewerSessionId: string;
    taskSessionId: string;
    kind: "review" | "plan_gate" | "recap" | "rundown";
    worktreePath: string;
    model: string | null;
    spawnedAt: number;
  }): void {
    this.db.run(
      `INSERT INTO reviewer_spawns
         (reviewerSessionId, taskSessionId, kind, worktreePath, model, spawnedAt)
       VALUES (?,?,?,?,?,?)`,
      [r.reviewerSessionId, r.taskSessionId, r.kind, r.worktreePath, r.model, r.spawnedAt],
    );
  }

  /** Fill a spawn's token totals + completedAt once its transcript is read. No-op when the
   *  reviewerSessionId is unknown (the WHERE simply matches nothing). */
  completeReviewerSpawn(reviewerSessionId: string, u: SessionUsage, completedAt: number): void {
    // Backfill the TRUE model from the transcript: the spawn-time `model` column held the
    // configured override, which is null when auto-resolved — but the transcript names the model
    // that actually ran. A reviewer spawn is one model, so `dominantModel(u)` is it. It returns
    // null for empty usage or records that named no real model (only parseLine's "unknown"
    // sentinel), and COALESCE then keeps the recorded value — the sentinel never overwrites it.
    // This lets usage-report weight a GC'd-transcript spawn's cost by its real tier, not a
    // task-model proxy. `u.messageCount` is intentionally dropped — not a cost fact.
    this.db.run(
      `UPDATE reviewer_spawns SET inputTokens = ?, outputTokens = ?, cacheReadTokens = ?,
         cacheWriteTokens = ?, totalTokens = ?, completedAt = ?, model = COALESCE(?, model)
         WHERE reviewerSessionId = ?`,
      [
        u.input,
        u.output,
        u.cacheRead,
        u.cacheWrite,
        u.total,
        completedAt,
        dominantModel(u),
        reviewerSessionId,
      ],
    );
  }

  /** All reviewer-spawn rows, oldest-spawned first. Column names already match the
   *  ReviewerSpawnRow fields, so a direct cast suffices. */
  listReviewerSpawns(): ReviewerSpawnRow[] {
    return this.db
      .query(`SELECT * FROM reviewer_spawns ORDER BY spawnedAt`)
      .all() as ReviewerSpawnRow[];
  }

  /** Drop reviewer-spawn rows older than `beforeTs` (own retention sweep — these are
   *  decoupled from the session archive path on purpose). Returns the count removed. */
  pruneReviewerSpawns(beforeTs: number): number {
    const n = (
      this.db
        .query(`SELECT COUNT(*) AS c FROM reviewer_spawns WHERE spawnedAt < ?`)
        .get(beforeTs) as { c: number }
    ).c;
    this.db.run(`DELETE FROM reviewer_spawns WHERE spawnedAt < ?`, [beforeTs]);
    return n;
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
      this.db.run(
        `DELETE FROM build_queue_steps WHERE sessionId IN (SELECT id FROM sessions WHERE ${victims})`,
        params,
      );
      this.db.run(
        `DELETE FROM build_queue_state WHERE sessionId IN (SELECT id FROM sessions WHERE ${victims})`,
        params,
      );
      this.db.run(
        `DELETE FROM plan_gates WHERE sessionId IN (SELECT id FROM sessions WHERE ${victims})`,
        params,
      );
      this.db.run(
        `DELETE FROM issue_log WHERE sessionId IN (SELECT id FROM sessions WHERE ${victims})`,
        params,
      );
      this.db.run(
        `DELETE FROM recaps WHERE sessionId IN (SELECT id FROM sessions WHERE ${victims})`,
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
    // nullable: NULL = inherit / gate off, 0/1 = explicit per-session override
    add("planGateEnabled", `planGateEnabled INTEGER`);
    add("planPhase", `planPhase TEXT`);
    add("autoMergeEnabled", `autoMergeEnabled INTEGER`);
    add("autoMergeRebaseCount", `autoMergeRebaseCount INTEGER NOT NULL DEFAULT 0`);
    add("autoMergeRebaseHead", `autoMergeRebaseHead TEXT`);
    add("auto", `auto INTEGER NOT NULL DEFAULT 0`);
    add("issueNumber", `issueNumber INTEGER`);
    // sandbox badge/banner: applied profile (nullable for legacy rows) + degrade flag.
    add("sandboxApplied", `sandboxApplied TEXT`);
    add("sandboxDegraded", `sandboxDegraded INTEGER NOT NULL DEFAULT 0`);
    // egress firewall: applied flag + degrade flag (legacy rows default false/false).
    add("egressApplied", `egressApplied INTEGER NOT NULL DEFAULT 0`);
    add("egressDegraded", `egressDegraded INTEGER NOT NULL DEFAULT 0`);
    add("mergingSince", `mergingSince INTEGER`);
    add("mergingTrainId", `mergingTrainId TEXT`);
    // research task kind: default 0 (false) for pre-existing rows.
    add("research", `research INTEGER NOT NULL DEFAULT 0`);
    add("mergeTrainPrs", `mergeTrainPrs TEXT`);
    add("mergingPrNumber", `mergingPrNumber INTEGER`);
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
    add("criticAllPrs", `criticAllPrs INTEGER NOT NULL DEFAULT 0`);
    add("learningsEnabled", `learningsEnabled INTEGER NOT NULL DEFAULT 1`);
    add("autopilotEnabled", `autopilotEnabled INTEGER NOT NULL DEFAULT 0`);
    add("planGateEnabled", `planGateEnabled INTEGER NOT NULL DEFAULT 0`);
    add("autoDrainEnabled", `autoDrainEnabled INTEGER NOT NULL DEFAULT 0`);
    add("autoMergeEnabled", `autoMergeEnabled INTEGER NOT NULL DEFAULT 0`);
    add("buildQueueEnabled", `buildQueueEnabled INTEGER NOT NULL DEFAULT 0`);
    add("maxAuto", `maxAuto INTEGER NOT NULL DEFAULT 1`);
    add("autoLabel", `autoLabel TEXT NOT NULL DEFAULT 'shepherd:auto'`);
    add("usageCeilingPct", `usageCeilingPct INTEGER NOT NULL DEFAULT 80`);
    add("draftMode", `draftMode INTEGER NOT NULL DEFAULT 0`);
    add("signoffAuthority", `signoffAuthority TEXT NOT NULL DEFAULT 'human'`);
    add("sandboxProfile", `sandboxProfile TEXT NOT NULL DEFAULT 'trusted'`);
    add("defaultModel", `defaultModel TEXT NOT NULL DEFAULT 'inherit'`);
    // per-repo egress extra-hosts: JSON-encoded string array (nullable, default []).
    add("egressExtraHosts", `egressExtraHosts TEXT`);
  }

  private migrateEpicIntegratedColumns(): void {
    const cols = this.db.query(`PRAGMA table_info(epic_integrated)`).all() as { name: string }[];
    const add = (name: string, ddl: string) => {
      if (!cols.some((c) => c.name === name))
        this.db.run(`ALTER TABLE epic_integrated ADD COLUMN ${ddl}`);
    };
    add("prNumber", `prNumber INTEGER`);
    add("prUrl", `prUrl TEXT`);
    // #645: the branch the child actually squash-merged into. Nullable — pre-existing rows
    // backfill to NULL and never fire divergence warnings (forward-looking only; no backfill).
    add("mergedBase", `mergedBase TEXT`);
  }

  private migrateEpicCompletedColumns(): void {
    const cols = this.db.query(`PRAGMA table_info(epic_completed)`).all() as { name: string }[];
    const add = (name: string, ddl: string) => {
      if (!cols.some((c) => c.name === name))
        this.db.run(`ALTER TABLE epic_completed ADD COLUMN ${ddl}`);
    };
    // Stage B (#635) landing-PR lifecycle. NOT NULL columns carry constant defaults so the
    // ALTER backfills existing rows to 'pending'/0.
    add("landingPrNumber", `landingPrNumber INTEGER`);
    add("landingPrUrl", `landingPrUrl TEXT`);
    add("landingState", `landingState TEXT NOT NULL DEFAULT 'pending'`);
    add("landingAttempts", `landingAttempts INTEGER NOT NULL DEFAULT 0`);
    // Migration-awareness checkpoint (#645). migrationPathsJson: paths of migration files
    // detected in the landing PR (JSON array). migrationsAckedAt: a durable audit timestamp
    // recording WHEN a human acknowledged those migrations — written alongside dismissedAt by
    // ackEpicMigrations. It is a record, NOT a gate: re-prompt suppression is the coupled
    // dismissedAt (listEpicCompleted filters `dismissedAt IS NULL`), so an acked row is hidden
    // by the dismiss, never by this column. Both nullable: absence = no detection ran / not
    // yet acknowledged.
    add("migrationPathsJson", `migrationPathsJson TEXT`);
    add("migrationsAckedAt", `migrationsAckedAt INTEGER`);
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
    // Per-streak spawn ceiling + churn/revert dedup (#501). Old rows backfill to 0 / '[]':
    // a row at rest hydrates to a fresh streak (next head reviews once and starts counting),
    // and an empty reviewedPatchIds set keeps the patchId OR-branch as the lone rebase-skip.
    add("streakReviews", `streakReviews INTEGER NOT NULL DEFAULT 0`);
    add("reviewedPatchIds", `reviewedPatchIds TEXT NOT NULL DEFAULT '[]'`);
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

  /** Replace a flagged rule's text (and optionally rationale) and clear the visible
   *  ineffective flag. Only operates on active/promoted rules; no-ops for
   *  proposed/dismissed/missing. Blank rewrites are rejected (returns null).
   *  PRESERVES `ineffectiveSignalIds` so the dedup set survives the revision — only
   *  genuinely new failure signals can re-raise the flag after an optimization. */
  reviseLearning(id: string, rule: string, rationale?: string): Learning | null {
    const cur = this.getLearning(id);
    if (!cur || (cur.status !== "active" && cur.status !== "promoted")) return null;
    const text = rule.trim().slice(0, 240);
    if (!text) return null;
    const resolvedRationale = rationale !== undefined ? rationale : cur.rationale;
    this.db.run(
      `UPDATE learnings SET rule = ?, rationale = ?, ineffectiveCount = 0, updatedAt = ? WHERE id = ?`,
      [text, resolvedRationale, Date.now(), id],
    );
    return this.getLearning(id);
  }

  /** Resolve the stored `ineffectiveSignalIds` for a rule to full Signal rows.
   *  Server-side only — `ineffectiveSignalIds` is intentionally absent from the
   *  Learning type and hydrateLearning. Returns [] for missing/unflagged rules. */
  ineffectiveSignalsFor(id: string): Signal[] {
    const row = this.db
      .query(`SELECT ineffectiveSignalIds FROM learnings WHERE id = ?`)
      .get(id) as { ineffectiveSignalIds?: string } | null;
    if (!row) return [];
    const ids = parseFindings(row.ineffectiveSignalIds);
    return this.getSignalsByIds(ids);
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

  // ── build queue ──────────────────────────────────────────────────────────────
  getBuildQueue(sessionId: string): BuildQueue {
    const rows = this.db
      .query(
        `SELECT id, position, title, detail, status
         FROM build_queue_steps WHERE sessionId = ? ORDER BY position`,
      )
      .all(sessionId) as {
      id: string;
      position: number;
      title: string;
      detail: string;
      status: string;
    }[];
    const state = this.db
      .query(`SELECT approved FROM build_queue_state WHERE sessionId = ?`)
      .get(sessionId) as { approved: number } | null;
    const steps: BuildStep[] = rows.map((r) => ({
      id: r.id,
      title: r.title,
      detail: r.detail,
      status: r.status as BuildStepStatus,
      position: r.position,
    }));
    return { sessionId, steps, approved: state ? !!state.approved : false };
  }

  replaceBuildQueue(sessionId: string, steps: BuildStepInput[]): BuildQueue {
    const now = Date.now();
    this.db.transaction(() => {
      // read existing rows (inside the txn) to preserve status + createdAt for id-matching entries
      const existing = new Map<string, { status: BuildStepStatus; createdAt: number }>();
      const existingRows = this.db
        .query(`SELECT id, status, createdAt FROM build_queue_steps WHERE sessionId = ?`)
        .all(sessionId) as { id: string; status: string; createdAt: number }[];
      for (const r of existingRows) {
        existing.set(r.id, { status: r.status as BuildStepStatus, createdAt: r.createdAt });
      }
      this.db.run(`DELETE FROM build_queue_steps WHERE sessionId = ?`, [sessionId]);
      for (let i = 0; i < steps.length; i++) {
        const input = steps[i]!;
        const matchId = input.id && existing.has(input.id) ? input.id : null;
        const prior = matchId ? existing.get(matchId)! : null;
        const id = matchId ?? randomUUID();
        const status = input.status ?? prior?.status ?? "pending";
        const createdAt = prior?.createdAt ?? now;
        this.db.run(
          `INSERT INTO build_queue_steps (id, sessionId, position, title, detail, status, createdAt, updatedAt)
           VALUES (?,?,?,?,?,?,?,?)`,
          [id, sessionId, i, input.title, input.detail ?? "", status, createdAt, now],
        );
      }
    })();
    return this.getBuildQueue(sessionId);
  }

  /** Update the status of a single step. Returns true when a row was actually changed. */
  setBuildStepStatus(sessionId: string, stepId: string, status: BuildStepStatus): boolean {
    const { changes } = this.db.run(
      `UPDATE build_queue_steps SET status = ?, updatedAt = ? WHERE id = ? AND sessionId = ?`,
      [status, Date.now(), stepId, sessionId],
    );
    return changes > 0;
  }

  /** Flip the human-curation gate for a session's queue. */
  setBuildQueueApproved(sessionId: string, approved: boolean): void {
    this.db.run(
      `INSERT INTO build_queue_state (sessionId, approved, updatedAt) VALUES (?,?,?)
       ON CONFLICT(sessionId) DO UPDATE SET approved = excluded.approved, updatedAt = excluded.updatedAt`,
      [sessionId, approved ? 1 : 0, Date.now()],
    );
  }

  /** Return one BuildQueue per session that has ≥1 step, via a single JOIN.
   *  Sessions with no steps are omitted entirely. */
  listBuildQueues(): BuildQueue[] {
    const rows = this.db
      .query(
        `SELECT s.id AS stepId, s.sessionId, s.position, s.title, s.detail, s.status, st.approved
         FROM build_queue_steps s
         LEFT JOIN build_queue_state st ON st.sessionId = s.sessionId
         ORDER BY s.sessionId, s.position`,
      )
      .all() as {
      stepId: string;
      sessionId: string;
      position: number;
      title: string;
      detail: string;
      status: string;
      approved: number | null;
    }[];
    const map = new Map<string, BuildQueue>();
    for (const r of rows) {
      let q = map.get(r.sessionId);
      if (!q) {
        q = { sessionId: r.sessionId, steps: [], approved: !!r.approved };
        map.set(r.sessionId, q);
      }
      q.steps.push({
        id: r.stepId,
        title: r.title,
        detail: r.detail,
        status: r.status as BuildStepStatus,
        position: r.position,
      });
    }
    return [...map.values()];
  }

  // ── standalone repo-level PR reviews ─────────────────────────────────────
  getPrReview(repoPath: string, prNumber: number): PrReview | null {
    const r = this.db
      .query(
        `SELECT repoPath, prNumber, headSha, patchId, decision, reviewedPatchIds, updatedAt
         FROM pr_reviews WHERE repoPath = ? AND prNumber = ?`,
      )
      .get(repoPath, prNumber) as any;
    if (!r) return null;
    return {
      repoPath: r.repoPath,
      prNumber: r.prNumber,
      headSha: r.headSha,
      patchId: r.patchId ?? "",
      decision: r.decision ?? "",
      reviewedPatchIds: parseFindings(r.reviewedPatchIds),
      updatedAt: r.updatedAt,
    };
  }

  putPrReview(r: PrReview): void {
    this.db.run(
      `INSERT INTO pr_reviews (repoPath, prNumber, headSha, patchId, decision, reviewedPatchIds, updatedAt)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(repoPath, prNumber) DO UPDATE SET headSha=excluded.headSha,
         patchId=excluded.patchId, decision=excluded.decision,
         reviewedPatchIds=excluded.reviewedPatchIds, updatedAt=excluded.updatedAt`,
      [
        r.repoPath,
        r.prNumber,
        r.headSha,
        r.patchId ?? "",
        r.decision ?? "",
        JSON.stringify(r.reviewedPatchIds ?? []),
        r.updatedAt,
      ],
    );
  }

  /** Re-point an existing pr_review at a new head without changing the verdict. No-op when no row exists. */
  bumpPrReviewHead(repoPath: string, prNumber: number, headSha: string, now: number): void {
    this.db.run(
      `UPDATE pr_reviews SET headSha = ?, updatedAt = ? WHERE repoPath = ? AND prNumber = ?`,
      [headSha, now, repoPath, prNumber],
    );
  }

  private hydrate(r: any): Session {
    return {
      ...r,
      isolated: !!r.isolated,
      readyToMerge: !!r.readyToMerge,
      claudeSessionId: r.claudeSessionId ?? "",
      autopilotEnabled: nullableBool(r.autopilotEnabled),
      autopilotStepCount: r.autopilotStepCount ?? 0,
      autopilotPaused: !!r.autopilotPaused,
      autopilotComplete: !!r.autopilotComplete,
      autopilotQuestion: r.autopilotQuestion ?? null,
      planGateEnabled: nullableBool(r.planGateEnabled),
      planPhase: r.planPhase ?? null,
      autoMergeEnabled: nullableBool(r.autoMergeEnabled),
      autoMergeRebaseCount: r.autoMergeRebaseCount ?? 0,
      autoMergeRebaseHead: r.autoMergeRebaseHead ?? null,
      auto: !!r.auto,
      issueNumber: r.issueNumber ?? null,
      sandboxApplied: isSandboxProfile(r.sandboxApplied) ? r.sandboxApplied : null,
      sandboxDegraded: !!r.sandboxDegraded,
      egressApplied: !!r.egressApplied,
      egressDegraded: !!r.egressDegraded,
      research: !!r.research,
      mergingSince: r.mergingSince ?? null,
      mergingTrainId: r.mergingTrainId ?? null,
      mergeTrainPrs: parseMergeTrainPrsJson(r.mergeTrainPrs),
      mergingPrNumber: r.mergingPrNumber ?? null,
    } as Session;
  }
}
