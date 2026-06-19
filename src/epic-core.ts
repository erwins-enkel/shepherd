import type { Issue } from "./forge/types";

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
}
export interface Epic {
  repoPath: string;
  parentIssueNumber: number;
  parentTitle: string;
  source: EpicSource;
  children: EpicChild[];
  warnings: string[];
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
