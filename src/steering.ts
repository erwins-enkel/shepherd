/**
 * Steering report service (#4175): the I/O half of the in-app `/prompt-retro` port. Reads the
 * window's archived sessions and their transcripts, reduces them with src/steering-core.ts, has a
 * transient helper LABEL the prompts and steers, computes every table number itself, and persists
 * the report. Never throws: every failure persists a `failed` report with a reason.
 *
 * Helper lifecycle mirrors src/task-shape.ts / src/prompt-recommend.ts: fresh temp dir, spawn,
 * poll for the result file, reap pane + dir in a `finally`. The helper is `writer-only` (bare
 * `Write`, dontAsk, hooks off) with NO `--add-dir`: everything it needs is in the prompt, so it can
 * reach nothing outside its scratch dir. Its input is operator/agent text, fenced as untrusted.
 *
 * Runs are single-flight and in memory: a run lost to a restart simply ends, and its tab is reaped
 * by {@link STEERING_LABEL} (boot reap in index.ts + the tab reaper).
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoleEnvironment } from "./default-model";
import type { HerdrDriver } from "./herdr";
import type { OperatorLanguage } from "./operator-language";
import { fitAssembledPrompt } from "./prompt-fit";
import { apiKeyFailClosed, apiKeyPassthroughEnv } from "./spawn-auth";
import { spawnBudget } from "./spawn-budget";
import {
  STEERING_RESULT_FILE,
  buildSteeringPrompt,
  computeSteeringTables,
  labelsForStatus,
  parseSteeringResult,
  reportSessionsOf,
  selectSteeringSessions,
  steeringStatus,
  steeringTrend,
  summarizeSteering,
  weeklySteeringDue,
  type SteeringDigest,
  type SteeringLabels,
  type SteeringMessages,
  type SteeringReport,
  type SteeringReportTrigger,
  type SteeringSessionInput,
  type SteeringTrendPoint,
} from "./steering-core";
import type { SessionStore } from "./store";
import {
  cleanupHelperDir,
  makeHelperTmpDir,
  reapHelperRun,
  realSleep,
} from "./transient-helper-lifecycle";
import { buildTransientAgentArgv } from "./transient-agent-argv";
import type { Session } from "./types";

/** Label prefix for the labelling helper (`steering <hex>`). Space-prefixed so a prompt-derived
 *  `[a-z0-9-]` session slug can never collide; registered with the tab reaper + boot reap. */
export const STEERING_LABEL = "steering ";

/** Settings key: id of the newest weekly report the operator has opened (#4176 unread dot). */
export const STEERING_SEEN_SETTING = "steeringReportSeenId";

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_CAP = 60;
const READ_CONCURRENCY = 4;
const TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 3000;
/** Linux caps ONE argv element at 128 KiB regardless of the whole-argv budget (as recap.ts). */
const ARG_ELEMENT_MAX = 128 * 1024 - 1;

/** What the service pushes to listeners: a status signal only, never the report body. The `/events`
 *  stream reaches read-scope tokens while GET /api/steering/report is full-scope, so findings and
 *  rewrites must not ride the frame; clients re-GET the report on finish. */
export type SteeringEvent =
  { running: true } | { running: false; id: string; status: SteeringReport["status"] };

export interface SteeringReportDeps {
  store: Pick<
    SessionStore,
    | "listArchivedSessions"
    | "insertSteeringReport"
    | "latestSteeringReport"
    | "listSteeringReports"
    | "getSetting"
    | "setSetting"
  >;
  /** One session's transcript, read async (the composition root reads it via `sessionMessages`). */
  readMessages: (session: Session) => Promise<SteeringMessages>;
  herdr: Pick<HerdrDriver, "start" | "stop">;
  /** The helper's CLI/model/effort — the recap role environment. */
  env: () => RoleEnvironment;
  operatorLanguage?: () => OperatorLanguage;
  now?: () => number;
  emit?: (event: SteeringEvent) => void;
  /** True while the usage hold is active: the weekly tick defers instead of spawning (#4176). */
  usageHeld?: () => boolean;
  /** A weekly run produced an `ok`/`thin` report: the composition root pushes the digest. */
  onWeeklyReady?: (report: SteeringReport) => void;
  makeTmpDir?: () => string;
  readResult?: (cwd: string) => Promise<unknown>;
  cleanup?: (cwd: string) => void;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
}

