import type { Issue, GitState } from "./forge/types";
import type { AgentProvider, SessionStatus, ReviewDecision } from "./types";
import { signedOff, type SignoffAuthority, type SignoffView } from "./signoff";
import { checksCleared } from "./checks-gate";
import { verdictStale } from "./verdict-freshness";
import type { EpicChild, EpicRun } from "./epic-core";

/** Issues carrying this label always jump to the head of the drain queue,
 *  alongside any configured per-repo priority labels. */
export const PRIORITY_LABEL = "shepherd:priority";

/** The drain stamps this label on an issue when it claims it (spawns an auto
 *  session) and keeps it through retire — a ready PR awaiting human merge is still
 *  "taken". The SAME label is also stamped when a human links an issue at task
 *  creation (via the create route) and released when that session is archived, so a
 *  manually-linked issue is claimed too. It is the ONLY cross-instance coordination
 *  point: a second shepherd draining the same forge filters claimed issues out (see
 *  {@link selectCandidates}), so neither a second shepherd NOR the local drain takes
 *  an already-claimed issue (auto or manually-linked), and a retired-but-unmerged
 *  issue is not re-spawned. A constant (not the per-repo `autoLabel`) so every
 *  instance agrees on it without sharing config. The window is narrowed, not
 *  eliminated — two instances listing within the claim's set-up latency can still
 *  race; local dedup then prevents a single instance double-spawning. Released only
 *  when the work is abandoned (manual archive, no merge); a human merge auto-closes
 *  the issue, retiring the claim with it. */
export const ACTIVE_LABEL = "shepherd:active";

/** Why the drain is holding rather than spawning/retiring — surfaced on `drain:status`. */
export interface HoldReason {
  code:
    | "disabled" // per-repo toggle off
    | "cap" // maxAuto auto-agents already running
    | "usage" // usage % at/over the repo's ceiling
    | "credits" // extra-credit (paid overage) spend over the account ceiling
    | "blocked" // an auto-agent is blocked (trouble pause)
    | "changes_requested" // an auto-agent's critic is blocking (trouble pause)
    | "error" // an auto-agent's critic verdict is an error (don't advance on uncertainty)
    | "awaiting_signoff" // draftMode: a retireable PR is held at cap, awaiting its sign-off
    | "awaiting_approval" // epicAttended: next spawn held until operator approves
    | "epic_base_unavailable" // epic: the forge's ensureBranch threw — can't base the child on the integration branch (#1757)
    | "epic_base_stale" // epic: integration branch behind the default branch too long — no spawn until it can rebase (#3101)
    | "epic_base_conflict" // epic: rebasing the integration branch onto the default branch conflicts (#3101)
    | "epic_predecessor_unlanded" // epic: another epic's landing PR is still open — don't cut from a stale default (#3101)
    | "bootstrap_incomplete" // repo in active project-bootstrap (#3105); detail = missing phases/must-haves
    | "epic_unreadable" // epic: the forge's open-issue listing failed (e.g. a rate limit) — no epic this round, retrying
    | "empty"; // no eligible backlog item
  /** A desig (trouble pauses) or a percentage (usage), for the operator banner. */
  detail?: string;
}

export interface EpicProviderSettings {
  agentProvider: AgentProvider;
  model: string | null;
  effort: string | null;
}

export type DrainDecision =
  | {
      kind: "spawn";
      issue: Issue;
      integrationBranch?: string;
      /** Epic parent issue number to stamp on the spawned session (#2067). Set from the same
       *  epic run as `integrationBranch`, so the two cannot drift; undefined for label-drain. */
      epicParent?: number;
      /** #2069: this epic child stacks on its chain predecessor — base it on THIS branch (the
       *  predecessor's live PR head) instead of `integrationBranch`, and do NOT ensure it on the
       *  forge. Set only when `epicStacksEnabled` and the forge exposes the stacked-PR surface. */
      stackedBase?: string;
      epicProviderSettings?: EpicProviderSettings;
      /** #3191: the incremental epic this child belongs to — stamped as
       *  `Session.incrementalEpicParent`, never as `epicParent` (the child bases on the default
       *  branch and lands on its own). Undefined for integration epics and label-drain. */
      incrementalEpicParent?: number;
    }
  | { kind: "retire"; sessionId: string; prNumber: number; headSha: string | null }
  | { kind: "hold"; reason: HoldReason };

