/**
 * Token-usage analysis for Shepherd task sessions.
 *
 * For a set of task sessions, reports a per-session token breakdown PLUS the
 * ancillary ("satellite") LLM-pass cost Shepherd spawns per task (critic /
 * PR-review and plan-review). Output feeds a written report, so `--md` emits
 * clean GitHub-flavored markdown tables.
 *
 *   bun run scripts/usage-report.ts                  # default 5 sample tasks
 *   bun run scripts/usage-report.ts TASK-288 TASK-287
 *   bun run scripts/usage-report.ts --recent 5       # 5 most-recent (ex-ops)
 *   bun run scripts/usage-report.ts --md             # markdown tables
 *   bun run scripts/usage-report.ts --include-excluded
 *
 * NOTE: the "cost-units" everywhere below are the RELATIVE per-Mtok cost-proxy
 * from src/pricing.ts (`weightedUnits`) — never dollars. Only ratios matter.
 *
 * Out of scope: the account-wide periodic distiller (`/tmp/shepherd-distill-*`)
 * is NOT per-task, so it is never attributed to a task here.
 */
import { Database } from "bun:sqlite";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { accumulate, dashify, jsonlPathFor, parseLine, type SessionUsage } from "../src/usage";
import { weightedUnits, cacheWriteUnits } from "../src/pricing";
import { isOperationalArchetype } from "../src/usage-archetype";
import { config } from "../src/config";

// ── DB shape ────────────────────────────────────────────────────────────────

interface SessionRow {
  id: string;
  desig: string;
  name: string;
  prompt: string;
  baseBranch: string;
  branch: string | null;
  worktreePath: string;
  repoPath: string;
  model: string | null;
  claudeSessionId: string | null;
  createdAt: number;
  updatedAt: number | null;
  archivedAt: number | null;
  status: string | null;
}

interface ReviewRow {
  sessionId: string;
  headSha: string | null;
}

interface PlanGateRow {
  sessionId: string;
}

