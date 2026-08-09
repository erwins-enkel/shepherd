import type { RepoConfig, SessionStore } from "./store";
import type { GitForge, GitState, Issue, PrStatus, SubIssueRef } from "./forge/types";
import type { CreateSessionInput, Session, SessionArchiveReason } from "./types";
import type { SessionStateChange } from "./session-snapshot";
import type { UsageLimits } from "./usage-limits";
import type { TelemetryService } from "./telemetry";
import { recordEpicIntegrationIfChild, settleMergedSession } from "./merge-teardown";
import { isFullAuto } from "./full-auto";
import { issueSpawnPrompt } from "./issue-spawn-prompt";
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
  isEpicChild,
  branchReferencesEpic,
} from "./epic-branch";
import { selectEpicCandidates, type Epic, type EpicRun, type EpicStackContext } from "./epic-core";
import { decomposeEpicChains } from "./epic-chains";
import {
  bottomMostUnmergedPr,
  buildStackSpawnPlan,
  detectStackWedge,
  epicChildBaseOk,
  hasLiveStackedSuccessor,
  isStackedBase,
  liveChainSegment,
  planStackComposition,
  stackRetireGate,
  stackRootedAtEpic,
  wedgeCleared,
  type EpicStackMember,
  type StackComposition,
  type StackPredecessorFact,
  type StrandedChildFact,
  type WedgeChildFact,
} from "./epic-stack";
import { detectMigrationPaths } from "./epic-migrations";
import {
  anyLiveRepairSession,
  buildRollup,
  computeLandingReady,
  type CompletedEpic,
  type CompletedEpicChild,
  type EpicLandingState,
} from "./completed-epic";
import { buildLandingPrTitle, buildLandingPrBody } from "./epic-landing";
import { parseEpicBody } from "./epic-parse";
import { diagnoseEpic, type EpicDiagnosis } from "./epic-diagnosis";
import { repoHasNoCiCached } from "./checks-gate";
import {
  EmptyDiffError,
  MergeEnqueuedError,
  MergePendingError,
  type StackInfo,
} from "./forge/types";
import { mapBounded } from "./map-bounded";
import { config } from "./config";
import { rebaseLandingBranch, isUnionDriverRegistered } from "./landing-rebase";
import type { NotifyInput } from "./push";

/** Concurrency cap for the per-child blocked_by fan-out when assembling an epic.
 *  Bounds `gh api` subprocesses so a large (100+-child) epic can't exhaust FDs or
 *  trip GitHub secondary rate limits. */
const EPIC_BLOCKED_BY_CONCURRENCY = 8;

/** #645 (c): re-scan the host for stray `epic/*` branches at most this often per epic. The
 *  scan is an advisory divergence warning, not gating — a 5-minute staleness is harmless and
 *  keeps `gh api matching-refs` off the per-pump hot path. */
const EPIC_BRANCH_SCAN_TTL_MS = 5 * 60_000;

/** #2069: re-run the stack-composition pass for one epic at most this often. Composition only has
 *  work to do when a child PR has just opened, so a per-tick re-read of the host's stack state
 *  would be pure overhead; each pass takes at most one step anyway. */
const EPIC_STACK_COMPOSE_TTL_MS = 60_000;

/** #2070: the "nothing is stack-held" answer, shared so every non-stacked repo's state carries the
 *  same empty set instead of allocating one per pump iteration. */
const EMPTY_SESSION_SET: ReadonlySet<string> = new Set<string>();

/** #790: after a drain spawn for an issue fails (e.g. worktree isolation aborted), back off
 *  re-attempting that issue for this long. Without it, abort + the ~30s tick would loop
 *  spawn→abort→re-claim with GitHub label-API churn. A transient failure self-heals after the
 *  window; a persistent one stops churning. */
const SPAWN_FAIL_COOLDOWN_MS = 5 * 60_000;

/** #1757: can this forge create the epic integration branch? A forge that resolves but lacks
 *  `ensureBranch` (Gitea/local) genuinely cannot — that drives the operator-facing
 *  NO_INTEGRATION_BRANCH_WARNING. An ABSENT forge is a different, unknown condition (we couldn't
 *  ask), so it reports `true` (no warning): the warning states a specific fact about the forge, and
 *  asserting it when no forge resolved would be telling the operator something untrue. */
function forgeCanEnsureBranch(forge: GitForge | null | undefined): boolean {
  return forge ? forge.ensureBranch != null : true;
}

/** #1757: `forge.ensureBranch` THREW while resolving an epic child's spawn base, so the integration
 *  branch could not be ensured. Thrown by resolveSpawnBase and caught (typed) in doSpawn, which
 *  records `epicBase` on the spawn-failure entry so the drain can surface an `epic_base_unavailable`
 *  hold. TYPED deliberately: doSpawn's catch also wraps `service.create()`, so an untyped marker
 *  would turn ANY epic-child spawn failure (sandbox hold, provider error, transient create error)
 *  into a mislabeled, epic-wide hold. Carries the branch for the operator-facing detail. */
class EpicBaseUnavailableError extends Error {
  constructor(
    readonly integrationBranch: string,
    cause?: unknown,
  ) {
    super(`epic integration branch \`${integrationBranch}\` could not be ensured on the forge`);
    this.name = "EpicBaseUnavailableError";
    this.cause = cause;
  }
}

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

/** Provisional banner prepended to the body of a #1664 pre-warm DRAFT landing PR — signals the PR
 *  was opened early to warm CI while the epic is still draining, so its body/child list are not yet
 *  final (Task 3's completion rebuild uses the plain builder, dropping this marker). Forge data
 *  authored by Shepherd (like `buildLandingPrBody`), passed verbatim to GitHub — NEVER i18n'd. */
const PREWARM_DRAFT_NOTICE =
  "> ⚠️ Pre-warm draft — CI is being warmed while the epic drains; the body and child list are finalized when the epic lands.\n\n";

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
  clampCodexModelForAuth,
  drainSpawnModel,
  modelForProviderOrDefault,
  resolveProviderDefaultModelSetting,
  type CodexAuthMode,
} from "./default-model";
import { readCodexAuthMode } from "./codex-auth";
import { drainSpawnEffort, resolveDefaultEffortSetting } from "./default-effort";
import {
  resolveProfile,
  autoHoldReason,
  egressApplies,
  detectBackend,
  type SandboxBackend,
} from "./sandbox";
import { detectEgressBackend, type EgressBackend } from "./egress";
import { epicBaseDirective, epicStackedBaseDirective } from "./autopilot";

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
    | "recordEpicStackMember"
    | "listEpicStack"
    | "deleteEpicStack"
    | "recordEpicStackWedge"
    | "listEpicStackWedges"
    | "clearEpicStackWedge"
    | "recordEpicBaseMismatch"
    | "clearEpicBaseMismatch"
    | "getEpicBaseMismatch"
    | "listEpicBaseMismatches"
  >;
  service: {
    create(input: CreateSessionInput): Promise<Session>;
    archive(id: string, reapKeys?: string[], reason?: SessionArchiveReason): Promise<number>;
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
  /** Live Codex auth mode; read per model resolution because login mode can change at runtime. */
  readCodexAuthMode?: () => CodexAuthMode;
  /** #1071: maximum genuine rebase attempts (cap budget). Wired from config.autoMergeRebaseCap
   *  in index.ts; injected directly so tests can set a small cap without touching global config. */
  rebaseCap: number;
  /** #1071: injectable seam for rebaseLandingBranch (tests inject a fake). Defaults to the real
   *  impl (src/landing-rebase.ts) in the constructor. */
  rebaseLandingBranch?: typeof rebaseLandingBranch;
  /** #1071: injectable seam for the driver-pause fast-path re-probe (tests inject a fake).
   *  Defaults to the real isUnionDriverRegistered (src/landing-rebase.ts) in the constructor. */
  isDriverRegistered?: (repoPath: string) => Promise<boolean>;
  /** #1838: push a notification (→ push.notify). Optional — absent in tests that don't assert it.
   *  Used by enterLandingConflict to surface a genuine-conflict landing pause to the operator. */
  notify?: (input: NotifyInput) => Promise<boolean> | void;
}

/** A forge that implements the whole stacked-PR surface (#2068). `unstack` is part of it because
 *  #2070's mid-stack repair has no other primitive — GitHub cannot reorder or drop one layer. */
type StackForge = GitForge &
  Required<Pick<GitForge, "stackForPr" | "createStack" | "addToStack" | "unstack">>;

/** Does this forge expose that surface? Branches on the METHODS, never on `kind`: Gitea/Local omit
 *  them, and a future adapter may add them. Narrows, so the composition helpers can call the
 *  methods without re-asserting each one. */
