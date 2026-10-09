import type { Issue, LinkedPr } from "./forge/types";
import type { AgentProvider, Session } from "./types";

export type EpicSource = "native" | "markdown";
export type EpicMode = "auto" | "attended";
export type EpicRunStatus = "idle" | "running" | "paused";
export type EpicChildState = "merged" | "in-review" | "running" | "ready" | "blocked";

export interface EpicChild {
  number: number;
  title: string;
  url: string;
  order: number;
  body: string; // real issue body — forwarded as issueRef.body on spawn (drain.ts:329)
  blockedBy: number[];
  /**
   * Materialized derivation produced once by `assembleEpic` (single writer via
   * `child.state = deriveChildState(child, closed)`). Consumers and the UI read this
   * field directly — do not hand-set or re-derive it anywhere else.
   */
  state: EpicChildState;
  sessionId: string | null;
  prNumber: number | null;
  issueClosed: boolean;
  /** The child's PR was squash-merged into the epic integration branch (recorded
   *  by the drain at merge time; the issue stays open until the final epic→default
   *  PR lands). Satisfies dependencies the same as issueClosed. */
  integrationMerged: boolean;
  claimed: boolean;
  /** When work on this child began: the earliest `createdAt` of its sessions (its delivery fact's
   *  once the session row is pruned); null when unknown. Set by `buildEpic`; optional so the many
   *  EpicChild test fixtures stay valid. */
  startedAt?: number | null;
  /** When this child was done: its `epic_integrated` stamp, else the `mergedAt` of its delivery
   *  fact; null while it is not done, or when unknown. Set by `buildEpic` (see `startedAt`). */
  endedAt?: number | null;
}
/** Persisted `epic_run` store row (stands alone; repoPath/parentIssueNumber are intentionally self-contained, not a duplication bug). */
export interface EpicRun {
  repoPath: string;
  parentIssueNumber: number;
  mode: EpicMode;
  status: EpicRunStatus;
  agentProvider?: AgentProvider | null;
  model?: string | null;
  effort?: string | null;
}
/** An epic's run settings without a status. They live in exactly one place: the repo's `epic_run`
 *  row while the epic holds it, its `epic_queue` row while queued, else its `epic_settings` row
 *  (absent = the defaults). */
export type EpicSettings = Pick<
  EpicRun,
  "repoPath" | "parentIssueNumber" | "mode" | "agentProvider" | "model" | "effort"
>;
/** Why an epic stopped leading its repo: the operator ended it, another epic was started over it,
 *  or all its children merged. */
export type EpicRunEndCause = "ended" | "superseded" | "completed";
/** The last time an epic stopped leading (persisted `epic_run_end` row, one per epic; cleared when
 *  it leads again). `via` names the access token that made the request, null for the UI. */
export interface EpicRunEnd {
  cause: EpicRunEndCause;
  /** The epic started over this one (`superseded` only). */
  successor: number | null;
  at: number;
  via: string | null;
}

/** Persisted `epic_clock` row: one per epic, keyed `(repoPath, parentIssueNumber)` like
 *  `epic_branch`, so it survives supersession and landing. The clock runs only while the epic's run
 *  is `running`; every other transition (pause, end, supersede, complete) stops it. */
export interface EpicClock {
  /** The first transition to `running`. */
  startedAt: number;
  /** When the clock last stopped; null while it runs. */
  pausedAt: number | null;
  /** Closed stops `[from, to]`, oldest first — a resume closes the open one. */
  pauses: [number, number][];
  /** When the last child integrated and the epic→default landing flow began. */
  landingStartedAt: number | null;
  /** When the landing PR merged (observed, like `DeliveryFact.mergedAt`). */
  landedAt: number | null;
}

/** The epic clock as the Epic payload carries it (epoch ms). Running time is
 *  `(pausedAt ?? now) − startedAt − pausedMs`. */
