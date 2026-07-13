import type { SessionStore } from "./store";
import type { GitForge, GitState } from "./forge/types";
import type { ReviewVerdict, Session } from "./types";
import type { WorktreeMgr } from "./worktree";
import {
  computeMerge,
  type MergeDecision,
  type MergeRepoState,
  type MergeSessionView,
} from "./automerge-core";
import { recordEpicIntegrationIfChild, settleMergedSession } from "./merge-teardown";
import { isFullAuto } from "./full-auto";

/** Live per-repo merge-train status pushed to clients. */
export interface AutoMergeStatus {
  repoPath: string;
  enabled: boolean;
  /** "merging" | "rebasing" | "merge_error" | "rebase_cap" while acting/paused; null when idle. */
  state: string | null;
  /** A desig for the operator banner, when relevant. */
  detail: string | null;
  /** The affected session's id, so the push deep-link selects it; null when none. */
  sessionId: string | null;
}

/** Steer text — agent-facing, English, NOT i18n (typed into the PTY like OPEN_PR_STEER).
 *  Names the session's real base branch so a non-`main` base rebases against the right ref. */
function rebaseSteer(baseBranch: string): string {
  return [
    "You're in full-auto and your PR can't merge as-is — it's behind the base branch (or has",
    `conflicts). Fetch origin, rebase your branch onto origin/${baseBranch}, resolve any conflicts,`,
    "and force-push with --force-with-lease. Do NOT merge the base branch into yours (it breaks the",
    "linear-history gate). If something genuinely blocks this, say specifically what you need.",
  ].join("\n");
}

/** After this many rapid merge failures on the SAME head, back the PR off so it stops
 *  re-firing forge.merge and stops blocking the train. */
const MERGE_ERROR_CAP = 3;
/** Backoff window once the cap trips: one retry allowed per window thereafter. */
const MERGE_ERROR_BACKOFF_MS = 300_000;

export interface AutoMergeDeps {
  store: Pick<
    SessionStore,
    | "get"
    | "list"
    | "getRepoConfig"
    | "getReview"
    | "setAutoMergeState"
    | "setAutopilotState"
    | "isEpicIntegratedChild"
    | "getEpicRun"
    | "getEpicIntegrationBranch"
    | "recordEpicIntegrated"
  >;
  service: {
    archive(id: string): Promise<number>;
    /** SessionService.reply (async since #1567; resolves true when the steer reached a live pane). */
    reply(id: string, text: string): Promise<boolean>;
    /** SessionService.resume (async — the awaited result decides; truthy = resumed). */
    resume(id: string): unknown;
    /** Clear the session's merge-train mark + credit the train tracker. Called directly
     *  here because an autonomous merge emits no session:git event for the normal
     *  resolveMerging path; a no-op unless the session was merge-train-flagged. */
    resolveMerging(id: string, didMerge: boolean): void;
  };
  resolveForge: (repoPath: string) => GitForge | null;
  worktree: Pick<WorktreeMgr, "behindBase">;
  prCache: { snapshot(): Record<string, GitState> };
  /** Whether the session's herdr pane is live (so a steer lands). */
  paneAlive: (id: string) => boolean;
  /** Defer steering while a herdr-restored account pane still needs a re-drive (SessionService.shouldDeferSteer). */
  deferSteer?: (id: string) => boolean;
  repos: () => string[];
  emitStatus: (s: AutoMergeStatus) => void;
  emitArchived: (id: string) => void;
  dropPrCache: (id: string) => void;
  noteMergedForRecap?: (input: {
    sessionId: string;
    prNumber: number;
    headSha: string | null;
  }) => void;
  /** Mark a session so the drain's onArchived keeps its claim (close failed). */
  retainClaim: (id: string) => void;
  rebaseCap: number;
  now?: () => number;
  /** Short cache TTL for behindBase (default 10s). */
  behindTtlMs?: number;
}

export class AutoMergeService {
  private pumping = new Set<string>();
  private behindCache = new Map<string, { behind: boolean | null; ts: number }>();
  /** Per-session merge-error backoff: consecutive failures on a head + when it's blocked until. */
  private mergeFail = new Map<string, { head: string; count: number; blockedUntil: number }>();
  private now: () => number;
  private behindTtlMs: number;

  constructor(private deps: AutoMergeDeps) {
    this.now = deps.now ?? Date.now;
    this.behindTtlMs = deps.behindTtlMs ?? 10_000;
  }

