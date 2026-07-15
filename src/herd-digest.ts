/**
 * HerdDigestService — synthesizes a cross-session "what needs a human right now?"
 * attention digest once per calendar day via a transient role spawn. Mirrors
 * RecapService structure, but keyed by calendar DAY (single-flight) instead of by
 * session head:
 *   sweep()      — daily auto-spark (presence-gated, non-empty herd, once/day)
 *   tick()       — finalize the in-flight digest (restart-safe, reads from DB)
 *   generate()   — shared spawn path (auto + on-demand)
 *   regenerate() — on-demand force (re-spawns today's digest even if ready)
 *   snapshot()   — latest digest for client bootstrap
 *
 * Spawn pattern mirrors src/recap.ts: tmpdir cwd and the provider-specific
 * writer-only transient-agent sandbox. No worktree, no membrane. All herd state
 * is supplied via injected accessors so the service stays unit-testable and never
 * reaches into index.ts's live caches directly (Task 3 wires the real ones).
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionStore } from "./store";
import type { HerdrDriver } from "./herdr";
import type { HerdDigest, ReviewVerdict, PlanGate, Recap, RundownEpicItem } from "./types";
import type { GitState } from "./forge/types";
import type { SessionUsage } from "./usage";
import { readSessionUsage } from "./usage";
import { apiKeyFailClosed, apiKeyPassthroughEnv } from "./spawn-auth";
import type { OperatorLanguage } from "./operator-language";
import type { RoleEnvironment } from "./default-model";
import { buildTransientAgentArgv } from "./transient-agent-argv";
import {
  assembleHerdState,
  buildRundownPrompt,
  parseRundownVerdict,
  attentionFingerprint,
  classifyAttention,
  RUNDOWN_VERDICT_FILE,
  RUNDOWN_DEFAULT_TOPN,
  RUNDOWN_EPICS_CAP,
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
 * The rundown spawn's argv — the shared `writer-only` transient-agent shape. The input is
 * cross-session digest text (UNTRUSTED); write access is constrained by the selected provider's
 * sandbox shape, not an input-trust claim. See buildTransientAgentArgv for the isolation rationale.
 */
function rundownArgv(
  environment: RoleEnvironment,
  prompt: string,
): { argv: string[]; sessionId: string } {
  return buildTransientAgentArgv("writer-only", {
    provider: environment.provider,
    model: environment.model,
    effort: environment.effort,
    prompt,
  });
}

