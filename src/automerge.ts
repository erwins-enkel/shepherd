import type { SessionStore } from "./store";
import type { GitForge, GitState } from "./forge/types";
import {
  MergeEnqueuedError,
  MergeNotCompletedError,
  StackedMergeRefusedError,
  StackUntestedError,
} from "./forge/types";
import type { ReviewVerdict, Session, SessionArchiveReason } from "./types";
import type { WorktreeMgr } from "./worktree";
import type { PrCache } from "./pr-poller";
import {
  CHECKS_ABSENT_MS,
  computeMerge,
  mergeWaitReason,
  type MergeDecision,
  type MergeWaitCode,
  type MergeRepoState,
  type MergeSessionView,
} from "./automerge-core";
import {
  recordEpicIntegrationIfChild,
  recordIncrementalStackLanding,
  settleMergedSession,
} from "./merge-teardown";
import { isFullAuto } from "./full-auto";
import { detectMigrationPaths } from "./epic-migrations";
import {
  EPIC_STACK_COMPOSE_TTL_MS,
  bottomMostUnmergedPr,
  epicChildBaseOk,
  isStackedBase,
  landedStackChildren,
  stackRetireGate,
} from "./epic-stack";

/** Live per-repo merge-train status pushed to clients. */
export interface AutoMergeStatus {
  repoPath: string;
  enabled: boolean;
  /** "merging" | "rebasing" | "merge_error" | "rebase_cap" | "stack_untested", or a hold code
   *  ("stacked", "migrations", "manual_steps") while acting/paused; null when idle. */
  state: string | null;
  /** A desig for the operator banner, when relevant. */
  detail: string | null;
  /** The affected session's id, so the push deep-link selects it; null when none. */
  sessionId: string | null;
  /** Every full-auto PR the train is currently NOT landing, with the reason (from the latest
   *  state build). Presence means "the train owns this PR"; absent sessions are either not
   *  full-auto, have no open PR, or are landing now. */
  waiting: AutoMergeWait[];
}

