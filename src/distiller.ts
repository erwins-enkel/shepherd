import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readRoleResultText, CODEX_LAST_MESSAGE_FILE } from "./codex-last-message";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionStore } from "./store";
import type { HerdrDriver } from "./herdr";
import { HerdrUnavailableError } from "./herdr";
import type { Signal, SignalKind } from "./types";
import { sanitizeScopeGlobs } from "./house-rules";
import { apiKeyFailClosed, apiKeyPassthroughEnv } from "./spawn-auth";
import { buildTransientAgentArgv } from "./transient-agent-argv";
import { reapTransientByLabel } from "./transient-tab-reaper";
import type { RoleEnvironment } from "./default-model";
import { normalizeRule } from "./learning-rule";

const PROPOSALS_FILE = ".shepherd-learnings.json";

/** Signal kinds the learnings distiller does NOT mine for code-review patterns.
 *  `egress_drop` (a blocked-host name) and `backup_stale` (#1080, a host-global backup-health
 *  alert) are operational, not code-review signals — feeding them to the rule-proposal LLM would
 *  pollute the corpus and count toward the distill threshold. `injection_detected` and
 *  `untrusted_author` are security telemetry for the same reason. */
const NON_LEARNING_SIGNAL_KINDS: ReadonlySet<SignalKind> = new Set<SignalKind>([
  "egress_drop",
  "backup_stale",
  "injection_detected",
  "untrusted_author",
]);

/**
 * Prefix for ephemeral distiller agent names. Each run appends the first 8 chars of its
 * session UUID so concurrent runs for different repos never collide on the same herdr name
 * (`agent_name_taken`). The underscores are load-bearing: prompt-derived session slugs are
 * `[a-z0-9-]` only (see namer.ts), so no real session can collide. The orphan-tab reaper
 * matches tabs whose name starts with this prefix — a bare "distill" would NOT be safe, since
 * a user prompt slugs to exactly that and would get reaped (cf. {@link PROBE_NAME}).
 */
export const DISTILL_LABEL = "__distill__";

const HEALTH_FAILURE_THRESHOLD = 3;

const MAX_ADDS_PER_RUN = 5;
const MAX_UPDATES_PER_RUN = 5;
const MAX_DELETES_PER_RUN = 5;
const MAX_REAFFIRM_PER_RUN = 5;

interface RawRule {
  rule?: unknown;
  rationale?: unknown;
  evidence?: unknown;
  scopeGlobs?: unknown;
}

interface RawUpdate {
  id?: unknown;
  rule?: unknown;
  rationale?: unknown;
}
interface RawDelete {
  id?: unknown;
  reason?: unknown;
}
interface RawProposals {
  rules?: unknown;
  ineffective?: unknown;
  updates?: unknown; // NEW
  deletes?: unknown; // NEW
  reaffirm?: unknown;
}
interface RawIneffective {
  id?: unknown;
  evidence?: unknown;
}
interface RawReaffirm {
  id?: unknown;
  evidence?: unknown;
}

interface InFlight {
  repoPath: string;
  dir: string;
  terminalId: string;
  startedAt: number;
  finalizing?: boolean;
  /** Signal ids handed to this run — the only ids whose citation as evidence for
   *  an ineffective rule we trust (blocks a hallucinated id from being counted). */
  signalIds: Set<string>;
  /** Timestamp lookup for proving a tombstoned rule cites genuinely post-prune evidence. */
  signalTs: Map<string, number>;
}

export interface DistillerDeps {
  store: Pick<
    SessionStore,
    | "listSignals"
    | "addLearning"
    | "listLearnings"
    | "listActiveLearnings"
    | "getRepoConfig"
    | "getSetting"
    | "setSetting"
    | "incrementLearningIneffective"
    | "accrueProposedEvidence"
    | "mergeLearning"
    | "retireLearning"
    | "getLearning"
    | "listLearningPruneTombstones"
  >;
  herdr: Pick<HerdrDriver, "start" | "stop" | "list" | "closeTab">;
  scratch: { create: () => { dir: string }; remove: (dir: string) => void };
  onChange: () => void;
  model?: string | null;
  environment?: () => RoleEnvironment;
  now?: () => number;
  timeoutMs?: number;
  windowMs?: number; // how far back to read signals (default 60d)
  minSignals?: number; // threshold for consider() (default 5)
  maxConcurrent?: number; // max simultaneous distill runs (default 3)
  intervalDays?: () => number;
  writeSignals?: (
    dir: string,
    signals: Signal[],
    existingRules: string[],
    activeRules: { id: string; rule: string; promoted: boolean }[],
    proposedRules: { id: string; rule: string }[],
  ) => void;
  readProposals?: (dir: string) => RawProposals | null;
}