  /** behindBase() shells out to `git fetch`; cache per (worktree,base) for a short TTL so a
   *  burst of poller events / client snapshots doesn't fan out one fetch per open PR each time.
   *  Cleared on a successful merge so siblings get a fresh read once main moves. */
  private async cachedBehind(worktreePath: string, baseBranch: string): Promise<boolean | null> {
    const key = `${worktreePath}\0${baseBranch}`;
    const hit = this.behindCache.get(key);
    if (hit && this.now() - hit.ts < this.behindTtlMs) return hit.behind;
    const behind = await this.deps.worktree.behindBase(worktreePath, baseBranch);
    this.behindCache.set(key, { behind, ts: this.now() });
    return behind;
  }

  /** Effective full-auto: a session is a candidate when both autopilot AND auto-merge resolve
   *  true (shared with the drain + autopilot via {@link isFullAuto}). */
  private fullAuto(s: Session): boolean {
    return isFullAuto(s, this.deps.store.getRepoConfig(s.repoPath));
  }

  /** Whether the repo has any non-archived full-auto session — the real gate for the train
   *  (a per-session override enables it even when the repo flag defaults off). */
  private repoHasFullAuto(repoPath: string): boolean {
    return this.deps.store
      .list()
      .some((s) => s.repoPath === repoPath && s.status !== "archived" && this.fullAuto(s));
  }

  /** True when a session's merge is currently backed off: CAP failures on the current head,
   *  inside the backoff window. A new head or a success clears the backoff entry. The head is
   *  normalized with `?? ""` to match recordMergeFailure, so even a (practically unreachable)
   *  null-head PR that keeps failing still backs off rather than retrying forever. */
  private computeMergeBlocked(id: string, headSha: string | null): boolean {
    const f = this.mergeFail.get(id);
    return (
      !!f && f.head === (headSha ?? "") && f.count >= MERGE_ERROR_CAP && this.now() < f.blockedUntil
    );
  }

  /** PR-derived view fields (defaults for an absent/closed snapshot). Pulled out so toView
   *  stays flat — every `git?.x ?? y` here is a branch that would otherwise inflate it. */
  private static prFields(git: GitState | null) {
    return {
      state: git?.state ?? ("none" as const),
      checks: git?.checks ?? ("none" as const),
      noCi: git?.noCi ?? false,
      mergeable: git?.mergeable ?? null,
      mergeStateStatus: git?.mergeStateStatus,
      number: git?.number ?? null,
      headSha: git?.headSha ?? null,
      humanApproved: git?.latestReview?.state === "approved",
      isDraft: git?.isDraft ?? false,
    };
  }

  /** Critic-verdict view fields (defaults when no verdict yet). */
  private static reviewFields(review: ReviewVerdict | null) {
    return {
      reviewDecision: review?.decision ?? null,
      reviewHeadSha: review?.headSha ?? null,
      findings: review?.findings ?? [],
    };
  }

  /** Project one full-auto session + its cached PR snapshot into the core's view. */
  private async toView(s: Session, git: GitState | null): Promise<MergeSessionView> {
    const pr = AutoMergeService.prFields(git);
    const behind =
      git?.state === "open" && s.worktreePath && s.branch
        ? await this.cachedBehind(s.worktreePath, s.baseBranch)
        : null;
    return {
      id: s.id,
      desig: s.desig,
      ...pr,
      behind,
      ...AutoMergeService.reviewFields(this.deps.store.getReview(s.id)),
      rebaseCount: s.autoMergeRebaseCount,
      rebaseSteeredHead: s.autoMergeRebaseHead,
      mergeBlocked: this.computeMergeBlocked(s.id, pr.headSha),
      manualSteps: s.manualSteps,
      manualStepsAckedAt: s.manualStepsAckedAt,
    };
  }

  private async buildState(repoPath: string): Promise<MergeRepoState> {
    const cfg = this.deps.store.getRepoConfig(repoPath);
    const snapshot = this.deps.prCache.snapshot();
    const sessions: MergeSessionView[] = await Promise.all(
      this.deps.store
        .list()
        .filter((s) => s.repoPath === repoPath && s.status !== "archived" && this.fullAuto(s))
        .map((s) => this.toView(s, snapshot[s.id] ?? null)),
    );
    return {
      enabled: sessions.length > 0,
      criticEnabled: cfg.criticEnabled,
      draftMode: cfg.draftMode,
      signoffAuthority: cfg.signoffAuthority,
      rebaseCap: this.deps.rebaseCap,
      sessions,
    };
  }