/** The slice of an auto session the decision core reasons over. */
export interface AutoSessionView {
  id: string;
  desig: string;
  issueNumber: number | null;
  status: SessionStatus;
  /** Cached PR state from the pr-poller; null when unknown or merge in flight. */
  git: GitState | null;
  /** Latest critic verdict decision, or null when none/critic disabled. */
  reviewDecision: ReviewDecision | null;
  /** The head SHA the latest verdict applies to, or null when no verdict. */
  reviewHeadSha: string | null;
  /** The PR is a draft (not ready-for-review). false when unknown/no PR. */
  isDraft: boolean;
  /** A human submitted an APPROVED review on the PR (forge data). */
  humanApproved: boolean;
  /** The latest critic verdict's discrete findings ([] = clean / none). */
  findings: string[];
  /** Effective full-auto (autopilot ∧ auto-merge). When true the merge train lands this
   *  session, so the drain must NOT retire it (that would foreclose rebase recovery). When
   *  false the drain retires it normally — even in an auto-merge repo — so it can't sit
   *  un-retired-and-un-merged holding a maxAuto slot (which would deadlock the drain). */
  fullAuto: boolean;
  /** The epic parent issue number this session is a child of — the persisted stamp, or for a
   *  legacy unstamped row the number its `epic/<#>-…` base branch names; null for a non-epic
   *  session. Read only by {@link buildRunSummary}; no drain decision looks at it. */
  epicParent: number | null;
  /** A landing-repair session (CI repair / conflict rework on an epic's landing PR, #2973): it
   *  holds no agent slot — the cap and the run picture's slots leave it out — but retires and
   *  trips trouble holds like any other auto session. LANDING_REPAIR_CAP bounds them. */
  landingRepair: boolean;
  /** #3245: the session runs outside its ticket's target repo (`Session.misroutedTarget`). Never
   *  retired: the hand-off would keep the claim on a ticket whose code belongs elsewhere. */
  misrouted?: boolean;
  /** Operator-shelved: never retired (archived/merged) while shelved. */
  shelved?: boolean;
}

/** The auto sessions that hold an agent slot — all but landing repairs (#2973). */
export function slotHolders<T extends Pick<AutoSessionView, "landingRepair">>(
  sessions: readonly T[],
): T[] {
  return sessions.filter((s) => !s.landingRepair);
}