export class DistillerService {
  private inflight = new Map<string, InFlight>();
  private queue: { repoPath: string; signals: Signal[] }[] = [];
  private queued = new Set<string>();
  private maxConcurrent: number;
  private now: () => number;
  private timeoutMs: number;
  private windowMs: number;
  private minSignals: number;
  private writeSignals: NonNullable<DistillerDeps["writeSignals"]>;
  private readProposals: (dir: string) => RawProposals | null;
  private healthFailures = 0;
  private lastFailure: { reason: string; at: number; repoPath: string } | null = null;

  constructor(private deps: DistillerDeps) {
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? 10 * 60 * 1000;
    this.windowMs = deps.windowMs ?? 60 * 24 * 60 * 60 * 1000;
    this.minSignals = deps.minSignals ?? 5;
    this.maxConcurrent = deps.maxConcurrent ?? 3;
    this.writeSignals = deps.writeSignals ?? defaultWriteSignals;
    this.readProposals = deps.readProposals ?? defaultReadProposals;
  }

  health(): {
    ok: boolean;
    consecutiveFailures: number;
    lastFailure: { reason: string; at: number; repoPath: string } | null;
  } {
    return {
      ok: this.healthOk(),
      consecutiveFailures: this.healthFailures,
      lastFailure: this.lastFailure,
    };
  }

  private healthOk(): boolean {
    return this.healthFailures < HEALTH_FAILURE_THRESHOLD;
  }

  private recordHealthFailure(repoPath: string, reason: string): void {
    this.healthFailures++;
    this.lastFailure = { reason, at: this.now(), repoPath };
    // Emit on the ok→unhealthy transition AND on every further failure while unhealthy,
    // so an already-open drawer keeps a fresh consecutiveFailures count instead of freezing
    // at the threshold value. Below the threshold the banner is hidden, so no emit is needed.
    if (!this.healthOk()) this.deps.onChange();
  }

  private recordHealthSuccess(): void {
    const wasUnhealthy = !this.healthOk();
    this.healthFailures = 0;
    this.lastFailure = null;
    if (wasUnhealthy) this.deps.onChange();
  }

  /** Recent learning signals for a repo — listSignals minus non-learning kinds
   *  (e.g. egress_drop), so security alerts don't pollute the corpus or the threshold. */
  private recentLearningSignals(repoPath: string): Signal[] {
    const since = this.now() - this.windowMs;
    return this.deps.store
      .listSignals(repoPath, { sinceTs: since })
      .filter((s) => !NON_LEARNING_SIGNAL_KINDS.has(s.kind));
  }

  /** Start a distill run for `repoPath` if enough recent signals exist and none is in flight.
   *  `async` since #1553 (the spawn is async); callers that don't need to await fire-and-forget. */
  async consider(repoPath: string): Promise<void> {
    if (!this.deps.store.getRepoConfig(repoPath).learningsEnabled) return;
    const signals = this.recentLearningSignals(repoPath);
    if (signals.length < this.minSignals) return;
    if (!this.intervalElapsed(repoPath)) return;
    await this.enqueueOrBegin(repoPath, signals);
  }

  private intervalElapsed(repoPath: string): boolean {
    const saved = this.deps.store.getSetting?.(`distiller:last-run:${repoPath}`);
    if (saved === null || saved === undefined) return true;
    const lastRun = Number(saved);
    if (!Number.isFinite(lastRun)) return true;
    const intervalDays = this.deps.intervalDays?.() ?? 1;
    return this.now() - lastRun >= intervalDays * 24 * 60 * 60 * 1000;
  }

  /** Force a distill run regardless of the signal threshold (manual trigger).
   *  Still requires at least one signal — nothing to distill from otherwise.
   *  Subject to the concurrency cap; excess calls are queued. */
  async distillNow(repoPath: string): Promise<void> {
    const signals = this.recentLearningSignals(repoPath);
    if (signals.length === 0) return;
    await this.enqueueOrBegin(repoPath, signals);
  }