  private status(
    repoPath: string,
    enabled: boolean,
    state: string | null,
    detail: string | null,
    sessionId: string | null,
  ): AutoMergeStatus {
    return { repoPath, enabled, state, detail, sessionId };
  }

  /** Reset the rebase budget for sessions whose branch is now current and conflict-free. */
  private resetClearedCounters(state: MergeRepoState): void {
    for (const s of state.sessions) {
      if (s.rebaseCount > 0 && s.behind === false && s.mergeable === true) {
        this.deps.store.setAutoMergeState(s.id, { rebaseCount: 0, rebaseHead: null });
      }
    }
  }

  /**
   * Apply one merge-decision step. Returns "continue" to keep pumping, "break" to stop.
   * Preserves the attempted-guard and fail-closed semantics of the original inline code.
   */
  private async applyDecision(
    repoPath: string,
    decision: MergeDecision,
    attempted: Set<string>,
  ): Promise<"continue" | "break"> {
    if (decision.kind === "merge") {
      if (attempted.has(decision.sessionId)) return "break";
      attempted.add(decision.sessionId);
      const ok = await this.doMerge(
        repoPath,
        decision.sessionId,
        decision.prNumber,
        decision.headSha,
      );
      return ok ? "continue" : "break";
    }
    if (decision.kind === "rebase") {
      if (attempted.has(decision.sessionId)) return "break";
      attempted.add(decision.sessionId);
      await this.doRebase(repoPath, decision.sessionId, decision.headSha);
      return "break";
    }
    const reason = decision.reason.code === "idle" ? null : decision.reason.code;
    this.deps.emitStatus(
      this.status(
        repoPath,
        true,
        reason,
        decision.reason.detail ?? null,
        decision.reason.sessionId ?? null,
      ),
    );
    return "break";
  }

  /** Pump a repo's merge train: build → decide → apply, until it holds. Serial per repo. */
  async pump(repoPath: string): Promise<void> {
    if (this.pumping.has(repoPath)) return;
    this.pumping.add(repoPath);
    try {
      const attempted = new Set<string>();
      for (let i = 0; i < 100; i++) {
        let state: MergeRepoState;
        try {
          state = await this.buildState(repoPath);
        } catch (err) {
          console.warn(`[automerge] build/compute failed for ${repoPath}:`, err);
          break;
        }
        this.resetClearedCounters(state);
        let decision: MergeDecision;
        try {
          decision = computeMerge(state);
        } catch (err) {
          console.warn(`[automerge] compute failed for ${repoPath}:`, err);
          break;
        }
        const signal = await this.applyDecision(repoPath, decision, attempted);
        if (signal === "break") break;
      }
    } finally {
      this.pumping.delete(repoPath);
    }
  }

  /** Land a ready PR. Returns true on success (session settled), false on a fail-closed error. */
  private async doMerge(
    repoPath: string,
    sessionId: string,
    prNumber: number,
    headSha: string | null,
  ): Promise<boolean> {
    const forge = this.deps.resolveForge(repoPath);
    const s = this.deps.store.get(sessionId);
    if (!forge || !s) return false;
    this.deps.emitStatus(this.status(repoPath, true, "merging", s.desig, s.id));
    try {
      await forge.merge(prNumber, { method: forge.mergeMethod, deleteBranch: true });
    } catch (err) {
      console.warn(`[automerge] merge pr#${prNumber} failed for ${sessionId}:`, err);
      this.recordMergeFailure(sessionId, headSha);
      this.deps.emitStatus(this.status(repoPath, true, "merge_error", s.desig, s.id));
      return false;
    }
    this.mergeFail.delete(sessionId); // success clears any backoff
    this.deps.noteMergedForRecap?.({ sessionId, prNumber, headSha });
    // Clear the behind-cache so sibling sessions get a fresh read now that main has moved.
    this.behindCache.clear();
    // Autonomous merge emits no session:git event, so clear the merge-train mark and
    // credit the train tracker directly (the poller-driven resolveMerging never fires
    // for this path). No-op unless the session was merge-train-flagged.
    this.deps.service.resolveMerging(sessionId, true);
    // #1401: record epic integration BEFORE settleMergedSession so its isIntegratedEpicChild
    // guard (#1037) sees the fresh row and archives-only. The base comes from the prCache
    // snapshot (a merge doesn't change the base), with the helper's prReviewMeta fallback.
    // Normally unreachable for epic children (isFullAuto excludes integration-branch bases),
    // but a session whose PR was re-targeted to the epic branch can still be train-merged.
    const git = this.deps.prCache.snapshot()[sessionId] ?? null;
    await recordEpicIntegrationIfChild(
      s,
      { number: prNumber, url: git?.url, baseRefName: git?.baseRefName },
      { store: this.deps.store, forge },
    );
    await settleMergedSession(s, {
      resolveForge: this.deps.resolveForge,
      archive: (id) => this.deps.service.archive(id),
      dropPrCache: this.deps.dropPrCache,
      emitArchived: this.deps.emitArchived,
      retainClaim: this.deps.retainClaim,
      // #1037: defense-in-depth — never close an integrated epic child out of band here either.
      isIntegratedEpicChild: (sess) =>
        sess.issueNumber != null &&
        this.deps.store.isEpicIntegratedChild(sess.repoPath, sess.issueNumber),
    });
    return true;
  }