export interface EpicTiming {
  /** Null when the epic never ran. */
  startedAt: number | null;
  pausedAt: number | null;
  /** Time the clock stood still (paused, ended or superseded) before its latest resume. */
  pausedMs: number;
  landingStartedAt: number | null;
  landedAt: number | null;
  /** Sum of child session wall time. */
  agentMs: number;
  /** Running-clock time when no child session of this epic was alive. */
  idleMs: number;
}

/** How much the forecast rests on this epic's own measured children. No data at all is not a
 *  rung: the epic then carries `forecast: null`. */
export type EpicForecastConfidence = "very-low" | "low" | "medium" | "high";

/** One child still to finish, as the forecast schedules it (epoch ms). */
export interface EpicChildForecast {
  number: number;
  /** Its real start once in flight; null while the epic's clock is stopped. */
  projectedStart: number | null;
  /** Null while the epic's clock is stopped. */
  projectedEnd: number | null;
  /** In flight for more than 1.5× the step estimate. */
  overrun: boolean;
}

/** When the epic lands and how sure that is (see `forecastEpic` in src/epic-forecast.ts). */
export interface EpicForecast {
  /** Epoch ms the landing is projected to merge; null while the epic's clock is stopped. */
  finishAt: number | null;
  /** The range, from the p25 / p75 step durations; null while the clock is stopped. */
  finishLow: number | null;
  finishHigh: number | null;
  /** While the clock is stopped (paused, idle): ms from a resume to the landing; else null. */
  remainingMsFromResume: number | null;
  confidence: EpicForecastConfidence;
  /** The per-child estimate: this epic's measured children blended with the repo's median. */
  stepMs: number;
  /** The landing estimate: the repo's past epic landings, else 20 min. */
  landingMs: number;
  /** This epic's children with a measured duration. */
  epicSamples: number;
  /** Tasks behind the repo's median lead time (0 when it has none). */
  repoSamples: number;
  /** The first forecast made after the first child merged — the drift anchor. */
  firstFinishAt: number | null;
  /** The finish with one more agent slot; set only when that saves ≥ 15 min and a `ready` child
   *  waits on the cap. */
  fasterWithSlots: { slots: number; finishAt: number; savedMs: number } | null;
  /** Every child not yet merged, in epic order. */
  children: EpicChildForecast[];
}

/** Pure: does replacing the repo's run `prev` with `next` end an epic's lead, and why? An epic
 *  leads while its run is running or paused; it stops when the row passes to another epic
 *  (superseded) or when its own run turns idle (ended, or completed when the drain says so). */
export function epicRunEnding(
  prev: Pick<EpicRun, "parentIssueNumber" | "status"> | null,
  next: Pick<EpicRun, "parentIssueNumber" | "status">,
  opts: { completed?: boolean } = {},
): { parent: number; cause: EpicRunEndCause; successor: number | null } | null {
  if (!prev || (prev.status !== "running" && prev.status !== "paused")) return null;
  if (prev.parentIssueNumber !== next.parentIssueNumber)
    return {
      parent: prev.parentIssueNumber,
      cause: "superseded",
      successor: next.parentIssueNumber,
    };
  if (next.status !== "idle") return null;
  return {
    parent: prev.parentIssueNumber,
    cause: opts.completed ? "completed" : "ended",
    successor: null,
  };
}

/** Persisted `epic_queue` row (#2624): an epic waiting behind the repo's leading epic, with the
 *  settings it starts with once the queue promotes it. `position` orders the queue (ascending). */
export interface EpicQueueEntry {
  repoPath: string;
  parentIssueNumber: number;
  position: number;
  mode: EpicMode;
  agentProvider?: AgentProvider | null;
  model?: string | null;
  effort?: string | null;
  createdAt: number;
}