/** One held full-auto PR on {@link AutoMergeStatus.waiting}. */
export interface AutoMergeWait {
  sessionId: string;
  code: MergeWaitCode;
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
/** How long a marked PR counts as queued while a readable queue does not list it (#3223): since
 *  the enqueue (read lag) or its last sighting in the queue. Past it, a live read decides merged vs
 *  ejected. */
const ENQUEUE_GRACE_MS = 60_000;

/** A base's merge queue as the train sees it: its PR numbers, null = the base has no queue (or the
 *  forge has no queues), "unknown" = the read failed (fail open to queue-less behavior). */
type QueueRead = number[] | null | "unknown";

export interface AutoMergeDeps {
  capacity?: (session: Session) => Promise<boolean>;
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
    | "markEpicStackLanded"
    | "listEpicStack"
  >;
  service: {
    archive(id: string, reapKeys?: string[], reason?: SessionArchiveReason): Promise<number>;
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
  prCache: Pick<PrCache, "snapshot" | "noteEnqueued">;
  /** Whether the session's herdr pane is live (so a steer lands). */
  paneAlive: (id: string) => Promise<boolean>;
  /** Defer steering while a herdr-restored account pane still needs a re-drive (SessionService.shouldDeferSteer). */
  deferSteer?: (id: string) => Promise<boolean>;
  repos: () => string[];
  emitStatus: (s: AutoMergeStatus) => void;
  emitArchived: (id: string) => void;
  dropPrCache: (id: string) => void;
  noteMergedForRecap?: (input: {
    sessionId: string;
    prNumber: number;
    headSha: string | null;
  }) => void;
  /** #3133: freeze the merged session's manual steps into the Owed lens — a train merge emits
   *  no session:git merged event, so the poller-driven materialization never fires for it. */
  materializeManualSteps?: (s: Session, prNumber: number, prTitle: string) => void;
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
  /** Per (repo, base) merge-queue read, same TTL as {@link behindCache}. The promise is cached so
   *  the concurrent toView calls of one buildState share a single forge read. */
  private queueCache = new Map<string, { read: Promise<QueueRead>; ts: number }>();
  /** PRs the train handed to a merge queue (#3223), keyed by session, with the head enqueued and
   *  when. Counts the PR as queued through the read's lag, and is what tells a queue ejection
   *  (same head, no longer listed) apart from a PR nobody enqueued. In-memory only. */
  private enqueued = new Map<string, { head: string; at: number }>();
  /** Per-session merge-error backoff: consecutive failures on a head + when it's blocked until. */
  private mergeFail = new Map<string, { head: string; count: number; blockedUntil: number }>();
  /** Sessions whose PR was found to belong to a GitHub stack (#2059), keyed by the head SHA it
   *  was observed on. The train learns this the only cheap way available — it attempts the merge
   *  once and the forge refuses BEFORE mutating anything — then remembers, so the core skips the
   *  PR from then on instead of re-probing every pump. Keyed by head so a new push re-tests: a PR
   *  can leave a stack. In-memory only; a restart simply re-learns on the next attempt. */
  private stackedHold = new Map<string, string>();
  /** Incremental-epic children's migration probe, keyed by session and the head SHA it was read
   *  on: a new push re-probes. Only successful reads are cached (a failed read holds this pump and
   *  retries on the next). Pruned to live sessions on every buildState. In-memory only. */
  private migrationsCache = new Map<string, { head: string; migrations: boolean }>();
  /** #3197: incremental-epic stack layers whose live-stack confirmation refused at merge time,
   *  per repo, with when. TIME-BOXED (EPIC_STACK_COMPOSE_TTL_MS) rather than head-keyed like
   *  {@link stackedHold}: the layer below can land without this layer's head moving, so a
   *  head-keyed hold would never lift. Cleared for the repo on every successful train merge. */
  private stackConfirmHeld = new Map<string, Map<string, number>>();
  /** #3221: when each session's PR was first seen at `checks:"none"` on its current head. Feeds
   *  {@link MergeSessionView.checksAbsent}. In-memory only; a restart restarts the clock. */
  private checksNoneSince = new Map<string, { head: string; since: number }>();
  /** Per-repo wait reasons from the latest buildState, attached to every emitted status. */
  private waiting = new Map<string, AutoMergeWait[]>();
  private now: () => number;
  private behindTtlMs: number;

  constructor(private deps: AutoMergeDeps) {
    this.now = deps.now ?? Date.now;
    this.behindTtlMs = deps.behindTtlMs ?? 10_000;
  }

  /** behindBase() shells out to `git fetch`; cache per (worktree,base) for a short TTL so a
   *  burst of poller events / client snapshots doesn't fan out one fetch per open PR each time.
   *  Cleared on a successful merge so siblings get a fresh read once main moves. */
  private async cachedBehind(
    worktreePath: string,
    baseBranch: string,
    repoPath: string,
  ): Promise<boolean | null> {
    const key = `${worktreePath}\0${baseBranch}`;
    const hit = this.behindCache.get(key);
    if (hit && this.now() - hit.ts < this.behindTtlMs) return hit.behind;
    const behind = await this.deps.worktree.behindBase(worktreePath, baseBranch, repoPath);
    this.behindCache.set(key, { behind, ts: this.now() });
    return behind;
  }

  /** `base`'s merge queue (#3223), cached per (repo, base) for the behind TTL. */
  private cachedQueue(repoPath: string, base: string): Promise<QueueRead> {
    const forge = this.deps.resolveForge(repoPath);
    if (!forge?.mergeQueueEntries) return Promise.resolve(null);
    const key = `${repoPath}\0${base}`;
    const hit = this.queueCache.get(key);
    if (hit && this.now() - hit.ts < this.behindTtlMs) return hit.read;
    const read = forge.mergeQueueEntries(base).catch((err: unknown): QueueRead => {
      console.warn(`[automerge] merge-queue read for ${base} failed; assuming none:`, err);
      return "unknown";
    });
    this.queueCache.set(key, { read, ts: this.now() });
    return read;
  }

  /** Is this PR the merge queue's (#3223)? Listed in the queue, or marked (enqueued by the train,
   *  or seen listed) on its current head and still inside the grace window, or the queue is
   *  unreadable. A marked PR missing from a readable queue past the grace left it: merged (the
   *  poller's snapshot can lag a full sweep behind) or ejected — typically a failed merge_group
   *  run. {@link leftQueue} tells the two apart with a live read. */
  private async reconcileQueued(
    s: Session,
    pr: { state: string; number: number | null; headSha: string | null },
    queue: QueueRead,
  ): Promise<boolean> {
    const mark = this.enqueued.get(s.id);
    if (pr.state !== "open" || !pr.number) {
      this.enqueued.delete(s.id);
      return false;
    }
    const head = pr.headSha ?? "";
    const listed = Array.isArray(queue) && queue.includes(pr.number);
    if (listed) {
      // (Re)start the grace from the last sighting — whoever enqueued it — so a PR that leaves
      // the queue is judged by leftQueue, never re-merged on a stale "open" snapshot.
      this.enqueued.set(s.id, { head, at: this.now() });
      return true;
    }
    if (!mark) return false;
    if (mark.head !== head) {
      this.enqueued.delete(s.id); // a push dequeues: not an ejection worth counting
      return false;
    }
    if (queue === "unknown" || this.now() - mark.at < ENQUEUE_GRACE_MS) return true;
    return this.leftQueue(s, pr.number, head);
  }

  /** Read-only {@link reconcileQueued} for snapshot(): listed, or marked on the current head. A
   *  mark past its grace still reads as queued — whether it merged or was ejected is the pump's
   *  call, made with a live read. */
  private peekQueued(
    id: string,
    pr: { state: string; number: number | null; headSha: string | null },
    queue: QueueRead,
  ): boolean {
    if (pr.state !== "open" || !pr.number) return false;
    if (Array.isArray(queue) && queue.includes(pr.number)) return true;
    return this.enqueued.get(id)?.head === (pr.headSha ?? "");
  }

  /** A marked PR is gone from a readable queue. Ask the forge whether it is still open: merged or
   *  closed (or unreadable) keeps it queued — nothing to land, and the poller settles it — and
   *  only a live open PR counts as an ejection, a merge failure, so a deterministic ejection backs
   *  off at MERGE_ERROR_CAP instead of looping enqueue/eject forever. */
  private async leftQueue(s: Session, prNumber: number, head: string): Promise<boolean> {
    // Claim the mark BEFORE the await: a fresh grace makes any overlapping caller read it as
    // queued, and only the holder of this exact claim may count the ejection — never twice.
    const claim = { head, at: this.now() };
    this.enqueued.set(s.id, claim);
    const forge = this.deps.resolveForge(s.repoPath);
    let state: string | null = null;
    try {
      state = (await forge?.prReviewMeta?.(prNumber))?.state ?? null;
    } catch (err) {
      console.warn(`[automerge] pr#${prNumber} state read failed; keeping it queued:`, err);
    }
    // Merged/closed/unreadable: keep the claim — re-ask after another grace, not every pump.
    // A claim replaced meanwhile (re-sighted in the queue, a new head) is someone else's answer.
    if (state !== "open" || this.enqueued.get(s.id) !== claim) return true;
    console.warn(`[automerge] pr#${prNumber} left the merge queue unmerged; counting a failure`);
    this.enqueued.delete(s.id);
    this.recordMergeFailure(s.id, head);
    return false;
  }

  /** Effective full-auto: a session is a candidate when both autopilot AND auto-merge resolve
   *  true (shared with the drain + autopilot via {@link isFullAuto}). */
  private fullAuto(s: Session): boolean {
    return isFullAuto(s, this.deps.store.getRepoConfig(s.repoPath));
  }

  /** Repos with any non-archived full-auto session — the real gate for the train (a per-session
   *  override enables it even when the repo flag defaults off). One `list()` for all repos: it
   *  hydrates every session, so asking per repo is O(repos × sessions) on the event loop. */
  private fullAutoRepos(): Set<string> {
    return new Set(
      this.deps.store
        .list()
        .filter((s) => s.status !== "archived" && this.fullAuto(s))
        .map((s) => s.repoPath),
    );
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
      reviewSpawnAborted: review?.spawnAborted === true,
      findings: review?.findings ?? [],
    };
  }

