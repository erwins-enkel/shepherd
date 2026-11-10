import type { EpicChild } from "./epic-core";
import type { ChecksState, ForgeKind, PrStatus } from "./forge/types";
import type { Session } from "./types";
import { checksCleared, noCiMergeHeld, repoHasNoCiCached } from "./checks-gate";
import type { RepoConfig, SessionStore } from "./store";

export interface CompletedEpicChild {
  number: number;
  title: string;
  url: string;
  prNumber: number | null;
  prUrl: string | null;
  mergedAt: number | null;
  integrated: boolean;
}

/** Landing-PR lifecycle state — pending=not yet resolved, open=PR opened/reused,
 *  merged=landing PR has merged (epic landed; band about to be dismissed on parent close),
 *  none=nothing to land / human-closed, error=last open attempt failed/retrying. */
export type EpicLandingState = "pending" | "open" | "merged" | "none" | "error";

/** #3838: how an epic's run ended. `landed` = its landing PR merged; `incremental` = every child
 *  merged on its own (no landing PR); `closed-unlanded` = its parent closed before anything landed. */
export type EpicOutcome = "landed" | "incremental" | "closed-unlanded";

/** #3838: the outcomes that count as success — such a row stays in the band until the operator
 *  acknowledges it. */
export function isSucceededOutcome(o: EpicOutcome | null | undefined): boolean {
  return o === "landed" || o === "incremental";
}

export interface CompletedEpic {
  repoPath: string;
  parentIssueNumber: number;
  parentTitle: string;
  completedAt: number;
  children: CompletedEpicChild[];
  /** Pinned integration branch; absent on older payloads, null when no branch was recorded. */
  integrationBranch?: string | null;
  // Stage B (#635) landing-PR carried on the band; null/'pending' until the aggregate PR opens.
  landingPrNumber: number | null;
  landingPrUrl: string | null;
  landingState: EpicLandingState;
  // Migration-awareness checkpoint (#645): migration file paths detected in the landing PR
  // (empty when none / detection unavailable) + the epoch the operator acknowledged them (null
  // until acknowledged). A non-empty `migrationPaths` with a null `migrationsAckedAt` gates the
  // band row's clear behind an explicit acknowledgement — NEVER the autonomous completion flip.
  migrationPaths: string[];
  migrationsAckedAt: number | null;
  // #1071: why the auto-rebase pass paused. null = not paused / rebase not yet attempted.
  // 'cap': cap exhausted; 'conflict': genuine conflict; 'driver': merge driver unavailable.
  landingRebasePauseReason: "cap" | "conflict" | "driver" | null;
  // Landing-repair session counters: lifetime count of repair sessions dispatched for this
  // landing, and the epic/<#> head SHA recorded at the last repair dispatch (null when none
  // dispatched yet).
  landingRepairCount: number;
  landingRepairHead: string | null;
  // #1841: lifetime count of conflict-rework sessions dispatched for this landing (auto cap 1;
  // the manual "Resolve conflicts" dispatch bypasses the cap). Independent of landingRepairCount.
  landingConflictReworkCount: number;
  /** #3838: how the epic ended; null while its landing is still open. Optional, like the two
   *  stamps below, so pre-existing fixtures stay valid. */
  outcome?: EpicOutcome | null;
  /** #3838: when it succeeded — its landing PR's merge, or an incremental epic's completion. */
  succeededAt?: number | null;
  /** #3838: when the operator explicitly confirmed the success; null until then. */
  acknowledgedAt?: number | null;
  /** #1841: when the current conflict pause began (null outside a conflict pause). Optional so
   *  pre-existing fixtures/backfills stay valid. */
  landingConflictSince?: number | null;
  /** Live, non-persisted (#1841): a conflict pause has stood past EPIC_LANDING_STRANDED_MS with no
   *  live repair/rework session on the branch — the stale-conflict escalation chip. */
  landingConflictStranded?: boolean;
  /** Live (#2858): when the current conflict pause turns stale (`landingConflictSince` +
   *  EPIC_LANDING_STRANDED_MS); null outside a pause or while a live repair session works it. */
  landingConflictStrandedAt?: number | null;
  /** Live, non-persisted landing-PR gate signals (present only when the landing PR could be fetched). */
  landingChecks?: ChecksState;
  landingMergeable?: boolean | null;
  /** True when the landing PR is safe to merge from the app (gates the "Land epic" CTA). */
  landingReady?: boolean;
  /** Live, non-persisted (#3104): the landing PR is ready, auto-merge is on, but auto-land holds
   *  it because the repo has no CI and the operator has not opted in to `mergeWithoutCi`. */
  landingNoCiHold?: boolean;
  /** True when an open+ready landing has sat unlanded past EPIC_LANDING_STRANDED_MS (Rec D escalation). */
  landingStranded?: boolean;
  /** Live (#2858): when an open+ready landing turns stranded (`completedAt` +
   *  EPIC_LANDING_STRANDED_MS); null while not ready. Clients compare it with their own clock. */
  landingStrandedAt?: number | null;
  /** Live, non-persisted: the landing PR's CI is terminally failing (not behind/conflicting). */
  landingCiFailing?: boolean;
  /** Live, non-persisted: a genuinely-live landingRepair session currently holds this landing's
   *  integration branch, driving a fix — a CI repair (red PR) or a conflict rework (#1841,
   *  conflicting PR). Non-actionable — suppresses `landingCiFailing` while true
   *  (a stuck/finished session falls back to `landingCiFailing`, the backstop). */
  landingRepairing?: boolean;
  /** Live, non-persisted (#2872): the landing PR's per-check breakdown — red checks with their log
   *  URL plus the running/green counts. Absent when the forge reports no per-check detail. */
  landingCiChecks?: LandingCiChecks;
  /** Live, non-persisted (#2872): where Shepherd's automatic handling of a red landing PR stands —
   *  the rerun and agent-repair stages the landing card's "who's handling it" bar shows. */
  landingCiAutomation?: LandingCiAutomation;
}