/** A queued epic's stored settings as an (idle) run — what its detail and a promotion start from. */
export function queuedEpicRun(entry: EpicQueueEntry): EpicRun {
  return {
    repoPath: entry.repoPath,
    parentIssueNumber: entry.parentIssueNumber,
    mode: entry.mode,
    status: "idle",
    agentProvider: entry.agentProvider ?? null,
    model: entry.model ?? null,
    effort: entry.effort ?? null,
  };
}
export interface Epic {
  repoPath: string;
  parentIssueNumber: number;
  parentTitle: string;
  source: EpicSource;
  children: EpicChild[];
  warnings: string[];
  /** True when the epic has ≥2 `ready` children and 0 dependency edges (no native
   *  `blocked_by`, no `epic-dag`/task-list edges) — every open child derives to `ready`
   *  and drains in parallel. Surfaced as a dedicated, translated legibility warning on
   *  the epic panel (NOT appended to `warnings[]`, so it does not affect that count).
   *  Set once by `assembleEpic`; optional so the many Epic test fixtures stay valid. */
  noDependencyEdges?: boolean;
  run: EpicRun;
  /** Why the epic last stopped leading; absent while it leads or when nothing was recorded. */
  runEnd?: EpicRunEnd;
  /** The epic clock. Set by `buildEpic`; optional so the many Epic test fixtures stay valid. */
  timing?: EpicTiming;
  /** When the epic lands; null when there is no data to forecast from, or once it landed. Set by
   *  `buildEpic` (see `timing`). */
  forecast?: EpicForecast | null;
}

/** Child lifecycle state from its issue/session/PR facts. `done` = the set of member
 *  #s that are done-in-epic (integration-merged OR issue-closed). A claimed, session-less,
 *  open, not-yet-integrated child reads as in-review (spawned and retired/in-flight, PR
 *  awaiting merge). Spawn-eligibility gating still lives in `selectEpicCandidates`. */
export function deriveChildState(c: EpicChild, done: Set<number>): EpicChildState {
  if (c.integrationMerged || c.issueClosed) return "merged";
  if (c.sessionId && c.prNumber != null) return "in-review";
  if (c.sessionId) return "running";
  // claimed but no live local session + issue still open = spawned & retired/in-flight
  // (PR awaiting human merge); session was archived after the retire path.
  if (c.claimed) return "in-review";
  return c.blockedBy.every((b) => done.has(b)) ? "ready" : "blocked";
}

/** #1841: may the epic's integration branch be rebased onto the default branch mid-run? Only in
 *  a quiescent window — no child `running`/`in-review` (so no child worktree or PR is built on the
 *  current head) AND no non-archived session of this repo based on the integration branch (catches
 *  manual and repair sessions the child derivation cannot see). A rebase then rewrites nothing a
 *  live branch depends on; the next spawn is cut from the rebased head. */
export function epicQuiescentForCadenceRebase(
  children: Pick<EpicChild, "state">[],
  sessions: Pick<Session, "repoPath" | "baseBranch" | "status">[],
  repoPath: string,
  integrationBranch: string,
): boolean {
  if (children.some((c) => c.state === "running" || c.state === "in-review")) return false;
  return !sessions.some(
    (s) => s.repoPath === repoPath && s.status !== "archived" && s.baseBranch === integrationBranch,
  );
}

/** Stack facts a caller may supply to {@link selectEpicCandidates} (#2066, epic #2063) so a
 *  child can spawn onto its chain predecessor's branch instead of waiting for it to merge. */
export interface EpicStackContext {
  /** child # → its chain predecessor #, from `decomposeEpicChains` (src/epic-chains.ts). */
  predecessorOf: Map<number, number>;
  /** Predecessor #s the CALLER has judged stack-ready (branch pushed / PR open). That
   *  judgement needs PR/session facts this module deliberately has no access to. */
  stackReady: Set<number>;
}

/** Is this child's dependency gate satisfied? Without `stack`, exactly today's predicate:
 *  every blocker done-in-epic. With one, ALSO admit a child whose blockers are all done
 *  except exactly one, where that one is its chain predecessor and the caller flagged it
 *  stack-ready — the within-chain wait becomes a base pointer. Cross-chain edges are
 *  untouched, so the every-blocker-done gate stays authoritative for them.
 *
 *  Deduped because `blockedBy` may repeat a blocker (the markdown path in `epic-model.ts`
 *  appends edges without deduping): `.every()` doesn't care, "exactly one outstanding" does. */
