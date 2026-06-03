import type { SessionStore } from "./store";
import type { GitForge, GitState, Issue } from "./forge/types";
import type { CreateSessionInput, Session } from "./types";
import type { UsageLimits } from "./usage-limits";
import {
  computeNext,
  selectCandidates,
  type AutoSessionView,
  type DrainDecision,
  type DrainRepoState,
} from "./drain-core";

/** Live per-repo drain status pushed to the client (and used for bootstrap). */
export interface DrainStatus {
  repoPath: string;
  enabled: boolean;
  /** Held on trouble (blocked / changes_requested / error) — an operator banner. */
  paused: boolean;
  /** The HoldReason.code when holding; null while active (spawning/merging). */
  reason: string | null;
  /** HoldReason.detail (a desig or pct) when holding; else null. */
  detail: string | null;
  /** Candidate issues not yet mapped to a session. */
  queued: number;
  /** Non-archived auto sessions for the repo (counts toward cap). */
  inFlight: number;
  /** maxAuto. */
  max: number;
}

export interface DrainDeps {
  store: Pick<SessionStore, "get" | "list" | "getRepoConfig" | "getReview" | "archive">;
  service: { create(input: CreateSessionInput): Promise<Session>; archive(id: string): number };
  resolveForge: (repoPath: string) => GitForge | null;
  prCache: { snapshot(): Record<string, GitState> };
  usage: { limits(now: number): UsageLimits };
  /** Candidate repo paths (e.g. listRepos output). */
  repos: () => string[];
  /** → events.emit("drain:status", status). */
  emitStatus: (status: DrainStatus) => void;
  /** → events.emit("session:archived", {id}). */
  emitArchived: (id: string) => void;
  /** → prPoller.drop(id). */
  dropPrCache: (id: string) => void;
  now?: () => number;
  /** Short cache for listIssues (default 10s). */
  issuesTtlMs?: number;
}

/**
 * Side-effect harness for the self-draining work queue. It assembles a
 * {@link DrainRepoState} per repo, calls the pure {@link computeNext} core, and
 * applies the returned decision (spawn / merge / hold), looping until the core
 * holds. Driven by pr-poller events (onGit/onStatus), the archive event
 * (onArchived), and a periodic tick().
 */
export class DrainService {
  // repoPath lock held across the whole async pump — a concurrent pump for the
  // same repo bails immediately so we never double-spawn/double-merge.
  private pumping = new Set<string>();
  // sessionIds whose forge.merge SUCCEEDED but whose merged state the pr-poller
  // hasn't reported yet. buildState forces their `git` to null so computeNext
  // can't re-emit the merge (the PR still reads "open" until the next poll),
  // while they STILL count toward the cap. Cleared in onGit when merged observed.
  private merging = new Set<string>();
  private issuesCache = new Map<string, { issues: Issue[]; ts: number }>();
  private now: () => number;
  private issuesTtlMs: number;

  constructor(private deps: DrainDeps) {
    this.now = deps.now ?? Date.now;
    this.issuesTtlMs = deps.issuesTtlMs ?? 10_000;
  }

  // ── state assembly ──────────────────────────────────────────────────────────

  private async buildState(repoPath: string): Promise<DrainRepoState> {
    const cfg = this.deps.store.getRepoConfig(repoPath);
    const repoSessions = this.deps.store
      .list({ activeOnly: true })
      .filter((s) => s.repoPath === repoPath);
    const snapshot = this.deps.prCache.snapshot();
    const autoSessions: AutoSessionView[] = repoSessions
      .filter((s) => s.auto)
      .map((s) => ({
        id: s.id,
        desig: s.desig,
        issueNumber: s.issueNumber,
        status: s.status,
        // mid-merge (merge fired, not yet observed merged) → null so computeNext
        // won't re-emit the merge; the session still counts toward the cap.
        git: this.merging.has(s.id) ? null : (snapshot[s.id] ?? null),
        reviewDecision: this.deps.store.getReview(s.id)?.decision ?? null,
      }));
    const mappedIssueNumbers = new Set(
      repoSessions.map((s) => s.issueNumber).filter((n): n is number => n != null),
    );
    const limits = this.deps.usage.limits(this.now());
    const usagePct = Math.max(limits.session5h?.pct ?? 0, limits.week?.pct ?? 0);
    // Only hit the forge when drain is enabled — don't hammer listIssues for
    // repos that aren't draining.
    const candidates = cfg.autoDrainEnabled
      ? selectCandidates(await this.listIssues(repoPath), cfg.autoLabel)
      : [];
    return {
      enabled: cfg.autoDrainEnabled,
      maxAuto: cfg.maxAuto,
      usageCeilingPct: cfg.usageCeilingPct,
      usagePct,
      autoSessions,
      mappedIssueNumbers,
      candidates,
    };
  }