/** #2872: the per-check breakdown of a landing PR's head commit. */
export interface LandingCiChecks {
  failed: { name: string; url: string | null }[];
  running: number;
  passed: number;
}

/** #2872: one automatic stage on a red landing PR. `done` = budget spent (still red); `running` = in
 *  flight now; `pending` = the drain will still act; `skipped` = it will not, for `skipReason`. */
export type LandingStageStatus = "done" | "running" | "pending" | "skipped";

/** #2872: the two automatic stages of a red landing PR, mirroring the drain's gates
 *  (rerunRedLandingCiForRepo → processRedLandingRerun → maybeDispatchLandingRepair). */
export interface LandingCiAutomation {
  reruns: {
    status: LandingStageStatus;
    used: number;
    cap: number;
    skipReason: "no-github" | "draft-mode" | "not-engaged" | "draft-pr" | "no-run" | null;
  };
  repair: {
    status: LandingStageStatus;
    used: number;
    cap: number;
    skipReason: "no-github" | "draft-mode" | "draft-pr" | "auto-drain-off" | null;
    /** The live repair session, else the last recorded one while it is still visible. */
    sessionId: string | null;
    /** When the live repair session started (null when none is live). */
    sessionStartedAt: number | null;
  };
}

/** #2872: the persisted landing-automation counters enrichment reads off the DB row. Internal — the
 *  GET route strips them from the response once folded into `landingCiAutomation`. */
export interface LandingAutomationRow {
  landingRerunHead: string | null;
  landingRerunCount: number;
  landingRerunUnavailable: boolean;
  landingRepairSessionId: string | null;
}

/** Rec D threshold: surface the "stranded" escalation when an open+ready landing PR has sat
 *  unlanded this long after epic completion.
 *
 *  Documented deviation: the issue says "landing PR mergeable for > N hours"; we approximate with
 *  "epic completed > N h ago AND landing PR currently ready" to avoid persisting a `mergeableSince`
 *  column. A PR that becomes ready long after the epic completed would fire earlier than intended,
 *  but this is conservative (earlier escalation) and avoids a schema change. */
export const EPIC_LANDING_STRANDED_MS = 6 * 60 * 60_000;