function dependenciesSatisfied(c: EpicChild, done: Set<number>, stack?: EpicStackContext): boolean {
  const outstanding = [...new Set(c.blockedBy)].filter((b) => !done.has(b));
  if (outstanding.length === 0) return true;
  if (!stack || outstanding.length !== 1) return false;
  const pred = stack.predecessorOf.get(c.number);
  return pred !== undefined && outstanding[0] === pred && stack.stackReady.has(pred);
}

/** Dependency-gated spawn candidates (open, unclaimed, unspawned, not-integrated, all
 *  blockers done-in-epic), in epic order, shaped as drain's `Issue[]`. Pure: derives the
 *  done set (integration-merged OR issue-closed) from `children`.
 *
 *  `stack` is optional and additive: omitted (every caller today) ⇒ output identical to the
 *  pre-#2066 behaviour. See {@link dependenciesSatisfied}. */
export function selectEpicCandidates(children: EpicChild[], stack?: EpicStackContext): Issue[] {
  const done = new Set(
    children.filter((c) => c.integrationMerged || c.issueClosed).map((c) => c.number),
  );
  return children
    .filter(
      (c) =>
        !c.integrationMerged &&
        !c.issueClosed &&
        !c.claimed &&
        c.sessionId == null &&
        dependenciesSatisfied(c, done, stack),
    )
    .sort((a, b) => a.order - b.order || a.number - b.number)
    .map((c) => ({
      number: c.number,
      title: c.title,
      body: c.body,
      url: c.url,
      labels: [],
      createdAt: 0,
      // Epic candidates are synthesized from sub-issues and spawned by the epic
      // runner — they carry no assignee data and are not assignee-filtered (#824).
      assignees: [],
    }));
}

/** "Someone else is already working / owns this epic" flags for the backlog epic row (#1616),
 *  all resolved against the viewer so nothing here ever points at the operator's own work. */
export interface EpicOthersFlags {
  /** How many of the epic's children have an OPEN PR authored by someone other than the
   *  viewer (the viewer's own in-flight PRs are excluded from the COUNT, not just the names).
   *  0 → no pill. */
  inFlight: number;
  /** Distinct non-viewer authors of those in-flight child PRs, sorted — the pill's "by …". */
  inFlightBy: string[];
  /** Parent assignees other than the viewer, sorted (the "assigned to X" signal). */
  assignedOthers: string[];
  /** Parent author when it isn't the viewer, else null — the only tell for a freshly-created,
   *  unassigned epic with no child PRs yet. */
  authoredByOther: string | null;
}

/** Pure derivation of {@link EpicOthersFlags} from an epic's child numbers + the repo's
 *  open-PR→author map + the parent's assignees/author, all relative to `viewer`. `viewer`
 *  null (host can't resolve "me") fails open — every non-empty author/assignee counts as
 *  "other" (matching the #824 fail-open convention). Any OPEN PR qualifies as in-flight
 *  (incl. drafts / bot authors), so the UI copy says "in progress", not "in review". */
export function computeEpicOthersFlags(input: {
  childNumbers: number[];
  linked: Map<number, LinkedPr[]>;
  assignees: string[];
  author: string | null;
  viewer: string | null;
}): EpicOthersFlags {
  const { childNumbers, linked, assignees, author, viewer } = input;
  const inFlightAuthors = new Set<string>();
  let inFlight = 0;
  for (const num of new Set(childNumbers)) {
    const prs = (linked.get(num) ?? []).filter((p) => p.author && p.author !== viewer);
    if (prs.length === 0) continue;
    inFlight++;
    for (const p of prs) inFlightAuthors.add(p.author);
  }
  const assignedOthers = [...new Set(assignees.filter((a) => a && a !== viewer))].sort();
  return {
    inFlight,
    inFlightBy: [...inFlightAuthors].sort(),
    assignedOthers,
    authoredByOther: author && author !== viewer ? author : null,
  };
}
