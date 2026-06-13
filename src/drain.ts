import type { SessionStore } from "./store";
import type { GitForge, GitState, Issue, SubIssueRef } from "./forge/types";
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
import { assembleEpic } from "./epic-model";
import { epicIntegrationBranch as epicBranchName, isEpicIntegrationBranch } from "./epic-branch";
import { selectEpicCandidates, type Epic, type EpicRun } from "./epic-core";
import { mapBounded } from "./map-bounded";
import { config } from "./config";

/** Concurrency cap for the per-child blocked_by fan-out when assembling an epic.
 *  Bounds `gh api` subprocesses so a large (100+-child) epic can't exhaust FDs or
 *  trip GitHub secondary rate limits. */
const EPIC_BLOCKED_BY_CONCURRENCY = 8;
import { drainSpawnModel, resolveDefaultModelSetting } from "./default-model";
import { resolveProfile, autoHoldReason, detectBackend } from "./sandbox";
import { epicBaseDirective } from "./autopilot";

/** Cached epic structure for one pump cycle. */
interface EpicStructure {
  parent: Issue | null;
  subIssues: SubIssueRef[];
  blockedBy: Map<number, number[]>;
}

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
  /** Parent issue number when an epic is running; null in label-mode. */
  epicParent: number | null;
}

/** One queued backlog issue behind {@link DrainStatus.queued} — the rows the
 *  client's queue popover renders. */
export interface QueuedItem {
  number: number;
  title: string;
  url: string;
}

export interface DrainDeps {
  store: Pick<
    SessionStore,
    | "get"
    | "list"
    | "getRepoConfig"
    | "getReview"
    | "archive"
    | "getEpicRun"
    | "setEpicRun"
    | "listEpicIntegrated"
    | "recordEpicIntegrated"
  >;
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
  /** → events.emit("epic:update", epic). Optional — absent in tests that don't need it. */
  emitEpic?: (epic: Epic) => void;
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
  private epicStructureCache = new Map<string, { reads: EpicStructure; ts: number }>();
  private lastEpicSig = new Map<string, string>();
  private approvedNext = new Set<string>();
  private now: () => number;
  private issuesTtlMs: number;

  constructor(private deps: DrainDeps) {
    this.now = deps.now ?? Date.now;
    this.issuesTtlMs = deps.issuesTtlMs ?? 10_000;
  }

  /** Operator approves the next epic-attended spawn for the given repo. */
  approveEpicNext(repoPath: string): void {
    this.approvedNext.add(repoPath);
  }

  /** Fetch and cache the epic's structure (parent issue + sub-issues + blocked-by maps). */
  private async epicStructure(repoPath: string, run: EpicRun): Promise<EpicStructure | null> {
    const key = `${repoPath}:${run.parentIssueNumber}`;
    const cached = this.epicStructureCache.get(key);
    if (cached && this.now() - cached.ts < this.issuesTtlMs) return cached.reads;
    const forge = this.deps.resolveForge(repoPath);
    if (!forge) return null;
    const parent = (await forge.getIssue?.(run.parentIssueNumber)) ?? null;
    const subIssues = (await forge.listSubIssues?.(run.parentIssueNumber)) ?? [];
    // Each child's blocked_by is independent — fetch concurrently (once per epic per TTL
    // window, not per pump) but BOUNDED: a 100+-child epic must not spawn 100 `gh api`
    // subprocesses at once (FD/process pressure + GitHub secondary rate limits).
    const blockedByEntries = await mapBounded(
      subIssues,
      EPIC_BLOCKED_BY_CONCURRENCY,
      async (s) => [s.number, (await forge.listBlockedBy?.(s.number)) ?? []] as const,
    );
    const blockedBy = new Map<number, number[]>(blockedByEntries);
    const reads: EpicStructure = { parent, subIssues, blockedBy };
    this.epicStructureCache.set(key, { reads, ts: this.now() });
    return reads;
  }