function forgeHasStacks(forge: GitForge | null): forge is StackForge {
  return !!forge?.stackForPr && !!forge.createStack && !!forge.addToStack && !!forge.unstack;
}

/** Everything the #2069 composition helpers need about the epic they are composing, assembled once
 *  per pass so each helper stays a thin forge call + row write. */
interface StackComposeCtx {
  repoPath: string;
  parent: number;
  /** The epic's pinned integration branch — the trunk every stack of this epic must have. */
  pinned: string;
  /** PR number → the epic child it belongs to (live children only). */
  childByPr: Map<number, number>;
  /** child # → the base its session was spawned on, recorded on the stack row. */
  baseByChild: Map<number, string>;
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
  // #2069: `${repoPath}#${parentIssueNumber}` → last stack-composition pass, plus its in-flight
  // guard (the pass is a read-modify-write across awaits, and tick() has no re-entrancy lock).
  // In-memory on purpose: a restart composes on the next tick and the pass is idempotent.
  private epicStackComposedAt = new Map<string, number>();
  private epicStackInFlight = new Set<string>();
  // #2070: repoPath → sessionId → when its live-stack confirmation REFUSED at retire (a layer below
  // it is not a landed epic child). The persisted rows cannot predict that answer, so without this
  // the session would be re-selected and consume the pump's one retire attempt every tick, starving
  // the repo's whole drain. Cleared when an epic child integrates, and EXPIRING as well — a layer
  // merged out-of-band (operator, merge train) records through a path that never reaches this map,
  // and a permanently stale hold would be a silent stall. Expiry degrades that to one re-check per
  // window. In-memory: a restart simply re-checks.
  private stackConfirmHeld = new Map<string, Map<string, number>>();
  private lastEpicSig = new Map<string, string>();
  // #1401: `${repoPath}#${parentIssueNumber}` → last reconcile-sweep timestamp. In-memory on
  // purpose: a restart sweeps immediately (deploy ⇒ a pre-existing stall self-heals within one
  // tick), then settles to one sweep per EPIC_RECONCILE_TTL_MS.
  private epicReconcileAt = new Map<string, number>();
  /** #790: `${repoPath}#${issueNumber}` → last spawn failure; throttles re-spawn of an issue whose
   *  create() keeps throwing. Cleared on a successful spawn. In-memory.
   *
   *  #1757: the entry also carries `epicBase` when — and ONLY when — the failure was a typed
   *  {@link EpicBaseUnavailableError} (the forge's `ensureBranch` threw). buildState derives the
   *  `epic_base_unavailable` hold from that, applying the cooldown freshness test ITSELF: the lazy
   *  expiry delete lives inside doSpawn (below), which the hold PREVENTS from running — so a
   *  membership-only check would latch the hold forever instead of letting it lapse and retry. */
  private spawnFailures = new Map<string, { at: number; epicBase?: string }>();
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

  private clampCodexModel(model: string | null, provider: "claude" | "codex"): string | null {
    return clampCodexModelForAuth(
      model,
      provider,
      this.deps.readCodexAuthMode?.() ?? readCodexAuthMode(),
    );
  }