/** Returns true when the landing PR is safe to merge from the app (gates the "Land epic" CTA).
 *
 *  Requires: open, checks passing, and mergeable=true. When mergeStateStatus is present (GitHub),
 *  it must be "clean" or "has_hooks" — all other statuses indicate a PR that is not ready:
 *  - "blocked": branch-protection rules are blocking the merge; the app-triggered merge would fail,
 *    so we must NOT show an enabled CTA that fires a doomed merge call.
 *  - "behind", "dirty", "unstable", "draft", "unknown": also not mergeable.
 *  When mergeStateStatus is undefined (Gitea), we fall back to state+checks+mergeable alone.
 *  `noCi` (GitHub repo with no PR-triggered workflow) lets a terminal checks:"none" count as cleared — a
 *  no-CI repo's landing PR is still mergeable (mergeStateStatus stays the authoritative gate). */
export function computeLandingReady(
  pr: Pick<PrStatus, "state" | "checks" | "mergeable" | "mergeStateStatus">,
  noCi = false,
): boolean {
  if (pr.state !== "open") return false;
  if (!checksCleared(pr.checks, noCi)) return false;
  if (pr.mergeable !== true) return false;
  if (pr.mergeStateStatus === undefined) return true; // Gitea fallback
  return pr.mergeStateStatus === "clean" || pr.mergeStateStatus === "has_hooks";
}

/** Returns true when the landing PR is open, ready, and the epic completed over
 *  EPIC_LANDING_STRANDED_MS ago (the Rec D escalation threshold). */
export function computeLandingStranded(opts: {
  landingState: EpicLandingState;
  landingReady: boolean;
  completedAt: number;
  now: number;
}): boolean {
  return (
    opts.landingState === "open" &&
    opts.landingReady &&
    opts.now - opts.completedAt > EPIC_LANDING_STRANDED_MS
  );
}

/** #1841: true when a conflict pause has stood unresolved past EPIC_LANDING_STRANDED_MS and no live
 *  repair/rework session is working it — the conflict counterpart of {@link computeLandingStranded}
 *  (which needs landingReady, so it can never fire for a conflicting PR). */
export function computeLandingConflictStranded(opts: {
  pauseReason: CompletedEpic["landingRebasePauseReason"];
  conflictSince: number | null | undefined;
  repairing: boolean;
  now: number;
}): boolean {
  return (
    opts.pauseReason === "conflict" &&
    opts.conflictSince != null &&
    !opts.repairing &&
    opts.now - opts.conflictSince > EPIC_LANDING_STRANDED_MS
  );
}

/** Per-head-SHA budget of automatic failed-CI reruns for a red epic landing PR before the drain
 *  escalates to the agent repair. A new head resets the budget. Persisted on the row (#2872:
 *  `landingRerunHead`/`landingRerunCount`), so a restart does not re-spend it. */
export const LANDING_RERUN_CAP = 2;

/** One lifetime AUTO agent-repair attempt per epic landing PR (durable via `landingRepairCount`).
 *  Once the rerun budget is spent and CI is still terminally red, the drain dispatches a single
 *  capped repair session that pushes directly to the pinned integration branch. Exhausted ⇒ the
 *  operator-facing `landingCiFailing` surface. The operator's manual repair (#2872) bypasses it. */
export const LANDING_REPAIR_CAP = 1;

/** How long a repair session may hold the landing branch (fence + surface suppression) before it is
 *  treated as stuck and the operator-facing landingCiFailing surface returns. Bounds a hung session. */
export const REPAIR_ACTIVE_TTL_MS = 45 * 60 * 1000;

/** True while an epic-landing repair session is GENUINELY working the branch: pushing its fix and
 *  holding the rebase/land fence. Deliberately excludes blocked/paused/completed/terminal sessions and
 *  any session past REPAIR_ACTIVE_TTL_MS, so a stuck session releases the fence and reveals
 *  landingCiFailing (the backstop) instead of pinning the branch forever. */
export function isLiveRepairSession(s: Session, now: number): boolean {
  return (
    s.landingRepair &&
    (s.status === "running" || s.status === "idle") &&
    !s.autopilotComplete &&
    !s.autopilotPaused &&
    now - s.createdAt < REPAIR_ACTIVE_TTL_MS
  );
}

/** The genuinely-live repair session holding `integrationBranch` for `repoPath`, or null. Single
 *  source of truth for the fence/surface predicate so the drain pass and GET /api/epics/completed
 *  can't drift. */