  // public: also called by the epic server routes (Task 9) for on-demand epic assembly
  /** Assemble the live Epic for this repo's running epic (used by buildState + server). */
  async buildEpic(repoPath: string, run: EpicRun): Promise<Epic | null> {
    const struct = await this.epicStructure(repoPath, run);
    if (!struct) return null;
    const native = struct.subIssues.length > 0;
    let openIssues: { number: number; body: string; labels: string[] }[] = [];
    let openIssuesTruncated = false;
    if (!native) {
      const open = await this.listIssues(repoPath);
      openIssues = open.map((i) => ({ number: i.number, body: i.body, labels: i.labels }));
      openIssuesTruncated = open.length >= 200;
    }
    const prSnap = this.deps.prCache.snapshot();
    const sessions = this.deps.store
      .list()
      .filter(
        (x) =>
          x.repoPath === repoPath && x.auto && x.issueNumber != null && x.status !== "archived",
      )
      .map((x) => ({
        id: x.id,
        issueNumber: x.issueNumber,
        prNumber: prSnap[x.id]?.number ?? null,
      }));
    const integrated = this.deps.store.listEpicIntegrated(repoPath, run.parentIssueNumber);
    return assembleEpic({
      repoPath,
      run,
      integrated,
      parent: {
        number: run.parentIssueNumber,
        title: struct.parent?.title ?? `#${run.parentIssueNumber}`,
        body: struct.parent?.body ?? "",
      },
      subIssues: struct.subIssues,
      blockedBy: struct.blockedBy,
      openIssues,
      openIssuesTruncated,
      sessions,
    });
  }

  /** Emit the epic only when something meaningful changed (de-dup by signature). */
  private emitEpicIfChanged(repoPath: string, epic: Epic): void {
    const sig = JSON.stringify({
      st: epic.run.status,
      md: epic.run.mode,
      kids: epic.children.map((c) => [c.number, c.state, c.prNumber] as const),
      warn: epic.warnings.length,
    });
    if (this.lastEpicSig.get(repoPath) === sig) return;
    this.lastEpicSig.set(repoPath, sig);
    this.deps.emitEpic?.(epic);
  }

  // ── state assembly ──────────────────────────────────────────────────────────