  /** Project one full-auto session + its cached PR snapshot into the core's view. */
  private async toView(
    s: Session,
    git: GitState | null,
    mergeWithoutCi: boolean,
    reconcile: boolean,
  ): Promise<MergeSessionView> {
    const pr = AutoMergeService.prFields(git);
    const queue: QueueRead =
      pr.state === "open"
        ? await this.cachedQueue(s.repoPath, git?.baseRefName ?? s.baseBranch)
        : null;
    // #3223: on a merge-queue base GitHub retests each PR against the latest base itself, so
    // `behind` neither gates the merge nor warrants a rebase. Conflicts still do (mergeable/dirty).
    const onQueueBase = Array.isArray(queue);
    const behind =
      git?.state === "open" && s.worktreePath && s.branch
        ? onQueueBase
          ? false
          : await this.cachedBehind(s.worktreePath, s.baseBranch, s.repoPath)
        : null;
    return {
      id: s.id,
      desig: s.desig,
      ...pr,
      noCiHold: pr.noCi && !mergeWithoutCi,
      checksAbsent: this.checksAbsent(s.id, pr),
      behind,
      queued: reconcile
        ? await this.reconcileQueued(s, pr, queue)
        : this.peekQueued(s.id, pr, queue),
      ...AutoMergeService.reviewFields(this.deps.store.getReview(s.id)),
      rebaseCount: s.autoMergeRebaseCount,
      rebaseSteeredHead: s.autoMergeRebaseHead,
      rebaseSteeredAt: s.autoMergeRebaseSteeredAt ?? null,
      // Mirrors autopilot.tick()'s running/blocked skip, which the train otherwise lacks.
      busy: s.status === "running" || s.status === "blocked",
      mergeBlocked: this.computeMergeBlocked(s.id, pr.headSha),
      stacked:
        this.stackedHold.get(s.id) === (pr.headSha ?? "") ||
        (pr.state === "open" && (await this.incrementalStackHeld(s))),
      migrations: await this.touchesMigrations(s, pr.state, pr.number, pr.headSha),
      manualSteps: s.manualSteps,
      manualStepsAckedAt: s.manualStepsAckedAt,
    };
  }