/** A labelling run's outcome: labels over the (possibly trimmed) digest it ran on, or an error. */
type LabelOutcome =
  { digest: SteeringDigest; labels: SteeringLabels } | { digest: SteeringDigest; error: string };

async function defaultReadResult(cwd: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(cwd, STEERING_RESULT_FILE), "utf8")) as unknown;
  } catch {
    return null; // not written yet, or a partial write; try again next poll
  }
}

/** The reduction's view of a session; `Session` already carries every field under these names. */
function steeringInputOf(s: Session): SteeringSessionInput {
  return {
    id: s.id,
    desig: s.desig,
    prompt: s.prompt,
    repoPath: s.repoPath,
    auto: s.auto,
    issueNumber: s.issueNumber,
    scheduleId: s.scheduleId ?? null,
    landingRepair: s.landingRepair,
    terminal: s.terminal ?? false,
    archiveReason: s.archiveReason ?? null,
    createdAt: s.createdAt,
    settledAt: s.settledAt ?? null,
    archivedAt: s.archivedAt,
  };
}

/** Map `items` through `fn` with at most `limit` in flight, preserving order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err || "error");

/** A report worth reading: the weekly digest notifies, marks unread and feeds the trend. */
const isDigest = (r: SteeringReport): boolean => r.status === "ok" || r.status === "thin";

/** Keep the newest `n` sessions; a trimmed digest says so in its sample. */
function trimDigest(digest: SteeringDigest, n: number): SteeringDigest {
  if (n >= digest.sessions.length) return digest;
  return {
    sample: { ...digest.sample, considered: n, capped: true },
    sessions: digest.sessions.slice(0, n),
  };
}

export class SteeringReportService {
  private running = false;
  private readonly now: () => number;
  private readonly emit: (event: SteeringEvent) => void;

  constructor(private readonly deps: SteeringReportDeps) {
    this.now = deps.now ?? Date.now;
    this.emit = deps.emit ?? (() => {});
  }

  snapshot(): {
    running: boolean;
    report: SteeringReport | null;
    trend: SteeringTrendPoint[];
    unread: boolean;
  } {
    const store = this.deps.store;
    const weekly = store.listSteeringReports("weekly");
    const newest = weekly.find(isDigest);
    return {
      running: this.running,
      report: store.latestSteeringReport(),
      trend: steeringTrend(weekly),
      unread: !!newest && store.getSetting(STEERING_SEEN_SETTING) !== newest.id,
    };
  }

  /** The operator opened the report: the newest weekly digest is no longer unread. */
  markSeen(): void {
    const newest = this.deps.store.listSteeringReports("weekly").find(isDigest);
    if (newest) this.deps.store.setSetting(STEERING_SEEN_SETTING, newest.id);
  }

  /** The hourly weekly check (#4176): run when due, unless a run is in flight or usage is held. */
  async tickWeekly(): Promise<"ran" | "not-due" | "held" | "busy"> {
    if (this.running) return "busy";
    if (!weeklySteeringDue(this.deps.store.latestSteeringReport("weekly"), this.now())) {
      return "not-due";
    }
    if (this.deps.usageHeld?.()) {
      console.log("[steering] weekly run deferred: usage hold active");
      return "held";
    }
    return (await this.run("weekly")) ? "ran" : "busy";
  }

  /** Kick a run fire-and-forget. False when one is already in flight (the route's 409). */
  start(trigger: SteeringReportTrigger): boolean {
    if (this.running) return false;
    void this.run(trigger);
    return true;
  }