  private async enqueueOrBegin(repoPath: string, signals: Signal[]): Promise<void> {
    if (this.inflight.has(repoPath) || this.queued.has(repoPath)) return;
    if (this.inflight.size < this.maxConcurrent) {
      // begin() reserves its inflight slot synchronously (before its first await), so this
      // size check + the has() guard above hold even under a fire-and-forget fan-out. The
      // await here additionally lets awaiting callers (tests, the tick() drain) observe the
      // spawn's completion; it is NOT what enforces the cap.
      await this.begin(repoPath, signals);
    } else {
      this.queue.push({ repoPath, signals });
      this.queued.add(repoPath);
    }
  }

  private async begin(repoPath: string, signals: Signal[]): Promise<void> {
    const { dir } = this.deps.scratch.create();
    const environment = this.deps.environment?.() ?? {
      provider: "claude" as const,
      model: this.deps.model ?? null,
      effort: null,
    };
    // Fail closed: api-key mode without a configured key must NOT bill the subscription.
    if (apiKeyFailClosed(environment.provider)) {
      console.warn(
        "[distill] api-key mode enabled but no API key configured — skipping (fail closed, not billing subscription)",
      );
      this.deps.scratch.remove(dir);
      return;
    }
    // Include dismissed rules in the "do NOT repeat" list: finalize() drops any
    // re-proposal of a known rule anyway, so omitting dismissed ones just wastes
    // a proposal slot + tokens re-suggesting something the operator already rejected.
    const existing = this.deps.store.listLearnings(repoPath).map((l) => l.rule);
    const activeRules = this.deps.store
      .listActiveLearnings(repoPath)
      .map((l) => ({ id: l.id, rule: l.rule, promoted: l.status === "promoted" }));
    const proposedRules = this.deps.store
      .listLearnings(repoPath, { status: "proposed" })
      .sort((a, b) => b.evidenceCount - a.evidenceCount)
      .slice(0, 30)
      .map((l) => ({ id: l.id, rule: l.rule }));
    try {
      this.writeSignals(dir, signals, existing, activeRules, proposedRules);
    } catch (err) {
      console.warn(`[distill] write signals failed for ${repoPath}:`, err);
      this.deps.scratch.remove(dir);
      this.recordHealthFailure(repoPath, "write");
      return;
    }
    // Read-only distiller — the shared `writer-ro` transient-agent shape. The input is untrusted
    // agent/repo text; see buildTransientAgentArgv for the flag-order + isolation rationale.
    const { argv, sessionId } = buildTransientAgentArgv("writer-ro", {
      provider: environment.provider,
      model: environment.model,
      effort: environment.effort,
      prompt: distillPrompt(),
    });
    const agentName = DISTILL_LABEL + sessionId.slice(0, 8);
    // Reserve the inflight slot SYNCHRONOUSLY — before the async spawn yields — so the daily
    // sweep's fire-and-forget `void consider(repo)` fan-out can't let more than maxConcurrent
    // repos pass the `inflight.size < maxConcurrent` check before any reserves, bypassing the
    // cap/queue. The blocking sync path reserved implicitly by never yielding. terminalId is
    // backfilled once herdr.start resolves; the slot is released if the spawn fails. (tick()
    // skips a reserved run until it has output, so terminalId="" is never observed by finalize.)
    const entry: InFlight = {
      repoPath,
      dir,
      terminalId: "",
      startedAt: this.now(),
      signalIds: new Set(signals.map((s) => s.id)),
      signalTs: new Map(signals.map((s) => [s.id, s.ts])),
    };
    this.inflight.set(repoPath, entry);
    try {
      entry.terminalId = (
        await this.deps.herdr.start(
          agentName,
          dir,
          argv,
          environment.provider === "claude" ? apiKeyPassthroughEnv(false) : undefined,
        )
      ).terminalId;
      this.deps.store.setSetting?.(`distiller:last-run:${repoPath}`, String(this.now()));
    } catch (err) {
      this.inflight.delete(repoPath); // release the reservation
      if (err instanceof HerdrUnavailableError) {
        console.warn(`[distill] herdr unavailable for ${repoPath}:`, err);
      } else {
        console.warn(`[distill] spawn failed for ${repoPath}:`, err);
        this.recordHealthFailure(repoPath, "spawn");
      }
      this.deps.scratch.remove(dir);
      return;
    }
  }

