import { isConflicting } from "#lib/pr-conflict.js";
import { prReadinessBlock } from "#lib/pr-ready.js";
import { m } from "#lib/paraglide/messages.js";
import type { GitState, MergeStateStatus } from "#lib/types.js";
import type { CriticChip } from "../critic-badge";

/** The merge row's one state: the label it shows and whether its Merge is free (`ready`).
 *  Every kind but `ready` locks Merge and names its reason (see {@link mergeBlockedText}). */
export type PrRowKind =
  | "merging"
  | "draft"
  | "conflict"
  | "behind"
  | "ci_failed"
  | "ci_running"
  | "protected"
  | "ready"
  | "merged";

/** The merge row exists while the session's PR is open (#3540), or merged and the session still
 *  stands (#3541: its one action is Stilllegen). Viewport gates the mount and the recap's
 *  headline on this; the row re-checks it so it can never render empty. */
export function prActionRowVisible(git: GitState | null | undefined): git is GitState {
  return git?.state === "open" || git?.state === "merged";
}

/** Which state the merge row is in. `merging` (a merge in flight, or the PR sits in its base's
 *  merge queue) wins; then the readiness blocks the whole UI shares (`prReadinessBlock`) — draft,
 *  conflict, behind — before CI, since a rebase or conflict fix reruns CI anyway; then CI; and
 *  branch protection last, so a still-running required check reads as "CI running", not as a
 *  vague protection block.
 *
 *  Stricter than the merge gate elsewhere: ANY failing or pending check locks Merge here, even
 *  a non-required one GitHub reports as `unstable` (operator decision on #3540). */
export function prRowStatus(git: GitState, merging: boolean): PrRowKind {
  if (git.state === "merged") return "merged";
  if (merging) return "merging";
  const block = prReadinessBlock(git);
  if (block === "draft" || block === "conflict" || block === "behind") return block;
  if (git.checks === "failure") return "ci_failed";
  if (git.checks === "pending") return "ci_running";
  if (block === "blocked") return "protected";
  return "ready";
}

/** Why Merge is locked in this state, or null when it is free. */
export function mergeBlockedText(kind: PrRowKind): string | null {
  switch (kind) {
    case "merging":
      return m.gitrail_merge_blocked_busy();
    case "draft":
      return m.gitrail_merge_blocked_draft();
    case "conflict":
      return m.gitrail_merge_blocked_conflict();
    case "behind":
      return m.gitrail_merge_blocked_behind();
    case "ci_failed":
      return m.gitrail_merge_blocked_checks();
    case "ci_running":
      return m.gitrail_merge_blocked_pending();
    case "protected":
      return m.gitrail_merge_blocked_protected();
    case "ready":
    case "merged":
      return null;
  }
}

/** The row's status label. `base` names the branch a `behind` PR trails. */
export function prRowLabel(kind: PrRowKind, base: string): string {
  switch (kind) {
    case "merging":
      return m.prrow_merging();
    case "draft":
      return m.prrow_state_draft();
    case "conflict":
      return m.prrow_state_conflict();
    case "behind":
      return m.prrow_state_behind({ base });
    case "ci_failed":
      return m.prrow_state_ci_failed();
    case "ci_running":
      return m.prrow_state_ci_running();
    case "protected":
      return m.prrow_state_protected();
    case "ready":
      return m.gitrail_ready_to_merge();
    case "merged":
      return m.prrow_state_merged();
  }
}

/** The Merge button's label: a local forge merges locally, an epic child into its epic. */
export function mergeActionLabel(local: boolean, epicChild: boolean): string {
  if (local) return m.gitrail_merge_locally();
  if (epicChild) return m.gitrail_merge_into_epic();
  return m.gitrail_merge();
}

export type PrRowFactTone = "ok" | "pending" | "fail";

/** One merge prerequisite under the row's title. The text carries the meaning; the glyph
 *  ({@link FACT_GLYPH}) only reinforces it. */
export interface PrRowFact {
  id: "ci" | "critic" | "base" | "conflicts";
  tone: PrRowFactTone;
  text: string;
}

export const FACT_GLYPH: Record<PrRowFactTone, string> = { ok: "✓", pending: "◌", fail: "✗" };

// The merge states in which GitHub has measured the branch and found neither a conflict nor
// staleness. `blocked`/`draft` can mask the others, `dirty` is the conflict itself, `unknown` is
// not a measurement — a fact there would be a guess, so it is left out instead.
const MEASURED_CLEAN: ReadonlySet<MergeStateStatus> = new Set(["clean", "unstable", "has_hooks"]);

function ciFact(checks: GitState["checks"]): PrRowFact {
  if (checks === "success") return { id: "ci", tone: "ok", text: m.prrow_fact_ci_passing() };
  if (checks === "failure") return { id: "ci", tone: "fail", text: m.prrow_fact_ci_failed() };
  if (checks === "pending") return { id: "ci", tone: "pending", text: m.prrow_fact_ci_running() };
  return { id: "ci", tone: "pending", text: m.prrow_fact_ci_none() };
}

function criticFact(chip: CriticChip, criticOn: boolean): PrRowFact | null {
  if (chip.kind === "reviewing")
    return { id: "critic", tone: "pending", text: m.prrow_fact_critic_reviewing() };
  if (chip.kind === "verdict") {
    if (chip.decision === "commented")
      return { id: "critic", tone: "ok", text: m.prrow_fact_critic_reviewed() };
    if (chip.decision === "changes_requested")
      return { id: "critic", tone: "fail", text: m.prrow_fact_critic_changes() };
    return { id: "critic", tone: "fail", text: m.prrow_fact_critic_error() };
  }
  // No verdict yet: worth a line only where a critic will actually run.
  return criticOn ? { id: "critic", tone: "pending", text: m.prrow_fact_critic_pending() } : null;
}

function baseFact(git: GitState, base: string): PrRowFact | null {
  if (git.mergeStateStatus === "behind")
    return { id: "base", tone: "fail", text: m.prrow_fact_base_behind({ base }) };
  if (git.mergeStateStatus && MEASURED_CLEAN.has(git.mergeStateStatus))
    return { id: "base", tone: "ok", text: m.prrow_fact_base_current({ base }) };
  return null;
}

function conflictFact(git: GitState): PrRowFact | null {
  if (isConflicting(git)) return { id: "conflicts", tone: "fail", text: m.prrow_fact_conflicts() };
  if (git.mergeable === true || (git.mergeStateStatus && MEASURED_CLEAN.has(git.mergeStateStatus)))
    return { id: "conflicts", tone: "ok", text: m.prrow_fact_no_conflicts() };
  return null;
}

/** The row's fact line, in reading order: CI · critic · base · conflicts. A fact the host did
 *  not measure is left out rather than shown as a guess. */
export function prRowFacts(input: {
  git: GitState;
  chip: CriticChip;
  /** The repo runs the critic, so a missing verdict is still to come. */
  criticOn: boolean;
  base: string;
}): PrRowFact[] {
  const { git, chip, criticOn, base } = input;
  if (git.state === "merged") return [];
  return [
    ciFact(git.checks),
    criticFact(chip, criticOn),
    baseFact(git, base),
    conflictFact(git),
  ].filter((f): f is PrRowFact => f !== null);
}