/** Everything `computeNext` needs about ONE repo, assembled by the side-effect harness. */
export interface DrainRepoState {
  enabled: boolean;
  /** Per-repo critic toggle — when on, a clean verdict for the current head gates merges. */
  criticEnabled: boolean;
  /** Per-repo draft mode — PRs open as drafts and retire is gated on sign-off. */
  draftMode: boolean;
  /** Who can sign off a draft-mode PR for retire/merge ("human"|"critic"|"either"). */
  signoffAuthority: SignoffAuthority;
  maxAuto: number;
  usageCeilingPct: number;
  /** The operator lifted `usageCeilingPct` for the running epic's run (`epic_run.ignoreUsageCeiling`).
   *  Skips only the usage-percentage hold; the extra-credit guard still applies. Never set in
   *  label mode. */
  usageCeilingIgnored?: boolean;
  /** The worse of the 5h / weekly usage windows, 0–100. */
  usagePct: number;
  /** Paid extra-credit spend accrued since the current WEEKLY subscription window began
   *  (account-wide), 0 when none/stale/unknown. NOT the raw month-to-date total: a nonzero
   *  cumulative total with fresh weekly headroom is historical, not imminent, spend and reads 0
   *  here (see DrainService.effectiveCreditSpent). This keeps the pause on the subscription
   *  cadence instead of stuck until the monthly credit reset. */
  creditSpent: number;
  /** Account-wide ceiling (account currency units); spend strictly above it pauses the drain. */
  creditSpendCeiling: number;
  /** Non-archived auto sessions for this repo (sessions mid-merge carry git: null). */
  autoSessions: AutoSessionView[];
  /** Issue numbers already mapped to a session (auto OR manual) — see {@link mappedIssueSet}. */
  mappedIssueNumbers: Set<number>;
  /** Labeled, ordered backlog issues (see selectCandidates). */
  candidates: Issue[];
  /** Provider the next spawn would use after explicit epic settings or global defaults resolve. */
  spawnAgentProvider: AgentProvider;
  /** Epic mode: when true, hold each spawn until the operator approves it. */
  epicAttended: boolean;
  /** Epic mode: operator approved the next spawn (consumed on spawn). */
  epicApprovedNext: boolean;
  /** Epic mode: the active epic's integration branch — epic-child spawns base on it.
   *  null/undefined for label-drain (spawns base on the default branch). */
  epicIntegrationBranch?: string | null;
  /** Epic mode: the active epic's PARENT issue number, stamped on each child it spawns (#2067).
   *  Set from the same epic run as `epicIntegrationBranch`; null/undefined for label-drain. */
  epicParent?: number | null;
  /** Epic mode: explicit provider/model/effort for child spawns. Undefined for label-drain
   *  and for epics inheriting the repo/global defaults. */
  epicProviderSettings?: EpicProviderSettings | null;
  /** #2069: child # → the chain predecessor's head branch it should be based on. Populated only
   *  when the repo opted into `epicStacksEnabled` AND the predecessor's PR is open; absent
   *  everywhere else, which leaves every child on the integration branch as before. */
  epicStackBases?: Map<number, string> | null;
  /** #3191: the running epic's parent while it lands incrementally (no integration branch, so
   *  `epicIntegrationBranch` and `epicParent` stay null); null/undefined otherwise. */
  epicIncrementalParent?: number | null;
  /** Epic mode (#1757): the integration branch a RECENT epic-child spawn failed to ensure on the
   *  forge (`ensureBranch` threw), while that failure is still inside its cooldown window; null
   *  otherwise. Set ONLY for that specific, typed failure — never for an ordinary spawn error —
   *  and only ever for the epic's own branch, so the resulting hold pauses exactly the work that
   *  cannot proceed. Derived fresh each tick (see Drain.buildState), so a stale failure stops
   *  holding once its cooldown lapses: the drain then retries the spawn and either succeeds or
   *  re-holds. Deliberately NOT set when the forge simply lacks `ensureBranch` (gitea/local) —
   *  that degrades to the default branch and the epic still progresses; it surfaces as an epic
   *  warning instead of a hold. */
  epicBaseUnavailable?: string | null;
  /** #3101: the running epic's integration branch while a base-freshness hold applies — `Conflict`
   *  when its rebase onto the default branch conflicts, `Stale` when it has been behind for too long
   *  and the epic is not quiescent. Null/undefined otherwise (incl. an operator override). */
  epicBaseConflict?: string | null;
  epicBaseStale?: string | null;
  /** #3101: other epics whose landing PR is still open, while THIS epic has not begun; null when
   *  none, the epic is under way, or the operator overrode it. */
  epicPredecessorUnlanded?: readonly number[] | null;
  /** True when a running epic could not be assembled because the forge's open-issue listing
   *  failed (e.g. a GitHub rate limit). Its children's states are unknown, so nothing is spawned
   *  or judged done; the listing is retried on the next pump. */
  epicUnreadable?: boolean;
  /** #2070: sessions whose stacked epic-child PR may not merge yet — a layer BELOW it in the stack
   *  has not landed. Merging a stack layer lands every layer beneath it, so only the bottom-most
   *  unmerged layer may merge; the rest wait their turn.
   *
   *  The wait is expressed HERE, in the decision, rather than as a no-op inside the retire action:
   *  `pumpStep` spends the pump's single retire attempt on whatever `retireDecision` names, so a
   *  held layer that got selected would end the pump with no spawn and no other retire that tick —
   *  starving a later-created chain's bottom layer, which is the one thing that could unblock it.
   *  Empty for every non-stacked repo. */
  stackHeldSessions?: ReadonlySet<string>;
  /** #3105: what still holds an ACTIVE project-bootstrap repo's drain (incomplete phases, then
   *  red must-haves); null/undefined when the repo is not bootstrapping, is done, or the operator
   *  overrode the hold. See src/bootstrap.ts → bootstrapMissing. */
  bootstrapMissing?: readonly string[] | null;
}