  /** Boot reconcile (issue #1135): close orphaned distiller tabs left by a PRIOR server
   *  lifetime. `inflight` is memory-only, so a restart loses tracking of live runs; the
   *  spawned interactive `claude` idles at the prompt forever after writing its output
   *  (agent_status "done" = finished-turn, pane alive), and the husk-only tab reaper
   *  (tab-reaper.ts) spares it as an alive (non-shell) `claude`. Scan herdr once for agents
   *  whose name starts with DISTILL_LABEL and are NOT owned by a current-process inflight
   *  run, and close their tabs. Name-based — no persisted state (the issue's preferred
   *  approach); the prefix's underscores can't appear in a real session slug. */
  reapOrphans(): void {
    const ownedTerms = new Set(
      [...this.inflight.values()].map((f) => f.terminalId).filter(Boolean),
    );
    void reapTransientByLabel(this.deps.herdr, DISTILL_LABEL, ownedTerms, "[distill]");
  }

  /** Finalize any run whose proposals file is ready or that timed out, then drain queue. */
  async tick(): Promise<void> {
    for (const f of [...this.inflight.values()]) {
      if (f.finalizing) continue;
      const raw = this.readProposals(f.dir);
      const timedOut = this.now() - f.startedAt > this.timeoutMs;
      if (!raw && !timedOut) continue;
      f.finalizing = true;
      this.finalize(f, raw);
      this.inflight.delete(f.repoPath);
    }
    // Drain queue: each finalized run frees a slot
    while (this.inflight.size < this.maxConcurrent && this.queue.length) {
      const e = this.queue.shift()!;
      this.queued.delete(e.repoPath);
      // Await so begin() reserves its inflight slot before the loop re-checks size.
      await this.begin(e.repoPath, e.signals);
    }
  }

  private finalize(f: InFlight, raw: RawProposals | null): void {
    const { added, updated, deleted } = this.applyProposals(f, raw);
    const flagged = this.applyIneffective(f, raw);
    const reaffirmed = this.applyReaffirm(f, raw);
    void this.deps.herdr.stop(f.terminalId).catch(() => {});
    this.deps.scratch.remove(f.dir);
    if (raw !== null) {
      this.recordHealthSuccess();
    } else {
      this.recordHealthFailure(f.repoPath, "timeout-no-output");
    }
    if (added + updated + deleted + flagged + reaffirmed > 0) this.deps.onChange();
  }

  /** Persist new (deduped) proposed rules and apply UPDATE/DELETE from the distiller's output. */
  private applyProposals(
    f: InFlight,
    raw: RawProposals | null,
  ): { added: number; updated: number; deleted: number } {
    const repoPath = f.repoPath;
    const activeIds = new Set(
      this.deps.store
        .listActiveLearnings(repoPath)
        .filter((l) => l.status === "active")
        .map((l) => l.id),
    );
    const updated = this.applyUpdates(raw, activeIds);
    const deleted = this.applyDeletes(raw, activeIds);
    // Build the ADD dedup set AFTER updates/deletes: an UPDATE merges richer text into an
    // existing rule, so an ADD carrying that same merged text must dedup against the
    // just-merged rule (recomputing from the store reflects the post-merge text).
    const have = new Set(this.deps.store.listLearnings(repoPath).map((l) => normalizeRule(l.rule)));
    const tombstones = new Map(
      this.deps.store
        .listLearningPruneTombstones(repoPath)
        .map((tombstone) => [tombstone.ruleKey, tombstone.prunedAt]),
    );
    const added = this.applyAdds(f, raw, have, tombstones);
    return { added, updated, deleted };
  }

  private applyUpdates(raw: RawProposals | null, activeIds: Set<string>): number {
    let updated = 0;
    const updates = Array.isArray(raw?.updates) ? (raw!.updates as RawUpdate[]) : [];
    for (const u of updates) {
      if (updated >= MAX_UPDATES_PER_RUN) break;
      if (this.mergeOneUpdate(u, activeIds)) updated++;
    }
    return updated;
  }

  private mergeOneUpdate(u: RawUpdate, activeIds: Set<string>): boolean {
    const id = typeof u?.id === "string" ? u.id : undefined;
    if (!id || !activeIds.has(id)) return false;
    if (typeof u.rule !== "string" || !u.rule.trim()) return false;
    const rationale = typeof u.rationale === "string" ? u.rationale : undefined;
    return this.deps.store.mergeLearning(id, u.rule, rationale) !== null;
  }

  private applyDeletes(raw: RawProposals | null, activeIds: Set<string>): number {
    let deleted = 0;
    const deletes = Array.isArray(raw?.deletes) ? (raw!.deletes as RawDelete[]) : [];
    for (const d of deletes) {
      if (deleted >= MAX_DELETES_PER_RUN) break;
      const id = typeof d?.id === "string" ? d.id : undefined;
      if (!id || !activeIds.has(id)) continue;
      if (this.deps.store.getLearning(id)?.status !== "active") continue; // defense-in-depth
      if (this.deps.store.retireLearning(id, "superseded")) deleted++;
    }
    return deleted;
  }

