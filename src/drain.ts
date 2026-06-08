import type { SessionStore } from "./store";
import type { GitForge, GitState, Issue } from "./forge/types";
import type { CreateSessionInput, Session } from "./types";
import type { UsageLimits } from "./usage-limits";
import { settleMergedSession } from "./merge-teardown";
import { isFullAuto } from "./full-auto";
import {
  ACTIVE_LABEL,
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
  /** The HoldReason.code when holding; null while active (spawning/retiring). */
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

/** One queued backlog issue behind {@link DrainStatus.queued} — the rows the
 *  client's queue popover renders. */
export interface QueuedItem {
  number: number;
  title: string;
  url: string;
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
 * applies the returned decision (spawn / retire / hold), looping until the core
 * holds. Driven by pr-poller events (onGit/onStatus), the archive event
 * (onArchived), and a periodic tick().
 *
 * The drain NEVER merges PRs. A ready session is retired (session archived,
 * pane stopped, worktree removed) and its open, issue-linked PR is left for a
 * human to merge. Archiving frees the concurrency slot so the next backlog item
 * can spawn. When the human merges, the `Closes #N` link auto-closes the issue,
 * preventing re-spawn.
 */
export class DrainService {
  // repoPath lock held across the whole async pump — a concurrent pump for the
  // same repo bails immediately so we never double-spawn/double-retire.
  private pumping = new Set<string>();
  // sessionIds whose claim label onArchived must NOT release. Populated in doRetire
  // (a ready PR stays open → keep the claim so no instance re-spawns it; the human
  // merge auto-closes the issue, retiring the claim) and in onGit ONLY for a merge
  // whose closeIssue FAILED (issue still open → keep the claim). A plain abandon
  // (manual archive, never retired) is absent here, so onArchived drops the label
  // and re-queues the issue. Consumed (deleted) in onArchived.
  private retainClaimOnArchive = new Set<string>();
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
    // ALL sessions (incl. archived) for dedup: an issue drained once stays mapped via
    // its archived session, so a retired-but-not-yet-merged issue isn't re-pulled (bounded by
    // session retention). autoSessions/cap use only the non-archived subset.
    const allRepoSessions = this.deps.store.list().filter((s) => s.repoPath === repoPath);
    const snapshot = this.deps.prCache.snapshot();
    const autoSessions: AutoSessionView[] = allRepoSessions
      .filter((s) => s.status !== "archived" && s.auto)
      .map((s) => ({
        id: s.id,
        desig: s.desig,
        issueNumber: s.issueNumber,
        status: s.status,
        git: snapshot[s.id] ?? null,
        reviewDecision: this.deps.store.getReview(s.id)?.decision ?? null,
        reviewHeadSha: this.deps.store.getReview(s.id)?.headSha ?? null,
        fullAuto: isFullAuto(s, cfg),
      }));
    const mappedIssueNumbers = new Set(
      allRepoSessions.map((s) => s.issueNumber).filter((n): n is number => n != null),
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
      criticEnabled: cfg.criticEnabled,
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
    // cap is conveyed by inFlight/max, empty is normal idle — neither pauses.
    const paused =
      hold !== null && ["blocked", "changes_requested", "error", "usage"].includes(hold.code);
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
      // Per-pump guard: each session is retire-attempted at most once per pump
      // invocation. service.archive takes effect immediately, so the next buildState
      // sees the session as archived and won't re-select it — but if computeNext
      // somehow re-selects the same session anyway, we break rather than loop.
      const attemptedRetire = new Set<string>();
      // Same guard for spawns: a successful spawn maps the issue (so it won't be
      // re-selected), but a FAILED spawn leaves it unmapped — without this the loop
      // would re-pick the same failing issue every iteration up to the cap, churning
      // its claim label on each try. Break instead and let the next tick retry.
      const attemptedSpawn = new Set<number>();
      // Hard iteration cap as a runaway backstop; each spawn/retire changes state,
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
        if (decision.kind === "retire") {
          if (attemptedRetire.has(decision.sessionId)) break; // already tried this pump; defer to next tick
          attemptedRetire.add(decision.sessionId);
          await this.doRetire(repoPath, decision);
          continue;
        }
        if (decision.kind === "spawn") {
          if (attemptedSpawn.has(decision.issue.number)) break; // already tried this pump; defer to next tick
          attemptedSpawn.add(decision.issue.number);
          await this.doSpawn(repoPath, decision);
          continue;
        }
        break; // hold
      }
    } finally {
      this.pumping.delete(repoPath);
    }
  }

  /**
   * Retire a ready session: ensure the PR links its issue (so the forge
   * auto-closes the issue when a human merges), then archive the session
   * (stops the pane, removes the worktree, marks the row archived). The open,
   * linked PR is left for a human to merge — the drain never merges.
   * Archiving frees the concurrency slot so the next backlog item can spawn.
   */
  private async doRetire(
    repoPath: string,
    decision: Extract<DrainDecision, { kind: "retire" }>,
  ): Promise<void> {
    const forge = this.deps.resolveForge(repoPath);
    if (!forge) return;
    const s = this.deps.store.get(decision.sessionId);
    // Best-effort issue link: a failure must NOT block teardown.
    if (s?.issueNumber != null) {
      try {
        await forge.ensureIssueLink?.(decision.prNumber, s.issueNumber);
      } catch (err) {
        console.warn(
          `[drain] ensureIssueLink pr#${decision.prNumber} issue#${s.issueNumber} failed for ${decision.sessionId}:`,
          err,
        );
      }
    }
    // Isolate teardown: a worktree-remove / archive throw must not abort the
    // whole pump (which would skip remaining spawns/retires this tick). On
    // failure we warn and defer — the session stays live and mergeable, so the
    // next tick retries; we must NOT drop the pr-cache or emit "archived" for a
    // session that didn't actually archive.
    try {
      this.deps.service.archive(decision.sessionId);
    } catch (err) {
      console.warn(`[drain] archive failed for ${decision.sessionId}:`, err);
      return;
    }
    // The PR is left OPEN for a human to merge, so the issue stays open and claimed.
    // Mark the archive as a retire so onArchived KEEPS the claim — releasing it here
    // would let another instance re-spawn an issue that already has a ready PR. The
    // human merge auto-closes the issue (`Closes #N`), retiring the claim with it.
    // Set before emitArchived so a synchronous onArchived sees it.
    this.retainClaimOnArchive.add(decision.sessionId);
    this.deps.dropPrCache(decision.sessionId);
    this.deps.emitArchived(decision.sessionId);
  }

  private async doSpawn(
    repoPath: string,
    decision: Extract<DrainDecision, { kind: "spawn" }>,
  ): Promise<void> {
    const forge = this.deps.resolveForge(repoPath);
    if (!forge) return;
    const { number, url, title, body } = decision.issue;
    // Claim the issue on the host BEFORE spawning. The active label is the only
    // cross-instance signal, so stamp it first to shrink the window in which a
    // second shepherd grabs the same issue. Best-effort: a claim failure (label
    // API hiccup) must not stall the drain — we still spawn and lean on local
    // dedup. (Re-)claiming is idempotent.
    try {
      await forge.addIssueLabel?.(number, ACTIVE_LABEL);
    } catch (err) {
      console.warn(`[drain] claim label for issue #${number} failed:`, err);
    }
    try {
      const base = await forge.defaultBranch();
      await this.deps.service.create({
        repoPath,
        baseBranch: base,
        prompt: title,
        model: null,
        images: [],
        auto: true,
        issueRef: { number, url, title, body },
      });
      // The new auto session appears in the next buildState → counts toward the
      // cap AND mappedIssueNumbers, so the loop won't re-spawn this issue and
      // naturally stops at cap.
    } catch (err) {
      console.warn(`[drain] spawn failed for issue #${number}:`, err);
      // Release the claim so the unspawned issue returns to the pool (best-effort).
      try {
        await forge.removeIssueLabel?.(number, ACTIVE_LABEL);
      } catch (rerr) {
        console.warn(`[drain] release label for issue #${number} failed:`, rerr);
      }
    }
  }

  // ── event handlers (public surface) ───────────────────────────────────────────

  /** pr-poller observed a new git state for a session. */
  async onGit(id: string, git: GitState): Promise<void> {
    const s = this.deps.store.get(id);
    if (!s || !s.auto) return; // drain only manages auto sessions
    if (git.state === "merged") {
      await this.reapMerged(s);
      return;
    }
    // open/green/other → the retire gate may now fire (e.g. CI just went green).
    // Skip drain-disabled repos — no spawn/retire there, just WS noise.
    await this.pumpIfEnabled(s.repoPath);
  }

  /** Reap a session whose PR was observed merged out-of-band — a human or GitHub
   *  auto-merge the poller STILL tracked (the retire path drops the pr-cache first,
   *  so this fires only for a merge that beat the retire). Closes the backlog issue
   *  and settles its claim, then archives. Does NOT pump — the emitted
   *  session:archived routes to onArchived, the single advance path. Best-effort:
   *  the merge is done, so a close failure must not block teardown. */
  private async reapMerged(s: Session): Promise<void> {
    await settleMergedSession(s, {
      resolveForge: this.deps.resolveForge,
      archive: (sid) => this.deps.service.archive(sid),
      dropPrCache: this.deps.dropPrCache,
      emitArchived: this.deps.emitArchived,
      retainClaim: (sid) => this.retainClaimOnArchive.add(sid),
    });
  }

  /** A session was archived (retired auto session, or a manual archive). The
   *  single advance step: a freed slot lets the next candidate spawn. Skips
   *  drain-disabled repos so a manual archive there doesn't pump/emit. */
  async onArchived(id: string): Promise<void> {
    const retainClaim = this.retainClaimOnArchive.delete(id); // true → retire, or merged-but-close-failed
    const s = this.deps.store.get(id); // archived rows still return → repoPath available
    if (!s) return;
    // Drop the host claim label for ANY archived session holding a claim — whether
    // the drain stamped it (auto spawn) or a human stamped it by linking an issue at
    // task creation (via the create route). Release fires UNLESS retainClaim is set:
    // a retire (ready PR still open) or merged-but-close-failed (issue still open),
    // both of which keep the claim. The remaining case is an ABANDON (manual archive
    // of a session that never retired), which re-queues the issue. NOTE: the
    // abandoning instance still maps this issue via its own archived session, so the
    // release re-queues it for OTHER instances — and for this one only after its
    // archived session is pruned.
    // CAVEAT: an abandon does not inspect PR state, so manually archiving a session
    // (auto OR a manually-linked one) that already opened a PR — without going through
    // the retire path — releases the claim and lets another instance / the drain spawn
    // a DUPLICATE against that still-open PR. Accepted: a manual archive is a deliberate
    // "drop this" signal, and the retire path (not manual archive) is how a ready PR is
    // normally handed off with its claim kept. Unconditional of the drain toggle
    // (mirrors onGit's closeIssue) so a disabled-mid-flight session still frees its
    // claim. A session without an issueNumber never set a claim, so it's skipped.
    if (!retainClaim && s.issueNumber != null) {
      try {
        await this.deps.resolveForge(s.repoPath)?.removeIssueLabel?.(s.issueNumber, ACTIVE_LABEL);
      } catch (err) {
        console.warn(`[drain] release label #${s.issueNumber} for ${id} failed:`, err);
      }
    }
    await this.pumpIfEnabled(s.repoPath);
  }

  /** A session's status changed. Pump its repo, skipping drain-disabled repos. */
  async onStatus(id: string): Promise<void> {
    await this.pumpForSession(id);
  }

  /** Used by the merge train: a merge whose closeIssue failed keeps the claim (issue still open). */
  retainClaim(id: string): void {
    this.retainClaimOnArchive.add(id);
  }

  /** A critic verdict landed for a session. A clean verdict for the current head
   *  may now unblock the retire gate — pump promptly rather than waiting for the tick. */
  async onReview(id: string): Promise<void> {
    await this.pumpForSession(id);
  }

  /** Pump a session's repo, skipping when the session is gone. The shared body of
   *  the status/review event handlers. */
  private async pumpForSession(id: string): Promise<void> {
    const s = this.deps.store.get(id);
    if (!s) return;
    await this.pumpIfEnabled(s.repoPath);
  }

  /** Pump a repo unless its drain toggle is off — the shared tail of every handler. */
  private async pumpIfEnabled(repoPath: string): Promise<void> {
    if (!this.deps.store.getRepoConfig(repoPath).autoDrainEnabled) return;
    await this.pump(repoPath);
  }

  /** Periodic sweep (~30s): catches newly-labeled issues + resumed usage windows. */
  async tick(): Promise<void> {
    for (const repoPath of this.deps.repos()) {
      if (this.deps.store.getRepoConfig(repoPath).autoDrainEnabled) await this.pump(repoPath);
    }
  }

  /** Client bootstrap: a status per drain-enabled repo, WITHOUT applying side
   *  effects (no spawn/retire). Disabled repos are skipped. */
  async snapshot(): Promise<DrainStatus[]> {
    const out: DrainStatus[] = [];
    for (const repoPath of this.deps.repos()) {
      if (!this.deps.store.getRepoConfig(repoPath).autoDrainEnabled) continue;
      const state = await this.buildState(repoPath);
      out.push(this.toStatus(repoPath, state, computeNext(state)));
    }
    return out;
  }

  /** The actual backlog issues behind {@link DrainStatus.queued}: the not-yet-
   *  mapped candidates, in drain order (priority-first per selectCandidates).
   *  No side effects. Empty for drain-disabled repos (buildState yields no
   *  candidates there — and the forge is never hit). */
  async queue(repoPath: string): Promise<QueuedItem[]> {
    const state = await this.buildState(repoPath);
    return state.candidates
      .filter((c) => !state.mappedIssueNumbers.has(c.number))
      .map((c) => ({ number: c.number, title: c.title, url: c.url }));
  }
}