  private resolvedSpawnModel(
    decision: Extract<DrainDecision, { kind: "spawn" }>,
    repoDefaultModel: string,
  ): string | null {
    const settings = decision.epicProviderSettings;
    const provider = settings?.agentProvider ?? config.defaultAgentProvider;
    const model = settings
      ? modelForProviderOrDefault(settings.model, settings.agentProvider)
      : drainSpawnModel(
          resolveProviderDefaultModelSetting(
            repoDefaultModel,
            provider,
            config.defaultModel,
            config.defaultCodexModel,
          ),
        );
    return this.clampCodexModel(model, provider);
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
      // (#2070) stacks dissolved after losing a middle layer — blocking, and it supersedes the
      // generic base-mismatch remedy for the children it stranded.
      stackWedges: this.deps.store.listEpicStackWedges(repoPath, run.parentIssueNumber),
      // #1757: a forge without ensureBranch (Gitea/local) cannot create the integration branch, so
      // every child of this epic degrades onto the default branch. The epic still progresses, but
      // not the way the epic model implies — surface it as a warning instead of a console.warn.
      //
      // An UNRESOLVABLE forge is NOT the same thing (epicStructure can serve a cached build after
      // the forge is gone), and the warning asserts a specific, checkable fact — "this forge cannot
      // create branches". Claiming that when we simply couldn't ask would be a false statement to
      // the operator, so no-forge stays silent (true) rather than warning for the wrong reason.
      integrationBranchSupported: forgeCanEnsureBranch(this.deps.resolveForge(repoPath)),
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
    let epicStackBases: DrainRepoState["epicStackBases"] = null;
    let stackHeldSessions: ReadonlySet<string> = EMPTY_SESSION_SET;
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
        // #2069: with `epicStacksEnabled`, a child whose only outstanding blocker is a chain
        // predecessor with an OPEN PR is admitted early and based on that predecessor's branch.
        // An absent `ctx` (flag off / no forge support / nothing stackable) ⇒ the pre-#2069 call.
        const stack = this.epicStackContext(repoPath, cfg, builtEpic);
        epicStackBases = stack.baseByChild;
        stackHeldSessions = this.stackHeldSessions(repoPath, cfg, builtEpic);
        if (epicRun!.status === "running")
          candidates = selectEpicCandidates(builtEpic.children, stack.ctx);
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
        epicStackBases,
        stackHeldSessions,
        epicBaseUnavailable: this.freshEpicBaseFailure(repoPath),
      },
      epic: builtEpic,
    };
  }

  /** #2069: link an epic's child PRs into a GitHub stack rooted at its pinned integration branch,
   *  one step per pass. Runs from `tick()` beside the other self-guarding epic passes — NOT from
   *  `pumpStep`, which iterates up to 100 times per pump.
   *
   *  The guard ladder is ordered cheapest-first so an opted-out or unengaged repo costs ZERO forge
   *  calls. The whole body is wrapped: `tick()` calls its passes unguarded, and #2068's stack
   *  WRITES deliberately propagate their errors, so an unwrapped throw here would break the tick
   *  for every later repo.
   *
   *  #2070: the pass ALSO runs — sweep-only — when the repo has opted back out but still carries a
   *  live wedge marker. That marker drives a blocking "epic blocked until fixed" warning, and its
   *  only clearing path is this sweep; gating it behind the flag would leave the warning permanently
   *  unclearable for anyone who turned stacking off after a wedge. The extra work is one store read
   *  per tick for an epic that never wedged. */
  private async composeEpicStacksForRepo(repoPath: string): Promise<void> {
    try {
      const er = this.deps.store.getEpicRun(repoPath);
      if (er?.status !== "running") return;
      const parent = er.parentIssueNumber;
      const forge = this.deps.resolveForge(repoPath);
      const stackForge =
        this.deps.store.getRepoConfig(repoPath).epicStacksEnabled && forgeHasStacks(forge)
          ? forge
          : null;
      const wedged = this.deps.store.listEpicStackWedges(repoPath, parent).length > 0;
      if (!stackForge && !wedged) return;
      // READ-ONLY getter: never INSERT a title-drifted pin from a side path (see tryAutoLandEpic).
      // Unpinned ⇒ no epic child has been based on anything yet ⇒ nothing to compose.
      const pinned = this.deps.store.getEpicIntegrationBranch(repoPath, parent);
      if (!pinned) return;
      const key = `${repoPath}#${parent}`;
      const last = this.epicStackComposedAt.get(key);
      if (last !== undefined && this.now() - last < EPIC_STACK_COMPOSE_TTL_MS) return;
      if (this.epicStackInFlight.has(key)) return;
      this.epicStackInFlight.add(key);
      try {
        this.epicStackComposedAt.set(key, this.now());
        const epic = await this.buildEpic(repoPath, er);
        if (!epic) return;
        if (!stackForge) {
          this.sweepEpicStackWedges(repoPath, parent, pinned, epic); // opted out — clearing only
          return;
        }
        // #2070: repair before composing. A live wedge halts stacking for the epic entirely —
        // composing over a dissolved stack would just rebuild the shape the operator has to fix.
        if (await this.repairEpicStack(stackForge, repoPath, parent, pinned, epic)) return;
        await this.composeOneEpicStack(stackForge, repoPath, parent, pinned, epic);
      } finally {
        this.epicStackInFlight.delete(key);
      }
    } catch (err) {
      console.warn(`[drain] epic stack composition failed for ${repoPath}:`, err);
    }
  }

  /** #2070: mid-stack loss. A closed or abandoned middle layer blocks every layer above it, and
   *  GitHub has NO reorder or drop-one endpoint (`gh stack modify` is TUI-only) — so the single
   *  repair primitive is unstack-and-recreate. Returns true when stacking is halted for this epic,
   *  either because a wedge is still live or because this pass just raised one.
   *
   *  Fail-visible by design: the layers above keep their branches for an operator or a repair steer,
   *  the blocking `assembleEpic` warning names them and the remedy, and the halt keeps the drain
   *  from quietly re-stacking around the hole. */
  private async repairEpicStack(
    forge: StackForge,
    repoPath: string,
    parent: number,
    pinned: string,
    epic: Epic,
  ): Promise<boolean> {
    if (this.sweepEpicStackWedges(repoPath, parent, pinned, epic)) return true;
    const rows = this.deps.store.listEpicStack(repoPath, parent);
    if (rows.length === 0) return false;
    const facts = new Map<number, WedgeChildFact>(
      epic.children.map((c) => [
        c.number,
        {
          integrationMerged: c.integrationMerged,
          issueClosed: c.issueClosed,
          prNumber: c.prNumber,
        },
      ]),
    );
    const wedge = detectStackWedge({ rows, facts, closedPrs: this.closedEpicChildPrs(repoPath) });
    if (!wedge) return false;
    await forge.unstack(wedge.stackNumber);
    this.deps.store.deleteEpicStack(repoPath, parent, wedge.stackNumber);
    this.deps.store.recordEpicStackWedge(repoPath, parent, {
      childNumber: wedge.lostChild,
      stackNumber: wedge.stackNumber,
      stranded: wedge.stranded,
      detectedAt: this.now(),
    });
    console.warn(
      `[drain] epic #${parent}: stack ${wedge.stackNumber} dissolved — child #${wedge.lostChild}'s layer PR is gone, stranding #${wedge.stranded.join(", #")}`,
    );
    return true;
  }

  /** Drop wedge markers whose stranded children have all resolved. Returns true while any marker is
   *  still live (stacking stays halted). Keyed on the STRANDED children, never on the lost one: a
   *  loss caused BY an issue closing would otherwise clear itself on the very next pass, after the
   *  rows the detector needs to re-raise it have already been deleted. */
  private sweepEpicStackWedges(
    repoPath: string,
    parent: number,
    pinned: string,
    epic: Epic,
  ): boolean {
    const wedges = this.deps.store.listEpicStackWedges(repoPath, parent);
    if (wedges.length === 0) return false;
    const spawnBases = this.epicChildSpawnBases(repoPath);
    const facts = new Map<number, StrandedChildFact>(
      epic.children.map((c) => [
        c.number,
        {
          integrationMerged: c.integrationMerged,
          issueClosed: c.issueClosed,
          spawnBase: spawnBases.get(c.number) ?? null,
        },
      ]),
    );
    let live = 0;
    for (const w of wedges) {
      if (wedgeCleared({ stranded: w.stranded, facts, pinnedBranch: pinned })) {
        this.deps.store.clearEpicStackWedge(repoPath, parent, w.childNumber);
        console.log(`[drain] epic #${parent}: stack wedge on child #${w.childNumber} cleared`);
      } else {
        live++;
      }
    }
    return live > 0;
  }

  /** PR numbers of this repo's live auto sessions whose pull request is CLOSED (never merged) — the
   *  other way a stack layer goes missing while its child still holds that PR. */
  private closedEpicChildPrs(repoPath: string): ReadonlySet<number> {
    const snap = this.deps.prCache.snapshot();
    const closed = new Set<number>();
    for (const s of this.deps.store.list()) {
      if (s.repoPath !== repoPath || !s.auto || s.status === "archived") continue;
      const git = snap[s.id];
      if (git?.state === "closed" && git.number != null) closed.add(git.number);
    }
    return closed;
  }

  /** Plan and apply at most ONE composition step across the epic's chains. Only children still in
   *  flight take part: a done-in-epic layer is no longer something to stack onto (its successor
   *  bases on the integration branch again), so it is dropped from the chain before planning. */
  private async composeOneEpicStack(
    forge: StackForge,
    repoPath: string,
    parent: number,
    pinned: string,
    epic: Epic,
  ): Promise<void> {
    const liveChildren = new Set(
      epic.children.filter((c) => !c.integrationMerged && !c.issueClosed).map((c) => c.number),
    );
    const live = (n: number) => liveChildren.has(n);
    const prByChild = new Map<number, number>();
    for (const c of epic.children) {
      if (c.prNumber != null && live(c.number)) prByChild.set(c.number, c.prNumber);
    }
    const existing = new Map<number, EpicStackMember>(
      this.deps.store.listEpicStack(repoPath, parent).map((r) => [r.childNumber, r]),
    );
    const ctx: StackComposeCtx = {
      repoPath,
      parent,
      pinned,
      childByPr: new Map([...prByChild].map(([child, pr]) => [pr, child])),
      baseByChild: this.epicChildSpawnBases(repoPath),
    };
    for (const chain of decomposeEpicChains(epic.children).chains) {
      const plan = planStackComposition({
        chain: liveChainSegment(chain, live),
        prByChild,
        existing,
      });
      if (plan.kind === "none") continue;
      if (plan.kind === "create") await this.seedEpicStack(forge, ctx, plan);
      else await this.extendEpicStack(forge, ctx, plan);
      return; // one mutation per pass; the next tick carries the chain further
    }
  }

  /** Session spawn base per child issue — the `baseBranch` recorded on each stack row, so the
   *  persisted layer says what the child was actually built on. */
  private epicChildSpawnBases(repoPath: string): Map<number, string> {
    const out = new Map<number, string>();
    for (const s of this.deps.store.list()) {
      if (s.repoPath === repoPath && s.auto && s.issueNumber != null && s.status !== "archived") {
        out.set(s.issueNumber, s.baseBranch);
      }
    }
    return out;
  }

  /** Create the stack from its bottom two layers.
   *
   *  The bottom layer's base IS the stack's trunk, so it is verified against the pinned branch
   *  first: children are only ADVISED to target the epic branch (that is why the retire base gate
   *  exists), and seeding on a child that targeted `main` would root the whole stack — every layer
   *  above it included — at `main`. An already-existing stack is adopted instead of duplicated. */
  private async seedEpicStack(
    forge: StackForge,
    ctx: StackComposeCtx,
    { bottom, next }: Extract<StackComposition, { kind: "create" }>,
  ): Promise<void> {
    if (await this.adoptExistingStack(forge, ctx, bottom.prNumber)) return;
    const base = (await forge.prReviewMeta?.(bottom.prNumber))?.baseRefName;
    if (base !== ctx.pinned) {
      console.warn(
        `[drain] epic #${ctx.parent}: not seeding a stack — child #${bottom.childNumber} pr#${bottom.prNumber} targets \`${base ?? "?"}\`, not the epic branch \`${ctx.pinned}\``,
      );
      return;
    }
    const stack = await forge.createStack([bottom.prNumber, next.prNumber]);
    this.recordStackLayers(ctx, stack.number, [bottom.prNumber, next.prNumber]);
    console.log(
      `[drain] epic #${ctx.parent}: stack ${stack.number} created on \`${ctx.pinned}\` from pr#${bottom.prNumber} + pr#${next.prNumber}`,
    );
  }

  /** Append one layer to the top of an existing stack. */
  private async extendEpicStack(
    forge: StackForge,
    ctx: StackComposeCtx,
    plan: Extract<StackComposition, { kind: "add" }>,
  ): Promise<void> {
    if (await this.adoptExistingStack(forge, ctx, plan.prNumber)) return;
    await forge.addToStack(plan.stackNumber, plan.prNumber);
    this.deps.store.recordEpicStackMember(ctx.repoPath, ctx.parent, {
      childNumber: plan.childNumber,
      stackNumber: plan.stackNumber,
      prNumber: plan.prNumber,
      baseBranch: ctx.baseByChild.get(plan.childNumber) ?? ctx.pinned,
      position: plan.position,
    });
    console.log(
      `[drain] epic #${ctx.parent}: pr#${plan.prNumber} added to stack ${plan.stackNumber} at position ${plan.position}`,
    );
  }

  /** Did the host already stack this PR? Adopting what is there is what makes the pass idempotent
   *  across a restart between the mutation and its row write, and keeps Shepherd from creating a
   *  second stack over PRs someone stacked by hand. A stack rooted somewhere OTHER than the epic
   *  branch is reported and left alone: GitHub has no reorder/insert API, so repair means
   *  unstack-and-recreate — a deliberate act, not a side effect of a composition pass.
   *
   *  The read fails open to null (#2068), i.e. "not stacked"; a create/add then either succeeds or
   *  throws host-side, which the caller logs. */
  private async adoptExistingStack(
    forge: StackForge,
    ctx: StackComposeCtx,
    prNumber: number,
  ): Promise<boolean> {
    const stack = await forge.stackForPr(prNumber);
    if (!stack) return false;
    if (!stackRootedAtEpic(stack, ctx.pinned)) {
      console.warn(
        `[drain] epic #${ctx.parent}: pr#${prNumber} is in stack ${stack.number} rooted at \`${stack.baseRef}\`, not \`${ctx.pinned}\` — leaving it alone`,
      );
      return true;
    }
    this.recordStackLayers(ctx, stack.number, stack.prNumbers);
    return true;
  }

  /** Persist `prNumbers` (bottom → top) as this epic's stack layers. PRs that belong to no child
   *  of this epic are skipped rather than guessed at. */
  private recordStackLayers(ctx: StackComposeCtx, stackNumber: number, prNumbers: number[]): void {
    prNumbers.forEach((prNumber, i) => {
      const childNumber = ctx.childByPr.get(prNumber);
      if (childNumber === undefined) return;
      this.deps.store.recordEpicStackMember(ctx.repoPath, ctx.parent, {
        childNumber,
        stackNumber,
        prNumber,
        baseBranch: ctx.baseByChild.get(childNumber) ?? ctx.pinned,
        position: i + 1,
      });
    });
  }

  /** #2070: the sessions of stacked children that may NOT merge yet, because a layer below them in
   *  the stack has not landed. Store reads only — a held layer costs zero forge calls per tick, and
   *  the drain re-derives this on every pump iteration.
   *
   *  Unions the in-memory {@link stackConfirmHeld}: a live-stack confirmation that refused at retire
   *  is a hold the rows could not predict, and without it that session would be re-selected and end
   *  the pump every single tick — starving the whole repo, not just that layer. */
  private stackHeldSessions(repoPath: string, cfg: RepoConfig, epic: Epic): ReadonlySet<string> {
    const confirmHeld = this.freshStackConfirmHolds(repoPath);
    if (!cfg.epicStacksEnabled) return confirmHeld;
    const held = new Set<string>(confirmHeld);
    const rows = this.deps.store.listEpicStack(repoPath, epic.parentIssueNumber);
    if (rows.length > 0) {
      const integratedChildren = this.deps.store.listEpicIntegrated(
        repoPath,
        epic.parentIssueNumber,
      );
      for (const c of epic.children) {
        if (c.sessionId === null) continue;
        const gate = stackRetireGate({ rows, childNumber: c.number, integratedChildren });
        if (gate.kind === "hold") held.add(c.sessionId);
      }
    }
    return held;
  }

  /** #2069: what the drain knows about each epic child as a potential stack PREDECESSOR — the
   *  branch a successor would be based on, and whether its PR is actually open. Same session
   *  filter as buildEpic (auto, issue-linked, not archived), so a child that reads as
   *  stack-ready here is one whose `EpicChild.prNumber` is populated there. A re-spawned issue
   *  can map to several rows; the one with an open PR wins. */
  private stackPredecessorFacts(repoPath: string): Map<number, StackPredecessorFact> {
    const snap = this.deps.prCache.snapshot();
    const facts = new Map<number, StackPredecessorFact>();
    for (const s of this.deps.store.list()) {
      if (s.repoPath !== repoPath || !s.auto || s.issueNumber == null) continue;
      if (s.status === "archived") continue;
      const git = snap[s.id];
      const prOpen = git?.state === "open" && git.number != null;
      if (!prOpen && facts.get(s.issueNumber)?.prOpen) continue;
      facts.set(s.issueNumber, { headBranch: s.branch, prOpen });
    }
    return facts;
  }

  /** #2069: the stack facts `selectEpicCandidates` needs to admit a child early, plus the branch
   *  each such child must be based on. Both absent — and therefore zero behaviour change — unless
   *  the repo opted in, the forge supports stacks, AND some child is actually stackable right now.
   *
   *  Returns a struct rather than a nullable one so the caller needs no `?.`/`??` — buildState is
   *  at its complexity cap and this must not be what pushes it over.
   *
   *  #2070: a live wedge suppresses stacked bases entirely. This path is INDEPENDENT of the
   *  composition pass, so halting composition alone would keep spawning children onto sibling
   *  branches that nothing will ever stack — each then refused at retire. Suppressing here is what
   *  makes a wedged epic fall back to the pre-#2069 wait-for-merge behaviour. */
  private epicStackContext(
    repoPath: string,
    cfg: RepoConfig,
    epic: Epic,
  ): { ctx?: EpicStackContext; baseByChild: Map<number, string> | null } {
    if (!cfg.epicStacksEnabled || !forgeHasStacks(this.deps.resolveForge(repoPath))) {
      return { baseByChild: null };
    }
    if (this.deps.store.listEpicStackWedges(repoPath, epic.parentIssueNumber).length > 0) {
      return { baseByChild: null };
    }
    const decomposition = decomposeEpicChains(epic.children);
    const plan = buildStackSpawnPlan({
      children: epic.children,
      decomposition,
      facts: this.stackPredecessorFacts(repoPath),
    });
    if (plan.baseByChild.size === 0) return { baseByChild: null };
    return {
      ctx: { predecessorOf: decomposition.predecessorOf, stackReady: plan.stackReady },
      baseByChild: plan.baseByChild,
    };
  }

  /** Record a spawn failure for the #790 cooldown, tagging it with the epic integration branch ONLY
   *  for the typed {@link EpicBaseUnavailableError} (#1757). doSpawn's catch also wraps
   *  `service.create()`, so tagging any failure would raise a mislabeled, epic-wide
   *  `epic_base_unavailable` hold for an unrelated cause (sandbox hold, provider error, transient
   *  create error) — a far broader pause than the per-issue cooldown, with the wrong copy. */
  private recordSpawnFailure(failKey: string, err: unknown): void {
    const epicBase = err instanceof EpicBaseUnavailableError ? err.integrationBranch : undefined;
    this.spawnFailures.set(failKey, { at: this.now(), ...(epicBase ? { epicBase } : {}) });
  }

  /** #1757: the integration branch of a RECENT, still-cooling epic-base spawn failure for this repo
   *  (`ensureBranch` threw), or null. Feeds the `epic_base_unavailable` hold.
   *
   *  The freshness test lives HERE, not in the map's lifecycle, and that is load-bearing: the lazy
   *  cooldown-expiry delete lives inside doSpawn — which the hold PREVENTS from running — so a
   *  membership-only check would hold the epic forever instead of lapsing and retrying. Scanning is
   *  scoped to this repo (`failKey` is `${repoPath}#${number}`) so another repo's failure can never
   *  hold this one. Freshest qualifying entry wins. */
  private freshEpicBaseFailure(repoPath: string): string | null {
    const prefix = `${repoPath}#`;
    let best: { at: number; epicBase: string } | null = null;
    for (const [key, fail] of this.spawnFailures) {
      if (!key.startsWith(prefix) || !fail.epicBase) continue;
      if (this.now() - fail.at >= SPAWN_FAIL_COOLDOWN_MS) continue; // stale → no longer holds
      if (!best || fail.at > best.at) best = { at: fail.at, epicBase: fail.epicBase };
    }
    return best?.epicBase ?? null;
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
      [
        "blocked",
        "changes_requested",
        "error",
        "usage",
        "credits",
        // #1757: the epic can't base its children — genuinely stuck until the forge recovers, so it
        // reads as a paused banner (amber), not a quiet idle state.
        "epic_base_unavailable",
      ].includes(hold.code);
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
      const cfg = this.deps.store.getRepoConfig(repoPath);
      const resolution = await this.classifyLanding(
        forge,
        row,
        integrationBranch,
        cfg.preWarmEpicLandingCi,
      );
      this.resolveLanding(repoPath, parentIssueNumber, resolution);
      if (resolution.state === "open" && resolution.prNumber != null) {
        // #1838: the open-time rebase (in openNewLandingPr / adoptOpenLanding) hit a genuine
        // conflict — layer the conflict pause + operator push on AFTER resolveLanding has persisted
        // the PR, so a store/notify hiccup can never demote the just-opened PR to error+attempts++.
        if (resolution.rebaseConflict) {
          this.enterLandingConflict(repoPath, parentIssueNumber, resolution.prNumber);
        }
        // Migration-awareness checkpoint (#645): once the landing PR's number is known, detect any
        // migration files it carries so the band can ask the operator to acknowledge them. Strictly
        // best-effort — a detection failure (or a forge without prChangedPaths) leaves no paths,
        // hence no chip, and NEVER affects the landing resolution above.
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
   * existing open PR (adopting + finalizing a pre-warm draft — #1664), record an already-merged
   * one as `merged`, treat a human-closed non-draft one as terminal `none` (a closed draft is
   * re-opened), open a new one, or classify the failure (EmptyDiffError → `none`; anything
   * else → `error` + attempt++). Pure decision — the caller persists + emits. NEVER throws:
   * every forge touch is wrapped here (the editPr/markReady adoption calls carry their OWN
   * try/catch so a finalize hiccup can't bubble to the outer catch and demote a healthy
   * adoption to a null-ref `error`).
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
    preWarm: boolean,
  ): Promise<{
    state: EpicLandingState;
    prNumber: number | null;
    prUrl: string | null;
    attempts: number;
    rebaseConflict?: boolean;
  }> {
    const { repoPath, parentIssueNumber, landingAttempts } = row;
    try {
      // Idempotency guard: prStatus reads `--state all`, so it sees any prior PR whose head
      // is the integration branch (which is only ever the landing PR's head).
      const existing = await forge.prStatus(integrationBranch);
      if (existing.state === "open") {
        // Reuse — never open a second PR. Covers the open-succeeded/record-failed gap AND the
        // #1664 pre-warm adoption: finalize the early draft from the FINAL rollup.
        return await this.adoptOpenLanding(forge, row, integrationBranch, existing, preWarm);
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
        if (existing.isDraft !== true) {
          // A human deliberately closed a real (non-draft) landing PR (unmerged) — terminal,
          // do NOT re-open it.
          return { state: "none", prNumber: null, prUrl: null, attempts: landingAttempts };
        }
        // A #1664 pre-warm DRAFT was closed mid-drain (prStatus reads `--state all`, so isDraft
        // is populated for closed PRs too; the integration branch is only ever the landing PR's
        // head ⇒ closed+draft unambiguously means "pre-warm draft closed"). Fall through to open
        // a fresh NON-draft landing PR from the final rollup.
      }
      // existing.state === "none" (or a closed pre-warm draft) → no live PR, open one.
      return await this.openNewLandingPr(forge, row, integrationBranch);
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
   * A.3 sub-step of {@link adoptOpenLanding} (#1664), split out to keep that method under the
   * fallow complexity gate. Refreshes the existing PR's title/body from the final rollup —
   * caller already gated the call on `preWarm || existing.isDraft`. Swallows its own errors
   * (same try/catch + console.warn wording as before the split) and reports success/failure
   * back to the caller so A.4 stays coupled: never un-draft onto a stale body.
   */
  private async refreshLandingBody(
    forge: GitForge,
    row: {
      repoPath: string;
      parentIssueNumber: number;
      parentTitle: string;
      childrenJson: string;
      landingAttempts: number;
    },
    integrationBranch: string,
    existing: PrStatus,
  ): Promise<boolean> {
    const { repoPath, parentIssueNumber, parentTitle } = row;
    try {
      const defaultBranch = await forge.defaultBranch();
      const children = JSON.parse(row.childrenJson) as CompletedEpicChild[];
      const title = buildLandingPrTitle(parentIssueNumber, parentTitle);
      const body = buildLandingPrBody({
        parentNumber: parentIssueNumber,
        parentTitle,
        integrationBranch,
        defaultBranch,
        children,
      }); // plain builder — NO provisional marker
      if (forge.editPr && existing.number != null) {
        await forge.editPr(existing.number, { title, body });
      }
      // editPr absent or number null ⇒ nothing to do, refresh counts as successful
      return true;
    } catch (err) {
      console.warn(
        `[drain] landing body refresh failed for ${repoPath}#${parentIssueNumber}:`,
        err,
      );
      return false;
    }
  }

  /**
   * A.4 sub-step of {@link adoptOpenLanding} (#1664), split out to keep that method under the
   * fallow complexity gate. Caller already gated the call on `existing.isDraft === true &&
   * bodyRefreshed`. Swallows its own errors (same try/catch + console.warn wording as before the
   * split) and reports success back to the caller.
   */
  private async markLandingReady(
    forge: GitForge,
    repoPath: string,
    parentIssueNumber: number,
    existing: PrStatus,
  ): Promise<boolean> {
    if (!forge.markReady || existing.number == null) return false;
    try {
      await forge.markReady(existing.number);
      return true;
    } catch (err) {
      console.warn(`[drain] markReady failed for ${repoPath}#${parentIssueNumber}:`, err);
      return false;
    }
  }

  /**
   * Extracted from {@link classifyLanding}'s `existing.state === "open"` branch (#1664) to keep
   * complexity under the fallow gate. Reuses the existing open PR: refreshes its body from the
   * final rollup (A.3, delegated to {@link refreshLandingBody}) and marks it ready if it's still
   * a draft (A.4, delegated to {@link markLandingReady}). MUST be called from inside
   * classifyLanding's outer try — it does not add its own catch-all; both sub-steps swallow
   * their own forge-call errors exactly as classifyLanding did before the extraction.
   */
  private async adoptOpenLanding(
    forge: GitForge,
    row: {
      repoPath: string;
      parentIssueNumber: number;
      parentTitle: string;
      childrenJson: string;
      landingAttempts: number;
    },
    integrationBranch: string,
    existing: PrStatus,
    preWarm: boolean,
  ): Promise<{
    state: EpicLandingState;
    prNumber: number | null;
    prUrl: string | null;
    attempts: number;
    rebaseConflict?: boolean;
  }> {
    const { repoPath, parentIssueNumber, landingAttempts } = row;
    // #1838: a pre-warm draft (drain.ts openPr, no rebase) is finalized here, bypassing
    // openNewLandingPr — so rebase the integration branch onto the current default at adoption too.
    // For the record-failed re-adoption (already rebased at its openNewLandingPr) this hits the
    // seam's `current` short-circuit and cheaply returns false. Wrapped so a defaultBranch hiccup
    // degrades to no-rebase (PR still adopted) — honoring adoptOpenLanding's "sub-steps swallow
    // their own forge-call errors" contract rather than demoting a healthy adoption to error.
    let rebaseConflict = false;
    try {
      const defaultBranch = await forge.defaultBranch();
      rebaseConflict = await this.rebaseIntegrationAtLanding(
        forge,
        repoPath,
        integrationBranch,
        defaultBranch,
        parentIssueNumber,
      );
    } catch (err) {
      console.warn(
        `[drain] open-time rebase prep failed for ${repoPath}#${parentIssueNumber}:`,
        err,
      );
    }
    // A.3 — refresh body from the FINAL rollup. Gated on the UNION (preWarm || existing.isDraft)
    //       so the flag-off record-failed-gap (non-draft) stays a no-op, but ANY actual draft
    //       is refreshed even if the operator disabled the flag (or un-drafted) mid-drain.
    const bodyRefreshed =
      preWarm || existing.isDraft === true
        ? await this.refreshLandingBody(forge, row, integrationBranch, existing)
        : true;
    // A.4 — mark ready exactly once, ONLY for an actual draft, and ONLY if the body refresh
    //       succeeded (coupled: never un-draft onto a stale body).
    const readied =
      existing.isDraft === true && bodyRefreshed
        ? await this.markLandingReady(forge, repoPath, parentIssueNumber, existing)
        : false;
    // Do NOT finalize a still-draft PR to terminal `open`: if it is still a draft and we could
    // not ready it this tick, return `error`+attempts+1 (carrying the PR ref) so
    // ensureLandingPrsForRepo retries under the cap and, if persistent, parks it VISIBLY as
    // `error` rather than a healthy-looking `open` that auto-land skips forever.
    if (existing.isDraft === true && !readied) {
      return {
        state: "error",
        prNumber: existing.number ?? null,
        prUrl: existing.url ?? null,
        attempts: landingAttempts + 1,
      };
    }
    return {
      state: "open",
      prNumber: existing.number ?? null,
      prUrl: existing.url ?? null,
      attempts: landingAttempts,
      rebaseConflict,
    };
  }

  /**
   * #1838: Best-effort open-time rebase of an epic's integration branch onto the default branch,
   * reusing the union-aware landing-rebase seam. Called at landing-PR OPEN time (openNewLandingPr)
   * and at pre-warm-draft ADOPTION time (adoptOpenLanding) so a landing PR is never born behind an
   * advanced default. GitHub-only (the seam force-pushes to origin; other forges have no remote to
   * rebase against) and repair-fenced (never --force-with-lease over a live repair session's
   * commits, mirroring doLandingRebase). NEVER throws — the seam returns a result union, so a
   * skipped/short-circuited/faulted attempt yields false. Returns true ONLY on a genuine (non-union)
   * conflict, so the caller keeps the PR open and routes it to enterLandingConflict.
   *
   * Safe to force-push here: both call sites run post-completion (adoption is only reached via
   * classifyLanding, which requires a completed-epic row), so every child PR is already merged.
   */
  private async rebaseIntegrationAtLanding(
    forge: GitForge,
    repoPath: string,
    integrationBranch: string,
    defaultBranch: string,
    parent: number,
  ): Promise<boolean> {
    if (forge.kind !== "github") return false;
    if (this.hasLiveRepairSession(repoPath, integrationBranch)) return false;
    const res = await this.rebaseLandingBranch(repoPath, integrationBranch, defaultBranch);
    if (res.kind === "conflict") {
      console.warn(
        `[drain] open-time rebase for ${repoPath}#${parent} hit a genuine conflict; ` +
          `opening/adopting the landing PR paused`,
      );
      return true;
    }
    return false;
  }

  /**
   * #1838: Transition an epic's landing row into the genuine-conflict pause and notify the operator.
   * Single source of truth for the conflict pause + push, called from BOTH the open-time paths (via
   * ensureLandingPr, after resolveLanding has persisted the PR) and the reactive rebase pass's
   * conflict case. The pause is edge-set (callers reach this only on the transition into conflict),
   * so the push fires once per transition; a cooldownKey backstops any repeat. NEVER lets a notify
   * throw/reject escape — a push hiccup must not demote a successfully-opened landing PR.
   */
  private enterLandingConflict(repoPath: string, parent: number, landingPr: number | null): void {
    this.deps.store.setEpicLandingRebaseState(repoPath, parent, { pauseReason: "conflict" });
    this.emitCompleted(repoPath, parent);
    try {
      void Promise.resolve(
        this.deps.notify?.({
          kind: "landing_conflict",
          sessionId: "",
          tag: `landing-conflict:${repoPath}#${parent}`,
          name: "epic",
          epicNumber: parent,
          landingPr: landingPr ?? undefined,
          cooldownKey: `landing_conflict:${repoPath}#${parent}`,
        }),
      ).catch((err) =>
        console.warn(`[drain] landing_conflict notify failed for ${repoPath}#${parent}:`, err),
      );
    } catch (err) {
      console.warn(`[drain] landing_conflict notify threw for ${repoPath}#${parent}:`, err);
    }
  }

  /**
   * Extracted from {@link classifyLanding}'s fall-through "no live PR, open one" tail (#1664) to
   * keep complexity under the fallow gate. Covers `existing.state === "none"` and a closed
   * pre-warm draft. MUST be called from inside classifyLanding's outer try — it deliberately has
   * NO try/catch of its own, so an `openPr` throw (including EmptyDiffError) propagates to
   * classifyLanding's catch and is mapped to `none`/`error` exactly as before the extraction.
   */
  private async openNewLandingPr(
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
    rebaseConflict?: boolean;
  }> {
    const { parentIssueNumber, parentTitle, landingAttempts } = row;
    const defaultBranch = await forge.defaultBranch();
    // #1838: rebase the integration branch onto the current default BEFORE opening, so the PR is
    // not born behind/conflicting. A genuine conflict is left un-pushed by the seam; open the PR
    // anyway (the operator needs a PR to see) and signal it so the caller pauses + notifies.
    const rebaseConflict = await this.rebaseIntegrationAtLanding(
      forge,
      row.repoPath,
      integrationBranch,
      defaultBranch,
      parentIssueNumber,
    );
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
      rebaseConflict,
    };
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
   * #1664 pre-warm pass: open the epic's aggregate landing PR EARLY as a draft — while the epic is
   * still draining — so its CI is already green (or diagnosable) by the time the epic completes.
   * Opt-in per repo (`preWarmEpicLandingCi`, default off). GitHub-only + engaged-only (running,
   * non-draft-mode), matching rebaseStuckLandingPrsForRepo's gate shape.
   *
   * LOAD-BEARING invariant: this pass writes NO DB row (no `epic_completed` / `landingState`). The
   * rebase pass (rebaseStuckLandingPrsForRepo) force-pushes only rows in `listEpicCompleted` with
   * `landingState:"open"`; a draft with no row is therefore never force-rewritten under still-open
   * child PRs during the drain. The completion/adoption path (Task 3) is what records the row.
   *
   * The ENTIRE body is wrapped in one try/catch: tick() calls the landing passes UNGUARDED (each
   * guards itself), and the steps below touch the forge (prStatus / buildEpic issue reads /
   * defaultBranch / openPr) — an unguarded throw would break the whole tick for all later repos.
   */
  private async ensureDraftLandingPrForRepo(repoPath: string): Promise<void> {
    try {
      // 1. Opt-in gate (no forge).
      const cfg = this.deps.store.getRepoConfig(repoPath);
      if (!cfg.preWarmEpicLandingCi) return;

      // 2. Engaged predicate: a running epic, not draft-mode (no forge).
      const er = this.deps.store.getEpicRun(repoPath);
      if (cfg.draftMode || er?.status !== "running") return;

      // 3. GitHub-only (matching rebaseStuckLandingPrsForRepo).
      const forge = this.deps.resolveForge(repoPath);
      if (!forge || forge.kind !== "github") return;

      // 4. ≥1 integration-merged child — nothing on the branch to pre-warm otherwise (same
      //    source ensureLandingPr's pre-gate uses).
      const parent = er.parentIssueNumber;
      const details = this.deps.store.listEpicIntegratedDetails(repoPath, parent);
      if (details.length === 0) return;

      // 5. Read the pinned integration branch (READ-ONLY getter — never INSERT a title-drifted
      //    pin from this path; see the comment at tryAutoLandEpic). Null ⇒ unpinned ⇒ skip.
      const branch = this.deps.store.getEpicIntegrationBranch(repoPath, parent);
      if (!branch) return;

      // 6. Serialize per (repo, parent) — shared key namespace with ensureLandingPr et al.
      const key = `${repoPath}#${parent}`;
      if (this.landingInFlight.has(key)) return;
      this.landingInFlight.add(key);
      try {
        // 7. Idempotency: prStatus reads `--state all`, so a prior open/merged/CLOSED draft on
        //    this head all early-return here. A closed draft is NOT re-opened mid-run (respect
        //    the operator's close; re-open-at-completion is Task 3, not here).
        const existing = await forge.prStatus(branch);
        if (existing.state !== "none") return;

        // 8. buildEpic returns null for a repo with no epic structure — guard before use.
        const epic = await this.buildEpic(repoPath, er);
        if (!epic) return;

        // 9. Build the PR fields with the shared epic-landing builders.
        const children = buildRollup(epic.children, details);
        const defaultBranch = await forge.defaultBranch();
        const title = buildLandingPrTitle(parent, epic.parentTitle);
        const baseBody = buildLandingPrBody({
          parentNumber: parent,
          parentTitle: epic.parentTitle,
          integrationBranch: branch,
          defaultBranch,
          children,
        });

        // 10. Prepend the provisional marker (this pass only — the shared builder is unchanged).
        const body = PREWARM_DRAFT_NOTICE + baseBody;

        // 11. Open the draft. EmptyDiffError ⇒ nothing to pre-warm yet (silent). NO DB row.
        try {
          await forge.openPr({ head: branch, base: defaultBranch, title, body, draft: true });
        } catch (err) {
          if (err instanceof EmptyDiffError) return;
          throw err;
        }
      } finally {
        this.landingInFlight.delete(key);
      }
    } catch (err) {
      console.warn(`[drain] ensureDraftLandingPrForRepo failed for ${repoPath}:`, err);
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
      landingPrNumber: number | null;
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
        // Genuine conflict (non-union path, or union path + driver self-test passed). #1838: route
        // through the shared helper so the conflict pause + operator push are set as one transition.
        this.enterLandingConflict(repoPath, parent, row.landingPrNumber);
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
    return anyLiveRepairSession(this.deps.store.list(), repoPath, integrationBranch, this.now());
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
    const cfgModel = this.clampCodexModel(
      drainSpawnModel(
        resolveProviderDefaultModelSetting(
          cfg.defaultModel,
          config.defaultAgentProvider,
          config.defaultModel,
          config.defaultCodexModel,
        ),
      ),
      config.defaultAgentProvider,
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
      // Log only the error message, never the error object: a create/auth failure can carry the
      // provider apiKey in its request config, and passing `err` to the logger trips CodeQL's
      // js/clear-text-logging. The message string alone is off that taint path.
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[drain] landing-repair spawn for ${repoPath}#${parent} failed: ${reason}`);
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
    // #2059: an async merge that is still in flight host-side (merge queue, or a poll that
    // outlived its budget) is NOT a failure — the merge may well land. Recording it would burn
    // LAND_MERGE_ERROR_CAP against a non-failure, and the live re-read above already reconciles
    // to 'merged' on the next tick once it does. A StackedMergeRefusedError deliberately falls
    // through to the backoff instead: unlike the other two it is a DURABLE refusal, so without
    // the cap it would re-fire forge.merge on every tick forever.
    if (err instanceof MergeEnqueuedError || err instanceof MergePendingError) {
      console.warn(`[drain] auto-land for ${key} still in flight (${err.code}):`, err.message);
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
   *
   * #2069: the accept RULE itself lives in `epicChildBaseOk` and nothing here second-guesses it.
   * A stacked child (based on a sibling's head, not the epic branch) is accepted ONLY as a member
   * of a stack whose trunk is the pinned branch — plain base equality would squash-merge an
   * uncomposed child into its SIBLING'S branch. The stack read is skipped entirely in the healthy
   * unstacked case, so an opted-out repo pays nothing.
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
    const pinned = this.deps.store.getEpicIntegrationBranch(repoPath, parent);
    const stacked = isStackedBase(s.baseBranch, pinned);
    // Fast path: an ordinary child on the epic branch, targeting it. No stack read at all.
    if (!stacked && actual === s.baseBranch) {
      this.deps.store.clearEpicBaseMismatch(repoPath, parent, child); // matched — clear stale marker.
      return false;
    }
    const stack = await this.readPrStack(forge, repoPath, decision.prNumber);
    if (
      epicChildBaseOk({
        actualBase: actual ?? "",
        sessionBase: s.baseBranch,
        stack,
        pinnedBranch: pinned,
      })
    ) {
      this.deps.store.clearEpicBaseMismatch(repoPath, parent, child);
      return false;
    }
    this.deps.store.recordEpicBaseMismatch(repoPath, parent, child, {
      actualBase: actual ?? "",
      prNumber: decision.prNumber,
      checkedAt: this.now(),
    });
    console.warn(
      stacked
        ? `[drain] epic child pr#${decision.prNumber} (issue #${child}) is based on \`${s.baseBranch}\` but is not in a stack rooted at \`${pinned ?? "?"}\` — blocked (merging it would land in a sibling's branch)`
        : `[drain] epic child pr#${decision.prNumber} (issue #${child}) targets \`${actual ?? "?"}\`, not the epic branch \`${s.baseBranch}\` — blocked until re-targeted`,
    );
    return true; // fail closed: child stays un-integrated; dependents stay blocked.
  }

  /** #2069: the stack a child PR belongs to, or null. Reads the host only for a repo that opted
   *  in on a forge that supports stacks, so the flag-off path makes no call. Fails open to null
   *  (the read itself does too), which is the conservative answer everywhere it is consumed. */
  private async readPrStack(
    forge: GitForge,
    repoPath: string,
    prNumber: number,
  ): Promise<StackInfo | null> {
    if (!forge.stackForPr || !this.deps.store.getRepoConfig(repoPath).epicStacksEnabled) {
      return null;
    }
    try {
      return await forge.stackForPr(prNumber);
    } catch (err) {
      console.warn(`[drain] stack read for pr#${prNumber} failed; treating as unstacked:`, err);
      return null;
    }
  }

  /** #2069: must this child's head branch survive its own merge? True when a chain successor is
   *  already spawned and still in flight — that successor is based on this branch and may not have
   *  opened its PR yet. Flag-gated and epic-scoped; a non-opted-in repo answers false without
   *  touching the epic. Over-answering true only leaves a merged branch on the remote (which a
   *  stack merge does anyway, per #2068); answering false wrongly orphans a live child. */
  private async keepBranchForStackedSuccessor(
    repoPath: string,
    parent: number,
    childNumber: number,
  ): Promise<boolean> {
    if (!this.deps.store.getRepoConfig(repoPath).epicStacksEnabled) return false;
    const er = this.deps.store.getEpicRun(repoPath);
    if (!er || er.parentIssueNumber !== parent) return false;
    const epic = await this.buildEpic(repoPath, er); // cached structure; usually a hit this pump
    if (!epic) return false;
    return hasLiveStackedSuccessor({
      children: epic.children,
      decomposition: decomposeEpicChains(epic.children),
      childNumber,
    });
  }

  /** #2070: may this epic child's PR be landed right now, and does landing it need `allowStacked`?
   *
   *  `true` → merge with `allowStacked` (it is the bottom-most unmerged layer, so exactly one PR
   *  lands). `false` → merge exactly as before. `null` → HOLD: do not merge, do not record, leave
   *  the session live for the next tick.
   *
   *  The store answer (free) comes first, so a held layer never spends a forge call; the live-stack
   *  read happens only at the moment of merging. It is not redundant with the rows: the rows
   *  describe what Shepherd composed, and a foreign PR hand-added to the stack would not appear in
   *  them — landing then would silently merge every ungated layer beneath us. Anything the live read
   *  cannot vouch for fails closed to a hold. */
  private async stackedMergeAllowed(
    forge: GitForge,
    repoPath: string,
    parent: number,
    s: Session,
    decision: Extract<DrainDecision, { kind: "retire" }>,
  ): Promise<boolean | null> {
    if (!this.deps.store.getRepoConfig(repoPath).epicStacksEnabled) return false;
    const gate = stackRetireGate({
      rows: this.deps.store.listEpicStack(repoPath, parent),
      childNumber: s.issueNumber!,
      integratedChildren: this.deps.store.listEpicIntegrated(repoPath, parent),
    });
    if (gate.kind === "plain") return false;
    if (gate.kind === "hold") {
      // buildState marks these so retireDecision skips them; reaching here means the rows changed
      // mid-pump. Holding is still correct — just don't merge.
      console.log(
        `[drain] epic child pr#${decision.prNumber} (issue #${s.issueNumber}) holds: stack layer #${gate.belowChild} below it has not landed (${gate.reason})`,
      );
      return null;
    }
    const stack = await this.readPrStack(forge, repoPath, decision.prNumber);
    // Not stacked (or unreadable — the read fails open): merge the old way. If it IS stacked after
    // all, #2061's own probe refuses the merge and the next tick retries; both directions are safe.
    if (!stack) return false;
    const integratedPrs = new Set(
      this.deps.store
        .listEpicIntegratedDetails(repoPath, parent)
        .map((d) => d.prNumber)
        .filter((n): n is number => n != null),
    );
    if (bottomMostUnmergedPr(stack.prNumbers, integratedPrs) === decision.prNumber) return true;
    this.holdStackConfirm(repoPath, decision.sessionId);
    console.warn(
      `[drain] epic child pr#${decision.prNumber} (issue #${s.issueNumber}) is not the bottom-most unmerged layer of stack ${stack.number} — held (merging it would land the layers beneath it)`,
    );
    return null;
  }

  /** Remember a live-stack confirmation refusal so {@link stackHeldSessions} keeps this session out
   *  of the retire decision. Without it the session is re-selected every tick and ends the pump
   *  before any spawn or any other retire runs. */
  private holdStackConfirm(repoPath: string, sessionId: string): void {
    const held = this.stackConfirmHeld.get(repoPath) ?? new Map<string, number>();
    held.set(sessionId, this.now());
    this.stackConfirmHeld.set(repoPath, held);
  }

  /** Confirmation refusals still inside their window; expired ones are dropped so the layer is
   *  re-checked (the layer below may have been merged through a path that never clears this map). */
  private freshStackConfirmHolds(repoPath: string): ReadonlySet<string> {
    const held = this.stackConfirmHeld.get(repoPath);
    if (!held) return EMPTY_SESSION_SET;
    for (const [id, at] of held) {
      if (this.now() - at >= EPIC_STACK_COMPOSE_TTL_MS) held.delete(id);
    }
    if (held.size === 0) {
      this.stackConfirmHeld.delete(repoPath);
      return EMPTY_SESSION_SET;
    }
    return new Set(held.keys());
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
    // deleteBranch removes the child's MERGED head (task) branch on origin — standard post-merge
    // hygiene. It is the PR's head, never the integration branch (the base), so the accumulating
    // integration branch is untouched. #2069 carves out ONE case: a stacked successor is BASED on
    // that head, and deleting it makes the successor's `gh pr create --base <branch>` fail outright
    // (GitHub closes an already-open PR whose base ref disappears). `mergeStacked` ignores
    // deleteBranch for the same reason; this is the legacy path's equivalent.
    // #2070: a stacked layer may only be landed when it is the bottom-most unmerged one. Asked
    // FIRST so a held layer does no other work at all.
    const stacked = await this.stackedMergeAllowed(forge, repoPath, parent, s, decision);
    if (stacked === null) return; // held — a layer below has not landed; next tick re-checks.
    const keepBranch = await this.keepBranchForStackedSuccessor(repoPath, parent, s.issueNumber!);
    try {
      await forge.merge(decision.prNumber, {
        method: "squash",
        deleteBranch: !keepBranch,
        ...(stacked ? { allowStacked: true } : {}),
      });
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
      // #645 (b): the branch this child actually squash-merged into. A stacked layer lands on its
      // STACK'S TRUNK — the pinned epic branch — not on `s.baseBranch`, which for any layer above
      // the bottom is its predecessor's head branch. Recording the session base there would make
      // divergenceWarnings (b) claim, permanently and falsely, that the child merged into a sibling.
      stacked
        ? this.deps.store.getEpicIntegrationBranch(repoPath, parent) || s.baseBranch
        : s.baseBranch,
    );
    // The answer to every other layer's gate just changed.
    this.stackConfirmHeld.delete(repoPath);
    try {
      await this.deps.service.archive(decision.sessionId, undefined, "drain");
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
    this.retainArchivedClaim(decision.sessionId);
  }

  private retainArchivedClaim(sessionId: string): void {
    this.retainClaimOnArchive.add(sessionId);
    this.deps.dropPrCache(sessionId);
    this.deps.emitArchived(sessionId);
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
    // open until the final epic→default PR lands). Detected by the session's persisted epic-child
    // identity (#2067) + an active epic for the repo.
    const epicRun = this.deps.store.getEpicRun(repoPath);
    const epicActive = !!epicRun && (epicRun.status === "running" || epicRun.status === "paused");
    if (epicActive && s?.issueNumber != null && isEpicChild(s)) {
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
      await this.deps.service.archive(decision.sessionId, undefined, "drain");
    } catch (err) {
      console.warn(`[drain] archive failed for ${decision.sessionId}:`, err);
      return;
    }
    // The PR is left OPEN for a human to merge, so the issue stays open and claimed.
    // Mark the archive as a retire so onArchived KEEPS the claim — releasing it here
    // would let another instance re-spawn an issue that already has a ready PR. The
    // human merge auto-closes the issue (`Closes #N`), retiring the claim with it.
    // Set before emitArchived so a synchronous onArchived sees it.
    this.retainArchivedClaim(decision.sessionId);
  }

  /**
   * Resolve the base branch + agent prompt for a spawn. Epic children base on (and ensure on
   * the host) the integration branch — so each builds on its predecessors' merged work — and
   * get a directive to target it as their PR base; a non-epic spawn bases on the default branch
   * with the bare task title.
   *
   * The two epic failure modes are NOT the same and are handled differently (#1757):
   *
   *  - `ensureBranch` THREW (GitHub; a rate-limit, 5xx, race): FAIL CLOSED — throw
   *    {@link EpicBaseUnavailableError}. Degrading this ONE child onto the default branch would mix
   *    bases mid-epic: it would lose `epicBaseDirective`, open its PR against main, and — since a
   *    degraded child gets NO `epicParent` stamp, so `isFullAuto` does not exclude it — the merge
   *    train would then land it on main automatically, while its siblings integrate on the epic
   *    branch. A retry may well succeed, so doSpawn's catch backs off (cooldown) and the drain holds
   *    visibly (`epic_base_unavailable`) meanwhile.
   *
   *  - The forge simply LACKS `ensureBranch` (gitea/local): DEGRADE, as before. On such a forge NO
   *    child can ever get an integration branch, so the epic degrades CONSISTENTLY — every child
   *    bases on the default branch, lands on main one at a time, and the epic still progresses (a
   *    merged child closes its issue, and epic done-ness is `integrationMerged || issueClosed`).
   *    Failing closed here would convert a degraded-but-progressing epic into permanent zero
   *    progress with no operator path out. Instead the degrade is surfaced as an epic WARNING
   *    (assembleEpic → EpicPanel), so it is visible rather than a server-side console.warn.
   */
  private async resolveSpawnBase(
    forge: GitForge,
    decision: Extract<DrainDecision, { kind: "spawn" }>,
  ): Promise<{ base: string; prompt: string; epicParent: number | null }> {
    const { number, title } = decision.issue;
    // #2069: a STACKED child bases on its chain predecessor's live PR head. `ensureBranch` is
    // deliberately NOT called: the branch already exists (an open PR implies it was pushed), and
    // "ensuring" it would create it at the default branch's tip if it had since been deleted —
    // silently basing the child on an EMPTY predecessor. It is still an epic child, so the
    // `epicParent` stamp is kept: it must stay off the merge train and retire into the epic.
    if (decision.stackedBase && decision.integrationBranch) {
      return {
        base: decision.stackedBase,
        prompt: `${issueSpawnPrompt(number, title)}\n\n${epicStackedBaseDirective(
          decision.stackedBase,
          decision.integrationBranch,
        )}`,
        epicParent: decision.epicParent ?? null,
      };
    }
    const def = await forge.defaultBranch();
    let base = def;
    if (decision.integrationBranch && forge.ensureBranch) {
      try {
        await forge.ensureBranch(decision.integrationBranch, def);
        base = decision.integrationBranch;
      } catch (err) {
        // Fail closed — see the doc comment. Never silently base an epic child on the default
        // branch when the forge CAN create branches: that child would land on main mid-epic.
        throw new EpicBaseUnavailableError(decision.integrationBranch, err);
      }
    } else if (decision.integrationBranch) {
      console.warn(
        `[drain] forge lacks ensureBranch; basing epic child #${number} on ${def} (epic runs without an integration branch — see the epic warning)`,
      );
    }
    // Epic child actually based on the integration branch → tell the agent to target it as the
    // PR base (the agent opens its own PR and would otherwise default to the main branch).
    // The directive rides AFTER the templated title so a `/`-leading title can't reach argv
    // position 0 and be parsed as a slash command (issueSpawnPrompt).
    const usingEpicBase = !!decision.integrationBranch && base === decision.integrationBranch;
    const task = issueSpawnPrompt(number, title);
    const prompt = usingEpicBase ? `${task}\n\n${epicBaseDirective(base)}` : task;
    // Stamp epic-child identity (#2067) ONLY for a child that actually got the integration branch.
    // A DEGRADED child (forge without `ensureBranch`) bases on the default branch and behaves like
    // any ordinary session — the merge train carries it and it retires normally — so stamping it
    // would silently reroute every gitea/local epic through the squash-into-integration path.
    const epicParent = usingEpicBase ? (decision.epicParent ?? null) : null;
    return { base, prompt, epicParent };
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
      if (this.now() - lastFail.at < SPAWN_FAIL_COOLDOWN_MS) {
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
      const { base, prompt, epicParent } = await this.resolveSpawnBase(forge, decision);
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
        model: this.resolvedSpawnModel(decision, rc.defaultModel),
        effort: epicSettings
          ? epicSettings.effort
          : drainSpawnEffort(resolveDefaultEffortSetting(rc.defaultEffort, config.defaultEffort)),
        images: [],
        auto: true,
        issueRef: { number, url, title, body },
        epicParent, // persisted epic-child identity; null for a label-drain or degraded spawn
      });
      this.spawnFailures.delete(failKey); // #790: clear any prior failure cooldown on success
      // The new auto session appears in the next buildState → counts toward the
      // cap AND mappedIssueNumbers, so the loop won't re-spawn this issue and
      // naturally stops at cap.
    } catch (err) {
      this.recordSpawnFailure(failKey, err);
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
      archive: (sid, reason) => this.deps.service.archive(sid, undefined, reason),
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
      // #1664: pre-warm the epic landing PR as an early draft (opt-in). Placed AFTER reconcile so a
      // child integrated earlier this tick is already in listEpicIntegratedDetails. Flag-gated +
      // running-only + GitHub-only; ~1 prStatus/tick per running flagged epic while the draft is
      // open (NOT zero — unlike the completed-row passes). UNGATED by drain, like its neighbors.
      // #2069: link child PRs into the epic's stack. Placed AFTER reconcile (so a child integrated
      // earlier this tick is already out of the live set) and BEFORE the pump, so a stack composed
      // now is visible to this tick's spawn decisions. Flag-gated + running-only + throttled →
      // zero forge calls in steady state; self-guarding like its neighbours.
      await this.composeEpicStacksForRepo(repoPath);
      await this.ensureDraftLandingPrForRepo(repoPath);
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
