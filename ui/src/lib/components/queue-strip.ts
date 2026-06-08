import type { AutoMergeStatus, DrainStatus } from "../types";
import { m } from "$lib/paraglide/messages";

/** Enabled drains only, sorted by repo path — the rows the QueueStrip renders. */
export function enabledDrains(drain: Record<string, DrainStatus>): DrainStatus[] {
  return Object.values(drain)
    .filter((d) => d.enabled)
    .sort((a, b) => a.repoPath.localeCompare(b.repoPath));
}

/** Whether the `queued` indicator is an interactive trigger (opens the queue
 *  popover) rather than inert text — true only when something is actually queued. */
export function queueOpenable(d: DrainStatus): boolean {
  return d.queued > 0;
}

/** Active (non-idle) merge-train statuses, sorted by repoPath. */
export function activeMergeTrain(autoMerge: Record<string, AutoMergeStatus>): AutoMergeStatus[] {
  return Object.values(autoMerge)
    .filter((s) => s.state !== null && s.state !== undefined)
    .sort((a, b) => a.repoPath.localeCompare(b.repoPath));
}

/** Whether the merge-train state is an attention/error state (vs active/in-progress). */
export function mergeTrainIsAttention(state: string): boolean {
  return state === "merge_error" || state === "rebase_cap";
}

/**
 * Localized label for a merge-train state code.
 * Returns an empty string for null/undefined (idle) — callers should guard before rendering.
 */
export function mergeTrainLabel(state: string | null | undefined): string {
  switch (state) {
    case "merging":
      return m.automerge_state_merging();
    case "rebasing":
      return m.automerge_state_rebasing();
    case "merge_error":
      return m.automerge_state_merge_error();
    case "rebase_cap":
      return m.automerge_state_rebase_cap();
    default:
      return "";
  }
}

/** Localized banner line for a paused drain, mapped from its reason + detail. */
export function pausedText(d: DrainStatus): string {
  const desig = d.detail ?? "";
  switch (d.reason) {
    case "blocked":
      return m.drain_paused_blocked({ desig });
    case "changes_requested":
      return m.drain_paused_changes({ desig });
    case "error":
      return m.drain_paused_error({ desig });
    case "usage":
      return m.drain_paused_usage({ pct: desig });
    default:
      return m.drain_paused_generic();
  }
}