function findLiveRepairSession(
  sessions: Session[],
  repoPath: string,
  integrationBranch: string,
  now: number,
): Session | null {
  return (
    sessions.find(
      (s) =>
        s.repoPath === repoPath &&
        s.baseBranch === integrationBranch &&
        isLiveRepairSession(s, now),
    ) ?? null
  );
}

/** Whether any session in `sessions` is a genuinely-live repair session holding `integrationBranch`
 *  for `repoPath` (see {@link findLiveRepairSession}). */
export function anyLiveRepairSession(
  sessions: Session[],
  repoPath: string,
  integrationBranch: string,
  now: number,
): boolean {
  return findLiveRepairSession(sessions, repoPath, integrationBranch, now) !== null;
}

/** #2872: the per-check breakdown of a landing PR, or undefined when the forge reports none. */
export function landingCiChecksOf(pr: Pick<PrStatus, "jobs">): LandingCiChecks | undefined {
  if (!pr.jobs) return undefined;
  return {
    failed: pr.jobs
      .filter((j) => j.state === "failure")
      .map((j) => ({ name: j.name, url: j.url ?? null })),
    running: pr.jobs.filter((j) => j.state === "pending").length,
    passed: pr.jobs.filter((j) => j.state === "success").length,
  };
}

/** The repo-level inputs of the drain's landing-automation gates (#2872), plus the session lookups
 *  the repair stage needs. */
export interface LandingAutomationContext {
  draftMode: boolean;
  autoMergeEnabled: boolean;
  autoDrainEnabled: boolean;
  /** The repo's epic run is `running` (it engages the rerun pass like the two toggles). */
  epicRunning: boolean;
  /** The genuinely-live repair session on the integration branch, if any. */
  liveRepair: Pick<Session, "id" | "createdAt"> | null;
  /** Whether a recorded session id still names a visible (non-archived) session. */
  sessionVisible: (id: string) => boolean;
}

type DeriveAutomationInput = {
  pr: Pick<PrStatus, "checks" | "headSha" | "isDraft">;
  github: boolean;
  ctx: LandingAutomationContext;
  row: LandingAutomationRow & { landingRepairCount: number };
};
type RerunSkip = LandingCiAutomation["reruns"]["skipReason"];
type RepairSkip = LandingCiAutomation["repair"]["skipReason"];

/** Why the drain's red-landing pass (rerunRedLandingCiForRepo → processRedLandingRerun) never
 *  reaches either stage — the repair inherits these, except `not-engaged` (implies auto-drain off). */
function landingPassSkip(o: DeriveAutomationInput): Exclude<RerunSkip, "no-run"> {
  const { ctx } = o;
  if (!o.github) return "no-github";
  if (ctx.draftMode) return "draft-mode";
  if (!(ctx.autoMergeEnabled || ctx.autoDrainEnabled || ctx.epicRunning)) return "not-engaged";
  return o.pr.isDraft ? "draft-pr" : null;
}

function rerunStage(o: DeriveAutomationInput, passSkip: RerunSkip): LandingCiAutomation["reruns"] {
  const { pr, row } = o;
  const sameHead = row.landingRerunHead === (pr.headSha ?? "");
  const used = sameHead ? row.landingRerunCount : 0;
  const skipReason = passSkip ?? (sameHead && row.landingRerunUnavailable ? "no-run" : null);
  let status: LandingStageStatus = "pending";
  if (skipReason) status = "skipped";
  else if (pr.checks === "pending" && used > 0) status = "running";
  else if (used >= LANDING_RERUN_CAP) status = "done";
  return { status, used, cap: LANDING_RERUN_CAP, skipReason };
}

function repairStage(o: DeriveAutomationInput, passSkip: RerunSkip): LandingCiAutomation["repair"] {
  const { ctx, row } = o;
  // `not-engaged` implies auto-drain off; `no-run` escalates to the repair (not a repair skip).
  const skip: RepairSkip =
    passSkip && passSkip !== "not-engaged" && passSkip !== "no-run"
      ? passSkip
      : ctx.autoDrainEnabled
        ? null
        : "auto-drain-off";
  let status: LandingStageStatus = "pending";
  if (ctx.liveRepair) status = "running";
  else if (row.landingRepairCount >= LANDING_REPAIR_CAP) status = "done";
  else if (skip) status = "skipped";
  const recorded = row.landingRepairSessionId;
  return {
    status,
    used: row.landingRepairCount,
    cap: LANDING_REPAIR_CAP,
    skipReason: status === "skipped" ? skip : null,
    sessionId: ctx.liveRepair?.id ?? (recorded && ctx.sessionVisible(recorded) ? recorded : null),
    sessionStartedAt: ctx.liveRepair?.createdAt ?? null,
  };
}

