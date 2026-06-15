/**
 * HerdDigestService — synthesizes a cross-session "what needs a human right now?"
 * attention digest once per calendar day via a transient Sonnet spawn. Mirrors
 * RecapService structure, but keyed by calendar DAY (single-flight) instead of by
 * session head:
 *   sweep()      — daily auto-spark (presence-gated, non-empty herd, once/day)
 *   tick()       — finalize the in-flight digest (restart-safe, reads from DB)
 *   generate()   — shared spawn path (auto + on-demand)
 *   regenerate() — on-demand force (re-spawns today's digest even if ready)
 *   snapshot()   — latest digest for client bootstrap
 *
 * Spawn pattern mirrors src/recap.ts: tmpdir cwd, Write-only, dontAsk,
 * disableAllHooks, disable-slash-commands. No worktree, no membrane. All herd
 * state is supplied via injected accessors so the service stays unit-testable and
 * never reaches into index.ts's live caches directly (Task 3 wires the real ones).
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionStore } from "./store";
import type { HerdrDriver } from "./herdr";
import type { HerdDigest, ReviewVerdict, PlanGate, Recap } from "./types";
import type { GitState } from "./forge/types";
import type { SessionUsage } from "./usage";
import { readSessionUsage } from "./usage";
import {
  isApiKeyMode,
  isApiKeyConfigured,
  apiKeySettingsFragment,
  apiKeyPassthroughEnv,
} from "./spawn-auth";
import {
  assembleHerdState,
  buildRundownPrompt,
  parseRundownVerdict,
  attentionFingerprint,
  classifyAttention,
  RUNDOWN_VERDICT_FILE,
  RUNDOWN_DEFAULT_TOPN,
} from "./rundown-core";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

// ── injected accessor shapes ────────────────────────────────────────────────────

/** Per-session in-memory caches the rundown classifies on, keyed by session id. */
export interface HerdSnapshots {
  git: Record<string, GitState>;
  reviews: Record<string, ReviewVerdict>;
  gates: Record<string, PlanGate>;
  recaps: Record<string, Recap>;
}

/** Merge-train state the rundown folds in: which PRs are queued + per-session train
 *  status (e.g. an errored run). Task 3 supplies the live source. */
export interface MergeTrainState {
  queuedPrs: number[];
  bySession: Record<string, { error?: boolean }>;
}

// ── defaults ────────────────────────────────────────────────────────────────────

function defaultReadVerdict(cwd: string): string | null {
  const p = join(cwd, RUNDOWN_VERDICT_FILE);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null; // partial write; retry next tick
  }
}

function defaultMakeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "shepherd-rundown-"));
}