interface ReviewerSpawnRow {
  reviewerSessionId: string;
  taskSessionId: string;
  model: string | null;
  totalTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

// ── CLI ───────────────────────────────────────────────────────────────────--

interface Args {
  desigs: string[];
  recent: number | null;
  md: boolean;
  includeExcluded: boolean;
}

/** The five sample tasks used when no designations and no --recent are given. */
const DEFAULT_SAMPLE = ["TASK-286", "TASK-287", "TASK-288", "TASK-290", "TASK-295"];

function parseArgs(argv: string[]): Args {
  const args: Args = { desigs: [], recent: null, md: false, includeExcluded: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--md") args.md = true;
    else if (a === "--include-excluded") args.includeExcluded = true;
    else if (a === "--recent") {
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--recent expects a positive number, got: ${raw ?? "(missing)"}`);
      }
      args.recent = Math.floor(n);
    } else if (a.startsWith("--")) {
      throw new Error(`unknown flag: ${a}`);
    } else {
      args.desigs.push(a);
    }
  }
  return args;
}

// ── probe / satellite classification ──────────────────────────────────────---

/** Known model-detection probe prompts (src/usage-probe.ts plumbing). */
const PROBE_PROMPTS = ["reply with the single word: ok", "in one short line, state your model id"];

/** A transcript is "small" (probe-sized) when it carries this few assistant turns or fewer. */
const PROBE_MAX_MESSAGES = 3;

/** A critic transcript's first user turn is the reviewPrompt; this is its stable preamble. */
const CRITIC_PREAMBLE = "you are a code critic reviewing a pull request";

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** First non-empty user-text turn of a transcript (lower-cased, whitespace-collapsed). */
function firstUserText(lines: string[]): string {
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let o: unknown;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const rec = o as { type?: string; message?: { content?: unknown } };
    if (rec.type !== "user" || !rec.message) continue;
    const c = rec.message.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c))
      text = c
        .map((p) => (p && typeof p === "object" ? ((p as { text?: string }).text ?? "") : ""))
        .join(" ");
    if (text.trim()) return norm(text);
  }
  return "";
}

// ── per-transcript metrics ────────────────────────────────────────────────---

interface TranscriptCost {
  usage: SessionUsage;
  costUnits: number;
  cacheWriteUnits: number;
}

/**
 * Accumulate one transcript: standard token buckets via `accumulate`, PLUS the
 * weighted cost-units summed per-record (NOT from the aggregate, which collapses
 * the 5m/1h cache-write split that carries different weights).
 */
function transcriptCost(lines: string[]): TranscriptCost {
  const usage = accumulate(lines);
  let costUnits = 0;
  let cwUnits = 0;
  const seen = new Set<string>();
  for (const line of lines) {
    const r = parseLine(line);
    if (!r) continue;
    if (r.requestId) {
      if (seen.has(r.requestId)) continue;
      seen.add(r.requestId);
    }
    costUnits += weightedUnits(r, r.model);
    cwUnits += cacheWriteUnits(r, r.model);
  }
  return { usage, costUnits, cacheWriteUnits: cwUnits };
}

async function readLines(path: string): Promise<string[] | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return (await file.text()).split("\n");
}

// ── in-worktree ancillary (probes / resumed / unknown) ─────────────────────---

type AncillaryKind = "probe" | "resumed" | "unknown";

interface AncillaryTranscript {
  sessionId: string;
  kind: AncillaryKind;
  usage: SessionUsage;
  costUnits: number;
}

function classifyInWorktree(lines: string[]): AncillaryKind {
  const first = firstUserText(lines);
  const isProbePrompt = PROBE_PROMPTS.some((p) => first.startsWith(p));
  const tc = accumulate(lines);
  if (isProbePrompt && tc.messageCount <= PROBE_MAX_MESSAGES) return "probe";
  if (tc.messageCount > PROBE_MAX_MESSAGES) return "resumed";
  return "unknown";
}

/** Every OTHER *.jsonl in the pinned session's worktree project dir. */
async function inWorktreeAncillary(
  worktreePath: string,
  pinnedSessionId: string,
): Promise<AncillaryTranscript[]> {
  const dir = join(config.claudeProjectsDir, dashify(worktreePath));
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out: AncillaryTranscript[] = [];
  for (const f of entries) {
    const sid = f.slice(0, -".jsonl".length);
    if (sid === pinnedSessionId) continue;
    const lines = await readLines(join(dir, f));
    if (!lines) continue;
    const { usage, costUnits } = transcriptCost(lines);
    out.push({ sessionId: sid, kind: classifyInWorktree(lines), usage, costUnits });
  }
  return out;
}

// ── satellite (critic + plan-review) attribution ───────────────────────────---

type LinkTag = "spawn" | "db" | "content" | "sha-confirmed";

interface SatelliteDir {
  /** dashified project dir name under ~/.claude/projects */
  dir: string;
  /** absolute path */
  path: string;
  /** plan-review embeds the task session UUID; null for bare critic dirs */
  embeddedSessionId: string | null;
  sha8: string;
  mtime: number;
}

const REVIEW_MARK = "-review-";
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/** Enumerate every `*-review-*` project dir, parsing its embedded session id (if any) + sha8. */
function enumerateReviewDirs(): SatelliteDir[] {
  const base = config.claudeProjectsDir;
  let names: string[];
  try {
    names = readdirSync(base).filter((n) => n.includes(REVIEW_MARK));
  } catch {
    return [];
  }
  const out: SatelliteDir[] = [];
  for (const dir of names) {
    const path = join(base, dir);
    let mtime: number;
    try {
      if (!statSync(path).isDirectory()) continue;
      mtime = newestJsonlMtime(path);
    } catch {
      continue;
    }
    const tag = dir.slice(dir.lastIndexOf(REVIEW_MARK) + REVIEW_MARK.length);
    const uuidMatch = tag.match(UUID_RE);
    const shaMatch = tag.match(/([0-9a-f]{8})$/);
    out.push({
      dir,
      path,
      embeddedSessionId: uuidMatch ? uuidMatch[0] : null,
      sha8: shaMatch ? shaMatch[1]! : "",
      mtime,
    });
  }
  return out;
}

/** Newest mtime among a dir's *.jsonl (the transcript activity), else the dir mtime. */
function newestJsonlMtime(dir: string): number {
  let newest = 0;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      newest = Math.max(newest, statSync(join(dir, f)).mtimeMs);
    }
  } catch {
    /* fall through */
  }
  if (!newest) {
    try {
      newest = statSync(dir).mtimeMs;
    } catch {
      /* leave 0 */
    }
  }
  return newest;
}

interface SatelliteTranscript {
  dir: string;
  tag: LinkTag;
  usage: SessionUsage;
  costUnits: number;
}

/** Concatenate every *.jsonl in a review dir and cost it as one satellite pass. */
async function costReviewDir(dirPath: string): Promise<TranscriptCost> {
  let files: string[];
  try {
    files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return { usage: accumulate([]), costUnits: 0, cacheWriteUnits: 0 };
  }
  const allLines: string[] = [];
  for (const f of files) {
    const lines = await readLines(join(dirPath, f));
    if (lines) allLines.push(...lines);
  }
  return transcriptCost(allLines);
}

/** The claude-session-id stems of a review dir's *.jsonl files (filenames sans extension). */
function jsonlStems(dirPath: string): string[] {
  try {
    return readdirSync(dirPath)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -".jsonl".length));
  } catch {
    return [];
  }
}

/** First user text of a review dir (its transcript opens with the reviewPrompt). */
async function reviewDirFirstUser(dirPath: string): Promise<string> {
  let files: string[];
  try {
    files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return "";
  }
  for (const f of files) {
    const lines = await readLines(join(dirPath, f));
    if (!lines) continue;
    const t = firstUserText(lines);
    if (t) return t;
  }
  return "";
}

/** Robust prefix of a prompt for the critic content-match (first ~80 non-ws chars, normalized). */
function promptNeedle(prompt: string): string {
  const n = norm(prompt);
  let count = 0;
  let end = 0;
  for (let i = 0; i < n.length; i++) {
    end = i + 1;
    if (n[i] !== " ") count++;
    if (count >= 80) break;
  }
  return n.slice(0, end);
}

interface SatelliteResult {
  /** sessionId → list of linked satellite transcripts */
  bySession: Map<string, SatelliteTranscript[]>;
  /** review dirs matching no task but whose mtime fell in some task window */
  residual: { dir: string; usage: SessionUsage; costUnits: number }[];
}

/**
 * Attribute satellite (critic + plan-review) transcripts to tasks.
 *   exact spawn-id link (reviewer_spawns) → DB-first (reviews/plan_gates) →
 *   plan-review by embedded UUID → critic by content-match.
 * The critic re-runs per reviewed head, so a task owns MULTIPLE critic dirs — all summed.
 * Residual: any review dir matching no task whose mtime lands in a task's [createdAt, end].
 * Final step — DB-totals fallback: a spawn whose transcript dir is gone (task archived +
 * ~/.claude/projects GC'd) is costed from its persisted reviewer_spawns token totals, so review
 * burn survives the transcript; skipped when its on-disk dir was already consumed above.
 */
async function attributeSatellites(
  sessions: ResolvedSession[],
  reviews: ReviewRow[],
  planGates: PlanGateRow[],
  spawns: ReviewerSpawnRow[],
): Promise<SatelliteResult> {
  const bySession = new Map<string, SatelliteTranscript[]>();
  const add = (sid: string, sat: SatelliteTranscript) => {
    const list = bySession.get(sid) ?? [];
    list.push(sat);
    bySession.set(sid, list);
  };

  const dirs = enumerateReviewDirs();
  const consumed = new Set<string>(); // dir names already linked
  const byId = new Map(sessions.map((s) => [s.row.id, s]));

  // 0. EXACT link (issue #502): a reviewer_spawns row maps a reviewer session id — which is a
  //    *.jsonl stem inside the review dir — straight to its task. Recorded at spawn and retained
  //    past archive, so it's authoritative and reconstruction-free. Takes precedence over every
  //    heuristic below.
  const taskByReviewer = new Map(spawns.map((sp) => [sp.reviewerSessionId, sp.taskSessionId]));
  for (const d of dirs) {
    if (consumed.has(d.dir)) continue;
    const hit = jsonlStems(d.path)
      .map((id) => taskByReviewer.get(id))
      .find((tid): tid is string => !!tid && byId.has(tid));
    if (hit) {
      const tc = await costReviewDir(d.path);
      add(hit, { dir: d.dir, tag: "spawn", ...tc });
      consumed.add(d.dir);
    }
  }

  // 1. DB-first: a reviews/plan_gates row makes that session's matching dirs authoritative.
  //    (headSha is persisted on reviews; we match a review dir whose sha8 prefixes it.)
  const dbReviewSessions = new Set(reviews.map((r) => r.sessionId));
  const dbPlanSessions = new Set(planGates.map((p) => p.sessionId));
  for (const d of dirs) {
    if (consumed.has(d.dir)) continue;
    // plan-review dir embeds the task session UUID directly
    if (
      d.embeddedSessionId &&
      byId.has(d.embeddedSessionId) &&
      dbPlanSessions.has(d.embeddedSessionId)
    ) {
      const tc = await costReviewDir(d.path);
      add(d.embeddedSessionId, { dir: d.dir, tag: "db", ...tc });
      consumed.add(d.dir);
      continue;
    }
    // critic dir confirmed by a persisted review headSha for an in-scope session
    if (!d.embeddedSessionId && d.sha8) {
      const hit = reviews.find(
        (r) => r.headSha && r.headSha.startsWith(d.sha8) && byId.has(r.sessionId),
      );
      if (hit && dbReviewSessions.has(hit.sessionId)) {
        const tc = await costReviewDir(d.path);
        add(hit.sessionId, { dir: d.dir, tag: "db", ...tc });
        consumed.add(d.dir);
      }
    }
  }

  // 2. plan-review by embedded UUID (content/structural link, no DB row needed).
  for (const d of dirs) {
    if (consumed.has(d.dir) || !d.embeddedSessionId) continue;
    if (byId.has(d.embeddedSessionId)) {
      const tc = await costReviewDir(d.path);
      add(d.embeddedSessionId, { dir: d.dir, tag: "content", ...tc });
      consumed.add(d.dir);
    }
  }

  // 3. critic (bare <repo>-review-<sha8>) by content-match on the reviewPrompt's first turn:
  //    it embeds the task prompt + baseBranch. Optionally sha-confirm against the repo.
  const needles = sessions.map((s) => ({
    s,
    needle: promptNeedle(s.row.prompt),
    base: norm(s.row.baseBranch),
  }));
  const shaCache = new Map<string, Set<string>>(); // repoPath → known commit sha8 set
  for (const d of dirs) {
    if (consumed.has(d.dir) || d.embeddedSessionId) continue;
    const first = await reviewDirFirstUser(d.path);
    if (!first.startsWith(CRITIC_PREAMBLE)) continue;
    const match = needles.find(
      (n) => n.needle && first.includes(n.needle) && first.includes(`git diff ${n.base}`),
    );
    if (!match) continue;
    let tag: LinkTag = "content";
    if (d.sha8 && shaBelongsToRepo(match.s.row.repoPath, d.sha8, shaCache)) tag = "sha-confirmed";
    const tc = await costReviewDir(d.path);
    add(match.s.row.id, { dir: d.dir, tag, ...tc });
    consumed.add(d.dir);
  }

  // 4. residual: an unconsumed review dir whose mtime falls inside any task window.
  const residual: SatelliteResult["residual"] = [];
  for (const d of dirs) {
    if (consumed.has(d.dir)) continue;
    const inWindow = sessions.some((s) => d.mtime >= s.row.createdAt && d.mtime <= s.end);
    if (!inWindow) continue;
    const tc = await costReviewDir(d.path);
    residual.push({ dir: d.dir, usage: tc.usage, costUnits: tc.costUnits });
  }

  // 5. DB-totals fallback (issue #502's archive-survival payoff): a spawn whose transcript dir
  //    is gone from disk (task archived + ~/.claude/projects GC'd) still has its exact token
  //    total persisted. Attribute it from the row so review burn survives the transcript.
  //    Guard against double-counting: skip any spawn whose reviewer session id is a *.jsonl
  //    stem of a dir already consumed above (that dir's cost is already attributed, in full).
  const consumedStems = new Set<string>();
  for (const d of dirs) {
    if (!consumed.has(d.dir)) continue;
    for (const stem of jsonlStems(d.path)) consumedStems.add(stem);
  }
  for (const sp of spawns) {
    if (sp.totalTokens == null) continue; // never completed → nothing exact to attribute
    if (!byId.has(sp.taskSessionId)) continue; // out of scope
    if (consumedStems.has(sp.reviewerSessionId)) continue; // already counted via its on-disk dir
    const usage: SessionUsage = {
      input: sp.inputTokens ?? 0,
      output: sp.outputTokens ?? 0,
      cacheRead: sp.cacheReadTokens ?? 0,
      cacheWrite: sp.cacheWriteTokens ?? 0,
      total: sp.totalTokens,
      messageCount: 0,
      lastActivity: null,
      byModel: {},
      fullRecaches: 0,
      sidechainCount: 0,
    };
    // The 5m/1h cache-write split isn't persisted (the aggregate collapses it); attribute it to
    // the 5m bucket, matching parseLine's default when the split is absent. Model: completion
    // backfills the spawn row's true model (dominantModel of the transcript), so `sp.model` is
    // accurate for any completed spawn that named a real model. The task-model proxy is reached
    // only when both are null — spawn-time model "auto" AND a transcript that named no real model
    // (these are all completed spawns; the never-completed ones are filtered by totalTokens above).
    const model = sp.model ?? byId.get(sp.taskSessionId)!.row.model ?? "unknown";
    const costUnits = weightedUnits(
      {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite5m: usage.cacheWrite,
        cacheWrite1h: 0,
      },
      model,
    );
    add(sp.taskSessionId, {
      dir: `db:${sp.reviewerSessionId.slice(0, 8)}`,
      tag: "spawn",
      usage,
      costUnits,
    });
  }

  return { bySession, residual };
}

/** Best-effort: is sha8 a known commit in repoPath? (branches deleted post-merge → scan --all + reflog.) */
function shaBelongsToRepo(
  repoPath: string,
  sha8: string,
  cache: Map<string, Set<string>>,
): boolean {
  let set = cache.get(repoPath);
  if (!set) {
    set = new Set<string>();
    for (const args of [
      ["log", "--all", "--format=%H"],
      ["reflog", "--format=%H"],
    ]) {
      try {
        const proc = Bun.spawnSync(["git", "-C", repoPath, ...args]);
        if (proc.success) {
          for (const h of proc.stdout.toString().split("\n")) {
            const t = h.trim();
            if (t) set.add(t.slice(0, 8));
          }
        }
      } catch {
        /* best-effort */
      }
    }
    cache.set(repoPath, set);
  }
  return set.has(sha8);
}

// ── session resolution ──────────────────────────────────────────────────────

interface ResolvedSession {
  row: SessionRow;
  authoring: TranscriptCost;
  ancillary: AncillaryTranscript[];
  /** end of the session's activity window (archivedAt ?? updatedAt ?? maxLastActivity) */
  end: number;
  /** duration ms, or null when unresolvable (ongoing) */
  durationMs: number | null;
}

function openDb(): Database {
  const path = process.env.SHEPHERD_DB ?? `${process.env.HOME}/.shepherd/shepherd.db`;
  return new Database(path, { readonly: true });
}

const SESSION_COLS =
  "id, desig, name, prompt, baseBranch, branch, worktreePath, repoPath, model, claudeSessionId, createdAt, updatedAt, archivedAt, status";

function fetchByDesig(db: Database, desigs: string[]): SessionRow[] {
  const stmt = db.query<SessionRow, [string]>(
    `SELECT ${SESSION_COLS} FROM sessions WHERE desig = ?`,
  );
  const rows: SessionRow[] = [];
  for (const d of desigs) {
    const r = stmt.get(d);
    if (r) rows.push(r);
    else console.warn(`[usage-report] no session for ${d}`);
  }
  return rows;
}

function fetchRecent(db: Database, n: number): SessionRow[] {
  const all = db
    .query<SessionRow, []>(`SELECT ${SESSION_COLS} FROM sessions ORDER BY createdAt DESC`)
    .all();
  return all.filter((r) => !isOperationalArchetype(r)).slice(0, n);
}

function fetchExcluded(db: Database, n: number): SessionRow[] {
  const all = db
    .query<SessionRow, []>(`SELECT ${SESSION_COLS} FROM sessions ORDER BY createdAt DESC`)
    .all();
  return all.filter((r) => isOperationalArchetype(r)).slice(0, n);
}

async function resolveSession(row: SessionRow): Promise<ResolvedSession> {
  const cs = row.claudeSessionId;
  const authoringLines = cs ? await readLines(jsonlPathFor(row.worktreePath, cs)) : null;
  const authoring = transcriptCost(authoringLines ?? []);
  const ancillary = cs ? await inWorktreeAncillary(row.worktreePath, cs) : [];

  const maxActivity = authoring.usage.lastActivity ?? 0;
  const end = row.archivedAt ?? row.updatedAt ?? maxActivity ?? 0;
  let durationMs: number | null = null;
  if (end && row.createdAt && end > row.createdAt) durationMs = end - row.createdAt;
  return { row, authoring, ancillary, end: end || row.createdAt, durationMs };
}

// ── derived metrics ───────────────────────────────────────────────────────---

function cacheReadRatio(u: SessionUsage): number {
  const denom = u.input + u.cacheRead + u.cacheWrite;
  return denom > 0 ? u.cacheRead / denom : 0;
}

function cacheWriteCostShare(authoring: TranscriptCost): number {
  return authoring.costUnits > 0 ? authoring.cacheWriteUnits / authoring.costUnits : 0;
}

// ── formatting ──────────────────────────────────────────────────────────────

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}
function fmtUnits(n: number): string {
  return n.toFixed(3);
}
function fmtRatio(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}
function fmtDuration(ms: number | null): string {
  if (ms === null) return "n/a (ongoing)";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}
function fmtModelMix(byModel: Record<string, number>): string {
  const entries = Object.entries(byModel).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return "—";
  const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
  return entries.map(([m, v]) => `${shortModel(m)} ${Math.round((v / total) * 100)}%`).join(", ");
}
function shortModel(m: string): string {
  const lc = m.toLowerCase();
  for (const k of ["opus", "sonnet", "haiku", "fable"]) if (lc.includes(k)) return k;
  return m;
}

// ── row assembly ────────────────────────────────────────────────────────────

export interface ReportRow {
  desig: string;
  name: string;
  model: string;
  authTotal: number;
  authInput: number;
  authOutput: number;
  authCacheRead: number;
  authCacheWrite: number;
  authMsgs: number;
  authCostUnits: number;
  modelMix: string;
  cacheReadRatio: number;
  fullRecaches: number;
  cacheWriteCostShare: number;
  duration: string;
  ancCount: number;
  ancProbe: number;
  ancResumed: number;
  ancUnknown: number;
  ancTokens: number;
  ancCostUnits: number;
  satCount: number;
  satTokens: number;
  satCostUnits: number;
  satTags: string;
  reviewMultiplier: number | null;
}

function buildRow(s: ResolvedSession, sats: SatelliteTranscript[]): ReportRow {
  const au = s.authoring.usage;
  const anc = s.ancillary;
  const ancTokens = anc.reduce((sum, a) => sum + a.usage.total, 0);
  const ancCost = anc.reduce((sum, a) => sum + a.costUnits, 0);
  const satTokens = sats.reduce((sum, x) => sum + x.usage.total, 0);
  const satCost = sats.reduce((sum, x) => sum + x.costUnits, 0);
  const tagCounts = new Map<LinkTag, number>();
  for (const x of sats) tagCounts.set(x.tag, (tagCounts.get(x.tag) ?? 0) + 1);
  const satTags = [...tagCounts.entries()].map(([t, c]) => `${t}×${c}`).join(" ") || "—";
  return {
    desig: s.row.desig,
    name: s.row.name,
    model: shortModel(s.row.model ?? "default"),
    authTotal: au.total,
    authInput: au.input,
    authOutput: au.output,
    authCacheRead: au.cacheRead,
    authCacheWrite: au.cacheWrite,
    authMsgs: au.messageCount,
    authCostUnits: s.authoring.costUnits,
    modelMix: fmtModelMix(au.byModel),
    cacheReadRatio: cacheReadRatio(au),
    fullRecaches: au.fullRecaches,
    cacheWriteCostShare: cacheWriteCostShare(s.authoring),
    duration: fmtDuration(s.durationMs),
    ancCount: anc.length,
    ancProbe: anc.filter((a) => a.kind === "probe").length,
    ancResumed: anc.filter((a) => a.kind === "resumed").length,
    ancUnknown: anc.filter((a) => a.kind === "unknown").length,
    ancTokens,
    ancCostUnits: ancCost,
    satCount: sats.length,
    satTokens,
    satCostUnits: satCost,
    satTags,
    reviewMultiplier: s.authoring.costUnits > 0 ? satCost / s.authoring.costUnits : null,
  };
}

// ── rendering ─────────────────────────────────────────────────────────────--

export const HEADERS = [
  "Task",
  "Name",
  "Model",
  "Auth total",
  "Auth input",
  "Auth output",
  "Auth cacheR",
  "Auth cacheW",
  "Msgs",
  "Auth cost*",
  "Model mix",
  "CacheRead%",
  "FullRecache",
  "CacheWcost%",
  "Duration",
  "Anc(p/r/u)",
  "Anc tok",
  "Anc cost*",
  "Sat dirs",
  "Sat tok",
  "Sat cost*",
  "Sat tags",
  "ReviewMult",
];

export function rowCells(r: ReportRow): string[] {
  return [
    r.desig,
    r.name,
    r.model,
    fmtInt(r.authTotal),
    fmtInt(r.authInput),
    fmtInt(r.authOutput),
    fmtInt(r.authCacheRead),
    fmtInt(r.authCacheWrite),
    fmtInt(r.authMsgs),
    fmtUnits(r.authCostUnits),
    r.modelMix,
    fmtRatio(r.cacheReadRatio),
    String(r.fullRecaches),
    fmtRatio(r.cacheWriteCostShare),
    r.duration,
    `${r.ancProbe}/${r.ancResumed}/${r.ancUnknown}`,
    fmtInt(r.ancTokens),
    fmtUnits(r.ancCostUnits),
    String(r.satCount),
    fmtInt(r.satTokens),
    fmtUnits(r.satCostUnits),
    r.satTags,
    r.reviewMultiplier === null ? "—" : `${r.reviewMultiplier.toFixed(2)}×`,
  ];
}

export function totalsCells(rows: ReportRow[]): string[] {
  const sum = (f: (r: ReportRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  const authCost = sum((r) => r.authCostUnits);
  const satCost = sum((r) => r.satCostUnits);
  return [
    "TOTAL",
    `${rows.length} tasks`,
    "",
    fmtInt(sum((r) => r.authTotal)),
    fmtInt(sum((r) => r.authInput)),
    fmtInt(sum((r) => r.authOutput)),
    fmtInt(sum((r) => r.authCacheRead)),
    fmtInt(sum((r) => r.authCacheWrite)),
    fmtInt(sum((r) => r.authMsgs)),
    fmtUnits(authCost),
    "",
    "",
    fmtInt(sum((r) => r.fullRecaches)),
    "",
    "",
    `${sum((r) => r.ancProbe)}/${sum((r) => r.ancResumed)}/${sum((r) => r.ancUnknown)}`,
    fmtInt(sum((r) => r.ancTokens)),
    fmtUnits(sum((r) => r.ancCostUnits)),
    fmtInt(sum((r) => r.satCount)),
    fmtInt(sum((r) => r.satTokens)),
    fmtUnits(satCost),
    "",
    authCost > 0 ? `${(satCost / authCost).toFixed(2)}×` : "—",
  ];
}

function renderMarkdownTable(rows: string[][]): string {
  const head = `| ${HEADERS.join(" | ")} |`;
  const sep = `| ${HEADERS.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.map(mdCell).join(" | ")} |`);
  return [head, sep, ...body].join("\n");
}
function mdCell(s: string): string {
  return s.replace(/\|/g, "\\|");
}

function renderPlainTable(rows: string[][]): string {
  const all = [HEADERS, ...rows];
  const widths = HEADERS.map((_, c) => Math.max(...all.map((r) => (r[c] ?? "").length)));
  const fmtRow = (r: string[]) => r.map((cell, c) => (cell ?? "").padEnd(widths[c]!)).join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  return [fmtRow(HEADERS), sep, ...rows.map(fmtRow)].join("\n");
}

const LEGEND = [
  "Legend:",
  "  Anc(p/r/u)  in-worktree ancillary transcripts: probe / resumed / unknown",
  "  Sat tags    satellite linkage: spawn (reviewer_spawns exact id link) / db (DB row authoritative) / content (prompt+base or embedded UUID match) / sha-confirmed (sha8 found in repo)",
  "  FullRecache main-thread prompt-cache full rebuilds — every warm→cold drop (sidechain/sub-agent records excluded, warned on stderr); counts genuine invalidation AND compaction/resume-induced cold restarts alike, so it's an upper bound on true invalidation",
  "  CacheWcost% cache-write weighted units ÷ total authoring cost-units (cost weight of cache writes; far above their ~3% token share because write weights are 1.25×/2×; includes all records — main-thread and sidechain — unlike FullRecache)",
  "  ReviewMult  satellite cost-units ÷ authoring cost-units",
  "  *cost       RELATIVE per-Mtok cost-proxy (src/pricing.ts weightedUnits) — NOT dollars; only ratios are meaningful.",
  "  Out of scope: account-wide periodic distiller (/tmp/shepherd-distill-*) is not per-task and is never attributed here.",
];

function render(
  title: string,
  rows: ReportRow[],
  residual: SatelliteResult["residual"],
  md: boolean,
): string {
  const cells = rows.map(rowCells);
  cells.push(totalsCells(rows));
  const table = md ? renderMarkdownTable(cells) : renderPlainTable(cells);
  const parts: string[] = [];
  parts.push(md ? `## ${title}` : `=== ${title} ===`);
  parts.push("");
  parts.push(table);
  parts.push("");
  if (residual.length) {
    const rTokens = residual.reduce((s, x) => s + x.usage.total, 0);
    const rCost = residual.reduce((s, x) => s + x.costUnits, 0);
    const line = `Unlinked-in-window residual: ${residual.length} review dir(s), ${fmtInt(
      rTokens,
    )} tokens, ${fmtUnits(rCost)} cost-units (flagged — not merged into any task).`;
    parts.push(md ? `> ${line}` : line);
    parts.push("");
  }
  parts.push(
    (md ? LEGEND.map((l) => (l === "Legend:" ? `**${l}**` : `- ${l.trim()}`)) : LEGEND).join("\n"),
  );
  return parts.join("\n");
}

// ── main ──────────────────────────────────────────────────────────────────--

async function buildGroup(
  rows: SessionRow[],
  reviews: ReviewRow[],
  planGates: PlanGateRow[],
  spawns: ReviewerSpawnRow[],
): Promise<{ reportRows: ReportRow[]; residual: SatelliteResult["residual"] }> {
  const resolved = await Promise.all(rows.map(resolveSession));
  const sat = await attributeSatellites(resolved, reviews, planGates, spawns);
  const reportRows = resolved.map((s) => buildRow(s, sat.bySession.get(s.row.id) ?? []));
  // One aggregated stderr line for all sessions carrying sub-agent records, so a
  // reader knows FullRecache (main-thread only) doesn't reflect their cold sidechains.
  const withSidechains = resolved
    .filter((s) => s.authoring.usage.sidechainCount > 0)
    .map((s) => `${s.row.desig}×${s.authoring.usage.sidechainCount}`);
  if (withSidechains.length) {
    console.warn(
      `[usage-report] sidechain (sub-agent) records present — FullRecache counts main-thread only: ${withSidechains.join(", ")}`,
    );
  }
  return { reportRows, residual: sat.residual };
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const db = openDb();

  const reviews = db.query<ReviewRow, []>("SELECT sessionId, headSha FROM reviews").all();
  const planGates = db.query<PlanGateRow, []>("SELECT sessionId FROM plan_gates").all();
  // An older DB (server not yet restarted onto the #502 migration) may lack this table;
  // fall back to no exact links — the heuristic chain below still attributes satellites.
  let spawns: ReviewerSpawnRow[] = [];
  try {
    spawns = db
      .query<ReviewerSpawnRow, []>(
        "SELECT reviewerSessionId, taskSessionId, model, totalTokens, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens FROM reviewer_spawns",
      )
      .all();
  } catch {
    /* table absent on legacy DBs */
  }

  let primary: SessionRow[];
  let title: string;
  if (args.desigs.length) {
    primary = fetchByDesig(db, args.desigs);
    title = `Explicit tasks (${args.desigs.join(", ")})`;
  } else if (args.recent !== null) {
    primary = fetchRecent(db, args.recent);
    title = `${args.recent} most-recent task sessions (operational archetypes excluded)`;
  } else {
    primary = fetchByDesig(db, DEFAULT_SAMPLE);
    title = `Default sample (${DEFAULT_SAMPLE.join(", ")})`;
  }

  const { reportRows, residual } = await buildGroup(primary, reviews, planGates, spawns);
  const out: string[] = [render(title, reportRows, residual, args.md)];

  if (args.includeExcluded) {
    const excluded = fetchExcluded(db, args.recent ?? 5);
    const eg = await buildGroup(excluded, reviews, planGates, spawns);
    out.push("");
    out.push(
      render("Appendix: excluded operational archetypes", eg.reportRows, eg.residual, args.md),
    );
  }

  db.close();
  process.stdout.write(out.join("\n\n") + "\n");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