  private applyAdds(
    f: InFlight,
    raw: RawProposals | null,
    have: Set<string>,
    tombstones: Map<string, number>,
  ): number {
    let added = 0;
    const rules = Array.isArray(raw?.rules) ? (raw!.rules as RawRule[]) : [];
    for (const r of rules) {
      if (added >= MAX_ADDS_PER_RUN) break;
      if (typeof r?.rule !== "string" || !r.rule.trim()) continue;
      const key = normalizeRule(r.rule);
      if (have.has(key)) continue;
      const evidence = Array.isArray(r.evidence)
        ? r.evidence.filter((e): e is string => typeof e === "string")
        : [];
      const prunedAt = tombstones.get(key);
      if (isBlockedByPruneTombstone(f.signalTs, evidence, prunedAt)) {
        console.warn(
          `[distill] rejected tombstoned rule without post-prune evidence for ${f.repoPath}: ${key}`,
        );
        continue;
      }
      have.add(key);
      this.deps.store.addLearning({
        repoPath: f.repoPath,
        rule: r.rule.trim().slice(0, 240),
        rationale: typeof r.rationale === "string" ? r.rationale : "",
        evidence,
        scopeGlobs: sanitizeScopeGlobs(r.scopeGlobs),
      });
      added++;
    }
    return added;
  }

  /** Bump ineffectiveCount for any active rule the distiller cited as not working,
   *  passing the cited evidence signal ids (validated against THIS run's signal set)
   *  so the store can dedup them and not re-count on a later distill. Returns the
   *  count of rules freshly flagged. */
  private applyIneffective(f: InFlight, raw: RawProposals | null): number {
    let flagged = 0;
    const activeIds = new Set(this.deps.store.listActiveLearnings(f.repoPath).map((l) => l.id));
    const entries = Array.isArray(raw?.ineffective) ? (raw!.ineffective as RawIneffective[]) : [];
    for (const e of entries) {
      const id = typeof e?.id === "string" ? e.id : undefined;
      if (!id || !activeIds.has(id)) continue;
      const evidence = Array.isArray(e.evidence)
        ? e.evidence.filter((s): s is string => typeof s === "string" && f.signalIds.has(s))
        : [];
      if (this.deps.store.incrementLearningIneffective(id, evidence)) flagged++;
    }
    return flagged;
  }

  /** Accrue re-evidence for proposed rules the distiller cited as reaffirmed,
   *  passing cited evidence signal ids (validated against THIS run's signal set)
   *  so the store can dedup them. Returns the count of proposed rules freshly reaffirmed. */
  private applyReaffirm(f: InFlight, raw: RawProposals | null): number {
    let reaffirmed = 0;
    const proposedIds = new Set(
      this.deps.store.listLearnings(f.repoPath, { status: "proposed" }).map((l) => l.id),
    );
    const entries = Array.isArray(raw?.reaffirm) ? (raw!.reaffirm as RawReaffirm[]) : [];
    for (const e of entries) {
      if (reaffirmed >= MAX_REAFFIRM_PER_RUN) break;
      const id = typeof e?.id === "string" ? e.id : undefined;
      if (!id || !proposedIds.has(id)) continue;
      const evidence = Array.isArray(e.evidence)
        ? e.evidence.filter((s): s is string => typeof s === "string" && f.signalIds.has(s))
        : [];
      if (this.deps.store.accrueProposedEvidence(id, evidence) !== null) reaffirmed++;
    }
    return reaffirmed;
  }
}

function isBlockedByPruneTombstone(
  signalTs: Map<string, number>,
  evidence: string[],
  prunedAt: number | undefined,
): boolean {
  return (
    prunedAt !== undefined &&
    !evidence.some((signalId) => (signalTs.get(signalId) ?? Number.NEGATIVE_INFINITY) > prunedAt)
  );
}