/** True when this session's PR is ready to be retired / handed off for a human to merge.
 *
 *  Basic gate (both modes): open, CI green, host-mergeable, has a PR number.
 *
 *  draftMode: sign-off by the configured `authority` REPLACES the critic sub-gate — the
 *  authority IS the gate, not the repo critic flag. This closes the born-ready retire race:
 *  an unsigned green PR (draft OR briefly-flipped-ready) cannot retire until signed off.
 *
 *  non-draftMode: the original behavior — changes_requested/error blocks; with the critic
 *  ENABLED we additionally require a clean verdict for the CURRENT head, so a PR can't be
 *  retired when CI goes green before the critic (started on push, #3426 — or by that same
 *  CI-green tick, its backstop trigger) has posted a verdict for that head. */
/** Sign-off view for a draft-mode gate, projected off the flat AutoSessionView (head from
 *  the cached PR snapshot). Mirrors automerge-core's `signoffView` so the two cores read
 *  identically and the literal lives in one place per core. */
function signoffView(s: AutoSessionView): SignoffView {
  return {
    humanApproved: s.humanApproved,
    reviewDecision: s.reviewDecision,
    findings: s.findings,
    reviewHeadSha: s.reviewHeadSha,
    headSha: s.git?.headSha ?? null,
  };
}

export function readyToRetire(
  s: AutoSessionView,
  criticEnabled: boolean,
  draftMode: boolean,
  authority: SignoffAuthority,
): boolean {
  const g = s.git;
  if (
    !g ||
    g.state !== "open" ||
    !checksCleared(g.checks, g.noCi ?? false) ||
    g.mergeable !== true ||
    !g.number
  ) {
    return false;
  }
  if (draftMode) {
    return signedOff(authority, signoffView(s));
  }
  if (s.reviewDecision === "changes_requested" || s.reviewDecision === "error") return false;
  if (criticEnabled) {
    if (s.reviewDecision === null) return false; // critic on, no verdict yet → wait
    if (s.reviewHeadSha !== g.headSha) return false; // verdict is for an older head → wait
  }
  return true; // critic off → CI-green + mergeable; critic on → clean verdict for this head
}

/** True when a draft-mode session is retireable EXCEPT it lacks the required sign-off, i.e.
 *  open + CI green + host-mergeable + has a PR number, but `signedOff` is false. Used only to
 *  RELABEL the cap hold as `awaiting_signoff` (see computeNext). */
function awaitingSignoff(
  s: AutoSessionView,
  draftMode: boolean,
  authority: SignoffAuthority,
): boolean {
  if (!draftMode) return false;
  const g = s.git;
  if (
    !g ||
    g.state !== "open" ||
    !checksCleared(g.checks, g.noCi ?? false) ||
    g.mergeable !== true ||
    !g.number
  ) {
    return false;
  }
  return !signedOff(authority, signoffView(s));
}

/** Whether the repo's drain acts at all (spawns AND retires): a leading epic (running or paused)
 *  decides — only `running` acts; an idle run or no row defers to the label-drain toggle. Shared by
 *  the drain's buildState and the epic-run-stopped hold (#2735) so the two cannot drift. */
export function drainEnabled(
  run: Pick<EpicRun, "status"> | null | undefined,
  autoDrainEnabled: boolean,
): boolean {
  if (run?.status === "running") return true;
  if (run?.status === "paused") return false;
  return autoDrainEnabled;
}

function usageGuardsApply(state: DrainRepoState): boolean {
  return state.spawnAgentProvider === "claude";
}

function retireDecision(state: DrainRepoState): DrainDecision | null {
  const toRetire = state.autoSessions.find(
    (s) =>
      !s.fullAuto &&
      !state.stackHeldSessions?.has(s.id) && // #2070: a stacked layer waiting for the one below it
      !s.misrouted && // #3245: never hand off a session outside its ticket's target repo
      !s.shelved && // shelving promises the session stays until unshelved
      readyToRetire(s, state.criticEnabled, state.draftMode, state.signoffAuthority),
  );
  return toRetire
    ? {
        kind: "retire",
        sessionId: toRetire.id,
        prNumber: toRetire.git!.number!,
        // F09: the head the CI + critic gate just passed — the epic-child merge is bound to it.
        headSha: toRetire.git!.headSha ?? null,
      }
    : null;
}