  /** Short-TTL cache around the forge's listIssues (the pump may re-read state
   *  many times in one drain). A forge throw warns and yields [] — never crashes
   *  the pump. */
  private async listIssues(repoPath: string): Promise<Issue[]> {
    const cached = this.issuesCache.get(repoPath);
    if (cached && this.now() - cached.ts < this.issuesTtlMs) return cached.issues;
    const forge = this.deps.resolveForge(repoPath);
    try {
      const issues = forge ? await forge.listIssues() : [];
      this.issuesCache.set(repoPath, { issues, ts: this.now() });
      return issues;
    } catch (err) {
      console.warn(`[drain] listIssues failed for ${repoPath}:`, err);
      return [];
    }
  }

  private toStatus(repoPath: string, state: DrainRepoState, decision: DrainDecision): DrainStatus {
    const hold = decision.kind === "hold" ? decision.reason : null;
    const paused =
      hold !== null &&
      (hold.code === "blocked" || hold.code === "changes_requested" || hold.code === "error");
    const queued = state.candidates.filter((c) => !state.mappedIssueNumbers.has(c.number)).length;
    return {
      repoPath,
      enabled: state.enabled,
      paused,
      reason: hold?.code ?? null,
      detail: hold?.detail ?? null,
      queued,
      inFlight: state.autoSessions.length,
      max: state.maxAuto,
    };
  }

  // ── the loop ────────────────────────────────────────────────────────────────

  /** Drain `repoPath`: build state → computeNext → apply, until the core holds.
   *  Re-entrant-safe via the per-repo `pumping` lock. */
  async pump(repoPath: string): Promise<void> {
    if (this.pumping.has(repoPath)) return; // a drain for this repo is already running
    this.pumping.add(repoPath);
    try {
      // Per-pump guard: each session is merge-attempted at most once per pump
      // invocation. If a merge throws and computeNext re-selects the same session,
      // we break instead of retrying — leaving it for the next pump/tick.
      const attemptedMerge = new Set<string>();
      // Hard iteration cap as a runaway backstop; each spawn/merge changes state,
      // so a well-behaved drain ends on a hold well before this.
      for (let i = 0; i < 100; i++) {
        let decision: DrainDecision;
        try {
          const state = await this.buildState(repoPath);
          decision = computeNext(state);
          this.deps.emitStatus(this.toStatus(repoPath, state, decision));
        } catch (err) {
          console.warn(`[drain] pump iteration failed for ${repoPath}:`, err);
          break; // don't spin on a bad iteration
        }
        if (decision.kind === "merge") {
          if (attemptedMerge.has(decision.sessionId)) break; // already tried this pump; defer to next tick
          attemptedMerge.add(decision.sessionId);
          await this.doMerge(repoPath, decision);
          continue;
        }
        if (decision.kind === "spawn") {
          await this.doSpawn(repoPath, decision);
          continue;
        }
        break; // hold
      }
    } finally {
      this.pumping.delete(repoPath);
    }
  }