/** #2872: where the drain's automatic handling of a red landing PR stands. Mirrors the gates of
 *  rerunRedLandingCiForRepo / processRedLandingRerun / maybeDispatchLandingRepair — when one of those
 *  moves, this moves. Pure. */
export function deriveLandingCiAutomation(o: DeriveAutomationInput): LandingCiAutomation {
  const passSkip = landingPassSkip(o);
  return { reruns: rerunStage(o, passSkip), repair: repairStage(o, passSkip) };
}

/** #2872: true while an automatic stage is still pending or in flight — the operator's turn waits. */
function automationStillActing(a: LandingCiAutomation): boolean {
  return [a.reruns.status, a.repair.status].some((s) => s === "pending" || s === "running");
}

/** Accessors enrichLandingEpics needs, injected so this module stays forge-light (a structural
 *  forge shape, not the full GitForge type). `resolveForge` returns null when the repo has no forge. */
export interface EnrichLandingDeps {
  getEpicIntegrationBranch: (repoPath: string, parentIssueNumber: number) => string | null;
  resolveForge: (
    repoPath: string,
  ) => { kind: ForgeKind; prStatus: (headBranch: string) => Promise<PrStatus> } | null | undefined;
  /** Whether a genuinely-live repair session currently holds this epic's integration branch.
   *  Callers build it via anyLiveRepairSession(store.list(), repoPath, integrationBranch, now). */
  hasLiveRepairSession: (repoPath: string, integrationBranch: string) => boolean;
  /** Read the landing PR's state. Absent ⇒ a fresh `forge.prStatus(branch)` per row; the GET
   *  route passes a snapshot-first, shared-TTL read so polling tabs don't multiply calls. */
  prStatus?: (repoPath: string, branch: string) => Promise<PrStatus>;
  /** #2872: the inputs of the drain's landing-automation gates. Absent ⇒ no `landingCiAutomation`,
   *  and `landingCiFailing` is not held back for pending automatic stages. */
  automation?: (repoPath: string, integrationBranch: string) => LandingAutomationContext;
  /** #3104: the repo's merge settings. Absent ⇒ no `landingNoCiHold`. */
  repoConfig?: (
    repoPath: string,
  ) => Pick<RepoConfig, "draftMode" | "autoMergeEnabled" | "mergeWithoutCi">;
  now: number;
}

/** #3104: whether drain auto-land is holding this ready landing PR for want of CI. Mirrors
 *  autoLandLandingPrsForRepo's opt-in (`draftMode ? false : autoMergeEnabled`) — with auto-merge
 *  off nothing auto-lands, so there is no hold to report. */
export function computeLandingNoCiHold(
  pr: Pick<PrStatus, "checks">,
  landingReady: boolean,
  noCi: boolean,
  cfg: Pick<RepoConfig, "draftMode" | "autoMergeEnabled" | "mergeWithoutCi">,
): boolean {
  const autoLandOn = cfg.draftMode ? false : cfg.autoMergeEnabled;
  return landingReady && autoLandOn && noCiMergeHeld(pr.checks, noCi, cfg.mergeWithoutCi);
}

/** #2872: the automation stages of one enriched row, or undefined without the `automation` dep. */
function rowAutomation(
  row: CompletedEpic & Partial<LandingAutomationRow>,
  pr: PrStatus,
  forgeKind: ForgeKind,
  branch: string,
  deps: Pick<EnrichLandingDeps, "automation">,
): LandingCiAutomation | undefined {
  if (!deps.automation) return undefined;
  return deriveLandingCiAutomation({
    pr,
    github: forgeKind === "github",
    ctx: deps.automation(row.repoPath, branch),
    row: {
      landingRerunHead: row.landingRerunHead ?? null,
      landingRerunCount: row.landingRerunCount ?? 0,
      landingRerunUnavailable: row.landingRerunUnavailable ?? false,
      landingRepairSessionId: row.landingRepairSessionId ?? null,
      landingRepairCount: row.landingRepairCount,
    },
  });
}