function defaultCleanup(cwd: string): void {
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * The `claude` argv for the rundown spawn — mirrors recapArgv exactly.
 *
 * Layout: --session-id uuid --settings '{"disableAllHooks":true}'
 *   --disable-slash-commands --allowedTools Write [--model <m>]
 *   --permission-mode dontAsk <prompt>
 * NOTE: --allowedTools is variadic and eats tokens until the next flag, so
 * --permission-mode must follow it and the prompt must be last. Don't reorder.
 */
function rundownArgv(model: string | null, prompt: string): { argv: string[]; sessionId: string } {
  const sessionId = randomUUID();
  const argv = [
    "claude",
    "--session-id",
    sessionId,
    "--settings",
    JSON.stringify({ disableAllHooks: true, ...apiKeySettingsFragment() }),
    "--disable-slash-commands",
    "--allowedTools",
    "Write",
  ];
  if (model) argv.push("--model", model);
  argv.push("--permission-mode", "dontAsk");
  argv.push(prompt);
  return { argv, sessionId };
}

/** `YYYY-MM-DD` for the operator's LOCAL day at `now`. The single-flight key. */
export function dayKeyFor(now: number): string {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Start-of-local-day epoch ms for `now` — the overnightDelta floor when no prior digest. */
function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ── deps ──────────────────────────────────────────────────────────────────────

export interface HerdDigestServiceDeps {
  store: Pick<
    SessionStore,
    | "getHerdDigest"
    | "getLatestHerdDigest"
    | "putHerdDigest"
    | "generatingHerdDigests"
    | "overnightDelta"
    | "recordReviewerSpawn"
    | "completeReviewerSpawn"
    | "list"
  >;
  herdr: Pick<HerdrDriver, "start" | "stop" | "list">;
  /** Operator-present gate for the daily auto-spark. */
  isActive: () => boolean;
  onChange: (digest: HerdDigest) => void;
  /** Per-session caches to classify on (index.ts live caches in Task 3). */
  snapshots: () => HerdSnapshots;
  /** Session ids currently detected as stalled (transcript-derived; supplied by Task 3). */
  stalledSessionIds?: () => Set<string>;
  /** Merge-train state (queued PRs + per-session errors); supplied by Task 3. */
  mergeTrainState?: () => MergeTrainState;
  model?: string | null;
  now?: () => number;
  timeoutMs?: number;
  topN?: number;
  // injectables (testing):
  readVerdict?: (cwd: string) => string | null;
  readUsage?: (cwd: string, spawnSessionId: string) => Promise<SessionUsage | null>;
  makeTmpDir?: () => string;
  cleanup?: (cwd: string) => void;
}

export type GenerateResult = "started" | "in-flight" | "empty" | "error";

// ── service ─────────────────────────────────────────────────────────────────────

export class HerdDigestService {
  private now: () => number;
  private timeoutMs: number;
  private topN: number;
  private model: string | null;

  private _readVerdict: (cwd: string) => string | null;
  private _readUsage: (cwd: string, spawnSessionId: string) => Promise<SessionUsage | null>;
  private _makeTmpDir: () => string;
  private _cleanup: (cwd: string) => void;

  /** Single-flight guard keyed by dayKey, against a regenerate racing a mid-flight spawn. */
  private inFlight = new Set<string>();
  /** Guards a digest being finalized twice across overlapping ticks. */
  private finalizing = new Set<string>();

  constructor(private deps: HerdDigestServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.topN = deps.topN ?? RUNDOWN_DEFAULT_TOPN;
    this.model = deps.model ?? "sonnet";
    this._readVerdict = deps.readVerdict ?? defaultReadVerdict;
    this._readUsage = deps.readUsage ?? readSessionUsage;
    this._makeTmpDir = deps.makeTmpDir ?? defaultMakeTmpDir;
    this._cleanup = deps.cleanup ?? defaultCleanup;
  }

  // ── resolveTerminal ────────────────────────────────────────────────────────────

  /** Find a rundown spawn's live terminal by its tmpdir cwd. "" when gone; stop("") is a no-op. */
  private resolveTerminal(cwd: string): string {
    return this.deps.herdr.list().find((a) => a.cwd === cwd)?.terminalId ?? "";
  }

  // ── sweep ──────────────────────────────────────────────────────────────────────

  /**
   * Daily auto-spark — the "first look of the day". Fires generate() at most once per
   * calendar day when ALL of:
   *   (a) no `ready` or `generating` digest exists for today's dayKey,
   *   (b) the operator is present (isActive()), and
   *   (c) the herd is non-empty (≥1 active session).
   * Idempotent/safe to call every tick: a `failed` digest for today is allowed to
   * re-spark (the day's look is still owed); a `ready`/`generating` one is not.
   */
  async sweep(): Promise<void> {
    const now = this.now();
    const dayKey = dayKeyFor(now);

    const existing = this.deps.store.getHerdDigest(dayKey);
    if (existing && (existing.state === "ready" || existing.state === "generating")) return;
    if (this.inFlight.has(dayKey)) return;

    if (!this.deps.isActive()) return;
    if (this.deps.store.list({ activeOnly: true }).length === 0) return;

    await this.generate();
  }

  // ── generate ─────────────────────────────────────────────────────────────────

  /**
   * Assemble the herd state, spawn a rundown agent, and write a `generating` row for
   * today's dayKey. Shared by sweep (auto) and regenerate (on-demand).
   *
   * Returns:
   *   "in-flight" — a generating row already exists for today, or a spawn is mid-flight.
   *   "empty"     — the herd has no active sessions at all; nothing to triage, no spawn.
   *   "started"   — spawn launched; a generating row is written for today.
   *   "error"     — herdr.start failed (or api-key fail-closed); tmpdir cleaned, no row.
   *
   * NOTE: a herd with active sessions but ZERO attention-bearing ones still spawns — the
   * digest can legitimately say "all clear". Only a completely empty herd short-circuits.
   * Does NOT throw — a spawn failure self-heals to "error".
   * `opts.force` (regenerate) bypasses the existing-generating-row skip.
   */
  async generate(opts?: { force?: boolean }): Promise<GenerateResult> {
    // Fail closed: api-key mode without a configured key must NOT bill the subscription.
    if (isApiKeyMode() && !isApiKeyConfigured()) {
      console.warn(
        "[rundown] api-key mode enabled but no API key configured — skipping (fail closed)",
      );
      return "error";
    }

    const now = this.now();
    const dayKey = dayKeyFor(now);

    // Synchronous guard: never double-spawn the same day.
    if (this.inFlight.has(dayKey)) return "in-flight";

    // Skip an in-flight generating row unless forced (regenerate).
    if (!opts?.force) {
      const existing = this.deps.store.getHerdDigest(dayKey);
      if (existing?.state === "generating") return "in-flight";
    }

    this.inFlight.add(dayKey);
    try {
      const sessions = this.deps.store.list({ activeOnly: true });
      if (sessions.length === 0) return "empty";

      const snap = this.deps.snapshots();
      const stalled = this.deps.stalledSessionIds?.() ?? new Set<string>();
      const train = this.deps.mergeTrainState?.();

      // overnightDelta floor: the prior digest's generatedAt, else start-of-day.
      const latest = this.deps.store.getLatestHerdDigest();
      const sinceTs = latest?.generatedAt ?? startOfDay(now);
      const overnightDelta = this.deps.store.overnightDelta(sinceTs);

      const assembled = assembleHerdState({
        sessions,
        git: snap.git,
        reviews: snap.reviews,
        gates: snap.gates,
        recaps: snap.recaps,
        stalled,
        trains: train?.bySession,
        overnightDelta,
        generatedFor: dayKey,
        now,
        topN: this.topN,
      });

      // Fingerprint EVERY active session (not just the topN-kept) so drift is measured
      // against the full attention surface.
      const fingerprint = attentionFingerprint(
        sessions.map((s) => ({
          sessionId: s.id,
          signals: classifyAttention(
            s,
            {
              git: snap.git[s.id],
              review: snap.reviews[s.id],
              gate: snap.gates[s.id],
              recap: snap.recaps[s.id],
              train: train?.bySession[s.id],
              stalled: stalled.has(s.id),
            },
            now,
          ).signals,
        })),
      );

      const prompt = buildRundownPrompt(assembled);
      const { argv, sessionId: spawnSessionId } = rundownArgv(this.model, prompt);

      const cwd = this._makeTmpDir();
      try {
        this.deps.herdr.start("rundown", cwd, argv, apiKeyPassthroughEnv(false));
      } catch {
        this._cleanup(cwd);
        return "error"; // spawn failed; no row left so a later sweep can retry
      }

      const spawnedAt = this.now();

      this.deps.store.recordReviewerSpawn({
        reviewerSessionId: spawnSessionId,
        taskSessionId: "", // herd-wide — not bound to a single task
        kind: "rundown",
        worktreePath: cwd,
        model: this.model,
        spawnedAt,
      });

      const row: HerdDigest = {
        dayKey,
        state: "generating",
        overnight: "",
        decisions: [],
        ciRework: [],
        train: "",
        focusNext: [],
        attentionFingerprint: fingerprint,
        spawnSessionId,
        cwd,
        model: this.model,
        spawnedAt,
        generatedAt: null,
        updatedAt: spawnedAt,
      };
      this.deps.store.putHerdDigest(row);
      this.deps.onChange(row);

      return "started";
    } finally {
      this.inFlight.delete(dayKey);
    }
  }

  // ── regenerate ───────────────────────────────────────────────────────────────

  /** On-demand force (the ⟳ button): re-spawn today's digest even if it's already ready. */
  async regenerate(): Promise<GenerateResult> {
    return this.generate({ force: true });
  }

  // ── tick ─────────────────────────────────────────────────────────────────────

  /**
   * Finalize any generating digest whose verdict file is ready or that has timed out.
   * Restart-safe: reads from the DB, not memory.
   */
  async tick(): Promise<void> {
    for (const d of this.deps.store.generatingHerdDigests()) {
      if (this.finalizing.has(d.dayKey)) continue;

      const raw = this._readVerdict(d.cwd);
      const timedOut = this.now() - d.spawnedAt > this.timeoutMs;
      if (!raw && !timedOut) continue;

      this.finalizing.add(d.dayKey);
      try {
        await this.finalize(d, raw);
      } finally {
        this.finalizing.delete(d.dayKey);
      }
    }
  }

  private async finalize(d: HerdDigest, raw: string | null): Promise<void> {
    const t = this.now();
    let newRow: HerdDigest;
    try {
      const parsed = raw ? parseRundownVerdict(raw) : null;
      if (parsed) {
        newRow = {
          ...d,
          state: "ready",
          overnight: parsed.overnight,
          decisions: parsed.decisions,
          ciRework: parsed.ciRework,
          train: parsed.train,
          focusNext: parsed.focusNext,
          generatedAt: t,
          updatedAt: t,
        };
      } else {
        // timeout or unparseable — fail closed, never fake an empty "ready".
        newRow = { ...d, state: "failed", generatedAt: t, updatedAt: t };
      }
      this.deps.store.putHerdDigest(newRow);
      this.deps.onChange(newRow);

      // Best-effort usage capture (backfills the true model from the transcript).
      try {
        const u = await this._readUsage(d.cwd, d.spawnSessionId);
        if (u) this.deps.store.completeReviewerSpawn(d.spawnSessionId, u, t);
      } catch (err) {
        console.warn(`[rundown] usage capture failed for ${d.dayKey}:`, err);
      }
    } finally {
      // Always reap pane + tmpdir.
      try {
        this.deps.herdr.stop(this.resolveTerminal(d.cwd));
      } catch {
        /* best-effort */
      }
      this._cleanup(d.cwd);
    }
  }

  // ── snapshot ─────────────────────────────────────────────────────────────────

  /** Latest digest for client bootstrap (null when none generated yet). */
  snapshot(): HerdDigest | null {
    return this.deps.store.getLatestHerdDigest();
  }
}