function troubleHold(state: DrainRepoState): HoldReason | null {
  const blocked = state.autoSessions.find((s) => s.status === "blocked");
  if (blocked) return { code: "blocked", detail: blocked.desig };
  // A verdict for an OLDER head (rework pushed, PR open at a newer head, re-review pending) is
  // NOT trouble — the same SHA staleness `readyToRetire` already respects. Suppress it here so a
  // superseded changes_requested/error doesn't falsely pause the drain (banner "needs changes").
  const cr = state.autoSessions.find(
    (s) => s.reviewDecision === "changes_requested" && !verdictStale(s.reviewHeadSha, s.git),
  );
  if (cr) return { code: "changes_requested", detail: cr.desig };
  const err = state.autoSessions.find(
    (s) => s.reviewDecision === "error" && !verdictStale(s.reviewHeadSha, s.git),
  );
  return err ? { code: "error", detail: err.desig } : null;
}

function bootstrapHold(state: DrainRepoState): HoldReason | null {
  const missing = state.bootstrapMissing;
  return missing?.length ? { code: "bootstrap_incomplete", detail: missing.join(",") } : null;
}

function capHold(state: DrainRepoState): HoldReason | null {
  const holding = slotHolders(state.autoSessions);
  if (holding.length < state.maxAuto) return null;
  const awaiting = holding.find((s) => awaitingSignoff(s, state.draftMode, state.signoffAuthority));
  return awaiting
    ? { code: "awaiting_signoff", detail: awaiting.desig }
    : { code: "cap", detail: String(state.maxAuto) };
}

function usageHold(state: DrainRepoState): HoldReason | null {
  if (!usageGuardsApply(state)) return null;
  // Claude usage ceiling — unless the operator lifted it for the running epic.
  if (!state.usageCeilingIgnored && state.usagePct >= state.usageCeilingPct) {
    return { code: "usage", detail: String(state.usagePct) };
  }
  // Extra-credit cost guard: never keep spending NEW real pay-as-you-go money unattended.
  // creditSpent is spend accrued since the weekly window began (see effectiveCreditSpent), so a
  // nonzero month-to-date total with subscription headroom does NOT pause here.
  if (state.creditSpent > state.creditSpendCeiling) {
    return { code: "credits", detail: String(state.creditSpent) };
  }
  return null;
}

/**
 * Pure decision core. Given one repo's state snapshot, returns the single
 * highest-priority next action. The harness applies it, re-reads state, and calls
 * again — so spawns fill up to maxAuto and the loop ends on a `hold`.
 *
 * Priority: completing in-flight work (retire/hand-off) beats starting new work (spawn), and
 * a ready PR is still retired even while a sibling agent is in trouble (trouble only
 * halts NEW spawns).
 */