/** The live, non-persisted landing-gate fields enrichment adds to a row. */
type LandingGate = Pick<
  CompletedEpic,
  | "landingChecks"
  | "landingMergeable"
  | "landingReady"
  | "landingNoCiHold"
  | "landingStranded"
  | "landingStrandedAt"
  | "landingCiFailing"
  | "landingRepairing"
  | "landingCiChecks"
  | "landingCiAutomation"
  | "landingConflictStranded"
  | "landingConflictStrandedAt"
>;

/** Every {@link LandingGate} key — what {@link overlayPushedGate} copies. */
const LANDING_GATE_KEYS = [
  "landingChecks",
  "landingMergeable",
  "landingReady",
  "landingNoCiHold",
  "landingStranded",
  "landingStrandedAt",
  "landingCiFailing",
  "landingRepairing",
  "landingCiChecks",
  "landingCiAutomation",
  "landingConflictStranded",
  "landingConflictStrandedAt",
] as const satisfies readonly (keyof LandingGate)[];

/** #2858: give an open row the gate the drain last pushed for it, so a GET seeds clients with the
 *  very state later pushes build on (a fresher read here could disagree, and nothing would correct
 *  it until the next change). Applies only to the same landing PR; the time-derived booleans are
 *  re-evaluated at `now`. Returns whether it applied. */
export function overlayPushedGate(
  row: CompletedEpic,
  pushed: CompletedEpic | null | undefined,
  now: number,
): boolean {
  if (!pushed || row.landingState !== "open" || pushed.landingPrNumber !== row.landingPrNumber)
    return false;
  const target = row as unknown as Record<string, unknown>;
  for (const k of LANDING_GATE_KEYS) target[k] = pushed[k];
  row.landingStranded = row.landingStrandedAt != null && now > row.landingStrandedAt;
  row.landingConflictStranded =
    row.landingConflictStrandedAt != null && now > row.landingConflictStrandedAt;
  return true;
}

/** When an open+ready landing turns stranded (#2858): clients compare it with their own clock. */
function strandedAt(row: CompletedEpic, landingReady: boolean): number | null {
  return landingReady ? row.completedAt + EPIC_LANDING_STRANDED_MS : null;
}

/** When a conflict pause turns stale (#2858) — null outside a pause or while a repair works it. */
function conflictStrandedAt(row: CompletedEpic, live: boolean): number | null {
  return row.landingRebasePauseReason === "conflict" && row.landingConflictSince != null && !live
    ? row.landingConflictSince + EPIC_LANDING_STRANDED_MS
    : null;
}

/** The live landing-gate fields of one OPEN-landing row, given its landing PR's state. Pure apart
 *  from the injected lookups; shared by GET /api/epics/completed and the drain's landing-gate
 *  observation (#2858) so the two can't drift. */
function deriveLandingGate(
  row: CompletedEpic & Partial<LandingAutomationRow>,
  pr: PrStatus,
  forgeKind: ForgeKind,
  branch: string,
  deps: Omit<EnrichLandingDeps, "getEpicIntegrationBranch" | "resolveForge" | "prStatus">,
): LandingGate {
  const noCi = repoHasNoCiCached(forgeKind, row.repoPath);
  const landingReady = computeLandingReady(pr, noCi);
  // A terminally-failing landing PR that is NOT behind/conflicting (those are owned by the
  // rebase pass's landingRebasePauseReason). Surfaced as a distinct Tier-1 item (index.ts) —
  // UNLESS a genuinely-live repair session is already holding the branch and fixing it, in
  // which case the non-actionable landingRepairing surface takes over instead.
  // #1841: a CONFLICTING landing PR held by a live repair session is a conflict rework in
  // flight — same non-actionable landingRepairing surface (the card shows the chip, not the
  // "Resolve conflicts" CTA). landingCiFailing stays false for it (conflict-owned).
  const red = pr.checks === "failure" && pr.mergeStateStatus !== "behind" && pr.mergeable !== false;
  const conflicting = pr.mergeable === false;
  // One live-session probe serves both the repairing surface and the #1841 stale-conflict chip.
  const conflictPaused = row.landingRebasePauseReason === "conflict";
  const live =
    (red || conflicting || conflictPaused) && deps.hasLiveRepairSession(row.repoPath, branch);
  const repairing = (red || conflicting) && live;
  const automation = rowAutomation(row, pr, forgeKind, branch, deps);
  const gate: LandingGate = {
    landingChecks: pr.checks,
    landingMergeable: pr.mergeable ?? null,
    landingReady,
    landingStranded: computeLandingStranded({
      landingState: "open",
      landingReady,
      completedAt: row.completedAt,
      now: deps.now,
    }),
    landingStrandedAt: strandedAt(row, landingReady),
    landingRepairing: repairing,
    landingCiChecks: landingCiChecksOf(pr),
    landingCiAutomation: automation,
    // #2872: "your turn" only once no automatic stage is still pending or in flight.
    landingCiFailing: red && !repairing && !(automation && automationStillActing(automation)),
    landingConflictStranded: computeLandingConflictStranded({
      pauseReason: row.landingRebasePauseReason,
      conflictSince: row.landingConflictSince,
      repairing: live,
      now: deps.now,
    }),
    landingConflictStrandedAt: conflictStrandedAt(row, live),
  };
  if (deps.repoConfig)
    gate.landingNoCiHold = computeLandingNoCiHold(
      pr,
      landingReady,
      noCi,
      deps.repoConfig(row.repoPath),
    );
  return gate;
}