function distillPrompt(): string {
  return [
    "You are a code-review pattern analyst. Read `signals.json` in this directory.",
    "It is a JSON object with four fields:",
    "  `signals` — an array of past corrections, blocks, stalls, and critic findings for one repository;",
    "  `existingRules` — all recorded/dismissed rules (do NOT ADD any of these — they are the dedup set);",
    "  `activeRules` — currently-active house rules as {id, rule, promoted} objects. UPDATE/DELETE may target ONLY entries with promoted:false; promoted:true rules are mirrored in CLAUDE.md and may only be flagged ineffective.",
    "  `proposedRules` — currently-proposed rules as {id, rule} objects (not yet active).",
    "",
    "For each candidate finding, choose exactly ONE action:",
    "  ADD    → emit in `rules`   (new guidance, not already in existingRules)",
    "  UPDATE → emit in `updates` (same topic AND same target; richer wording — keep the most informative version)",
    "  DELETE → emit in `deletes` (the finding directly CONTRADICTS that activeRule — emit any corrected rule as a separate ADD)",
    "  NOOP   → emit nothing      (already fully covered by an existingRule or activeRule)",
    "",
    "MULTI-VALUED GUARD: never UPDATE or DELETE a rule whose target (file / category / object) DIFFERS",
    "from the candidate, even if the topic is similar. A UI rule and a migration rule about the same",
    "feature must coexist — only the SAME target may be merged or contradicted.",
    "",
    "If a signal shows an activeRule was violated or did not prevent the mistake, add an",
    "`ineffective` entry: {id: the activeRule id, evidence: the signal ids that show it failing}.",
    "Only cite ids present in the data — never invent ids.",
    "",
    "If a signal re-evidences an existing PROPOSED rule (matches a `proposedRules` entry), do NOT",
    "NOOP it and do NOT re-ADD it — emit a `reaffirm` entry {id: the proposedRule id, evidence: the",
    "signal ids that re-evidence it}. Only cite ids present in the data.",
    "(Proposed rules also appear in `existingRules`; the reaffirm action overrides the do-not-re-ADD/NOOP",
    "guidance for them — reaffirm accrues additional evidence so a proposed rule can graduate to active.)",
    "",
    "Limits: at most 5 ADDs, 5 updates, 5 deletes, 5 reaffirms.",
    "",
    "When an ADD clearly applies only to specific files or areas (judging by the file paths",
    "mentioned in the signals), include an optional `scopeGlobs`: an array of up to 5 repo-relative",
    'glob patterns (e.g. "src/**", "ui/**/*.svelte") so the rule injects only for tasks touching',
    "those files. OMIT `scopeGlobs` (or use []) for general rules — do not invent a scope when unsure.",
    `Write your output as JSON to \`${PROPOSALS_FILE}\` in this directory, shaped exactly:`,
    '{"rules":[{"rule":"<=160 char imperative","rationale":"why","evidence":["signalId",...],"scopeGlobs":["glob",...]}],"updates":[{"id":"activeRuleId","rule":"<=160 char imperative","rationale":"why"}],"deletes":[{"id":"activeRuleId","reason":"why"}],"ineffective":[{"id":"activeRuleId","evidence":["signalId",...]}],"reaffirm":[{"id":"proposedRuleId","evidence":["signalId",...]}]}',
    'If nothing applies, write {"rules":[],"updates":[],"deletes":[],"ineffective":[],"reaffirm":[]}. Do not write anything else.',
  ].join("\n");
}

function defaultWriteSignals(
  dir: string,
  signals: Signal[],
  existingRules: string[],
  activeRules: { id: string; rule: string; promoted: boolean }[],
  proposedRules: { id: string; rule: string }[],
): void {
  const payload = {
    signals: signals.map((s) => ({ kind: s.kind, payload: s.payload, ts: s.ts, id: s.id })),
    existingRules,
    activeRules,
    proposedRules,
  };
  writeFileSync(join(dir, "signals.json"), JSON.stringify(payload, null, 2));
}

function defaultReadProposals(dir: string): RawProposals | null {
  // Result file first, Codex `-o` last-message fallback when absent (a Codex distiller that answers
  // in chat never writes the result file — see codex-last-message.ts).
  // Disposable-tmpdir role → fixed fallback name (fresh empty cwd, no pre-seed risk).
  const text = readRoleResultText(dir, PROPOSALS_FILE, CODEX_LAST_MESSAGE_FILE);
  if (text === null) return null;
  try {
    return JSON.parse(text) as RawProposals;
  } catch {
    return null; // partial write; retry next tick
  }
}

/** Default scratch dir: a throwaway temp dir (the distiller needs no git, only Read/Write). */
export const defaultScratch = {
  create: () => ({ dir: mkdtempSync(join(tmpdir(), "shepherd-distill-")) }),
  remove: (dir: string) => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  },
};