  /** #3197: the default branch — an incremental epic's stack trunk — or null when unreadable. The
   *  forge caches it, so this is free after the first read. */
  private async trunkOf(repoPath: string): Promise<string | null> {
    try {
      return (await this.deps.resolveForge(repoPath)?.defaultBranch()) ?? null;
    } catch (err) {
      console.warn(`[automerge] default-branch read failed for ${repoPath}:`, err);
      return null;
    }
  }

  /** #3197: is this incremental-epic child a stack layer the train may not land yet? Store-only
   *  (plus the cached trunk). A recorded layer waits while a layer below it has not landed; a
   *  child on a SIBLING's branch that no stack holds yet waits outright — a plain merge would
   *  squash it into that sibling's branch. A refused live confirmation holds for its window. */
  private async incrementalStackHeld(s: Session): Promise<boolean> {
    const parent = s.incrementalEpicParent;
    if (parent == null || s.issueNumber == null) return false;
    if (this.freshConfirmHold(s)) return true;
    const rows = this.deps.store.listEpicStack(s.repoPath, parent);
    if (rows.some((r) => r.childNumber === s.issueNumber)) {
      const gate = stackRetireGate({
        rows,
        childNumber: s.issueNumber,
        integratedChildren: landedStackChildren(rows),
      });
      return gate.kind === "hold";
    }
    const trunk = await this.trunkOf(s.repoPath);
    return trunk === null || isStackedBase(s.baseBranch, trunk);
  }

  private freshConfirmHold(s: Session): boolean {
    const held = this.stackConfirmHeld.get(s.repoPath);
    const at = held?.get(s.id);
    if (at === undefined) return false;
    if (this.now() - at < EPIC_STACK_COMPOSE_TTL_MS) return true;
    held!.delete(s.id);
    return false;
  }

  private holdStackConfirm(s: Session): void {
    const held = this.stackConfirmHeld.get(s.repoPath) ?? new Map<string, number>();
    held.set(s.id, this.now());
    this.stackConfirmHeld.set(s.repoPath, held);
  }

