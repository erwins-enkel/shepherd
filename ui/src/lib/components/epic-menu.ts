import type { DrainStatus, Epic } from "#lib/types.js";
import { firstSafeHttpUrl } from "#lib/url.js";
import { epicRunState, queuePosition } from "./epic-panel";

/** What the herd's epic context menu offers for one epic, read from its run and the repo's drain. */
export interface EpicMenuModel {
  /** An attended run waits for the operator to approve its next child. */
  approve: boolean;
  pause: boolean;
  /** "resume" a paused run, "start" a stopped one. Null while it runs or is queued, and whenever
   *  starting here would supersede another epic or the repo's run picture is unknown: that start
   *  needs the epic detail's supersede dialog. */
  start: "start" | "resume" | null;
  unqueue: boolean;
  /** Offered while running or paused; `promotes` is the queued epic that then starts. */
  end: { promotes: number | null } | null;
  /** The run waits for the operator's approval before each child starts. */
  attended: boolean;
}

export function epicMenuModel(epic: Epic, drain: DrainStatus | null | undefined): EpicMenuModel {
  const parent = epic.parentIssueNumber;
  const status = epic.run.status;
  const summary = drain?.runSummary;
  const position = queuePosition(summary, parent);
  const leader = summary?.leadingEpic ?? null;
  const startable =
    status !== "running" && position == null && !!summary && (leader == null || leader === parent);
  return {
    approve: epicRunState(epic, parent, drain).kind === "awaiting_approval",
    pause: status === "running",
    start: startable ? (status === "paused" ? "resume" : "start") : null,
    unqueue: position != null && status !== "running",
    end:
      status === "running" || status === "paused"
        ? { promotes: leader === parent ? (summary?.queued?.[0] ?? null) : null }
        : null,
    attended: epic.run.mode === "attended",
  };
}

/** The epic's own issue URL, derived from a child's (Shepherd keys an epic's children by number in
 *  the epic's repo); null when no child carries a usable issue URL. */
export function epicIssueUrl(epic: Pick<Epic, "children" | "parentIssueNumber">): string | null {
  for (const c of epic.children) {
    const tail = `/issues/${c.number}`;
    if (!c.url.endsWith(tail)) continue;
    const url = firstSafeHttpUrl(
      `${c.url.slice(0, -tail.length)}/issues/${epic.parentIssueNumber}`,
    );
    if (url) return url;
  }
  return null;
}