  /** One single-flight run. Resolves false without doing anything when a run is in flight. */
  async run(trigger: SteeringReportTrigger): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    this.emit({ running: true });
    const createdAt = this.now();
    let report: SteeringReport;
    try {
      report = await this.generate(trigger, createdAt);
    } catch (err) {
      report = this.report(trigger, createdAt, null, { status: "failed", error: errorText(err) });
    }
    try {
      this.deps.store.insertSteeringReport(report);
    } catch (err) {
      console.warn(`[steering] could not persist report ${report.id}: ${errorText(err)}`);
    }
    this.running = false;
    this.emit({ running: false, id: report.id, status: report.status });
    if (trigger === "weekly" && isDigest(report)) {
      try {
        this.deps.onWeeklyReady?.(report);
      } catch (err) {
        console.warn(`[steering] weekly notification failed: ${errorText(err)}`);
      }
    }
    return true;
  }

  private async generate(trigger: SteeringReportTrigger, now: number): Promise<SteeringReport> {
    const digest = await this.collect(now);
    if (steeringStatus(digest) === "empty") {
      return this.report(trigger, now, digest, { status: "empty" });
    }
    const env = this.deps.env();
    const model = env.model;
    const outcome = await this.label(digest, env);
    if ("error" in outcome) {
      return this.report(trigger, now, outcome.digest, {
        status: "failed",
        error: outcome.error,
        model,
      });
    }
    const status = steeringStatus(outcome.digest);
    if (status === "empty") return this.report(trigger, now, outcome.digest, { status, model });
    const labels = labelsForStatus(outcome.labels, status);
    const tables = computeSteeringTables(outcome.digest, labels);
    return this.report(trigger, now, outcome.digest, { status, model, labels, tables });
  }

  /** Select the window's sessions, read their transcripts (bounded concurrency), reduce. */
  private async collect(now: number): Promise<SteeringDigest> {
    const all = this.deps.store.listArchivedSessions();
    const inputs = all.map(steeringInputOf);
    const window = { now, windowMs: WINDOW_MS, cap: SESSION_CAP };
    const byId = new Map(all.map((s) => [s.id, s]));
    const kept = selectSteeringSessions(inputs, window).kept.flatMap((k) => {
      const s = byId.get(k.id);
      return s ? [s] : [];
    });
    const reads = await mapLimit(kept, READ_CONCURRENCY, (s) => this.readOne(s));
    const messages = new Map(kept.map((s, i) => [s.id, reads[i] as SteeringMessages]));
    return summarizeSteering(inputs, messages, window);
  }

  private async readOne(s: Session): Promise<SteeringMessages> {
    try {
      return await this.deps.readMessages(s);
    } catch (err) {
      return { messages: [], unavailable: `read-failed: ${errorText(err)}` };
    }
  }

  /** Spawn the labelling helper over `digest` and validate its result. */
  private async label(digest: SteeringDigest, env: RoleEnvironment): Promise<LabelOutcome> {
    // Fail closed: api-key mode without a configured key must NOT bill the subscription.
    if (apiKeyFailClosed(env.provider)) return { digest, error: "unavailable" };
    const spawnEnv = env.provider === "claude" ? apiKeyPassthroughEnv(false) : undefined;
    const sessionId = randomUUID();
    const argvFor = (prompt: string): string[] =>
      buildTransientAgentArgv("writer-only", {
        provider: env.provider,
        model: env.model,
        effort: env.effort ?? null,
        prompt,
        sessionId,
      }).argv;

    let fitted: { digest: SteeringDigest; prompt: string } | null;
    try {
      fitted = this.fitPrompt(digest, (p) => ({ wrapped: argvFor(p), spawnEnv }));
    } catch (err) {
      return { digest, error: errorText(err) };
    }
    if (!fitted) return { digest, error: "oversized" };
    const result = await this.spawnAndPoll(argvFor(fitted.prompt), spawnEnv);
    if ("error" in result) return { digest: fitted.digest, error: result.error };
    const labels = parseSteeringResult(result.raw, fitted.digest);
    return labels
      ? { digest: fitted.digest, labels }
      : { digest: fitted.digest, error: "unparseable" };
  }

  /** Fit the prompt inside the argv budget by dropping the oldest sessions (#1944), or null. */
  private fitPrompt(
    digest: SteeringDigest,
    assemble: (p: string) => { wrapped: string[]; spawnEnv?: Record<string, string> },
  ): { digest: SteeringDigest; prompt: string } | null {
    const language = this.deps.operatorLanguage?.() ?? "en";
    const budget = spawnBudget(assemble);
    // Items are session positions; clampList drops from the tail (oldest) and appends a marker.
    const kept = (items: string[]) => items.filter((x) => /^\d+$/.test(x)).length;
    const fit = fitAssembledPrompt({
      ...budget,
      budget: Math.min(budget.budget, ARG_ELEMENT_MAX),
      specs: [
        {
          id: "sessions",
          kind: "list",
          items: digest.sessions.map((_, i) => String(i)),
          noun: "sessions",
        },
      ],
      compose: (v) =>
        buildSteeringPrompt(trimDigest(digest, kept(v.sessions as string[])), language),
    });
    if (!fit.ok) {
      console.warn(`[steering] refusing to spawn the labeller: ${fit.detail}`);
      return null;
    }
    const dropped = fit.clamps[0]?.droppedItems ?? 0;
    if (dropped) console.warn(`[steering] prompt fitted to the argv limit: −${dropped} sessions`);
    return { digest: trimDigest(digest, digest.sessions.length - dropped), prompt: fit.prompt };
  }

  private async spawnAndPoll(
    argv: string[],
    spawnEnv: Record<string, string> | undefined,
  ): Promise<{ raw: unknown } | { error: string }> {
    const cleanup = this.deps.cleanup ?? cleanupHelperDir;
    let cwd: string | null = null;
    let terminalId: string | null = null;
    try {
      cwd = (this.deps.makeTmpDir ?? (() => makeHelperTmpDir("shepherd-steering-")))();
      const label = `${STEERING_LABEL}${randomUUID().slice(0, 8)}`;
      try {
        terminalId = (await this.deps.herdr.start(label, cwd, argv, spawnEnv)).terminalId;
      } catch (err) {
        return { error: `spawn-failed: ${errorText(err)}` };
      }
      const raw = await this.poll(cwd);
      return raw === null ? { error: "timeout" } : { raw };
    } finally {
      await reapHelperRun(this.deps.herdr, terminalId, cwd, cleanup);
    }
  }

  private async poll(cwd: string): Promise<unknown> {
    const readResult = this.deps.readResult ?? defaultReadResult;
    const sleep = this.deps.sleep ?? realSleep;
    const timeoutMs = this.deps.timeoutMs ?? TIMEOUT_MS;
    const pollMs = this.deps.pollMs ?? POLL_MS;
    const start = this.now();
    while (this.now() - start <= timeoutMs) {
      const raw = await readResult(cwd);
      if (raw !== null) return raw;
      await sleep(pollMs);
    }
    return null;
  }

  private report(
    trigger: SteeringReportTrigger,
    createdAt: number,
    digest: SteeringDigest | null,
    fields: Partial<Pick<SteeringReport, "error" | "model" | "labels" | "tables">> &
      Pick<SteeringReport, "status">,
  ): SteeringReport {
    return {
      id: randomUUID(),
      createdAt,
      windowStart: digest?.sample.windowStart ?? createdAt - WINDOW_MS,
      windowEnd: digest?.sample.windowEnd ?? createdAt,
      trigger,
      status: fields.status,
      error: fields.error ?? null,
      model: fields.model ?? null,
      sample: digest?.sample ?? null,
      sessions: digest ? reportSessionsOf(digest) : [],
      labels: fields.labels ?? null,
      tables: fields.tables ?? null,
    };
  }
}