/** Enrich each OPEN-landing completed epic in `rows` with live landing-PR gate signals
 *  ({@link LandingGate}), mutating in place.
 *  Best-effort + fail-safe per row: a missing branch/forge or a forge error simply leaves that
 *  row's live fields undefined — never throws. Used by GET /api/epics/completed and the drain's
 *  landing-gate observation. */
export async function enrichLandingEpics(
  rows: Array<CompletedEpic & Partial<LandingAutomationRow>>,
  deps: EnrichLandingDeps,
): Promise<void> {
  await Promise.all(
    rows.map(async (row) => {
      if (row.landingState !== "open") return;
      const branch = deps.getEpicIntegrationBranch(row.repoPath, row.parentIssueNumber);
      if (branch === null) return;
      const forge = deps.resolveForge(row.repoPath);
      if (!forge) return;
      try {
        const pr = deps.prStatus
          ? await deps.prStatus(row.repoPath, branch)
          : await forge.prStatus(branch);
        Object.assign(row, deriveLandingGate(row, pr, forge.kind, branch, deps));
      } catch {
        // leave live fields undefined — callers always serve/return the base DB rows
      }
    }),
  );
}

/** The store reads {@link completedEpicRows} and {@link landingAutomationContext} need. */
export type CompletedEpicStore = Pick<
  SessionStore,
  "listEpicCompleted" | "getEpicIntegrationBranch" | "getRepoConfig" | "getEpicRun" | "list" | "get"
>;

/** A band row as the API serves it, still carrying the internal automation counters enrichment
 *  reads; {@link publicCompletedEpic} strips them before the row leaves the server. */
export type CompletedEpicRow = CompletedEpic & LandingAutomationRow;

/** The non-dismissed completed epics (optionally one repo's), mapped from DB rows to band rows:
 *  internal counters dropped, children parsed, integration branch attached. */
export function completedEpicRows(
  store: Pick<CompletedEpicStore, "listEpicCompleted" | "getEpicIntegrationBranch">,
  repoPath?: string,
): CompletedEpicRow[] {
  return store.listEpicCompleted(repoPath).map((row) => toCompletedEpicRow(store, row));
}

/** #3838: every epic whose run ended — succeeded (acknowledged or not) or closed without landing —
 *  mapped like {@link completedEpicRows}, newest first. Dismissal does not hide a row here. */
export function epicHistoryRows(
  store: Pick<SessionStore, "listEpicHistory" | "getEpicIntegrationBranch">,
  repoPath?: string,
): CompletedEpicRow[] {
  return store.listEpicHistory(repoPath).map((row) => toCompletedEpicRow(store, row));
}