export function computeNext(state: DrainRepoState): DrainDecision {
  if (!state.enabled) return { kind: "hold", reason: { code: "disabled" } };

  // 1. Retire gate — a ready NON-full-auto session is handed off for a human to merge.
  // Full-auto sessions are left for the merge train (it lands them; retiring would remove the
  // worktree/pane and foreclose rebase recovery). Gating per-session (not on the repo flag)
  // ensures a non-full-auto session in an auto-merge repo still retires instead of sitting
  // un-retired-and-un-merged on a maxAuto slot and deadlocking the drain.
  const retire = retireDecision(state);
  if (retire) return retire;

  // 1a. Project bootstrap (#3105): an actively-bootstrapping repo spawns nothing — epic or label
  // drain — until P1–P4 are done and the must-haves are green, or the operator overrides (which
  // nulls bootstrapMissing upstream). After the retire gate, so a ready PR still hands off.
  const bootstrap = bootstrapHold(state);
  if (bootstrap) return { kind: "hold", reason: bootstrap };

  // 2. Trouble → halt new spawns (in-flight agents keep running; retires above still pass).
  const trouble = troubleHold(state);
  if (trouble) return { kind: "hold", reason: trouble };

  // 2a–2c. Epic holds: unreadable, base unavailable, base freshness (see epicHold).
  const epic = epicHold(state);
  if (epic) return { kind: "hold", reason: epic };

  // 3. Concurrency cap. In draftMode, if a session is retireable-but-unsigned it's the reason
  //    the slot stays taken — relabel the hold `awaiting_signoff` (with that session's desig) so
  //    the operator sees WHY the drain is stuck, not a bare `cap`. Relabel is CAP-ONLY by design:
  //    below the cap the drain keeps spawning, and surfacing a pending sign-off there is the herd
  //    UI's job, not a drain hold.
  const cap = capHold(state);
  if (cap) return { kind: "hold", reason: cap };

  // 4. Usage ceiling.
  const usage = usageHold(state);
  if (usage) return { kind: "hold", reason: usage };

  // 5. Next un-mapped candidate.
  const next = state.candidates.find((c) => !state.mappedIssueNumbers.has(c.number));
  if (!next) return { kind: "hold", reason: { code: "empty" } };

  // Epic attended mode: hold the next spawn until the operator approves it.
  if (next && state.epicAttended && !state.epicApprovedNext) {
    return { kind: "hold", reason: { code: "awaiting_approval", detail: String(next.number) } };
  }

  return {
    kind: "spawn",
    issue: next,
    integrationBranch: state.epicIntegrationBranch ?? undefined,
    epicParent: state.epicParent ?? undefined,
    epicProviderSettings: state.epicProviderSettings ?? undefined,
    stackedBase: state.epicStackBases?.get(next.number),
    incrementalEpicParent: state.epicIncrementalParent ?? undefined,
  };
}

/** The epic-only holds of {@link computeNext}, in priority order (after retire, trouble and
 *  bootstrap; before the cap). */
function epicHold(state: DrainRepoState): HoldReason | null {
  // 2a. Epic unreadable: the epic could not be assembled because the open-issue listing failed.
  // Without this the stall reads as an empty backlog (`empty`) and the operator never learns why
  // the epic stopped moving. A ready PR still retires above; the listing is retried next pump.
  if (state.epicUnreadable) return { code: "epic_unreadable" };

  // 2b. Epic base unavailable (#1757): the forge's `ensureBranch` THREW for a child spawn, so the
  // integration branch could not be ensured. Basing the child on the default branch instead would
  // silently mix bases mid-epic — the merge train would land that one child on main (it is not
  // excluded from full-auto: a child that did NOT get the integration branch carries no `epicParent`
  // stamp, so `isEpicChild` is false for it) while its siblings integrate on the epic branch.
  // So fail closed and hold. Gated on an active epic run, so
  // it can never fire in label-mode drain; while an epic runs the candidate set IS that epic's
  // children, and every sibling would fail identically, so pausing new spawns is exactly right.
  // Placed AFTER the retire gate (a ready PR still retires) and BEFORE the cap. The marker is
  // cooldown-fresh (see Drain.buildState), so this self-heals: it lapses, the spawn retries.
  //
  // The marker must name THIS epic's branch. The failure map is keyed per repo+issue, not per epic,
  // so a failure recorded for epic A survives its cooldown window into a DIFFERENT epic started in
  // the same repo minutes later — holding epic B while the banner names epic A's branch. Comparing
  // the two makes a stale cross-epic marker inert (and it ages out of the map on its own).
  if (state.epicIntegrationBranch && state.epicBaseUnavailable === state.epicIntegrationBranch)
    return { code: "epic_base_unavailable", detail: state.epicBaseUnavailable };

  // 2c. Epic base freshness (#3101): no NEW child while the integration branch cannot follow the
  // default branch (conflict) or has drifted too long (stale), and no first child while another
  // epic's landing is still open. After the retire gate — in-flight children still integrate.
  return epicBaseHold(state);
}

