import type { SessionStore } from "./store";
import type { GitForge, GitState, Issue, PrStatus, SubIssueRef } from "./forge/types";
import type { CreateSessionInput, Session } from "./types";
import type { SessionStateChange } from "./session-snapshot";
import type { UsageLimits } from "./usage-limits";
import type { TelemetryService } from "./telemetry";
import { recordEpicIntegrationIfChild, settleMergedSession } from "./merge-teardown";
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
import {
  epicIntegrationBranch as epicBranchName,
  isEpicIntegrationBranch,
  branchReferencesEpic,
} from "./epic-branch";
import { selectEpicCandidates, type Epic, type EpicRun } from "./epic-core";
import { detectMigrationPaths } from "./epic-migrations";
import {
  buildRollup,
  computeLandingReady,
  isLiveRepairSession,
  type CompletedEpic,
  type CompletedEpicChild,
  type EpicLandingState,
} from "./completed-epic";
import { buildLandingPrTitle, buildLandingPrBody } from "./epic-landing";
import { parseEpicBody } from "./epic-parse";
import { diagnoseEpic, type EpicDiagnosis } from "./epic-diagnosis";
import { repoHasNoCiCached } from "./checks-gate";
import { EmptyDiffError } from "./forge/types";
import { mapBounded } from "./map-bounded";
import { config } from "./config";
import { rebaseLandingBranch, isUnionDriverRegistered } from "./landing-rebase";

/** Concurrency cap for the per-child blocked_by fan-out when assembling an epic.
 *  Bounds `gh api` subprocesses so a large (100+-child) epic can't exhaust FDs or
 *  trip GitHub secondary rate limits. */
const EPIC_BLOCKED_BY_CONCURRENCY = 8;

/** #645 (c): re-scan the host for stray `epic/*` branches at most this often per epic. The
 *  scan is an advisory divergence warning, not gating — a 5-minute staleness is harmless and
 *  keeps `gh api matching-refs` off the per-pump hot path. */
const EPIC_BRANCH_SCAN_TTL_MS = 5 * 60_000;

/** #790: after a drain spawn for an issue fails (e.g. worktree isolation aborted), back off
 *  re-attempting that issue for this long. Without it, abort + the ~30s tick would loop
 *  spawn→abort→re-claim with GitHub label-API churn. A transient failure self-heals after the
 *  window; a persistent one stops churning. */
const SPAWN_FAIL_COOLDOWN_MS = 5 * 60_000;

/** #645 (Task 2): once a child's PR is found targeting the wrong base, don't re-pay the
 *  `prReviewMeta` API call on every pump while the operator hasn't fixed it — recheck at most
 *  this often per child. Bounds the cost to ≤1 call/child/~60s while a child stays blocked. */
const EPIC_BASE_RECHECK_TTL_MS = 60_000;
/** #1401: one reconcile sweep per epic per this window (plus one on the first tick after a
 *  restart — the throttle map is in-memory). Slow on purpose: the sweep is convergence repair
 *  for merges whose event-time recording was missed, not a hot path. */
const EPIC_RECONCILE_TTL_MS = 5 * 60_000;

/** Cap on epic-landing-PR open attempts (#635, Stage B). A failed `openPr` flips the
 *  `epic_completed` row to `landingState:'error'` and increments `landingAttempts`; the
 *  autonomous tick retries until this many failures, then PARKS the row in `error` —
 *  still surfaced on the band, but excluded from the retry set so it makes no further
 *  forge calls. Bounds the cost of a permanently-broken landing (no perpetual retry). */
const MAX_LANDING_ATTEMPTS = 5;

/** Per-head-SHA budget of automatic failed-CI reruns for a red epic landing PR before we stop and
 *  leave it to the operator-facing `landingCiFailing` surfacing. A new head resets the budget. */
const LANDING_RERUN_CAP = 2;

/** One lifetime agent-repair attempt per epic landing PR (durable via `landingRepairCount`). Once
 *  C's rerun budget is spent and CI is still terminally red, the drain dispatches a single capped
 *  repair session that pushes directly to the pinned integration branch. Exhausted ⇒ fall back to
 *  the operator-facing `landingCiFailing` surface. */
const LANDING_REPAIR_CAP = 1;

/** Auto-land merge-error guardrails (#1044) — mirror AutoMergeService's per-head cap + backoff.
 *  After this many consecutive merge failures on the SAME landing-PR head, back the epic off so it
 *  stops re-firing forge.merge each tick; one retry per backoff window thereafter. In-memory only
 *  (a merge failure is NOT persisted on the row — `landingAttempts`/`error` track the OPEN action,
 *  not the merge — so the manual CTA and the next eligible tick can still retry). */
const LAND_MERGE_ERROR_CAP = 3;
const LAND_MERGE_BACKOFF_MS = 300_000;
import {
  drainSpawnModel,
  modelForProviderOrDefault,
  resolveDefaultModelSetting,
} from "./default-model";
import { drainSpawnEffort, resolveDefaultEffortSetting } from "./default-effort";
import {
  resolveProfile,
  autoHoldReason,
  egressApplies,
  detectBackend,
  type SandboxBackend,
} from "./sandbox";
import { detectEgressBackend, type EgressBackend } from "./egress";
import { epicBaseDirective } from "./autopilot";

/** #1071: After this many consecutive driver-absent / driver-broken results without a successful
 *  rebase, escalate to the operator (pauseReason='driver'). Keeps a persistently-misconfigured
 *  clone from silently retrying forever while giving transient registration glitches a few chances
 *  to self-heal before surfacing. */