  private async doMerge(
    repoPath: string,
    decision: Extract<DrainDecision, { kind: "merge" }>,
  ): Promise<void> {
    const forge = this.deps.resolveForge(repoPath);
    if (!forge) return;
    // Claim BEFORE the await: the next loop iteration must see this session as
    // mid-merge (git → null) so it can't double-merge the still-"open" PR.
    this.merging.add(decision.sessionId);
    try {
      await forge.merge(decision.prNumber, { method: forge.mergeMethod, deleteBranch: true });
      // SUCCESS → leave it in `merging`; onGit clears it when the merged state lands.
      // The slot stays consumed until the pr-poller reports "merged" (frees on its signal, not self-recovering).
    } catch (err) {
      console.warn(`[drain] merge failed for ${decision.sessionId}:`, err);
      // A throw (race / conflict) → remove so a later poll can retry the merge.
      this.merging.delete(decision.sessionId);
    }
  }

  private async doSpawn(
    repoPath: string,
    decision: Extract<DrainDecision, { kind: "spawn" }>,
  ): Promise<void> {
    const forge = this.deps.resolveForge(repoPath);
    if (!forge) return;
    try {
      const base = await forge.defaultBranch();
      await this.deps.service.create({
        repoPath,
        baseBranch: base,
        prompt: decision.issue.title,
        model: null,
        images: [],
        auto: true,
        issueRef: {
          number: decision.issue.number,
          url: decision.issue.url,
          title: decision.issue.title,
          body: decision.issue.body,
        },
      });
      // The new auto session appears in the next buildState → counts toward the
      // cap AND mappedIssueNumbers, so the loop won't re-spawn this issue and
      // naturally stops at cap.
    } catch (err) {
      console.warn(`[drain] spawn failed for issue #${decision.issue.number}:`, err);
    }
  }

  // ── event handlers (public surface) ───────────────────────────────────────────

  /** pr-poller observed a new git state for a session. */
  async onGit(id: string, git: GitState): Promise<void> {
    const s = this.deps.store.get(id);
    if (!s || !s.auto) return; // drain only manages auto sessions
    if (git.state === "merged") {
      // Clear the merge guard and reap — regardless of whether drain is still
      // enabled (avoid leaking a merged auto session). Do NOT pump here: the
      // emitted session:archived routes to onArchived, the single advance path.
      this.merging.delete(id);
      this.deps.service.archive(id);
      this.deps.dropPrCache(id);
      this.deps.emitArchived(id);
      return;
    }
    // open/green/other → the merge gate may now fire (e.g. CI just went green).
    await this.pump(s.repoPath);
  }

  /** A session was archived (merged auto session, or a manual archive). The
   *  single advance step: a freed slot lets the next candidate spawn. */
  async onArchived(id: string): Promise<void> {
    this.merging.delete(id); // harmless no-op if not present; clears any stale merge guard
    const s = this.deps.store.get(id); // archived rows still return → repoPath available
    if (s) await this.pump(s.repoPath);
  }

  /** A session's status changed. Pump its repo, but skip unrelated non-drain repos. */
  async onStatus(id: string): Promise<void> {
    const s = this.deps.store.get(id);
    if (!s) return;
    if (!s.auto && !this.deps.store.getRepoConfig(s.repoPath).autoDrainEnabled) return;
    await this.pump(s.repoPath);
  }

  /** Periodic sweep (~30s): catches newly-labeled issues + resumed usage windows. */
  async tick(): Promise<void> {
    for (const repoPath of this.deps.repos()) {
      if (this.deps.store.getRepoConfig(repoPath).autoDrainEnabled) await this.pump(repoPath);
    }
  }

  /** Client bootstrap: a status per drain-enabled repo, WITHOUT applying side
   *  effects (no spawn/merge, no `merging` mutation). Disabled repos are skipped. */
  async snapshot(): Promise<DrainStatus[]> {
    const out: DrainStatus[] = [];
    for (const repoPath of this.deps.repos()) {
      if (!this.deps.store.getRepoConfig(repoPath).autoDrainEnabled) continue;
      const state = await this.buildState(repoPath);
      out.push(this.toStatus(repoPath, state, computeNext(state)));
    }
    return out;
  }
}