  private async buildState(repoPath: string): Promise<{
    state: DrainRepoState & { epicParent: number | null };
    epic: Epic | null;
  }> {
    const cfg = this.deps.store.getRepoConfig(repoPath);
    // ALL sessions (incl. archived) for dedup: an issue drained once stays mapped via
    // its archived session, so a retired-but-not-yet-merged issue isn't re-pulled (bounded by
    // session retention). autoSessions/cap use only the non-archived subset.
    const allRepoSessions = this.deps.store.list().filter((s) => s.repoPath === repoPath);
    const snapshot = this.deps.prCache.snapshot();
    const autoSessions: AutoSessionView[] = allRepoSessions
      .filter((s) => s.status !== "archived" && s.auto)
      .map((s) => {
        const review = this.deps.store.getReview(s.id);
        return {
          id: s.id,
          desig: s.desig,
          issueNumber: s.issueNumber,
          status: s.status,
          git: snapshot[s.id] ?? null,
          reviewDecision: review?.decision ?? null,
          reviewHeadSha: review?.headSha ?? null,
          findings: review?.findings ?? [],
          humanApproved: snapshot[s.id]?.latestReview?.state === "approved",
          isDraft: snapshot[s.id]?.isDraft ?? false,
          fullAuto: isFullAuto(s, cfg),
        };
      });
    const mappedIssueNumbers = new Set(
      allRepoSessions.map((s) => s.issueNumber).filter((n): n is number => n != null),
    );
    const limits = this.deps.usage.limits(this.now());
    const usagePct = Math.max(limits.session5h?.pct ?? 0, limits.week?.pct ?? 0);

    // Epic branch: only override label-drain when the epic is actively running or paused.
    // An idle epic_run row (or no row at all) falls through to label-drain as normal.
    const epicRun = this.deps.store.getEpicRun(repoPath);
    const epicActive = !!epicRun && (epicRun.status === "running" || epicRun.status === "paused");
    let candidates: Issue[] = [];
    let epicAttended = false;
    let epicParent: number | null = null;
    let epicIntegrationBranch: string | null = null;
    let builtEpic: Epic | null = null;
    if (epicActive) {
      // Epic is running/paused: source candidates from its dependency-gated children
      // instead of the label-based listIssues path.
      builtEpic = await this.buildEpic(repoPath, epicRun!);
      if (builtEpic) {
        epicParent = epicRun!.parentIssueNumber;
        epicIntegrationBranch = epicBranchName(builtEpic.parentIssueNumber, builtEpic.parentTitle);
        if (epicRun!.status === "running") candidates = selectEpicCandidates(builtEpic.children);
        epicAttended = epicRun!.mode === "attended";
      }
    } else if (cfg.autoDrainEnabled) {
      // Label mode: only hit the forge when drain is enabled — don't hammer listIssues for
      // repos that aren't draining.
      candidates = selectCandidates(await this.listIssues(repoPath), cfg.autoLabel);
    }
    // enabled reflects whether spawning is active: epic running → use epic's running
    // status; otherwise fall back to the label-drain toggle. An idle/paused epic or no
    // epic row at all defers to autoDrainEnabled.
    const enabled = epicActive ? epicRun!.status === "running" : cfg.autoDrainEnabled;

    return {
      state: {
        enabled,
        criticEnabled: cfg.criticEnabled,
        draftMode: cfg.draftMode,
        signoffAuthority: cfg.signoffAuthority,
        maxAuto: cfg.maxAuto,
        usageCeilingPct: cfg.usageCeilingPct,
        usagePct,
        autoSessions,
        mappedIssueNumbers,
        candidates,
        epicAttended,
        epicApprovedNext: this.approvedNext.has(repoPath),
        epicParent,
        epicIntegrationBranch,
      },
      epic: builtEpic,
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

  private toStatus(
    repoPath: string,
    state: DrainRepoState & { epicParent: number | null },
    decision: DrainDecision,
  ): DrainStatus {
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
      epicParent: state.epicParent,
    };
  }

  // ── the loop ────────────────────────────────────────────────────────────────

  /**
   * Auto-complete check + emit for an in-flight epic.
   * If the epic is running and every child is merged, transitions the stored run
   * to idle and emits the updated epic. Otherwise just emits the current state.
   * Pump-only — snapshot()/queue() must never call this.
   * Returns true when it auto-completed the epic this call (running→idle).
   */
  private handleEpicSideEffects(repoPath: string, epicRun: EpicRun, epic: Epic): boolean {
    if (
      epicRun.status === "running" &&
      epic.children.length > 0 &&
      epic.children.every((c) => c.state === "merged")
    ) {
      const completedRun = { ...epicRun, status: "idle" as const };
      this.deps.store.setEpicRun(completedRun);
      // Emit a final epic:update reflecting the completed/idle state before
      // the next buildState sees idle and stops emitting epicParent.
      this.emitEpicIfChanged(repoPath, { ...epic, run: completedRun });
      return true;
    } else {
      this.emitEpicIfChanged(repoPath, epic);
      return false;
    }
  }

  /**
   * Execute one step of the drain loop: build state, run epic side-effects,
   * compute the next decision, emit status, then apply the decision.
   * Returns false when the loop should break (hold or error), true to continue.
   */
  private async pumpStep(
    repoPath: string,
    attemptedRetire: Set<string>,
    attemptedSpawn: Set<number>,
  ): Promise<boolean> {
    let decision: DrainDecision;
    try {
      const { state, epic } = await this.buildState(repoPath);
      // Auto-complete: a running epic whose every child is merged transitions to idle.
      // This clears the banner, re-enables label-drain, and ensures the panel updates.
      let epicAutoCompleted = false;
      if (epic && state.epicParent !== null) {
        const epicRun = this.deps.store.getEpicRun(repoPath);
        if (epicRun) epicAutoCompleted = this.handleEpicSideEffects(repoPath, epicRun, epic);
      }
      decision = computeNext(state);
      // When the epic just auto-completed (running→idle), the state we built still
      // carries epicParent from the now-idle run. Emit a corrected status built from
      // the post-transition state (epicParent=null) so the AutomationPanel banner
      // clears immediately without a manual reload. The decision for THIS step can
      // still use the original state — only the emitted status needs the correction.
      if (epicAutoCompleted) {
        const { state: idleState } = await this.buildState(repoPath);
        this.deps.emitStatus(this.toStatus(repoPath, idleState, decision));
      } else {
        this.deps.emitStatus(this.toStatus(repoPath, state, decision));
      }
    } catch (err) {
      console.warn(`[drain] pump iteration failed for ${repoPath}:`, err);
      return false; // don't spin on a bad iteration
    }
    if (decision.kind === "retire") {
      if (attemptedRetire.has(decision.sessionId)) return false; // defer to next tick
      attemptedRetire.add(decision.sessionId);
      await this.doRetire(repoPath, decision);
      return true;
    }
    if (decision.kind === "spawn") {
      if (attemptedSpawn.has(decision.issue.number)) return false; // defer to next tick
      attemptedSpawn.add(decision.issue.number);
      await this.doSpawn(repoPath, decision);
      return true;
    }
    return false; // hold
  }

  /** Drain `repoPath`: build state → computeNext → apply, until the core holds.
   *  Re-entrant-safe via the per-repo `pumping` lock. */
  async pump(repoPath: string): Promise<void> {
    if (this.pumping.has(repoPath)) return; // a drain for this repo is already running
    this.pumping.add(repoPath);
    try {
      // Per-pump guard: each session is retire-attempted / spawn-attempted at most
      // once per pump invocation to avoid churning on repeated failures.
      const attemptedRetire = new Set<string>();
      const attemptedSpawn = new Set<number>();
      // Hard iteration cap as a runaway backstop; each spawn/retire changes state,
      // so a well-behaved drain ends on a hold well before this.
      for (let i = 0; i < 100; i++) {
        const shouldContinue = await this.pumpStep(repoPath, attemptedRetire, attemptedSpawn);
        if (!shouldContinue) break;
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
    // Epic child: squash-merge the PR INTO its integration branch (not the default branch) and
    // record it so dependents unblock without a GitHub issue auto-close (the child issue stays
    // open until the final epic→default PR lands). Detected by the integration-branch base +
    // an active epic for the repo.
    const epicRun = this.deps.store.getEpicRun(repoPath);
    const epicActive = !!epicRun && (epicRun.status === "running" || epicRun.status === "paused");
    if (epicActive && s?.issueNumber != null && isEpicIntegrationBranch(s.baseBranch)) {
      try {
        // deleteBranch removes the child's MERGED head (task) branch on origin — standard
        // post-merge hygiene. It is the PR's head, never the integration branch (the base),
        // so the accumulating integration branch is untouched.
        await forge.merge(decision.prNumber, { method: "squash", deleteBranch: true });
      } catch (err) {
        console.warn(
          `[drain] epic child merge pr#${decision.prNumber} (issue #${s.issueNumber}) into ${s.baseBranch} failed:`,
          err,
        );
        return; // leave the session live; next tick retries. Do NOT record or archive.
      }
      this.deps.store.recordEpicIntegrated(repoPath, epicRun!.parentIssueNumber, s.issueNumber);
      try {
        this.deps.service.archive(decision.sessionId);
      } catch (err) {
        // The squash-merge already landed (PR is now MERGED) but teardown didn't finish. This
        // is recoverable, not a permanent strand: we deliberately do NOT dropPrCache/emit below,
        // so the session stays live AND polled (pr-poller skips only archived rows). The poller
        // re-observes the merged PR and settles it via reapMerged → settleMergedSession (archive
        // + teardown) — the same path any out-of-band merge takes. That recovery closes the child
        // issue instead of keeping it open, but the integration is already recorded above, so
        // dependents unblock either way. The session can NOT be re-selected by the retire gate
        // (readyToRetire requires state==="open"; the PR is merged), hence the poller is the
        // recovery, not a retry of this path.
        console.warn(
          `[drain] archive (epic child) failed for ${decision.sessionId}; pr-poller will reap the merged PR:`,
          err,
        );
        return;
      }
      // Keep the claim: the child issue stays open until the epic lands; releasing would let it
      // re-spawn. Mirrors the non-epic retire path below.
      this.retainClaimOnArchive.add(decision.sessionId);
      this.deps.dropPrCache(decision.sessionId);
      this.deps.emitArchived(decision.sessionId);
      return;
    }
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

  /**
   * Resolve the base branch + agent prompt for a spawn. Epic children base on (and ensure on
   * the host) the integration branch — so each builds on its predecessors' merged work — and
   * get a directive to target it as their PR base; a forge that can't create the branch, or a
   * non-epic spawn, falls back to the default branch with the bare task title.
   */
  private async resolveSpawnBase(
    forge: GitForge,
    decision: Extract<DrainDecision, { kind: "spawn" }>,
  ): Promise<{ base: string; prompt: string }> {
    const { number, title } = decision.issue;
    const def = await forge.defaultBranch();
    let base = def;
    if (decision.integrationBranch && forge.ensureBranch) {
      try {
        await forge.ensureBranch(decision.integrationBranch, def);
        base = decision.integrationBranch;
      } catch (err) {
        console.warn(
          `[drain] ensureBranch ${decision.integrationBranch} failed; basing on ${def}:`,
          err,
        );
      }
    } else if (decision.integrationBranch) {
      console.warn(`[drain] forge lacks ensureBranch; basing epic child #${number} on ${def}`);
    }
    // Epic child actually based on the integration branch → tell the agent to target it as the
    // PR base (the agent opens its own PR and would otherwise default to the main branch).
    const usingEpicBase = !!decision.integrationBranch && base === decision.integrationBranch;
    const prompt = usingEpicBase ? `${title}\n\n${epicBaseDirective(base)}` : title;
    return { base, prompt };
  }

  private async doSpawn(
    repoPath: string,
    decision: Extract<DrainDecision, { kind: "spawn" }>,
  ): Promise<void> {
    const forge = this.deps.resolveForge(repoPath);
    if (!forge) return;
    const { number, url, title, body } = decision.issue;
    // Sandbox auto-gate pre-check: skip a held issue cleanly BEFORE claiming the label
    // or spawning, so a repo whose profile refuses auto (standard, or autonomous with no
    // backend) doesn't churn the claim label every tick. create() re-checks and throws as
    // defense-in-depth (its try releases the claim), but skipping here avoids that churn.
    const rc = this.deps.store.getRepoConfig(repoPath);
    const profile = resolveProfile(undefined, rc.sandboxProfile, config.sandboxDefaultProfile);
    // backend is backend-independent for trusted (autoHoldReason → null), so skip the real
    // bwrap self-test on a trusted repo — else auto-drain pays a probe every first tick.
    const hold = autoHoldReason(profile, profile === "trusted" ? null : detectBackend());
    if (hold) {
      console.warn(`[drain] issue #${number} held — ${hold}`);
      return;
    }
    // Pre-spawn claim re-check (closes the stale-cache race). The candidate came
    // from the short-TTL issuesCache, which can be up to issuesTtlMs old — long
    // enough for a SECOND instance to have stamped ACTIVE_LABEL since. A fresh,
    // uncached single-issue read catches that: if the claim is already present, an
    // earlier instance owns it, so yield without spawning (and without releasing
    // its label). Best-effort and optional: a host without getIssue, or a null
    // (gone/unreadable) read, falls through to spawn — local dedup still applies.
    // NOTE: this narrows, it does not eliminate, the window — two instances reading
    // fresh-and-unclaimed in the same instant still both stamp (see drain-core's
    // ACTIVE_LABEL note). That residual is accepted; closing it fully needs a
    // server-ordered claim (out of scope here).
    // SCOPE: the re-check inspects ONLY the claim label (ACTIVE_LABEL), not whether
    // the opt-in autoLabel is still present. A candidate another operator un-labeled
    // (opted out) between the cached list read and now is NOT caught here — it still
    // spawns. Re-validating the opt-in is a separate concern from the claim race this
    // closes, and the next tick's fresh listIssues drops a de-labeled issue anyway.
    try {
      const fresh = await forge.getIssue?.(number);
      if (fresh?.labels.includes(ACTIVE_LABEL)) return;
    } catch (err) {
      console.warn(`[drain] pre-spawn re-check for issue #${number} failed:`, err);
      // fall through to spawn — best-effort, never stall the drain.
    }
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
    // consume the attended-mode approval on attempt; a failed spawn requires re-approval (approval is not issue-bound)
    this.approvedNext.delete(repoPath);
    try {
      const { base, prompt } = await this.resolveSpawnBase(forge, decision);
      // Auto-spawns honor an explicit operator default-model — the repo override
      // wins over the global default; when both are unset ("inherit"/"auto") they
      // fall back to no --model flag (Claude's own default). The Fable promo is a
      // client-only UI concern and is NEVER applied to autonomous spawns.
      await this.deps.service.create({
        repoPath,
        baseBranch: base,
        prompt,
        model: drainSpawnModel(resolveDefaultModelSetting(rc.defaultModel, config.defaultModel)),
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
    // A legacy manual session created before issue-link stamping carries an
    // issueNumber but never had the label applied; the remove is then a harmless
    // idempotent no-op (best-effort, swallowed below) — not worth a per-session
    // "was-stamped" flag to suppress.
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

  /** Pump a repo unless its drain toggle is off AND no epic is running. */
  private async pumpIfEnabled(repoPath: string): Promise<void> {
    const cfg = this.deps.store.getRepoConfig(repoPath);
    const er = this.deps.store.getEpicRun(repoPath);
    // a paused epic must not pump (no new spawns) but still appears in snapshot()
    if (!(cfg.autoDrainEnabled || er?.status === "running")) return;
    await this.pump(repoPath);
  }

  /** Periodic sweep (~30s): catches newly-labeled issues + resumed usage windows. */
  async tick(): Promise<void> {
    for (const repoPath of this.deps.repos()) {
      const cfg = this.deps.store.getRepoConfig(repoPath);
      const er = this.deps.store.getEpicRun(repoPath);
      if (cfg.autoDrainEnabled || er?.status === "running") await this.pump(repoPath);
    }
  }

  /** Client bootstrap: a status per drain-enabled or epic-running repo, WITHOUT applying side
   *  effects (no spawn/retire). Disabled repos with no active epic are skipped. */
  async snapshot(): Promise<DrainStatus[]> {
    const out: DrainStatus[] = [];
    for (const repoPath of this.deps.repos()) {
      const cfg = this.deps.store.getRepoConfig(repoPath);
      const er = this.deps.store.getEpicRun(repoPath);
      if (!cfg.autoDrainEnabled && !(er?.status === "running" || er?.status === "paused")) continue;
      const { state } = await this.buildState(repoPath);
      out.push(this.toStatus(repoPath, state, computeNext(state)));
    }
    return out;
  }

  /** The actual backlog issues behind {@link DrainStatus.queued}: the not-yet-
   *  mapped candidates, in drain order (priority-first per selectCandidates).
   *  No side effects. Empty for drain-disabled repos (buildState yields no
   *  candidates there — and the forge is never hit). */
  async queue(repoPath: string): Promise<QueuedItem[]> {
    const { state } = await this.buildState(repoPath);
    return state.candidates
      .filter((c) => !state.mappedIssueNumbers.has(c.number))
      .map((c) => ({ number: c.number, title: c.title, url: c.url }));
  }
}