const DRIVER_MISS_CAP = 3;

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
    | "getOrInitEpicIntegrationBranch"
    | "getEpicIntegrationBranch"
    | "listEpicIntegrated"
    | "isEpicIntegratedChild"
    | "recordEpicIntegrated"
    | "listEpicIntegratedDetails"
    | "recordEpicCompleted"
    | "listEpicCompleted"
    | "setEpicLandingPr"
    | "setEpicLandingRebaseState"
    | "setEpicLandingRepairCount"
    | "setEpicMigrationPaths"
    | "recordEpicBaseMismatch"
    | "clearEpicBaseMismatch"
    | "getEpicBaseMismatch"
    | "listEpicBaseMismatches"
  >;
  service: {
    create(input: CreateSessionInput): Promise<Session>;
    archive(id: string): Promise<number>;
  };
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
  /** → events.emit("epic:completed", e). Optional — absent in tests that don't need it. */
  emitEpicCompleted?: (epic: CompletedEpic) => void;
  /** → events.emit("session:new", s). Optional — absent in tests that don't need it. */
  emitSessionNew?: (s: Session) => void;
  /** Anonymous product telemetry. `event()` no-ops unless consent is granted (src/telemetry.ts),
   *  so no call-site gating is needed. Absent in tests that don't assert emission. */
  telemetry?: Pick<TelemetryService, "event">;
  now?: () => number;
  /** Short cache for listIssues (default 10s). */
  issuesTtlMs?: number;
  /** Sandbox backend probe seam (tests inject so no real bwrap spawns); defaults to the
   *  cached real self-test in sandbox.ts. Mirrors SessionService's seam. */
  detectBackend?: () => SandboxBackend;
  /** Egress backend probe seam (tests inject so no real netns/dnsmasq spawns); defaults to
   *  the cached real self-test in egress.ts. Probed only for an autonomous-profile repo
   *  with an FS backend, so a drain-spawned autonomous session is refused-loud when egress
   *  is unavailable. */
  detectEgressBackend?: () => EgressBackend;
  /** #1071: maximum genuine rebase attempts (cap budget). Wired from config.autoMergeRebaseCap
   *  in index.ts; injected directly so tests can set a small cap without touching global config. */
  rebaseCap: number;
  /** #1071: injectable seam for rebaseLandingBranch (tests inject a fake). Defaults to the real
   *  impl (src/landing-rebase.ts) in the constructor. */
  rebaseLandingBranch?: typeof rebaseLandingBranch;
  /** #1071: injectable seam for the driver-pause fast-path re-probe (tests inject a fake).
   *  Defaults to the real isUnionDriverRegistered (src/landing-rebase.ts) in the constructor. */
  isDriverRegistered?: (repoPath: string) => Promise<boolean>;
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
  // In-flight guard for ensureLandingPr, keyed `${repoPath}#${parentIssueNumber}`.
  // ensureLandingPr is a read-modify-write across awaits and runs OUTSIDE the per-repo
  // `pumping` lock (reachable from tick(), which has no re-entrancy guard, and from the
  // pumpStep completion edge). Two overlapping resolutions for the same epic would
  // otherwise both read prStatus=none → both openPr (two landing PRs) and both read the
  // same landingAttempts → lose an increment. This set makes the second invocation a
  // no-op; it'll be retried next tick anyway.
  private landingInFlight = new Set<string>();
  /** Automatic landing-CI reruns (C), keyed `${repoPath}#${parentIssueNumber}` → the current head +
   *  reruns spent on it. A new head replaces the entry (reset), and a successful/terminal land deletes
   *  it — so the map stays bounded to live epics, mirroring `landMergeFail`. In-memory (ephemeral). */
  private landingRerunCount = new Map<string, { head: string; count: number }>();
  /** Landing-repair spawn back-off, keyed `${repoPath}#${parentIssueNumber}` → timestamp of the last
   *  FAILED spawn. A hold/egress/transient refusal must NOT permanently burn the one lifetime attempt
   *  (`landingRepairCount`) — it backs off SPAWN_FAIL_COOLDOWN_MS and retries; only a SUCCESSFUL
   *  spawn increments the durable count (and clears this entry). In-memory (ephemeral). */
  private repairSpawnCooldown = new Map<string, number>();
  // Auto-land (#1044) per-epic merge-error backoff, keyed `${repoPath}#${parentIssueNumber}`:
  // consecutive merge failures on the current landing-PR head + when the epic is blocked until.
  // A new head or a success clears the entry. In-memory (ephemeral); mirrors AutoMergeService.
  private landMergeFail = new Map<string, { head: string; count: number; blockedUntil: number }>();
  // sessionIds whose claim label onArchived must NOT release. Populated in doRetire
  // (a ready PR stays open → keep the claim so no instance re-spawns it; the human
  // merge auto-closes the issue, retiring the claim) and in onGit ONLY for a merge
  // whose closeIssue FAILED (issue still open → keep the claim). A plain abandon
  // (manual archive, never retired) is absent here, so onArchived drops the label
  // and re-queues the issue. Consumed (deleted) in onArchived.
  private retainClaimOnArchive = new Set<string>();
  private issuesCache = new Map<string, { issues: Issue[]; ts: number }>();
  private epicStructureCache = new Map<string, { reads: EpicStructure; ts: number }>();
  // #645 (c): throttle the host epic/* branch scan — keyed `${repoPath}#${parentIssueNumber}`,
  // refreshed at most every EPIC_BRANCH_SCAN_TTL_MS. In-memory only (ephemeral advisory warning;
  // recomputing on restart is fine — no persisted column).
  private epicBranchScanCache = new Map<string, { at: number; divergent: string[] }>();
  private lastEpicSig = new Map<string, string>();
  // #1401: `${repoPath}#${parentIssueNumber}` → last reconcile-sweep timestamp. In-memory on
  // purpose: a restart sweeps immediately (deploy ⇒ a pre-existing stall self-heals within one
  // tick), then settles to one sweep per EPIC_RECONCILE_TTL_MS.
  private epicReconcileAt = new Map<string, number>();
  /** #790: `${repoPath}#${issueNumber}` → last spawn-failure timestamp; throttles re-spawn
   *  of an issue whose create() keeps throwing. Cleared on a successful spawn. In-memory. */
  private spawnFailures = new Map<string, number>();
  private approvedNext = new Set<string>();
  /** Extra-credit cost-guard baseline (account-wide, in-memory/ephemeral). The scraped paid-credit
   *  total is CUMULATIVE MONTHLY, but paid overage only accrues once a subscription window is
   *  exhausted — so a nonzero month-to-date total while the weekly window still has headroom is
   *  HISTORICAL spend, not imminent spend, and must not freeze the drain until the monthly credit
   *  reset. We anchor the total at first observation and re-anchor at each weekly-window reset AND
   *  at each monthly credit-budget rollover (detected by the credit reset epoch advancing, with a
   *  spend-drop fallback for an unparseable reset label), then gate on spend accrued SINCE that
   *  anchor (see {@link effectiveCreditSpent}). null until first observed. On restart the anchor
   *  re-captures the current total, which is why a deploy of this fix immediately clears a stale
   *  historical-spend pause. */
  private creditBaseline: {
    spent: number;
    weekResetAt: number | null;
    monthResetAt: number | null;
  } | null = null;
  private now: () => number;
  private issuesTtlMs: number;
  /** #1071: injectable seam; defaults to the real rebaseLandingBranch import. */
  private rebaseLandingBranch: typeof rebaseLandingBranch;
  /** #1071: injectable seam; defaults to the real isUnionDriverRegistered import. */
  private isDriverRegistered: (repoPath: string) => Promise<boolean>;

  constructor(private deps: DrainDeps) {
    this.now = deps.now ?? Date.now;
    this.issuesTtlMs = deps.issuesTtlMs ?? 10_000;
    this.rebaseLandingBranch = deps.rebaseLandingBranch ?? rebaseLandingBranch;
    this.isDriverRegistered = deps.isDriverRegistered ?? isUnionDriverRegistered;
  }

  /** Operator approves the next epic-attended spawn for the given repo. */
  approveEpicNext(repoPath: string): void {
    this.approvedNext.add(repoPath);
  }

  /** Sandbox backend probe: injected seam (tests) or the real cached self-test. Presence-check
   *  (not `?? real()`) since the seam legitimately returns null. */
  private detectBackend(): SandboxBackend {
    return this.deps.detectBackend ? this.deps.detectBackend() : detectBackend();
  }

  /** Egress backend probe: injected seam (tests) or the real cached self-test. Presence-check
   *  (not `?? real()`) since the seam legitimately returns null. */
  private detectEgressBackend(): EgressBackend {
    return this.deps.detectEgressBackend ? this.deps.detectEgressBackend() : detectEgressBackend();
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
    let openIssues: {
      number: number;
      title: string;
      url: string;
      body: string;
      labels: string[];
    }[] = [];
    let openIssuesTruncated = false;
    if (!native) {
      const open = await this.listIssues(repoPath);
      openIssues = open.map((i) => ({
        number: i.number,
        title: i.title,
        url: i.url,
        body: i.body,
        labels: i.labels,
      }));
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
    const parentTitle = struct.parent?.title ?? `#${run.parentIssueNumber}`;
    // The pinned canonical name (#645) — divergence is measured against THIS, not the live title.
    const persistedBranch = this.deps.store.getOrInitEpicIntegrationBranch(
      repoPath,
      run.parentIssueNumber,
      epicBranchName(run.parentIssueNumber, parentTitle),
    );
    // (b) recorded merge base per integrated child (null bases — legacy rows — are skipped).
    const integratedBases = new Map<number, string>();
    for (const d of this.deps.store.listEpicIntegratedDetails(repoPath, run.parentIssueNumber)) {
      if (d.mergedBase) integratedBases.set(d.childNumber, d.mergedBase);
    }
    // (c) throttled host scan for stray epic/* refs that reference this epic.
    const divergentBranches = await this.scanDivergentEpicBranches(
      repoPath,
      run.parentIssueNumber,
      persistedBranch,
    );
    // (Task 2) children parked at retire because their PR targets the wrong base.
    const recordedMismatches = this.deps.store.listEpicBaseMismatches(
      repoPath,
      run.parentIssueNumber,
    );
    const base = {
      repoPath,
      run,
      integrated,
      parent: {
        number: run.parentIssueNumber,
        title: parentTitle,
        body: struct.parent?.body ?? "",
      },
      subIssues: struct.subIssues,
      blockedBy: struct.blockedBy,
      openIssues,
      openIssuesTruncated,
      sessions,
      persistedBranch,
      integratedBases,
      divergentBranches,
    };
    // Self-heal orphaned base-mismatch markers (#645). The marker is only cleared inside the
    // retire path (doRetire → epicChildBaseBlocked), which re-runs only while the child PR is
    // still open. A blocked child resolved out-of-band (PR merged into default → issue closed)
    // never re-enters retire, so its marker — and its actionable "epic blocked until fixed"
    // warning — would persist forever. assembleEpic is PURE; the model decides done-in-epic as
    // `integrationMerged || issueClosed`, so derive the same done-set from the assembled children
    // (no forge call), clear markers for any now-done child, and surface only the still-blocked
    // ones. Idempotent (runs every build) and fail-safe.
    const probe = assembleEpic({ ...base, baseMismatches: recordedMismatches });
    const doneInEpic = new Set(
      probe.children.filter((c) => c.integrationMerged || c.issueClosed).map((c) => c.number),
    );
    const liveMismatches = recordedMismatches.filter((mm) => {
      if (doneInEpic.has(mm.childNumber)) {
        this.deps.store.clearEpicBaseMismatch(repoPath, run.parentIssueNumber, mm.childNumber);
        return false;
      }
      return true;
    });
    // No swept markers → the probe is already correct; reuse it rather than re-assembling.
    if (liveMismatches.length === recordedMismatches.length) return probe;
    return assembleEpic({ ...base, baseMismatches: liveMismatches });
  }

  /** On-demand structural diagnosis for one epic parent (GET /api/epic/diagnose). Reuses the
   *  cached epicStructure + buildEpic (so it does the SAME idempotent branch-pin / base-mismatch
   *  bookkeeping as buildEpic — deliberately, matching handleEpicGet; no forge/GitHub writes) and
   *  layers the raw native/body facts the pure diagnosis needs. */
  async diagnoseEpic(repoPath: string, run: EpicRun): Promise<EpicDiagnosis | null> {
    const struct = await this.epicStructure(repoPath, run);
    if (!struct) return null;
    const epic = await this.buildEpic(repoPath, run); // reuses the just-cached struct
    if (!epic) return null;
    const parsedBody = parseEpicBody(struct.parent?.body ?? "");
    const native = struct.subIssues.length > 0;
    let openIssuesTruncated = false;
    if (!native) {
      const open = await this.listIssues(repoPath);
      openIssuesTruncated = open.length >= 200;
    }
    return diagnoseEpic({
      epic,
      subIssues: struct.subIssues,
      blockedBy: struct.blockedBy,
      parsedBody,
      openIssuesTruncated,
    });
  }

  /** #645 (c): list host `epic/*` branches that reference `parentNumber` as a digit-bounded
   *  token but are NOT the pinned branch — i.e. divergent epic branches. Throttled per epic
   *  (EPIC_BRANCH_SCAN_TTL_MS) and best-effort: a forge without `listBranches` or a scan
   *  failure yields the cached or empty list and never breaks buildEpic. */
  private async scanDivergentEpicBranches(
    repoPath: string,
    parentNumber: number,
    persistedBranch: string,
  ): Promise<string[]> {
    const forge = this.deps.resolveForge(repoPath);
    if (!forge?.listBranches) return [];
    const key = `${repoPath}#${parentNumber}`;
    const cached = this.epicBranchScanCache.get(key);
    if (cached && this.now() - cached.at < EPIC_BRANCH_SCAN_TTL_MS) return cached.divergent;
    try {
      const branches = await forge.listBranches("epic/");
      const divergent = branches.filter(
        (b) => b !== persistedBranch && branchReferencesEpic(b, parentNumber),
      );
      this.epicBranchScanCache.set(key, { at: this.now(), divergent });
      return divergent;
    } catch (err) {
      console.warn(`[drain] epic-branch scan for #${parentNumber} failed:`, err);
      return cached?.divergent ?? [];
    }
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

  /**
   * Effective extra-credit spend for the drain cost guard: paid pay-as-you-go overage accrued
   * since the current weekly subscription window began (see {@link creditBaseline}), NOT the raw
   * cumulative month-to-date total. Paid overage can only be spent while a subscription window is
   * exhausted, so a nonzero month-to-date total with fresh weekly headroom is historical spend
   * that must not pause the drain until the (much later) monthly credit reset — the bug this
   * fixes. Returns 0 when credits are absent or stale (fail-safe: never pause on a missing/stale
   * scrape). Idempotent within a pump: the anchor only advances on first observation and when the
   * weekly reset boundary moves, so repeated per-repo calls in one pump (and the read-path
   * snapshot()/queue()) can't drift it, and it never flaps — a credit pause holds until the weekly
   * window actually resets rather than clearing the instant spawning stops.
   */
  private effectiveCreditSpent(limits: UsageLimits): number {
    const credits = limits.credits;
    if (!credits || credits.stale) return 0;
    const weekResetAt = limits.week?.resetAt ?? null;
    const monthResetAt = credits.resetAt; // the monthly credit-budget reset epoch (null if unparsed)
    const b = this.creditBaseline;
    // First observation (incl. after a restart): anchor the historical total; govern only spend
    // from here. A subscription window with headroom means no paid spend is happening now, so
    // baselining out the pre-existing total is safe; any genuinely new spend still rises above it.
    if (!b) {
      this.creditBaseline = { spent: credits.spent, weekResetAt, monthResetAt };
      return 0;
    }
    // Monthly credit budget rolled over → the new cycle starts at 0, so ALL of it is new spend.
    // Detect via EITHER the monthly reset epoch advancing (the robust signal — catches a new cycle
    // that already reached/exceeded last month's total before our first fresh scrape, e.g. Shepherd
    // stale/down across the boundary; a spend-drop check alone would then subtract the old anchor
    // and under-count) OR, as a fallback when the reset label was unparseable (null epoch), the
    // scraped total dropping below the anchor. Anchor at 0 and count the observed new-cycle total in
    // full — NEVER subtract the old-month anchor. Checked BEFORE the weekly roll so a coincident
    // monthly+weekly reset still counts (the weekly branch re-anchors to current, which would mask).
    const monthlyRolled =
      (monthResetAt != null && b.monthResetAt != null && monthResetAt > b.monthResetAt) ||
      credits.spent < b.spent;
    if (monthlyRolled) {
      this.creditBaseline = { spent: 0, weekResetAt, monthResetAt };
      return credits.spent;
    }
    // Weekly subscription window rolled over → fresh headroom (temporarily) stops paid spend, so
    // last week's overage no longer gates this week's drain. Anchor at the current total (spend in
    // earlier weeks of the SAME month is historical, unlike the fresh-from-0 monthly case above).
    if (weekResetAt != null && b.weekResetAt != null && weekResetAt > b.weekResetAt) {
      this.creditBaseline = { spent: credits.spent, weekResetAt, monthResetAt };
      return 0;
    }
    // Adopt late-arriving anchors (weekly calibration or a monthly reset label that only parsed
    // after we first observed credits) without disturbing the spend anchor — so future resets
    // stay detectable.
    if (b.weekResetAt == null && weekResetAt != null) b.weekResetAt = weekResetAt;
    if (b.monthResetAt == null && monthResetAt != null) b.monthResetAt = monthResetAt;
    return Math.max(0, credits.spent - b.spent);
  }

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
    let epicProviderSettings: DrainRepoState["epicProviderSettings"] = null;
    let spawnAgentProvider = config.defaultAgentProvider;
    let builtEpic: Epic | null = null;
    if (epicActive) {
      // Epic is running/paused: source candidates from its dependency-gated children
      // instead of the label-based listIssues path.
      builtEpic = await this.buildEpic(repoPath, epicRun!);
      if (builtEpic) {
        epicParent = epicRun!.parentIssueNumber;
        epicProviderSettings = epicRun!.agentProvider
          ? {
              agentProvider: epicRun!.agentProvider,
              model: epicRun!.model ?? null,
              effort: epicRun!.effort ?? null,
            }
          : null;
        spawnAgentProvider = epicRun!.agentProvider ?? config.defaultAgentProvider;
        // Pin the canonical name once (#645): re-deriving from the live title would re-point
        // spawns + the landing base on a mid-run title edit, orphaning already-merged children.
        epicIntegrationBranch = this.deps.store.getOrInitEpicIntegrationBranch(
          repoPath,
          builtEpic.parentIssueNumber,
          epicBranchName(builtEpic.parentIssueNumber, builtEpic.parentTitle),
        );
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
        // Extra-credit cost guard: paid overage accrued since the current weekly window began
        // (0 when credits is null/stale/post-reset — fail-safe), against the account-wide live
        // ceiling. NOT the raw month-to-date total — see effectiveCreditSpent for why (a nonzero
        // cumulative total with fresh weekly headroom is historical, not imminent, spend).
        creditSpent: this.effectiveCreditSpent(limits),
        creditSpendCeiling: config.extraCreditsDrainCeiling,
        autoSessions,
        mappedIssueNumbers,
        candidates,
        spawnAgentProvider,
        epicAttended,
        epicApprovedNext: this.approvedNext.has(repoPath),
        epicParent,
        epicIntegrationBranch,
        epicProviderSettings,
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
      hold !== null &&
      ["blocked", "changes_requested", "error", "usage", "credits"].includes(hold.code);
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
      // CONTRACT(#635): record before status flip — persist the durable completed-epic
      // rollup (+ emit) BEFORE flipping to idle, and gate the flip on the record succeeding.
      // A failed record leaves the epic running so the next pump re-observes all-merged and
      // retries the idempotent upsert, rather than silently losing the rollup.
      try {
        const rollup = buildRollup(
          epic.children,
          this.deps.store.listEpicIntegratedDetails(repoPath, epicRun.parentIssueNumber),
        );
        const completed: CompletedEpic = {
          repoPath,
          parentIssueNumber: epicRun.parentIssueNumber,
          parentTitle: epic.parentTitle,
          completedAt: this.now(),
          children: rollup,
          // Recorded as pending — its final state here; ensureLandingPr (driven by the
          // autonomous tick) opens the landing PR and transitions landingState/landingPrNumber.
          landingPrNumber: null,
          landingPrUrl: null,
          landingState: "pending",
          // Migration detection (#645) runs at landing-open, not completion — see ensureLandingPr.
          migrationPaths: [],
          migrationsAckedAt: null,
          landingRebasePauseReason: null,
          landingRepairCount: 0,
          landingRepairHead: null,
        };
        this.deps.store.recordEpicCompleted({
          repoPath: completed.repoPath,
          parentIssueNumber: completed.parentIssueNumber,
          parentTitle: completed.parentTitle,
          completedAt: completed.completedAt,
          childrenJson: JSON.stringify(rollup),
        });
        this.deps.emitEpicCompleted?.(completed);
      } catch (err) {
        console.warn(
          `[drain] epic-completed record failed for ${repoPath}#${epicRun.parentIssueNumber}:`,
          err,
        );
        this.emitEpicIfChanged(repoPath, epic);
        return false; // CONTRACT(#635): stay running, retry next pump
      }
      const completedRun = { ...epicRun, status: "idle" as const };
      this.deps.store.setEpicRun(completedRun);
      // Emit a final epic:update reflecting the completed/idle state before
      // the next buildState sees idle and stops emitting epicParent.
      this.emitEpicIfChanged(repoPath, { ...epic, run: completedRun });
      this.deps.telemetry?.event("epic_drained", { childCount: epic.children.length });
      return true;
    } else {
      this.emitEpicIfChanged(repoPath, epic);
      return false;
    }
  }

  /**
   * Re-read the resolved `epic_completed` row and emit it as a {@link CompletedEpic}
   * so the integrated-epics band reflects the new landing state. Called by every
   * resolve branch of {@link ensureLandingPr} after `setEpicLandingPr` writes, so the
   * band sees the latest landing fields without duplicating the build. A
   * vanished row (dismissed mid-flight) silently no-ops.
   */
  private emitCompleted(repoPath: string, parentIssueNumber: number): void {
    const row = this.deps.store
      .listEpicCompleted(repoPath)
      .find((r) => r.parentIssueNumber === parentIssueNumber);
    if (!row) return;
    // Display-only emit; called from ensureLandingPr's catch path, so a malformed
    // childrenJson must NOT throw past the handler (breaking its never-throws contract).
    let children: CompletedEpicChild[];
    try {
      children = JSON.parse(row.childrenJson) as CompletedEpicChild[];
    } catch (err) {
      console.warn(
        `[drain] emitCompleted skipped — bad childrenJson for ${repoPath}#${parentIssueNumber}:`,
        err,
      );
      return;
    }
    const completed: CompletedEpic = {
      repoPath,
      parentIssueNumber,
      parentTitle: row.parentTitle,
      completedAt: row.completedAt,
      children,
      landingPrNumber: row.landingPrNumber,
      landingPrUrl: row.landingPrUrl,
      landingState: row.landingState,
      migrationPaths: row.migrationPaths,
      migrationsAckedAt: row.migrationsAckedAt,
      landingRebasePauseReason: row.landingRebasePauseReason,
      landingRepairCount: row.landingRepairCount,
      landingRepairHead: row.landingRepairHead,
    };
    this.deps.emitEpicCompleted?.(completed);
  }

  /** Write the resolved landing fields to the `epic_completed` row and re-emit the band's
   *  CompletedEpic. The store-write + emit pair recurs in every resolve branch of
   *  {@link ensureLandingPr}; collapsing it here removes copy-paste drift risk. */
  private resolveLanding(
    repoPath: string,
    parentIssueNumber: number,
    fields: {
      state: EpicLandingState;
      prNumber: number | null;
      prUrl: string | null;
      attempts: number;
    },
  ): void {
    this.deps.store.setEpicLandingPr(repoPath, parentIssueNumber, fields);
    this.emitCompleted(repoPath, parentIssueNumber);
  }

  /**
   * Migration-awareness checkpoint (#645): fetch the landing PR's changed paths, detect migration
   * files, and persist them on the `epic_completed` row so the band can prompt the operator to
   * acknowledge before clearing it. STRICTLY best-effort + fail-safe — the whole body is wrapped:
   * a forge without `prChangedPaths`, a fetch failure, or any throw leaves no paths (hence no
   * chip) and is swallowed. It NEVER affects the landing resolution and NEVER throws past the
   * caller (which owns ensureLandingPr's never-throws contract). Re-emits so the chip appears live.
   */
  private async detectAndPersistMigrations(
    forge: GitForge,
    repoPath: string,
    parentIssueNumber: number,
    prNumber: number,
  ): Promise<void> {
    if (!forge.prChangedPaths) return; // host can't enumerate PR files → detection off
    try {
      const paths = await forge.prChangedPaths(prNumber);
      const migrations = detectMigrationPaths(paths);
      if (migrations.length === 0) return; // nothing to flag → leave the row untouched
      this.deps.store.setEpicMigrationPaths(repoPath, parentIssueNumber, migrations);
      this.emitCompleted(repoPath, parentIssueNumber);
    } catch (err) {
      console.warn(
        `[drain] migration detection skipped for ${repoPath}#${parentIssueNumber} (PR #${prNumber}):`,
        err,
      );
    }
  }

  /**
   * Open (or reuse) the aggregate `epic/<#>-<slug> → <default>` landing PR for a completed
   * epic and record its resolution on the `epic_completed` row — a single idempotent
   * operation (#635, Stage B).
   *
   * DECOUPLED FROM THE IDLE FLIP (NEVER wedges the repo's drain): completion already
   * recorded the row + flipped `running → idle` (see {@link handleEpicSideEffects}); a
   * running epic suppresses the repo's label-mode drain, so we MUST NOT gate that flip on
   * the landing PR — a single forge hiccup would otherwise freeze ALL autonomous drain for
   * the repo. This runs separately and surfaces failure on the band (`landingState:'error'`),
   * never by holding the run open. It MUST NEVER throw: every forge touch is wrapped and
   * mapped to a terminal/retryable state.
   *
   * Idempotent: `prStatus(integrationBranch)` (the integration branch is only ever the
   * landing PR's head, and prStatus reads `--state all`) reuses any prior PR (open/merged),
   * treats a human-closed PR as terminal `none` (we don't re-open what an operator closed),
   * and only opens when there is none. An `EmptyDiffError` (nothing to land) resolves `none`;
   * any other failure resolves `error` and increments `landingAttempts` for capped retry.
   */
  private async ensureLandingPr(
    repoPath: string,
    parentIssueNumber: number,
    parentTitle: string,
  ): Promise<void> {
    const forge = this.deps.resolveForge(repoPath);
    if (!forge) return;

    // Serialize per (repo, parent): bail if a resolution for this epic is already mid-flight.
    // The body is a read-modify-write across awaits and runs outside the `pumping` lock, so an
    // overlapping invocation (tick() ⟷ pumpStep edge) would otherwise double-open the PR and
    // lose a landingAttempts increment. The second caller no-ops; the tick retries it anyway.
    const inFlightKey = `${repoPath}#${parentIssueNumber}`;
    if (this.landingInFlight.has(inFlightKey)) return;
    this.landingInFlight.add(inFlightKey);
    try {
      const row = this.deps.store
        .listEpicCompleted(repoPath)
        .find((r) => r.parentIssueNumber === parentIssueNumber);
      if (!row) return; // nothing recorded (or already dismissed/landed)

      // Terminal / parked short-circuit — never re-touch the forge for a resolved or
      // capped-out row. `open`/`merged`/`none` are terminal; `error` at/over the cap is parked.
      if (
        row.landingState === "open" ||
        row.landingState === "merged" ||
        row.landingState === "none"
      )
        return;
      if (row.landingState === "error" && row.landingAttempts >= MAX_LANDING_ATTEMPTS) return;

      // Cheap pre-gate: a pure-legacy epic accumulated nothing on the integration branch,
      // so there is nothing to land. The authoritative empty-diff check is the openPr
      // EmptyDiffError below; this just avoids a doomed openPr round-trip.
      const integratedDetails = this.deps.store.listEpicIntegratedDetails(
        repoPath,
        parentIssueNumber,
      );
      if (integratedDetails.length === 0) {
        this.resolveLanding(repoPath, parentIssueNumber, {
          state: "none",
          prNumber: null,
          prUrl: null,
          attempts: row.landingAttempts,
        });
        return;
      }

      // Read the pinned name (#645) so the landing PR bases on the SAME branch children
      // merged into — even if the epic's title was edited after the branch was first pinned.
      const integrationBranch = this.deps.store.getOrInitEpicIntegrationBranch(
        repoPath,
        parentIssueNumber,
        epicBranchName(parentIssueNumber, parentTitle),
      );
      const resolution = await this.classifyLanding(forge, row, integrationBranch);
      this.resolveLanding(repoPath, parentIssueNumber, resolution);
      // Migration-awareness checkpoint (#645): once the landing PR's number is known, detect any
      // migration files it carries so the band can ask the operator to acknowledge them. Strictly
      // best-effort — a detection failure (or a forge without prChangedPaths) leaves no paths,
      // hence no chip, and NEVER affects the landing resolution above.
      if (resolution.state === "open" && resolution.prNumber != null) {
        await this.detectAndPersistMigrations(
          forge,
          repoPath,
          parentIssueNumber,
          resolution.prNumber,
        );
      }
    } finally {
      this.landingInFlight.delete(inFlightKey);
    }
  }

  /**
   * Resolve what the landing PR's state should become by talking to the forge: reuse an
   * existing open PR, record an already-merged one as `merged`, treat a human-closed one as
   * terminal `none`, open a new one, or classify the failure (EmptyDiffError → `none`; anything
   * else → `error` + attempt++). Pure decision — the caller persists + emits. NEVER throws:
   * every forge touch is wrapped here.
   */
  private async classifyLanding(
    forge: GitForge,
    row: {
      repoPath: string;
      parentIssueNumber: number;
      parentTitle: string;
      childrenJson: string;
      landingAttempts: number;
    },
    integrationBranch: string,
  ): Promise<{
    state: EpicLandingState;
    prNumber: number | null;
    prUrl: string | null;
    attempts: number;
  }> {
    const { repoPath, parentIssueNumber, parentTitle, landingAttempts } = row;
    try {
      // Idempotency guard: prStatus reads `--state all`, so it sees any prior PR whose head
      // is the integration branch (which is only ever the landing PR's head).
      const existing = await forge.prStatus(integrationBranch);
      if (existing.state === "open") {
        // Reuse — never open a second PR. Covers the open-succeeded/record-failed gap.
        return {
          state: "open",
          prNumber: existing.number ?? null,
          prUrl: existing.url ?? null,
          attempts: landingAttempts,
        };
      }
      if (existing.state === "merged") {
        // Already merged (epic landed) — record as terminal `merged` so the band reads
        // accurately post-merge rather than "awaiting merge" until the parent-close reconcile.
        return {
          state: "merged",
          prNumber: existing.number ?? null,
          prUrl: existing.url ?? null,
          attempts: landingAttempts,
        };
      }
      if (existing.state === "closed") {
        // A human deliberately closed the landing PR (unmerged) — terminal, do NOT re-open it.
        return { state: "none", prNumber: null, prUrl: null, attempts: landingAttempts };
      }
      // existing.state === "none" → no PR yet, open one.
      const defaultBranch = await forge.defaultBranch();
      const children = JSON.parse(row.childrenJson) as CompletedEpicChild[];
      const title = buildLandingPrTitle(parentIssueNumber, parentTitle);
      const body = buildLandingPrBody({
        parentNumber: parentIssueNumber,
        parentTitle,
        integrationBranch,
        defaultBranch,
        children,
      });
      const status = await forge.openPr({
        head: integrationBranch,
        base: defaultBranch,
        title,
        body,
      });
      return {
        state: "open",
        prNumber: status.number ?? null,
        prUrl: status.url ?? null,
        attempts: landingAttempts,
      };
    } catch (err) {
      if (err instanceof EmptyDiffError) {
        // No net diff vs default (already landed, or integrations that net to nothing) —
        // terminal `none`, NOT an error. The length>0 pre-gate can't detect a zero net diff.
        return { state: "none", prNumber: null, prUrl: null, attempts: landingAttempts };
      }
      // Transient/unknown failure (network, no push access) → error + count it; retried by
      // the autonomous tick until the cap, then parked. NEVER holds the run.
      console.warn(
        `[drain] ensureLandingPr openPr failed for ${repoPath}#${parentIssueNumber} (attempt ${landingAttempts + 1}/${MAX_LANDING_ATTEMPTS}):`,
        err,
      );
      return { state: "error", prNumber: null, prUrl: null, attempts: landingAttempts + 1 };
    }
  }

  /**
   * DB-gated landing-PR retry for one repo, run UNGATED in {@link tick} (even for an idle
   * epic in a repo with autoDrain off). It touches the forge ONLY when a completed epic
   * still needs its landing PR resolved (`pending`, or `error` below the cap) — so steady
   * state (all rows `open`/`none`/parked-`error`) is zero forge calls. This is the genuinely-
   * autonomous home: it covers both an edge-time openPr failure and a completion recorded
   * across a restart (no UI required).
   */
  private async ensureLandingPrsForRepo(repoPath: string): Promise<void> {
    const pending = this.deps.store
      .listEpicCompleted(repoPath)
      .filter(
        (r) =>
          (r.landingState === "pending" || r.landingState === "error") &&
          r.landingAttempts < MAX_LANDING_ATTEMPTS,
      );
    for (const r of pending) {
      try {
        await this.ensureLandingPr(repoPath, r.parentIssueNumber, r.parentTitle);
      } catch (err) {
        // ensureLandingPr already swallows; this is defense-in-depth.
        console.warn(
          `[drain] ensureLandingPr retry failed for ${repoPath}#${r.parentIssueNumber}:`,
          err,
        );
      }
    }
  }

  /**
   * #1071: Session-less rebase pass for stuck (behind/conflicting) epic landing PRs.
   * Runs each tick between ensureLandingPrsForRepo and autoLandLandingPrsForRepo so that
   * a behind/conflicting PR is driven back to landable before the auto-land pass sees it.
   *
   * Gate: !draftMode && (autoMergeEnabled || autoDrainEnabled || epicRun.status==='running').
   * DELIBERATE DEVIATION from autoLandLandingPrsForRepo's `draftMode ? false : autoMergeEnabled`
   * gate: that gate would leave a drain-on / auto-merge-off repo with no rebase (forcing the
   * operator to rebase manually before the manual land CTA can succeed). Here we include
   * autoDrainEnabled and the running-epic-run case to stay consistent with the tick's pump gate.
   *
   * GitHub-only (forge.kind === 'github'): mergeStateStatus is GitHub-specific; LocalForge has no
   * remote to push to; Gitea is out of scope.
   *
   * DELIBERATE DEVIATION from autoLandLandingPrsForRepo re migration-bearing rows: unlike auto-land
   * (which skips rows with migrationPaths.length > 0 to require an operator ack/land), the rebase
   * pass processes them too. The pass NEVER merges, so keeping a migration-bearing landing PR
   * mergeable only makes the operator's manual ack/land CTA usable; skipping them would re-strand
   * exactly the PRs that most need a human. See plan §"Migration-bearing epics are still rebased".
   *
   * NEVER calls forge.merge. Landing stays with tryAutoLandEpic (auto-merge on) or the operator's
   * manual land CTA.
   */
  private async rebaseStuckLandingPrsForRepo(repoPath: string): Promise<void> {
    // Gate: automation must be engaged for this repo.
    const cfg = this.deps.store.getRepoConfig(repoPath);
    const er = this.deps.store.getEpicRun(repoPath);
    const engaged =
      !cfg.draftMode && (cfg.autoMergeEnabled || cfg.autoDrainEnabled || er?.status === "running");
    if (!engaged) return;

    // GitHub-only: mergeStateStatus is not available on other forge kinds.
    const forge = this.deps.resolveForge(repoPath);
    if (!forge || forge.kind !== "github") return;

    // DB-gate: only open rows with a recorded landing PR number are candidates.
    // Unlike autoLandLandingPrsForRepo, we do NOT skip migration-bearing rows (see doc above).
    const open = this.deps.store
      .listEpicCompleted(repoPath)
      .filter((r) => r.landingState === "open" && r.landingPrNumber != null);
    if (open.length === 0) return;

    const defaultBranch = await forge.defaultBranch();

    for (const row of open) {
      const parent = row.parentIssueNumber;
      const key = `${repoPath}#${parent}`;

      // Serialize per (repo, parent) — shared key namespace with ensureLandingPr /
      // autoLandLandingPrsForRepo; they act on disjoint landingStates of one epic.
      if (this.landingInFlight.has(key)) continue;
      this.landingInFlight.add(key);

      try {
        await this.processStuckLandingRow(repoPath, forge, defaultBranch, row);
      } catch (err) {
        // Defense in depth: one stuck epic must not break the whole tick.
        console.warn(`[drain] rebaseStuckLandingPrsForRepo failed for ${key}:`, err);
      } finally {
        this.landingInFlight.delete(key);
      }
    }
  }

  /**
   * Process one stuck landing PR row: handle driver-pause fast-path, probe PR state,
   * clear resolved pauses, and attempt rebase when appropriate.
   * Called from rebaseStuckLandingPrsForRepo (already serialized by landingInFlight).
   */
  private async processStuckLandingRow(
    repoPath: string,
    forge: GitForge,
    defaultBranch: string,
    row: {
      parentIssueNumber: number;
      landingRebasePauseReason: "cap" | "conflict" | "driver" | null;
    },
  ): Promise<void> {
    const parent = row.parentIssueNumber;

    // a. Driver-pause fast-path: if paused because the driver was absent/broken,
    //    cheaply re-probe git config before making any forge call.
    if (row.landingRebasePauseReason === "driver") {
      if (await this.isDriverRegistered(repoPath)) {
        // Driver now registered → clear the pause and fall through to probe prStatus.
        this.deps.store.setEpicLandingRebaseState(repoPath, parent, {
          count: 0,
          driverMisses: 0,
          pauseReason: null,
        });
        this.emitCompleted(repoPath, parent);
        // Fall through — pauseReason is now null so we do NOT return below.
      } else {
        // Still absent → stay paused, no prStatus call.
        return;
      }
    }

    // b. Read the pinned integration branch (read-only; null = unpinned → skip).
    const branch = this.deps.store.getEpicIntegrationBranch(repoPath, parent);
    if (branch === null) return;

    // c. Check current PR state.
    const pr = await forge.prStatus(branch);
    if (pr.state !== "open") return;

    // d. Compute stuck flags.
    const behind = pr.mergeStateStatus === "behind";
    const conflicting = pr.mergeable === false;
    const stuck = behind || conflicting;

    // e. Reason-aware clear: if PR is no longer stuck, clear all rebase state and stop.
    if (!stuck) {
      this.clearLandingRebaseStateIfNeeded(repoPath, parent);
      return;
    }

    // Re-read fresh counter values (the open[] snapshot is from the start of this tick).
    const freshRow = this.deps.store
      .listEpicCompleted(repoPath)
      .find((r) => r.parentIssueNumber === parent);
    if (!freshRow) return;

    if (freshRow.landingRebasePauseReason === "conflict" && !conflicting) {
      // Operator resolved the conflict; PR may still be behind. Clear conflict pause,
      // then attempt the rebase immediately with the corrected (cleared) state.
      this.deps.store.setEpicLandingRebaseState(repoPath, parent, {
        count: 0,
        pauseReason: null,
      });
      this.emitCompleted(repoPath, parent);
      await this.doLandingRebase(
        repoPath,
        parent,
        { ...freshRow, landingRebaseCount: 0, landingRebasePauseReason: null },
        branch,
        defaultBranch,
      );
      return;
    }

    // f. If paused (after the reason-aware clear didn't un-pause) → skip.
    if (freshRow.landingRebasePauseReason !== null) return;

    // g. Attempt rebase.
    await this.doLandingRebase(repoPath, parent, freshRow, branch, defaultBranch);
  }

  /**
   * If the landing PR is no longer stuck, clear all rebase counters/state.
   * Only writes when there is something to clear (avoid spurious DB writes on steady state).
   */
  private clearLandingRebaseStateIfNeeded(repoPath: string, parent: number): void {
    const r2 = this.deps.store
      .listEpicCompleted(repoPath)
      .find((r) => r.parentIssueNumber === parent);
    if (
      r2 &&
      (r2.landingRebaseCount !== 0 ||
        r2.landingRebaseDriverMisses !== 0 ||
        r2.landingRebasePauseReason !== null)
    ) {
      this.deps.store.setEpicLandingRebaseState(repoPath, parent, {
        count: 0,
        driverMisses: 0,
        pauseReason: null,
      });
      this.emitCompleted(repoPath, parent);
    }
  }

  /**
   * Inner rebase attempt for one epic's landing PR. Checks the cap, calls rebaseLandingBranch,
   * and maps the result union to the appropriate state update + emitCompleted.
   * Called from rebaseStuckLandingPrsForRepo (already serialized by landingInFlight).
   */
  private async doLandingRebase(
    repoPath: string,
    parent: number,
    row: {
      landingRebaseCount: number;
      landingRebaseDriverMisses: number;
      landingRebasePauseReason: "cap" | "conflict" | "driver" | null;
    },
    branch: string,
    defaultBranch: string,
  ): Promise<void> {
    // A live repair session owns this branch — never --force-with-lease over its commits. Before the
    // cap check so a live session doesn't get a spurious pauseReason:"cap" write.
    if (this.hasLiveRepairSession(repoPath, branch)) return;
    // Cap check: if we've already used the full budget, pause.
    if (row.landingRebaseCount >= this.deps.rebaseCap) {
      this.deps.store.setEpicLandingRebaseState(repoPath, parent, { pauseReason: "cap" });
      this.emitCompleted(repoPath, parent);
      return;
    }

    const res = await this.rebaseLandingBranch(repoPath, branch, defaultBranch);
    switch (res.kind) {
      case "rebased":
        // Genuine rebase: burn one cap attempt, reset driver-miss counter.
        this.deps.store.setEpicLandingRebaseState(repoPath, parent, {
          count: row.landingRebaseCount + 1,
          driverMisses: 0,
        });
        this.emitCompleted(repoPath, parent);
        break;

      case "current":
        // Branch already contains origin/<default> (GitHub mergeability lag, or a redundant
        // attempt after a concurrent push) — no real commits to replay; reset all counters
        // to avoid a false cap-exhaustion on the next tick.
        this.deps.store.setEpicLandingRebaseState(repoPath, parent, {
          count: 0,
          driverMisses: 0,
          pauseReason: null,
        });
        this.emitCompleted(repoPath, parent);
        break;

      case "conflict":
        // Genuine conflict (non-union path, or union path + driver self-test passed).
        this.deps.store.setEpicLandingRebaseState(repoPath, parent, { pauseReason: "conflict" });
        this.emitCompleted(repoPath, parent);
        break;

      case "driver-absent":
      case "driver-broken": {
        // Environment fault — NOT a content problem. Increment the miss counter without
        // burning the cap (per plan: "no count burn"). Escalate after DRIVER_MISS_CAP
        // consecutive misses; before that, log and retry next cycle.
        const m = row.landingRebaseDriverMisses + 1;
        if (m >= DRIVER_MISS_CAP) {
          this.deps.store.setEpicLandingRebaseState(repoPath, parent, {
            driverMisses: m,
            pauseReason: "driver",
          });
          this.emitCompleted(repoPath, parent);
        } else {
          this.deps.store.setEpicLandingRebaseState(repoPath, parent, { driverMisses: m });
          console.warn(
            `[drain] driver fault (${res.kind}) for ${repoPath}#${parent}, miss ${m}/${DRIVER_MISS_CAP}`,
          );
        }
        break;
      }

      case "transient":
        // Transient error (stale lease, fetch failure, etc.) — log only, no state change.
        // Will be retried on the next tick.
        console.warn(`[drain] transient rebase error for ${repoPath}#${parent}, will retry`);
        break;
    }
  }

  /**
   * C: auto-rerun the failed CI on a red epic landing PR (flake absorption). Runs each tick between
   * rebaseStuckLandingPrsForRepo (owns behind/conflict) and autoLandLandingPrsForRepo (lands green).
   * GitHub-only (rerun API is GitHub-specific), engaged-gated, capped per head, fail-closed, and
   * `landingInFlight`-serialized (shared key namespace with the other landing passes).
   * NEVER merges — a rerun that greens is landed by tryAutoLandEpic / the manual CTA; a red one that
   * exhausts its budget is surfaced by `landingCiFailing` (index.ts).
   */
  private async rerunRedLandingCiForRepo(repoPath: string): Promise<void> {
    const cfg = this.deps.store.getRepoConfig(repoPath);
    const er = this.deps.store.getEpicRun(repoPath);
    const engaged =
      !cfg.draftMode && (cfg.autoMergeEnabled || cfg.autoDrainEnabled || er?.status === "running");
    if (!engaged) return;
    const forge = this.deps.resolveForge(repoPath);
    if (!forge || forge.kind !== "github") return;
    // Capability gate (both are optional on GitForge — GitHub-only). Capture locals so TS keeps the
    // non-undefined narrowing across the awaits below.
    const latestFailedRunForPr = forge.latestFailedRunForPr;
    const rerunWorkflowRun = forge.rerunWorkflowRun;
    if (!latestFailedRunForPr || !rerunWorkflowRun) return;

    const open = this.deps.store
      .listEpicCompleted(repoPath)
      .filter((r) => r.landingState === "open" && r.landingPrNumber != null);
    if (open.length === 0) return;

    for (const row of open) {
      const parent = row.parentIssueNumber;
      const key = `${repoPath}#${parent}`;
      if (this.landingInFlight.has(key)) continue;
      this.landingInFlight.add(key);
      try {
        await this.processRedLandingRerun(
          repoPath,
          forge,
          parent,
          row.landingPrNumber!,
          latestFailedRunForPr,
          rerunWorkflowRun,
          row,
        );
      } catch (err) {
        console.warn(`[drain] rerunRedLandingCiForRepo failed for ${key}:`, err);
      } finally {
        this.landingInFlight.delete(key);
      }
    }
  }

  /** Process one open landing row: rerun its failed CI iff terminally red, mergeable, not behind,
   *  not draft, and under the per-head budget. Serialized by the caller via landingInFlight. */
  private async processRedLandingRerun(
    repoPath: string,
    forge: GitForge,
    parent: number,
    prNumber: number,
    latestFailedRunForPr: (prNumber: number) => Promise<number | null>,
    rerunWorkflowRun: (runId: number, o: { failedOnly: boolean }) => Promise<void>,
    row: { landingRepairCount: number; parentTitle: string; landingPrUrl: string | null },
  ): Promise<void> {
    const branch = this.deps.store.getEpicIntegrationBranch(repoPath, parent);
    if (branch === null) return;
    // A live repair session owns this branch: don't rerun CI on the commits it is pushing, and don't
    // dispatch a second repair session. (Also fences rebase/auto-land — see those passes.)
    if (this.hasLiveRepairSession(repoPath, branch)) return;
    const pr = await forge.prStatus(branch);
    if (pr.state !== "open" || pr.isDraft) return;
    // Only a TERMINAL failure on an otherwise-mergeable, not-behind PR. behind/conflicting → the rebase
    // pass; pending/none/success → nothing to rerun.
    if (pr.checks !== "failure" || pr.mergeStateStatus === "behind" || pr.mergeable === false)
      return;

    const head = pr.headSha ?? "";
    const key = `${repoPath}#${parent}`;
    // A new head resets the budget (new commits = a fresh failure to absorb); same head accumulates.
    const prior = this.landingRerunCount.get(key);
    const used = prior && prior.head === head ? prior.count : 0;
    if (used >= LANDING_RERUN_CAP) {
      // Rerun budget spent + CI still terminally red: escalate to ONE capped agent repair session.
      await this.maybeDispatchLandingRepair(repoPath, parent, prNumber, pr, branch, row);
      return;
    }

    const runId = await latestFailedRunForPr(prNumber);
    if (runId == null) return; // fork-origin PR / no failed run resolvable
    await rerunWorkflowRun(runId, { failedOnly: true });
    this.landingRerunCount.set(key, { head, count: used + 1 });
    console.warn(
      `[drain] rerunning failed landing CI for ${repoPath}#${parent} (run ${runId}, ${used + 1}/${LANDING_RERUN_CAP})`,
    );
  }

  /** True while a genuinely-live repair session (Task 4's isLiveRepairSession) holds this epic's
   *  integration branch. Fences the branch-mutating landing passes and de-dupes a 2nd repair spawn. */
  private hasLiveRepairSession(repoPath: string, integrationBranch: string): boolean {
    return this.deps.store
      .list()
      .some(
        (s) =>
          s.repoPath === repoPath &&
          s.baseBranch === integrationBranch &&
          isLiveRepairSession(s, this.now()),
      );
  }

  /** C's rerun budget is spent and CI is genuinely red: dispatch ONE capped agent repair session that
   *  pushes directly to the epic integration branch. Cap-exhausted / auto-drain-off / a recent spawn
   *  refusal all fall back to landingCiFailing (the operator backstop). NOT via doSpawn — that stamps
   *  ACTIVE_LABEL on the closed epic issue; use service.create directly (mirrors research spawns). */
  private async maybeDispatchLandingRepair(
    repoPath: string,
    parent: number,
    prNumber: number,
    pr: PrStatus,
    branch: string,
    row: { landingRepairCount: number; parentTitle: string; landingPrUrl: string | null },
  ): Promise<void> {
    const cfg = this.deps.store.getRepoConfig(repoPath);
    if (!cfg.autoDrainEnabled) return; // spawning respects the drain toggle → else the landingCiFailing backstop
    if (row.landingRepairCount >= LANDING_REPAIR_CAP) return; // one lifetime attempt spent → backstop
    if (this.hasLiveRepairSession(repoPath, branch)) return; // de-dupe (belt-and-suspenders w/ the fence)
    const key = `${repoPath}#${parent}`;
    const lastFail = this.repairSpawnCooldown.get(key);
    if (lastFail !== undefined && this.now() - lastFail < SPAWN_FAIL_COOLDOWN_MS) return; // recent refusal
    const head = pr.headSha ?? "";
    const cfgModel = drainSpawnModel(
      resolveDefaultModelSetting(cfg.defaultModel, config.defaultModel),
    );
    const cfgEffort = drainSpawnEffort(
      resolveDefaultEffortSetting(cfg.defaultEffort, config.defaultEffort),
    );
    const prompt =
      `Repair the failing CI on the landing pull request for epic #${parent} ("${row.parentTitle}"). ` +
      `Landing PR #${prNumber}${row.landingPrUrl ? ` (${row.landingPrUrl})` : ""} targets the epic ` +
      `integration branch \`${branch}\`. You are working in a scratch branch cut from \`${branch}\`. ` +
      `Drive the landing PR's CI green: commit your fix, then publish it by pushing your commit to the ` +
      `integration branch with \`git push origin HEAD:${branch}\` — this updates the landing PR's head ` +
      `and re-triggers its CI. Do NOT open a new pull request.`;
    try {
      await this.deps.service.create({
        repoPath,
        baseBranch: branch,
        prompt,
        model: cfgModel,
        effort: cfgEffort,
        images: [],
        auto: true,
        landingRepair: true,
      });
      // Increment ONLY on a successful spawn; record the head so the attempt is observable (head-advance).
      this.deps.store.setEpicLandingRepairCount(repoPath, parent, row.landingRepairCount + 1, head);
      this.repairSpawnCooldown.delete(key);
      console.warn(
        `[drain] dispatched landing-repair session for ${repoPath}#${parent} (landing PR #${prNumber}, head ${head})`,
      );
    } catch (err) {
      // Refusal (hold/egress/transient): back off, DO NOT increment — the lifetime attempt is not burned.
      this.repairSpawnCooldown.set(key, this.now());
      console.warn(`[drain] landing-repair spawn for ${repoPath}#${parent} failed:`, err);
    }
  }

  /**
   * AUTO-LAND (#1044): opt-in autonomous merge of a completed epic's aggregate landing PR. Runs in
   * {@link tick} alongside {@link ensureLandingPrsForRepo} — the session-less landing PR has no
   * managed session, so it can't ride the session-owned `AutoMergeService`; the drain (which
   * already OPENS these PRs) is its home. Mirrors the manual land endpoint's action
   * (`forge.merge` + landingState→'merged') and AutoMergeService's guardrails, scoped to landing PRs.
   *
   * Opt-in gate: `draftMode ? false : autoMergeEnabled` — the SAME effective merge predicate the
   * session train uses (isFullAuto's merge half), so draftMode suppresses auto-land too.
   *
   * DELIBERATE BROADENING vs isFullAuto (#1044): the gate intentionally does NOT also require
   * autopilot. A landing PR is session-less, so autopilot (a session-stepping flag) is orthogonal;
   * `autoMergeEnabled` is the operator's "automate my merges" opt-in and the correct signal. A repo
   * with autoMerge ON + autopilot OFF — which sees ZERO session auto-merges today (isFullAuto is
   * false there) — WILL now begin auto-landing epic landing PRs. Intended; flagged in the PR body.
   *
   * DB-gated to zero forge calls in steady state: candidates are only `open` rows carrying a
   * recorded landing PR, and only when the opt-in is on.
   */
  private async autoLandLandingPrsForRepo(repoPath: string): Promise<void> {
    const cfg = this.deps.store.getRepoConfig(repoPath);
    const mergeOn = cfg.draftMode ? false : cfg.autoMergeEnabled;
    if (!mergeOn) return;
    const forge = this.deps.resolveForge(repoPath);
    if (!forge) return;
    const open = this.deps.store
      .listEpicCompleted(repoPath)
      .filter((r) => r.landingState === "open" && r.landingPrNumber != null);
    for (const r of open) {
      // Migration-bearing epics are NEVER auto-landed — they require the operator's manual
      // ack/land (#645 checkpoint). The predicate is just `migrationPaths.length > 0`:
      // ackEpicMigrations also stamps dismissedAt, and listEpicCompleted filters dismissedAt IS
      // NULL, so an acked row is already gone from this list — a `migrationsAckedAt == null`
      // conjunct would be dead. Consequence: ack dismisses WITHOUT merging; such epics land only
      // via the manual CTA.
      if (r.migrationPaths.length > 0) continue;
      // Serialize per (repo, parent) against an overlapping tick / ensureLandingPr edge (shared
      // key namespace with ensureLandingPr — they act on disjoint landingStates of one epic).
      const key = `${repoPath}#${r.parentIssueNumber}`;
      if (this.landingInFlight.has(key)) continue;
      this.landingInFlight.add(key);
      try {
        await this.tryAutoLandEpic(forge, repoPath, r.parentIssueNumber, r.landingPrNumber!);
      } catch (err) {
        // tryAutoLandEpic is fail-closed internally; defense-in-depth so one epic can't break tick.
        console.warn(`[drain] auto-land failed for ${key}:`, err);
      } finally {
        this.landingInFlight.delete(key);
      }
    }
  }

  /**
   * Resolve + (maybe) merge ONE open landing PR. Fail-closed everywhere; never throws past the
   * caller's guard:
   *   - unpinned branch / prStatus throw → skip (never merge on an unreadable PR).
   *   - PR merged out-of-band → reconcile row to 'merged' (covers a manual land / external merge,
   *     and closes the manual-vs-auto DB-staleness window).
   *   - PR closed/none → reconcile to terminal 'none' (human-closed/vanished) so we stop re-polling.
   *   - draft / not-ready / backed-off → skip.
   *   - ready → forge.merge; success → reconcile 'merged' + clear backoff; failure → see
   *     {@link handleAutoLandMergeError} (lost race reconciles; genuine failure arms the backoff).
   */
  private async tryAutoLandEpic(
    forge: GitForge,
    repoPath: string,
    parentIssueNumber: number,
    prNumber: number,
  ): Promise<void> {
    // Read-only branch read (NOT getOrInitEpicIntegrationBranch — never INSERT a title-drifted pin
    // from this path). Matches the manual land endpoint + band enrichment. Null ⇒ unpinned ⇒ skip.
    const branch = this.deps.store.getEpicIntegrationBranch(repoPath, parentIssueNumber);
    if (branch === null) return;
    // A live repair session owns this branch — don't merge (deleteBranch:true) out from under it.
    if (this.hasLiveRepairSession(repoPath, branch)) return;
    let pr: PrStatus;
    try {
      pr = await forge.prStatus(branch);
    } catch (err) {
      console.warn(`[drain] auto-land prStatus failed for ${repoPath}#${parentIssueNumber}:`, err);
      return; // fail-closed
    }
    if (pr.state === "merged") {
      this.reconcileAutoLand(repoPath, parentIssueNumber, "merged", pr);
      return;
    }
    if (pr.state === "closed" || pr.state === "none") {
      this.reconcileAutoLand(repoPath, parentIssueNumber, "none", pr);
      return;
    }
    if (pr.isDraft) return; // never merge a draft (computeLandingReady's Gitea fallback can't tell)
    // not green / mergeable yet (no-CI repos: a terminal checks:"none" + clean mergeStateStatus is ready)
    if (!computeLandingReady(pr, repoHasNoCiCached(forge.kind, repoPath))) return;
    const key = `${repoPath}#${parentIssueNumber}`;
    if (this.landMergeBlocked(key, pr.headSha ?? "")) return; // backed off on this head
    try {
      await forge.merge(prNumber, { method: forge.mergeMethod, deleteBranch: true });
    } catch (err) {
      await this.handleAutoLandMergeError(forge, repoPath, parentIssueNumber, branch, key, pr, err);
      return;
    }
    this.landMergeFail.delete(key); // success clears any backoff
    this.landingRerunCount.delete(key); // landed → drop the rerun budget entry
    this.reconcileAutoLand(repoPath, parentIssueNumber, "merged", pr);
  }

  /**
   * A failed auto-land merge. Re-read live state ONCE (forge-agnostic — doesn't parse host-specific
   * error strings): a PR that is now merged/closed means a concurrent manual land (the server's
   * handleEpicsCompletedLand takes no shared lock with this loop) won the race — reconcile WITHOUT
   * arming the backoff (a lost race must not poison the cap). A still-open/unreadable PR is a
   * genuine failure → leave landingState 'open' (manual CTA + next tick can retry) and arm the
   * per-head backoff.
   */
  private async handleAutoLandMergeError(
    forge: GitForge,
    repoPath: string,
    parentIssueNumber: number,
    branch: string,
    key: string,
    pr: PrStatus,
    err: unknown,
  ): Promise<void> {
    let live: PrStatus | null;
    try {
      live = await forge.prStatus(branch);
    } catch {
      live = null;
    }
    if (live && live.state === "merged") {
      this.landMergeFail.delete(key);
      this.landingRerunCount.delete(key); // terminal → drop the rerun budget entry
      this.reconcileAutoLand(repoPath, parentIssueNumber, "merged", live);
      return;
    }
    if (live && (live.state === "closed" || live.state === "none")) {
      this.landMergeFail.delete(key);
      this.landingRerunCount.delete(key); // terminal → drop the rerun budget entry
      this.reconcileAutoLand(repoPath, parentIssueNumber, "none", live);
      return;
    }
    console.warn(`[drain] auto-land merge failed for ${key}:`, err);
    this.recordLandMergeFailure(key, pr.headSha ?? "");
  }

  /** Persist a reconciled landing state + re-emit the band's CompletedEpic (reuses resolveLanding).
   *  'merged' keeps the live/recorded PR number+url; terminal 'none' nulls them (mirrors
   *  classifyLanding's human-closed branch). */
  private reconcileAutoLand(
    repoPath: string,
    parentIssueNumber: number,
    state: EpicLandingState,
    pr: PrStatus,
  ): void {
    const row = this.deps.store
      .listEpicCompleted(repoPath)
      .find((r) => r.parentIssueNumber === parentIssueNumber);
    this.resolveLanding(repoPath, parentIssueNumber, {
      state,
      prNumber: state === "merged" ? (pr.number ?? row?.landingPrNumber ?? null) : null,
      prUrl: state === "merged" ? (pr.url ?? row?.landingPrUrl ?? null) : null,
      attempts: row?.landingAttempts ?? 0,
    });
  }

  /** True while this epic's auto-land is backed off: CAP failures on the current head, inside the
   *  window. A new head or a success clears the entry. Mirrors AutoMergeService.computeMergeBlocked. */
  private landMergeBlocked(key: string, head: string): boolean {
    const f = this.landMergeFail.get(key);
    return !!f && f.head === head && f.count >= LAND_MERGE_ERROR_CAP && this.now() < f.blockedUntil;
  }

  /** Record a merge failure against the current head; arm the backoff window at the cap. Mirrors
   *  AutoMergeService.recordMergeFailure. */
  private recordLandMergeFailure(key: string, head: string): void {
    const cur = this.landMergeFail.get(key);
    const count = cur && cur.head === head ? cur.count + 1 : 1;
    this.landMergeFail.set(key, {
      head,
      count,
      blockedUntil: count >= LAND_MERGE_ERROR_CAP ? this.now() + LAND_MERGE_BACKOFF_MS : 0,
    });
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
      if (epicAutoCompleted && epic) await this.openLandingPrOnComplete(repoPath, epic);
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

  /**
   * Best-effort landing PR on the completion edge. DECOUPLED from the (already-done) record+idle
   * flip: {@link ensureLandingPr} resolves to a state and never throws, but the try/catch is
   * defense-in-depth — a landing failure must NEVER hold the run open (that would freeze the
   * whole repo's drain). The autonomous tick retries it.
   */
  private async openLandingPrOnComplete(repoPath: string, epic: Epic): Promise<void> {
    try {
      await this.ensureLandingPr(repoPath, epic.parentIssueNumber, epic.parentTitle);
    } catch (err) {
      console.warn(
        `[drain] ensureLandingPr (completion edge) failed for ${repoPath}#${epic.parentIssueNumber}:`,
        err,
      );
    }
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
   * #645 (Task 2): verify an epic child's PR base before retire merges it into the integration
   * branch. The child is only *told* (advisory prompt/steer) to open its PR with
   * `--base <integration branch>`; nothing forces it. Returns `true` when retire must FAIL CLOSED
   * (do not merge/record/archive/drop-claim) — either the PR targets the wrong base, the probe
   * failed, or a fresh mismatch marker is throttling the recheck. `false` ⇒ base verified (or the
   * forge can't tell — Gitea has no `prReviewMeta`, so behavior is unchanged). Side effects: parks
   * / clears the `epic_base_mismatch` marker (the throttle anchor + assembleEpic warning source).
   */
  private async epicChildBaseBlocked(
    forge: GitForge,
    repoPath: string,
    parent: number,
    s: Session,
    decision: Extract<DrainDecision, { kind: "retire" }>,
  ): Promise<boolean> {
    if (!forge.prReviewMeta) return false; // Gitea: can't tell — preserve today's behavior exactly.
    const child = s.issueNumber!;
    // Throttle: a fresh (<60s) marker means we already found the wrong base recently — stay blocked
    // without re-paying the prReviewMeta call. Bounds it to ≤1 call/child/~60s while stuck.
    const existing = this.deps.store.getEpicBaseMismatch(repoPath, parent, child);
    if (existing && this.now() - existing.checkedAt < EPIC_BASE_RECHECK_TTL_MS) return true;
    let actual: string | undefined;
    try {
      actual = (await forge.prReviewMeta(decision.prNumber))?.baseRefName;
    } catch (err) {
      // Probe failure is not a green light — stay blocked (do NOT merge into the wrong place on a
      // transient API error). Refresh the marker so the throttle still applies.
      console.warn(
        `[drain] epic child base-check pr#${decision.prNumber} (issue #${child}) failed; staying blocked:`,
        err,
      );
      this.deps.store.recordEpicBaseMismatch(repoPath, parent, child, {
        actualBase: existing?.actualBase ?? "",
        prNumber: decision.prNumber,
        checkedAt: this.now(),
      });
      return true;
    }
    if (actual !== s.baseBranch) {
      this.deps.store.recordEpicBaseMismatch(repoPath, parent, child, {
        actualBase: actual ?? "",
        prNumber: decision.prNumber,
        checkedAt: this.now(),
      });
      console.warn(
        `[drain] epic child pr#${decision.prNumber} (issue #${child}) targets \`${actual ?? "?"}\`, not the epic branch \`${s.baseBranch}\` — blocked until re-targeted`,
      );
      return true; // fail closed: child stays un-integrated; dependents stay blocked.
    }
    this.deps.store.clearEpicBaseMismatch(repoPath, parent, child); // matched — clear stale marker.
    return false;
  }

  /**
   * Epic-child retire (base already verified by {@link epicChildBaseBlocked}): squash-merge the PR
   * INTO its integration branch, record it as integrated so dependents unblock (no GitHub issue
   * auto-close — the child issue stays open until the epic→default PR lands), then archive. The
   * claim is RETAINED (releasing would re-spawn the still-open issue). A merge throw leaves the
   * session live for next-tick retry (no record/archive); an archive throw is recoverable — the
   * integration is already recorded and the pr-poller reaps the merged PR.
   */
  private async retireEpicChild(
    forge: GitForge,
    repoPath: string,
    parent: number,
    s: Session,
    decision: Extract<DrainDecision, { kind: "retire" }>,
  ): Promise<void> {
    try {
      // deleteBranch removes the child's MERGED head (task) branch on origin — standard post-merge
      // hygiene. It is the PR's head, never the integration branch (the base), so the accumulating
      // integration branch is untouched.
      await forge.merge(decision.prNumber, { method: "squash", deleteBranch: true });
    } catch (err) {
      console.warn(
        `[drain] epic child merge pr#${decision.prNumber} (issue #${s.issueNumber}) into ${s.baseBranch} failed:`,
        err,
      );
      return; // leave the session live; next tick retries. Do NOT record or archive.
    }
    this.deps.store.recordEpicIntegrated(
      repoPath,
      parent,
      s.issueNumber!,
      {
        number: decision.prNumber,
        url: this.deps.prCache.snapshot()[decision.sessionId]?.url ?? "",
      },
      s.baseBranch, // #645 (b): the branch this child actually squash-merged into
    );
    try {
      await this.deps.service.archive(decision.sessionId);
    } catch (err) {
      // The squash-merge already landed (PR is now MERGED) but teardown didn't finish. This is
      // recoverable, not a permanent strand: we deliberately do NOT dropPrCache/emit below, so the
      // session stays live AND polled (pr-poller skips only archived rows). The poller re-observes
      // the merged PR and settles it via reapMerged → settleMergedSession (archive + teardown) —
      // the same path any out-of-band merge takes. #1037: because the integration is already
      // recorded above, settleMergedSession's isIntegratedEpicChild guard sees this child as
      // integrated and ARCHIVES-ONLY (never closes the issue) — so this recovery keeps the child
      // open until the landing PR merges, just like the happy path. The session can NOT be
      // re-selected by the retire gate (readyToRetire requires state==="open"; the PR is merged),
      // hence the poller is the recovery, not a retry.
      console.warn(
        `[drain] archive (epic child) failed for ${decision.sessionId}; pr-poller will reap the merged PR:`,
        err,
      );
      return;
    }
    // Keep the claim: the child issue stays open until the epic lands; releasing would let it
    // re-spawn. Mirrors the non-epic retire path.
    this.retainClaimOnArchive.add(decision.sessionId);
    this.deps.dropPrCache(decision.sessionId);
    this.deps.emitArchived(decision.sessionId);
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
      // #645 (Task 2): enforce the child PR's actual base against the integration branch. On
      // mismatch (or while throttled-blocked from a prior mismatch) this returns true → fail
      // closed: skip merge/record/archive/claim-drop so the child stays un-integrated and the
      // operator re-targets the PR (the remedy is surfaced via assembleEpic warnings).
      if (await this.epicChildBaseBlocked(forge, repoPath, epicRun!.parentIssueNumber, s, decision))
        return;
      await this.retireEpicChild(forge, repoPath, epicRun!.parentIssueNumber, s, decision);
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
      await this.deps.service.archive(decision.sessionId);
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
    const failKey = `${repoPath}#${number}`;
    const lastFail = this.spawnFailures.get(failKey);
    if (lastFail !== undefined) {
      if (this.now() - lastFail < SPAWN_FAIL_COOLDOWN_MS) {
        return; // #790: recently failed to spawn this issue — back off to avoid claim/label churn
      }
      this.spawnFailures.delete(failKey); // #790: cooldown elapsed — drop the stale entry so the map can't grow unbounded
    }
    // Sandbox auto-gate pre-check: skip a held issue cleanly BEFORE claiming the label
    // or spawning, so a repo whose profile refuses auto (standard, or autonomous with no
    // backend) doesn't churn the claim label every tick. create() re-checks and throws as
    // defense-in-depth (its try releases the claim), but skipping here avoids that churn.
    const rc = this.deps.store.getRepoConfig(repoPath);
    const profile = resolveProfile(undefined, rc.sandboxProfile, config.sandboxDefaultProfile);
    // backend is backend-independent for trusted (autoHoldReason → null), so skip the real
    // bwrap self-test on a trusted repo — else auto-drain pays a probe every first tick.
    const backend = profile === "trusted" ? null : this.detectBackend();
    // Probe egress only for an autonomous repo with an FS backend, so a drain-spawned
    // autonomous session is also refused-loud (EGRESS_UNAVAILABLE_REASON) when egress is
    // unavailable. Undefined elsewhere → autoHoldReason's 2-arg semantics (egress not considered).
    const egressBackend =
      egressApplies(profile) && backend !== null ? this.detectEgressBackend() : undefined;
    const hold = autoHoldReason(profile, backend, egressBackend);
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
    // Hold the created session so we can announce it AFTER the try/catch. Emitting
    // inside the try would route a throwing session:new listener into the catch
    // below (EventHub.emit has no per-listener guard), which releases the claim
    // label for an already-created session → duplicate re-spawn next tick. The UI
    // session list is push-only, so without this emit a drain-spawned (incl. epic
    // sub-issue) session never appears until a full page reload.
    let session: Session | undefined;
    try {
      const { base, prompt } = await this.resolveSpawnBase(forge, decision);
      const epicSettings = decision.epicProviderSettings;
      // Auto-spawns honor an explicit operator default-model — the repo override
      // wins over the global default; when both are unset ("inherit"/"auto") they
      // fall back to no --model flag (Claude's own default). The Fable promo is a
      // client-only UI concern and is NEVER applied to autonomous spawns.
      session = await this.deps.service.create({
        repoPath,
        baseBranch: base,
        prompt,
        ...(epicSettings ? { agentProvider: epicSettings.agentProvider } : {}),
        model: epicSettings
          ? modelForProviderOrDefault(epicSettings.model, epicSettings.agentProvider)
          : drainSpawnModel(resolveDefaultModelSetting(rc.defaultModel, config.defaultModel)),
        effort: epicSettings
          ? epicSettings.effort
          : drainSpawnEffort(resolveDefaultEffortSetting(rc.defaultEffort, config.defaultEffort)),
        images: [],
        auto: true,
        issueRef: { number, url, title, body },
      });
      this.spawnFailures.delete(failKey); // #790: clear any prior failure cooldown on success
      // The new auto session appears in the next buildState → counts toward the
      // cap AND mappedIssueNumbers, so the loop won't re-spawn this issue and
      // naturally stops at cap.
    } catch (err) {
      this.spawnFailures.set(failKey, this.now());
      console.warn(`[drain] spawn failed for issue #${number}:`, err);
      // Release the claim so the unspawned issue returns to the pool (best-effort).
      try {
        await forge.removeIssueLabel?.(number, ACTIVE_LABEL);
      } catch (rerr) {
        console.warn(`[drain] release label for issue #${number} failed:`, rerr);
      }
    }
    // Success-only, outside the try: push the new session to the UI live.
    if (session) this.deps.emitSessionNew?.(session);
  }

  // ── event handlers (public surface) ───────────────────────────────────────────

  /** SessionConsumer entry (#1094 seam). Sources the trigger row from the shared snapshot
   *  instead of a fresh store.get — drain runs FIRST in the ordered chain, so the snapshot
   *  (built this tick) is current for its purposes. Mirrors onGit/onStatus exactly. */
  async handle(change: SessionStateChange): Promise<void> {
    const s = change.snapshot.session;
    if (change.kind === "git") {
      // #1401: record epic integration BEFORE the auto gate — a manual (auto=0) session never
      // reaches reapMerged, so this is the only event-time hook covering its merged PR. Also
      // deliberately before settleMergedSession (via reapMerged below) so the #1037
      // isIntegratedEpicChild guard sees the fresh row and archives-only.
      if (change.git.state === "merged") await this.recordEpicIntegrationForMerge(s, change.git);
      if (!s.auto) return; // drain only manages auto sessions
      if (change.git.state === "merged") {
        await this.reapMerged(s);
        return;
      }
      await this.pumpIfEnabled(s.repoPath);
      return;
    }
    // kind === "status"
    await this.pumpIfEnabled(s.repoPath);
  }

  /** pr-poller observed a new git state for a session. */
  async onGit(id: string, git: GitState): Promise<void> {
    const s = this.deps.store.get(id);
    if (!s) return;
    // #1401: record BEFORE the auto gate (see handle() — same manual-session coverage).
    if (git.state === "merged") await this.recordEpicIntegrationForMerge(s, git);
    if (!s.auto) return; // drain only manages auto sessions
    if (git.state === "merged") {
      await this.reapMerged(s);
      return;
    }
    // open/green/other → the retire gate may now fire (e.g. CI just went green).
    // Skip drain-disabled repos — no spawn/retire there, just WS noise.
    await this.pumpIfEnabled(s.repoPath);
  }

  /** #1401: event-time epic-integration recording for a poller-observed merge. Thin adapter
   *  over the shared helper (which owns the gates: issue-linked, active epic, merged base ==
   *  pinned integration branch, never-throws). Ungated by `s.auto` — see handle()/onGit(). */
  private async recordEpicIntegrationForMerge(s: Session, git: GitState): Promise<void> {
    await recordEpicIntegrationIfChild(
      s,
      { number: git.number, url: git.url, baseRefName: git.baseRefName },
      { store: this.deps.store, forge: this.deps.resolveForge(s.repoPath) },
    );
  }

  /**
   * #1401 reconcile sweep: backfill `epic_integrated` rows for children whose merged PR was
   * settled without recording (out-of-band merges that predate the event-time fix, or whose
   * event was missed). Event-time recording is one-shot and already consumed for such children,
   * so a stalled epic can only converge through this pass. Runs from tick() ungated by the
   * drain toggle, but is internally cheap: nothing for repos without an active epic, and one
   * sweep per epic per {@link EPIC_RECONCILE_TTL_MS} otherwise.
   *
   * Mapping is session-records-only (ratified in the plan): every stored session row for the
   * child (ANY status incl. archived, ANY auto flag) contributes its branch; each DISTINCT
   * branch is probed via branch-keyed `prStatus` until one records. All rows — not first-match —
   * because `store.list()` is createdAt-ordered, so a dead predecessor session (spawned first,
   * never opened a PR) sorts before the manual respawn whose PR actually merged (#128's
   * TASK-1248 vs TASK-1249 shape). Branches whose LIVE session currently shows an open PR are
   * skipped — their merge will be recorded event-time; probing them every sweep would just burn
   * forge reads on healthy in-flight children.
   *
   * Worst case: one `prStatus` per distinct not-open-PR branch per un-integrated child per TTL.
   * After a backfill the same tick's pump reads the new row → handleEpicSideEffects completes
   * the epic → the landing PR opens. No manual DB surgery.
   */
  private async reconcileEpicIntegrations(repoPath: string): Promise<void> {
    const run = this.deps.store.getEpicRun(repoPath);
    if (!run || (run.status !== "running" && run.status !== "paused")) return;
    const key = `${repoPath}#${run.parentIssueNumber}`;
    const last = this.epicReconcileAt.get(key);
    if (last !== undefined && this.now() - last < EPIC_RECONCILE_TTL_MS) return;
    this.epicReconcileAt.set(key, this.now());
    const forge = this.deps.resolveForge(repoPath);
    if (!forge) return;
    const epic = await this.buildEpic(repoPath, run);
    if (!epic) return;
    const candidates = epic.children.filter((c) => !c.integrationMerged && !c.issueClosed);
    if (candidates.length === 0) return;
    const rows = this.deps.store
      .list()
      .filter((x) => x.repoPath === repoPath && x.issueNumber != null && x.branch);
    for (const child of candidates) {
      await this.probeChildIntegration(
        forge,
        repoPath,
        child.number,
        rows.filter((x) => x.issueNumber === child.number),
      );
    }
  }

  /** One child's probe pass for {@link reconcileEpicIntegrations}: try each DISTINCT branch
   *  among the child's session rows until one records. Rows arrive in `store.list()`
   *  (createdAt) order — dead predecessors first — which is exactly why every branch is tried.
   *  A live row whose snapshot shows an OPEN PR is skipped (event-time recording owns it);
   *  per-branch probe errors warn + continue. */
  private async probeChildIntegration(
    forge: GitForge,
    repoPath: string,
    childNumber: number,
    rows: Session[],
  ): Promise<void> {
    const prSnap = this.deps.prCache.snapshot();
    const seen = new Set<string>();
    for (const row of rows) {
      const branch = row.branch!;
      if (seen.has(branch)) continue;
      seen.add(branch);
      // Live session with an open PR → event-time recording owns it; skip the probe.
      if (row.status !== "archived" && prSnap[row.id]?.state === "open") continue;
      let pr: PrStatus;
      try {
        pr = await forge.prStatus(branch);
      } catch (err) {
        console.warn(`[drain] epic reconcile prStatus(${branch}) failed for ${repoPath}:`, err);
        continue;
      }
      if (pr.state !== "merged") continue;
      // The helper re-applies the full gate set (active epic, base resolution incl. the
      // base-incapable carve-out via THIS row's baseBranch, pinned match, idempotent upsert).
      await recordEpicIntegrationIfChild(
        row,
        { number: pr.number, url: pr.url, baseRefName: pr.baseRefName },
        { store: this.deps.store, forge },
      );
      if (this.deps.store.isEpicIntegratedChild(repoPath, childNumber)) return; // recorded
    }
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
      // #1037: an integrated epic child observed merged mid-archive must archive-only, never close.
      isIntegratedEpicChild: (sess) =>
        sess.issueNumber != null &&
        this.deps.store.isEpicIntegratedChild(sess.repoPath, sess.issueNumber),
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
      // #1401: backfill missed epic-integration rows BEFORE the pump so a stalled epic
      // completes (and opens its landing PR) in this same tick. UNGATED by the drain toggle,
      // like its neighbors; internally throttled + no-op without an active epic.
      try {
        await this.reconcileEpicIntegrations(repoPath);
      } catch (err) {
        console.warn(`[drain] epic reconcile failed for ${repoPath}:`, err);
      }
      // UNGATED landing-PR retry: runs for EVERY repo, BEFORE the pump gate, so a completed
      // epic's PR is opened/retried even in a repo with autoDrain off and no running epic.
      // DB-gated internally → zero forge calls in steady state.
      await this.ensureLandingPrsForRepo(repoPath);
      // #1071: rebase stuck (behind/conflicting) landing PRs back to landable BEFORE the
      // auto-land pass so a freshly-rebased PR can be landed in the same tick. Gated
      // internally (automation-engaged check + GitHub-only + DB-gate → zero forge calls in
      // steady state). UNGATED by drain, like its neighbors.
      await this.rebaseStuckLandingPrsForRepo(repoPath);
      // C: auto-rerun a red (flaky) landing PR's failed CI before the auto-land pass sees it —
      // GitHub-only, capped per head, never merges. UNGATED like the passes around it.
      await this.rerunRedLandingCiForRepo(repoPath);
      // #1044: opt-in auto-land of open landing PRs (gated internally on the repo's auto-merge
      // opt-in → zero forge calls when off). UNGATED by drain, like ensureLandingPrsForRepo.
      await this.autoLandLandingPrsForRepo(repoPath);
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