  /** #3197: may this incremental-epic child land now, and does it need `allowStacked`? `false` →
   *  an ordinary PR, merge as before. `true` → the bottom-most unmerged layer of a stack rooted at
   *  the default branch, so exactly one PR lands. `null` → hold: the live stack refused (a foreign
   *  PR below, a layer not yet stamped landed, a stack rooted elsewhere) — time-boxed — or the
   *  trunk could not be read (no hold; the next pump retries). The rows say what Shepherd
   *  composed; only the live read can vouch that nothing ungated sits beneath this layer. */
  private async confirmIncrementalStack(
    forge: GitForge,
    s: Session,
    prNumber: number,
  ): Promise<boolean | null> {
    const parent = s.incrementalEpicParent;
    if (parent == null || s.issueNumber == null) return false;
    const rows = this.deps.store.listEpicStack(s.repoPath, parent);
    const member = rows.some((r) => r.childNumber === s.issueNumber);
    const trunk = await this.trunkOf(s.repoPath);
    if (trunk === null) return null;
    if (!member && !isStackedBase(s.baseBranch, trunk)) return false;
    const stack = (await forge.stackForPr?.(prNumber)) ?? null;
    const actualBase =
      this.deps.prCache.snapshot()[s.id]?.baseRefName ??
      (await forge.prReviewMeta?.(prNumber))?.baseRefName ??
      "";
    const landedPrs = new Set(rows.filter((r) => r.landedAt != null).map((r) => r.prNumber));
    const ok =
      epicChildBaseOk({ actualBase, sessionBase: s.baseBranch, stack, trunk }) &&
      (!stack || bottomMostUnmergedPr(stack.prNumbers, landedPrs) === prNumber);
    if (ok) return !!stack;
    console.warn(
      `[automerge] incremental epic layer pr#${prNumber} (issue #${s.issueNumber}) is not the bottom-most unmerged layer of a stack on \`${trunk}\` — held`,
    );
    this.holdStackConfirm(s);
    return null;
  }

  /** Is another live session based on this one's branch? Then merging must keep that branch: a
   *  stacked successor that has not opened its PR yet would lose its base (#2069 keep-branch). */
  private hasLiveSuccessorOn(s: Session): boolean {
    if (!s.branch) return false;
    return this.deps.store
      .list({ activeOnly: true })
      .some((o) => o.id !== s.id && o.repoPath === s.repoPath && o.baseBranch === s.branch);
  }

  /** Does this incremental-epic child's open PR touch migration paths? Fails CLOSED (true) when
   *  the forge cannot list PR files or the read throws, so a human merges. Sessions that are not
   *  incremental-epic children (or have no open PR) never probe — zero extra forge calls. */
  private async touchesMigrations(
    s: Session,
    state: string,
    prNumber: number | null,
    headSha: string | null,
  ): Promise<boolean> {
    if (s.incrementalEpicParent == null || state !== "open" || !prNumber) return false;
    const hit = this.migrationsCache.get(s.id);
    if (hit && headSha !== null && hit.head === headSha) return hit.migrations;
    const forge = this.deps.resolveForge(s.repoPath);
    if (!forge?.prChangedPaths) return true;
    try {
      const migrations = detectMigrationPaths(await forge.prChangedPaths(prNumber)).length > 0;
      if (headSha !== null) this.migrationsCache.set(s.id, { head: headSha, migrations });
      return migrations;
    } catch (err) {
      console.warn(`[automerge] pr#${prNumber} changed-paths read failed; holding ${s.id}:`, err);
      return true;
    }
  }

  /** Drop migration-probe entries for sessions no longer live, so the cache stays bounded. */
  /** Whether a CI repo's open PR has sat at `checks:"none"` on its current head for
   *  CHECKS_ABSENT_MS while GitHub calls it `clean` (#3221). Stamps the first sighting. */
  private checksAbsent(id: string, pr: ReturnType<typeof AutoMergeService.prFields>): boolean {
    if (pr.state !== "open" || pr.checks !== "none" || pr.noCi) {
      this.checksNoneSince.delete(id);
      return false;
    }
    const head = pr.headSha ?? "";
    let seen = this.checksNoneSince.get(id);
    if (seen?.head !== head) {
      seen = { head, since: this.now() };
      this.checksNoneSince.set(id, seen);
    }
    return pr.mergeStateStatus === "clean" && this.now() - seen.since >= CHECKS_ABSENT_MS;
  }

  private pruneMigrationsCache(live: Session[]): void {
    if (this.migrationsCache.size === 0) return;
    const ids = new Set(live.filter((s) => s.status !== "archived").map((s) => s.id));
    for (const id of this.migrationsCache.keys()) if (!ids.has(id)) this.migrationsCache.delete(id);
  }

  private pruneChecksNoneSince(live: Session[]): void {
    if (this.checksNoneSince.size === 0) return;
    const ids = new Set(live.filter((s) => s.status !== "archived").map((s) => s.id));
    for (const id of this.checksNoneSince.keys()) if (!ids.has(id)) this.checksNoneSince.delete(id);
  }