  /** Record a merge failure against the current head; arm the backoff window at the cap. */
  private recordMergeFailure(sessionId: string, headSha: string | null): void {
    const head = headSha ?? "";
    const cur = this.mergeFail.get(sessionId);
    const count = cur && cur.head === head ? cur.count + 1 : 1;
    this.mergeFail.set(sessionId, {
      head,
      count,
      blockedUntil: count >= MERGE_ERROR_CAP ? this.now() + MERGE_ERROR_BACKOFF_MS : 0,
    });
  }

  /** Steer the (idle) agent to rebase onto its base; bump the attempt counter + record the head. */
  private async doRebase(
    repoPath: string,
    sessionId: string,
    headSha: string | null,
  ): Promise<void> {
    const s = this.deps.store.get(sessionId);
    if (!s) return;
    this.deps.emitStatus(this.status(repoPath, true, "rebasing", s.desig, s.id));
    if (!this.deps.paneAlive(sessionId) || this.deps.deferSteer?.(sessionId)) {
      // Not live, OR a herdr-restored account husk that must be re-driven first (else the rebase steer
      // lands on the wrong-account pane). resume() re-drives (Locus B) before we reply below.
      if (!(await this.deps.service.resume(sessionId))) return;
    }
    if (await this.deps.service.reply(sessionId, rebaseSteer(s.baseBranch))) {
      this.deps.store.setAutoMergeState(sessionId, {
        rebaseCount: s.autoMergeRebaseCount + 1,
        rebaseHead: headSha,
      });
      // A rebase is a fresh procedural task; give autopilot a clean step budget so unblocking
      // the rebase across several gates doesn't trip the runaway cap and pause spuriously.
      this.deps.store.setAutopilotState(sessionId, { stepCount: 0 });
    }
  }

  async onGit(id: string): Promise<void> {
    await this.pumpForSession(id);
  }
  async onReview(id: string): Promise<void> {
    await this.pumpForSession(id);
  }
  async onStatus(id: string): Promise<void> {
    await this.pumpForSession(id);
  }

  private async pumpForSession(id: string): Promise<void> {
    const s = this.deps.store.get(id);
    if (!s) return;
    if (!this.repoHasFullAuto(s.repoPath)) return;
    await this.pump(s.repoPath);
  }

  /** Periodic sweep (~30s): catch stale branches after sibling merges + resumed sessions. */
  async tick(): Promise<void> {
    for (const repoPath of this.deps.repos()) {
      if (this.repoHasFullAuto(repoPath)) await this.pump(repoPath);
    }
  }

  /** Client bootstrap: a status per full-auto-active repo, no side effects. */
  async snapshot(): Promise<AutoMergeStatus[]> {
    const out: AutoMergeStatus[] = [];
    for (const repoPath of this.deps.repos()) {
      if (!this.repoHasFullAuto(repoPath)) continue;
      const d = computeMerge(await this.buildState(repoPath));
      const reason = d.kind === "hold" ? (d.reason.code === "idle" ? null : d.reason.code) : d.kind;
      const detail = d.kind === "hold" ? (d.reason.detail ?? null) : null;
      const sessionId = d.kind === "hold" ? (d.reason.sessionId ?? null) : d.sessionId;
      out.push(this.status(repoPath, true, reason, detail, sessionId));
    }
    return out;
  }
}