function epicBaseHold(state: DrainRepoState): HoldReason | null {
  if (!state.epicIntegrationBranch) return null;
  if (state.epicBaseConflict) return { code: "epic_base_conflict", detail: state.epicBaseConflict };
  if (state.epicBaseStale) return { code: "epic_base_stale", detail: state.epicBaseStale };
  if (state.epicPredecessorUnlanded?.length)
    return {
      code: "epic_predecessor_unlanded",
      detail: state.epicPredecessorUnlanded.map((n) => `#${n}`).join(", "),
    };
  return null;
}

/** An auto session as the run picture shows it. */
export interface RunSummaryHolder {
  sessionId: string;
  desig: string;
  issueNumber: number | null;
  epicParent: number | null;
}

/** Read-only picture of how one repo's drain is running, shipped on `DrainStatus.runSummary`. */
export interface RunSummary {
  /** The epic_run parent while that run is running/paused; null in label mode or when idle. */
  leadingEpic: number | null;
  /** Epics other than the leading one that still have an auto session in flight (superseded by a
   *  newer epic in the same repo), epics ascending, their in-flight issue #s ascending. */
  windingDown: { epic: number; inFlight: number[] }[];
  slots: {
    used: number;
    max: number;
    holders: RunSummaryHolder[];
  };
  /** Landing-repair sessions in flight (#2973) — outside `slots`, since they hold none. */
  landingRepairs: RunSummaryHolder[];
  /** Not-yet-mapped candidates in the order `computeNext` would pick them. */
  next: number[];
  /** Label-mode priorities among next; optional for older-server compatibility. */
  nextPriority?: { number: number; labels: string[] }[];
  /** Open epic children directly blocked by `next[0]`; [] in label mode. */
  after: number[];
  /** Epics queued behind the leading one (#2624), head first — the head starts once the leader
   *  completes or is stopped (#2973). */
  queued: number[];
}

export interface RunSummaryInput {
  leadingEpic: number | null;
  autoSessions: AutoSessionView[];
  maxAuto: number;
  /** Ordered candidates — for an epic, computed even while the run is paused. */
  candidates: Issue[];
  priorityLabels?: string[];
  mappedIssueNumbers: Set<number>;
  /** The leading epic's children; [] in label mode. */
  epicChildren: Pick<
    EpicChild,
    "number" | "order" | "blockedBy" | "integrationMerged" | "issueClosed"
  >[];
  /** The repo's epic queue, head first. */
  queued: number[];
}

function summaryHolder(s: AutoSessionView): RunSummaryHolder {
  return { sessionId: s.id, desig: s.desig, issueNumber: s.issueNumber, epicParent: s.epicParent };
}

/** Pure: shape the {@link RunSummary} from the facts `Drain.buildState` already gathered. */
export function buildRunSummary(input: RunSummaryInput): RunSummary {
  const { leadingEpic, epicChildren } = input;
  const autoSessions = slotHolders(input.autoSessions);
  const byEpic = new Map<number, number[]>();
  for (const s of autoSessions) {
    if (s.epicParent == null || s.epicParent === leadingEpic) continue;
    const inFlight = byEpic.get(s.epicParent) ?? [];
    if (s.issueNumber != null) inFlight.push(s.issueNumber);
    byEpic.set(s.epicParent, inFlight);
  }
  const windingDown = [...byEpic]
    .sort(([a], [b]) => a - b)
    .map(([epic, inFlight]) => ({ epic, inFlight: inFlight.sort((a, b) => a - b) }));
  const pending = input.candidates.filter((c) => !input.mappedIssueNumbers.has(c.number));
  const next = pending.map((c) => c.number);
  const nextPriority =
    leadingEpic != null
      ? []
      : pending
          .map((c) => ({
            number: c.number,
            labels: matchingPriorityLabels(c, input.priorityLabels),
          }))
          .filter((c) => c.labels.length > 0);
  const head = next[0];
  const after =
    head === undefined
      ? []
      : epicChildren
          .filter((c) => !c.integrationMerged && !c.issueClosed && c.blockedBy.includes(head))
          .sort((a, b) => a.order - b.order || a.number - b.number)
          .map((c) => c.number);
  return {
    leadingEpic,
    windingDown,
    slots: {
      used: autoSessions.length,
      max: input.maxAuto,
      holders: autoSessions.map(summaryHolder),
    },
    landingRepairs: input.autoSessions.filter((s) => s.landingRepair).map(summaryHolder),
    next,
    nextPriority,
    after,
    queued: input.queued,
  };
}