  /** Drop enqueue marks for sessions no longer live (archived by the poller once merged). */
  private pruneEnqueued(live: Session[]): void {
    if (this.enqueued.size === 0) return;
    const ids = new Set(live.filter((s) => s.status !== "archived").map((s) => s.id));
    for (const id of this.enqueued.keys()) if (!ids.has(id)) this.enqueued.delete(id);
  }

  /** `reconcile` = false (snapshot) reads the merge-queue marks without touching them: no live PR
   *  read, no mark rewrite, no ejection counted — those belong to the pump alone (#3223). */
  private async buildState(repoPath: string, reconcile = true): Promise<MergeRepoState> {
    const cfg = this.deps.store.getRepoConfig(repoPath);
    const snapshot = this.deps.prCache.snapshot();
    const all = this.deps.store.list();
    this.pruneMigrationsCache(all);
    this.pruneChecksNoneSince(all);
    if (reconcile) this.pruneEnqueued(all);
    const sessions: MergeSessionView[] = await Promise.all(
      all
        // Shelved sessions are left alone: no merge, no rebase steer.
        .filter(
          (s) =>
            s.repoPath === repoPath && s.status !== "archived" && !s.shelved && this.fullAuto(s),
        )
        .map((s) => this.toView(s, snapshot[s.id] ?? null, cfg.mergeWithoutCi, reconcile)),
    );
    const state: MergeRepoState = {
      enabled: sessions.length > 0,
      now: this.now(),
      criticEnabled: cfg.criticEnabled,
      draftMode: cfg.draftMode,
      signoffAuthority: cfg.signoffAuthority,
      rebaseCap: this.deps.rebaseCap,
      sessions,
    };
    this.waiting.set(
      repoPath,
      sessions.flatMap((v) => {
        const code = mergeWaitReason(v, state);
        return code ? [{ sessionId: v.id, code }] : [];
      }),
    );
    return state;
  }

  private status(
    repoPath: string,
    enabled: boolean,
    state: string | null,
    detail: string | null,
    sessionId: string | null,
  ): AutoMergeStatus {
    return {
      repoPath,
      enabled,
      state,
      detail,
      sessionId,
      waiting: this.waiting.get(repoPath) ?? [],
    };
  }

