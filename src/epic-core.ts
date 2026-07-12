import type { Issue, LinkedPr } from "./forge/types";
import type { AgentProvider } from "./types";

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

/** Dependency-gated spawn candidates (open, unclaimed, unspawned, not-integrated, all
 *  blockers done-in-epic), in epic order, shaped as drain's `Issue[]`. Pure: derives the
 *  done set (integration-merged OR issue-closed) from `children`. */
export function selectEpicCandidates(children: EpicChild[]): Issue[] {
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
        c.blockedBy.every((b) => done.has(b)),
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