/** The session facts {@link mappedIssueSet} needs (auto OR manual, any status). */
export interface MappedSessionView {
  issueNumber: number | null;
  status: SessionStatus;
  branch: string | null;
  archivedAt: number | null;
}

/** How long a just-archived session still maps its issue outright. Outlasts the cached issue
 *  listing (≤30s) and open-PR snapshot (≤120s), so a merge that just closed the issue — or an
 *  archive that just released its claim — can't re-spawn it off a stale "open" listing. */
export const ARCHIVED_MAPPING_GRACE_MS = 5 * 60_000;

/** Non-archived, or archived at/after `recentSince` (within {@link ARCHIVED_MAPPING_GRACE_MS}). */
function mapsOutright(s: MappedSessionView, recentSince: number): boolean {
  return s.status !== "archived" || (s.archivedAt ?? 0) >= recentSince;
}

/** Older archived sessions with a branch whose issue nothing maps outright — only they need an
 *  open-PR check. */
function archivedOnly(sessions: MappedSessionView[], recentSince: number): MappedSessionView[] {
  const outright = new Set(
    sessions.filter((s) => mapsOutright(s, recentSince)).map((s) => s.issueNumber),
  );
  return sessions.filter(
    (s) => s.issueNumber != null && s.branch != null && !outright.has(s.issueNumber),
  );
}

/** True when some candidate is mapped only by older archived sessions that have a branch, i.e.
 *  its dedup depends on {@link mappedIssueSet}'s open-PR check. */
export function needsOpenPrCheck(
  sessions: MappedSessionView[],
  candidates: Issue[],
  recentSince: number,
): boolean {
  const numbers = new Set(candidates.map((c) => c.number));
  return archivedOnly(sessions, recentSince).some((s) => numbers.has(s.issueNumber!));
}

/**
 * Issues the drain must not (re-)spawn because a session already maps them (#3238): every
 * non-archived or recently archived (`archivedAt >= recentSince`) session, plus an older archived
 * one whose branch still has an OPEN PR — a retired, not-yet-merged PR (the kept
 * {@link ACTIVE_LABEL} claim covers it too) or a manual session archived with its PR awaiting
 * review. `openBranches` null = open PRs unknown → every older archived session with a branch
 * stays mapped (fail-closed). An older archived session without a branch never maps, so an
 * abandoned/merged issue relabelled for a follow-up drains again.
 */
export function mappedIssueSet(
  sessions: MappedSessionView[],
  openBranches: ReadonlySet<string> | null,
  recentSince: number,
): Set<number> {
  const mapped = new Set(
    sessions
      .filter((s) => mapsOutright(s, recentSince))
      .map((s) => s.issueNumber)
      .filter((n): n is number => n != null),
  );
  for (const s of archivedOnly(sessions, recentSince)) {
    if (openBranches == null || openBranches.has(s.branch!)) mapped.add(s.issueNumber!);
  }
  return mapped;
}

function matchingPriorityLabels(issue: Issue, priorityLabels: string[] = []): string[] {
  return [...new Set([PRIORITY_LABEL, ...priorityLabels])].filter((label) =>
    issue.labels.includes(label),
  );
}

/**
 * Filter issues to those carrying `autoLabel` and NOT already claimed
 * ({@link ACTIVE_LABEL}), then order: priority-labeled first (each group by issue
 * number ascending = oldest first). A priority label without the auto label is
 * ignored — the auto label is the opt-in. Excluding claimed issues is what keeps a
 * second shepherd instance from re-taking an issue this (or another) instance is
 * already working or has a ready PR open for.
 */
export function selectCandidates(
  issues: Issue[],
  autoLabel: string,
  priorityLabels: string[] = [],
): Issue[] {
  const eligible = issues.filter(
    (i) => i.labels.includes(autoLabel) && !i.labels.includes(ACTIVE_LABEL),
  );
  const prio = (i: Issue) => (matchingPriorityLabels(i, priorityLabels).length > 0 ? 0 : 1);
  return eligible.sort((a, b) => prio(a) - prio(b) || a.number - b.number);
}