function rundownSpawnEnv(environment: RoleEnvironment): Record<string, string> | undefined {
  if (environment.provider !== "claude") return undefined;
  return apiKeyPassthroughEnv(false);
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
  /** Backlog-priority rank per repoPath (lower = higher priority) from the warm /api/backlog
   *  cache; weights focusNext within a tier. Optional — absent → no backlog weighting. */
  backlogPriority?: () => Record<string, number>;
  /** Landing-ready completed epics to surface as Tier-1 "land this epic" items (#1045). Async —
   *  the index.ts wiring does forge probes (TTL-memoized) to compute readiness. Resolved inside
   *  generate() (≤once/day) and reconcileEpics(). Optional — absent → no epic surfacing. */
  landingReadyEpics?: () => Promise<RundownEpicItem[]>;
  /** Cheap sync signal: any completed epic currently in landingState 'open' (DB-only). Used ONLY
   *  as the sweep() pre-filter so an idle herd with a pending epic still triggers generate(); the
   *  authoritative not-ready→no-spawn decision lives in generate(). Optional — absent → false. */
  hasOpenLandingEpics?: () => boolean;
  /** Live role environment, resolved per spawn so Settings changes need no restart. */
  environment?: () => RoleEnvironment;
  /** Live operator-language setting, read per spawn (#1586). Absent → "en" (no directive). */
  operatorLanguage?: () => OperatorLanguage;
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
  private environment: () => RoleEnvironment;
  private operatorLanguage: () => OperatorLanguage;

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
    this.environment =
      deps.environment ?? (() => ({ provider: "claude", model: "sonnet", effort: "low" }));
    this.operatorLanguage = deps.operatorLanguage ?? (() => "en");
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

  // ── reapGenerating ───────────────────────────────────────────────────────────

  /**
   * Reap an existing generating row for this dayKey (stop its pane + clean its tmpdir).
   * Called before a forced regenerate launches a replacement, so the old in-flight
   * spawn doesn't leak: putHerdDigest will overwrite the row (same dayKey PK) with the
   * new cwd/spawnSessionId, after which tick() could never finalize the orphan.
   * No-op when there's no generating row (mirrors RecapService.reapGenerating). No row
   * drop needed — putHerdDigest overwrites by dayKey.
   */
  private reapGenerating(dayKey: string): void {
    const existing = this.deps.store.getHerdDigest(dayKey);
    if (!existing || existing.state !== "generating") return;
    try {
      void this.deps.herdr.stop(this.resolveTerminal(existing.cwd)).catch(() => {});
    } catch {
      /* best-effort */
    }
    this._cleanup(existing.cwd);
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
    // Pre-filter (cheap): skip only when the herd is empty AND no completed epic is awaiting landing.
    // The epic DB check runs only when there are no active sessions, so the 15s tick stays cheap.
    // generate() is the authority on whether an actually-ready epic warrants a spawn (#1045).
    if (
      this.deps.store.list({ activeOnly: true }).length === 0 &&
      !(this.deps.hasOpenLandingEpics?.() ?? false)
    )
      return;

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
    const environment = this.environment();
    // Fail closed only for Claude: Codex authenticates independently of the Anthropic API key.
    if (apiKeyFailClosed(environment.provider)) {
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
      // Reap any in-flight row for this dayKey first (forced regenerate over a
      // generating row): stop its orphaned pane + clean its tmpdir before the
      // replacement spawn overwrites the row (same dayKey PK). No-op otherwise.
      this.reapGenerating(dayKey);

      const sessions = this.deps.store.list({ activeOnly: true });

      // Resolve the landing-ready epic set (forge-backed, TTL-memoized in the wiring) BEFORE the
      // empty-guard: an idle/empty herd should still spawn when an epic is genuinely ready to land,
      // but an open-but-NOT-ready epic (e.g. CI red) must NOT trigger an all-clear spawn for nothing.
      const epicsToLand = (await this.deps.landingReadyEpics?.()) ?? [];
      if (sessions.length === 0 && epicsToLand.length === 0) return "empty";

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
        backlogRank: this.deps.backlogPriority?.(),
        epics: epicsToLand,
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

      const prompt = buildRundownPrompt(assembled, this.operatorLanguage());
      const { argv, sessionId: spawnSessionId } = rundownArgv(environment, prompt);

      const cwd = this._makeTmpDir();
      try {
        await this.deps.herdr.start("rundown", cwd, argv, rundownSpawnEnv(environment));
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
        reviewerProvider: environment.provider,
        model: environment.model,
        reviewerEffort: environment.effort ?? null,
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
        // Deterministic ground truth (NOT from the LLM verdict): captured at spawn time so the epic
        // section survives finalize/failed and is kept live intraday by reconcileEpics() (#1045).
        epicsToLand: assembled.epics,
        attentionFingerprint: fingerprint,
        spawnSessionId,
        cwd,
        model: environment.model,
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

    await this.reconcileEpics();
  }

  // ── reconcileEpics ─────────────────────────────────────────────────────────────

  /**
   * Keep today's settled digest's `epicsToLand` live as landing readiness flips intraday (#1045).
   *
   * `epicsToLand` is frozen on the row at spawn time. Without this, an epic whose CI goes green
   * AFTER the digest was generated would never surface (sweep early-returns on the existing settled
   * row, and epics are deliberately out of the attentionFingerprint, so staleCount never moves —
   * staleCount is also bootstrap-only). Because `epicsToLand` is server ground truth (never parsed
   * from the LLM verdict), we recompute it and update the row IN PLACE — no re-spawn, no LLM call —
   * then push it over `herd:digest` so the panel's epic section updates live. Self-heals both ways
   * (readiness gained, or lost/landed).
   *
   * Targets BOTH `ready` and `failed` digests: RundownPanel renders the epic section in either state
   * (it is ground truth, not LLM output), so a `failed` digest must be kept live too — otherwise it
   * would freeze a stale/landed "land this epic" entry until a manual regenerate.
   *
   * Cheap by construction: when no epic is open the (memoized) accessor short-circuits to [] with no
   * forge call; the deep-equality check makes the in-place write + WS push fire only on a real change.
   */
  private reconcilingEpics = false;
  async reconcileEpics(): Promise<void> {
    if (this.reconcilingEpics) return; // overlapping ticks: one at a time
    if (!this.deps.landingReadyEpics) return; // nothing to reconcile against
    const latest = this.deps.store.getLatestHerdDigest();
    if (!latest || (latest.state !== "ready" && latest.state !== "failed")) return;
    if (latest.dayKey !== dayKeyFor(this.now())) return; // only today's settled digest
    // A regenerate for today is mid-flight — don't fight it.
    if (this.inFlight.has(latest.dayKey) || this.finalizing.has(latest.dayKey)) return;

    this.reconcilingEpics = true;
    try {
      // Cap to the same bound assembleHerdState applies at spawn time (RundownPanel renders
      // epicsToLand uncapped, so the intraday list must honor the same ceiling for consistency).
      const current = ((await this.deps.landingReadyEpics()) ?? []).slice(0, RUNDOWN_EPICS_CAP);
      // Deep (ordered) equality is the only check needed — write whenever the rendered list differs
      // in membership OR shape (e.g. stranded flipped, landing PR appeared). A bare reorder of the
      // same epics would also write, but listEpicCompleted's stable completedAt-DESC ordering makes
      // that vanishingly rare.
      if (JSON.stringify(latest.epicsToLand) === JSON.stringify(current)) return; // no change → no-op

      const t = this.now();
      const updated: HerdDigest = { ...latest, epicsToLand: current, updatedAt: t };
      this.deps.store.putHerdDigest(updated);
      this.deps.onChange(updated);
    } finally {
      this.reconcilingEpics = false;
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
        await this.deps.herdr.stop(this.resolveTerminal(d.cwd));
      } catch {
        /* best-effort */
      }
      this._cleanup(d.cwd);
    }
  }

  // ── currentAttentionFingerprint ───────────────────────────────────────────────

  /**
   * Fingerprint the herd's CURRENT attention surface from the live in-memory caches,
   * with the SAME logic generate() uses at spawn time. The route diffs a stored digest's
   * `attentionFingerprint` against this to derive `staleCount` (how far the herd drifted).
   * Cheap + pure-classification: no spawn, no DB write; reads the injected snapshots once.
   * `stalledSessionIds`/`mergeTrainState` are optional, so a herd missing them still scores.
   */
  currentAttentionFingerprint(): Record<string, string[]> {
    const now = this.now();
    const sessions = this.deps.store.list({ activeOnly: true });
    const snap = this.deps.snapshots();
    const stalled = this.deps.stalledSessionIds?.() ?? new Set<string>();
    const train = this.deps.mergeTrainState?.();
    return attentionFingerprint(
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
  }

  // ── snapshot ─────────────────────────────────────────────────────────────────

  /** Latest digest for client bootstrap (null when none generated yet). */
  snapshot(): HerdDigest | null {
    return this.deps.store.getLatestHerdDigest();
  }
}