  /** Reset the rebase budget for sessions whose branch is now current and conflict-free. */
  private resetClearedCounters(state: MergeRepoState): void {
    for (const s of state.sessions) {
      if (s.rebaseCount > 0 && s.behind === false && s.mergeable === true) {
        this.deps.store.setAutoMergeState(s.id, {
          rebaseCount: 0,
          rebaseHead: null,
          rebaseSteeredAt: null,
        });
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
      const outcome = await this.doMerge(
        repoPath,
        decision.sessionId,
        decision.prNumber,
        decision.headSha,
      );
      // "enqueued" keeps pumping too: the PR now reads as queued, so the next decision is the
      // next ready PR — every green PR enters the queue in one pump (#3223).
      return outcome === false ? "break" : "continue";
    }
    if (decision.kind === "rebase") {
      if (attempted.has(decision.sessionId)) return "break";
      attempted.add(decision.sessionId);
      await this.doRebase(repoPath, decision.sessionId, decision.headSha, decision.conflict);
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

  /** Classify a failed `forge.merge` from {@link doMerge}: a named hold, an in-flight merge, or a
   *  counted failure. Returns what {@link doMerge} reports for it: "enqueued" when a merge queue
   *  took the PR (#3223), else false (not landed). */
  private onMergeError(
    err: unknown,
    repoPath: string,
    s: Session,
    prNumber: number,
    headSha: string | null,
  ): false | "enqueued" {
    const sessionId = s.id;
    if (err instanceof StackedMergeRefusedError && s.incrementalEpicParent != null) {
      // An incremental child the live read did not see stacked: time-box it like a refused
      // confirmation so it is re-checked once the layer below lands.
      console.warn(`[automerge] pr#${prNumber} is stacked; holding ${sessionId}:`, err.message);
      this.holdStackConfirm(s);
      this.deps.emitStatus(this.status(repoPath, true, "stacked", s.desig, s.id));
      return false;
    }
    if (err instanceof StackedMergeRefusedError) {
      // NOT a merge failure: the forge refused before mutating anything. Recording it would
      // burn MERGE_ERROR_CAP against a PR that will never become train-mergeable, so instead
      // remember the stack and let computeMerge report a named `stacked` hold from now on.
      console.warn(`[automerge] pr#${prNumber} is stacked; holding ${sessionId}:`, err.message);
      this.stackedHold.set(sessionId, headSha ?? "");
      this.deps.emitStatus(this.status(repoPath, true, "stacked", s.desig, s.id));
      return false;
    }
    if (err instanceof StackUntestedError) {
      // #3192: the stack was not tested against the trunk's current tip. Refused before any
      // mutation and cured by a restack, so NOT a merge failure; the next pump re-checks (the
      // behind gate normally steers that rebase first — this is the race backstop).
      console.warn(`[automerge] pr#${prNumber} untested against trunk; holding:`, err.message);
      this.deps.emitStatus(this.status(repoPath, true, "stack_untested", s.desig, s.id));
      return false;
    }
    if (err instanceof MergeEnqueuedError) {
      // In flight in the merge queue: neither settled nor a failure. Marked so the train stops
      // re-merging it and moves on; the PR poller reconciles the eventual merge.
      console.warn(`[automerge] pr#${prNumber} enqueued in the merge queue`);
      this.enqueued.set(sessionId, { head: headSha ?? "", at: this.now() });
      this.deps.prCache.noteEnqueued?.(sessionId, headSha);
      return "enqueued";
    }
    if (err instanceof MergeNotCompletedError) {
      // The merge is in flight host-side (a poll that outlived its budget).
      // Neither settle the session nor count a failure — the PR poller reconciles.
      console.warn(`[automerge] merge pr#${prNumber} not completed (${err.code}):`, err.message);
      return false;
    }
    console.warn(`[automerge] merge pr#${prNumber} failed for ${sessionId}:`, err);
    this.recordMergeFailure(sessionId, headSha);
    this.deps.emitStatus(this.status(repoPath, true, "merge_error", s.desig, s.id));
    return false;
  }

  /** Land a ready PR. Returns true on success (session settled), "enqueued" when a merge queue
   *  took it (#3223), false on a fail-closed error. */
  private async doMerge(
    repoPath: string,
    sessionId: string,
    prNumber: number,
    headSha: string | null,
  ): Promise<boolean | "enqueued"> {
    const forge = this.deps.resolveForge(repoPath);
    const s = this.deps.store.get(sessionId);
    // F09: the merge is bound to the head the CI + critic gate evaluated; no head, no merge.
    if (!forge || !s || !headSha) return false;
    let stacked: boolean | null;
    try {
      stacked = await this.confirmIncrementalStack(forge, s, prNumber);
    } catch (err) {
      console.warn(`[automerge] stack confirm for pr#${prNumber} failed; retrying later:`, err);
      return false; // no hold: the next pump re-reads
    }
    if (stacked === null) return false;
    this.deps.emitStatus(this.status(repoPath, true, "merging", s.desig, s.id));
    try {
      // `allowStacked` ONLY for the confirmed bottom-most unmerged layer of an incremental epic's
      // stack (#3197): merging it lands exactly one PR. Anything else is refused by the forge — the
      // train must never land a stack, since merging a layer also lands every unmerged layer below
      // it, and those were never gated by our CI check or the critic (#2059).
      await forge.merge(prNumber, {
        method: forge.mergeMethod,
        deleteBranch: !this.hasLiveSuccessorOn(s),
        expectedHeadSha: headSha,
        ...(stacked ? { allowStacked: true } : {}),
      });
    } catch (err) {
      return this.onMergeError(err, repoPath, s, prNumber, headSha);
    }
    this.mergeFail.delete(sessionId); // success clears any backoff
    this.enqueued.delete(sessionId);
    this.stackedHold.delete(sessionId); // a landed PR was evidently not stacked
    this.stackConfirmHeld.delete(repoPath); // a layer landed: every other layer's answer changed
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
    recordIncrementalStackLanding(s, prNumber, this.deps.store);
    await settleMergedSession(s, {
      resolveForge: this.deps.resolveForge,
      archive: (id, reason) => this.deps.service.archive(id, undefined, reason),
      dropPrCache: this.deps.dropPrCache,
      emitArchived: this.deps.emitArchived,
      retainClaim: this.deps.retainClaim,
      onMerged: (sess) => this.deps.materializeManualSteps?.(sess, prNumber, git?.title ?? ""),
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
    conflict: boolean,
  ): Promise<void> {
    const s = this.deps.store.get(sessionId);
    if (!s) return;
    if (this.deps.capacity && !(await this.deps.capacity(s))) return;
    this.deps.emitStatus(this.status(repoPath, true, "rebasing", s.desig, s.id));

    // CONFLICT PATH ONLY: record the attempt (count + head + the dedup/ownership stamp) BEFORE
    // the resume/reply, so an unresumable pane still marches to rebaseCap and hands back — the
    // property reEngageRebase relies on (autopilot.ts). Safe here because the conflict dedup
    // EXPIRES on REBASE_DEDUP_TTL_MS, so recording the head neither wedges the session nor lets
    // it monopolise the pump's single rebase slot.
    //
    // The `behind` path deliberately keeps count-on-success-only. Counting its delivery failures
    // was tried and reverted: `resetClearedCounters` only clears once the PR is current AND
    // mergeable, and reEngageRebase's reset is unreachable for full-auto sessions
    // (rebaseCandidate bails on fullAuto), so a transient pane/herdr outage spanning rebaseCap
    // pumps would permanently park a behind PR at the rebase_cap hold with no automatic
    // recovery. A transient outage must not become a permanent park.
    //
    // KNOWN, PRE-EXISTING: a behind session whose steer never lands records nothing, stays
    // eligible, and — since a rebase decision breaks the pump loop — occupies the repo's single
    // rebase slot until its pane recovers. That behaviour is unchanged from main and is not
    // introduced here; fixing it needs a release path this change deliberately does not invent.
    if (conflict) {
      this.deps.store.setAutoMergeState(sessionId, {
        rebaseCount: s.autoMergeRebaseCount + 1,
        rebaseHead: headSha,
        rebaseSteeredAt: this.now(),
      });
    }
    if (!(await this.deps.paneAlive(sessionId)) || (await this.deps.deferSteer?.(sessionId))) {
      // Not live, OR a herdr-restored account husk that must be re-driven first (else the rebase steer
      // lands on the wrong-account pane). resume() re-drives (Locus B) before we reply below.
      if (!(await this.deps.service.resume(sessionId))) return;
    }
    if (await this.deps.service.reply(sessionId, rebaseSteer(s.baseBranch))) {
      // Already recorded above on the conflict path — don't double-count.
      // The behind path stamps rebaseSteeredAt too, so autopilot's CI-fix loop stands down on a
      // behind+red PR the train has taken (ownedByRebaser) — whatever GitHub's mergeStateStatus
      // says, since the train's `behind` is a git fetch. Recorded on success only: a head stamped
      // before a failed delivery would sit behind the behind path's permanent per-head dedup.
      if (!conflict) {
        this.deps.store.setAutoMergeState(sessionId, {
          rebaseCount: s.autoMergeRebaseCount + 1,
          rebaseHead: headSha,
          rebaseSteeredAt: this.now(),
        });
      }
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
    if (!this.fullAutoRepos().has(s.repoPath)) return;
    await this.pump(s.repoPath);
  }

  /** Periodic sweep (~30s): catch stale branches after sibling merges + resumed sessions. */
  async tick(): Promise<void> {
    const live = this.fullAutoRepos();
    for (const repoPath of this.deps.repos()) {
      if (live.has(repoPath)) await this.pump(repoPath);
      else if (this.waiting.get(repoPath)?.length) {
        // Full-auto was switched off (session override or repo toggle) — neither path pumps, so
        // clear the last-known wait list once, or the UI would keep claiming the train owns the PR.
        this.waiting.set(repoPath, []);
        this.deps.emitStatus(this.status(repoPath, false, null, null, null));
      }
    }
  }

  /** Client bootstrap: a status per full-auto-active repo. Never pumps and never reconciles the
   *  merge-queue marks (see buildState's `reconcile`). */
  async snapshot(): Promise<AutoMergeStatus[]> {
    const out: AutoMergeStatus[] = [];
    const live = this.fullAutoRepos();
    for (const repoPath of this.deps.repos()) {
      if (!live.has(repoPath)) continue;
      const d = computeMerge(await this.buildState(repoPath, false));
      const reason = d.kind === "hold" ? (d.reason.code === "idle" ? null : d.reason.code) : d.kind;
      const detail = d.kind === "hold" ? (d.reason.detail ?? null) : null;
      const sessionId = d.kind === "hold" ? (d.reason.sessionId ?? null) : d.sessionId;
      out.push(this.status(repoPath, true, reason, detail, sessionId));
    }
    return out;
  }
}