function toCompletedEpicRow(
  store: Pick<CompletedEpicStore, "getEpicIntegrationBranch">,
  row: ReturnType<SessionStore["listEpicCompleted"]>[number],
): CompletedEpicRow {
  // landingAttempts, landingRebaseCount, landingRebaseDriverMisses are internal counters,
  // not part of the CompletedEpic response. landingRebasePauseReason is API-facing and passes through.
  const {
    childrenJson,
    landingAttempts,
    landingRebaseCount,
    landingRebaseDriverMisses,
    landingConflictEscalatedAt,
    ...rest
  } = row;
  void landingAttempts;
  void landingRebaseCount;
  void landingRebaseDriverMisses;
  void landingConflictEscalatedAt;
  return {
    ...rest,
    integrationBranch: store.getEpicIntegrationBranch(row.repoPath, row.parentIssueNumber),
    children: JSON.parse(childrenJson) as CompletedEpic["children"],
  };
}

/** #2872: the raw automation counters are folded into landingCiAutomation — not part of the API. */
export function publicCompletedEpic(row: CompletedEpicRow): CompletedEpic {
  const {
    landingRerunHead,
    landingRerunCount,
    landingRerunUnavailable,
    landingRepairSessionId,
    ...rest
  } = row;
  void landingRerunHead;
  void landingRerunCount;
  void landingRerunUnavailable;
  void landingRepairSessionId;
  return rest;
}

/** #2872: the drain's landing-automation gate inputs for one repo + the session lookups the repair
 *  stage needs — fed to enrichLandingEpics so the card's stages mirror what the drain will do. */
function landingAutomationContext(
  store: Pick<CompletedEpicStore, "getRepoConfig" | "getEpicRun" | "list" | "get">,
  repoPath: string,
  integrationBranch: string,
  now: number,
): LandingAutomationContext {
  const cfg = store.getRepoConfig(repoPath);
  return {
    draftMode: cfg.draftMode,
    autoMergeEnabled: cfg.autoMergeEnabled,
    autoDrainEnabled: cfg.autoDrainEnabled,
    epicRunning: store.getEpicRun(repoPath)?.status === "running",
    liveRepair: findLiveRepairSession(store.list(), repoPath, integrationBranch, now),
    sessionVisible: (id) => {
      const s = store.get(id);
      return s !== null && s.status !== "archived";
    },
  };
}

/** The enrichment deps for `store`, reading each landing PR through `prStatus` — the GET's
 *  snapshot-first cache, or the drain's no-fetch view of reads it already made. */
export function storeEnrichDeps(
  store: CompletedEpicStore,
  resolveForge: EnrichLandingDeps["resolveForge"],
  prStatus: NonNullable<EnrichLandingDeps["prStatus"]>,
  now: number,
): EnrichLandingDeps {
  return {
    getEpicIntegrationBranch: (repoPath, parent) =>
      store.getEpicIntegrationBranch(repoPath, parent),
    resolveForge,
    hasLiveRepairSession: (repoPath, integrationBranch) =>
      anyLiveRepairSession(store.list(), repoPath, integrationBranch, now),
    prStatus,
    automation: (repoPath, integrationBranch) =>
      landingAutomationContext(store, repoPath, integrationBranch, now),
    repoConfig: (repoPath) => store.getRepoConfig(repoPath),
    now,
  };
}

/** #3838: an incremental epic's rollup — every child merged straight into the default branch, so
 *  each counts as included; its PR number when the drain knew it, no integration-merge facts. */
export function incrementalRollup(
  children: Pick<EpicChild, "number" | "title" | "url" | "prNumber">[],
): CompletedEpicChild[] {
  return children.map((c) => ({
    number: c.number,
    title: c.title,
    url: c.url,
    prNumber: c.prNumber,
    prUrl: null,
    mergedAt: null,
    integrated: true,
  }));
}

export function buildRollup(
  children: Pick<EpicChild, "number" | "title" | "url">[],
  details: {
    childNumber: number;
    prNumber: number | null;
    prUrl: string | null;
    mergedAt: number;
  }[],
): CompletedEpicChild[] {
  const detailMap = new Map(details.map((d) => [d.childNumber, d]));
  return children.map((child) => {
    const detail = detailMap.get(child.number);
    if (detail) {
      return {
        number: child.number,
        title: child.title,
        url: child.url,
        prNumber: detail.prNumber,
        prUrl: detail.prUrl,
        mergedAt: detail.mergedAt,
        integrated: true,
      };
    }
    return {
      number: child.number,
      title: child.title,
      url: child.url,
      prNumber: null,
      prUrl: null,
      mergedAt: null,
      integrated: false,
    };
  });
}
