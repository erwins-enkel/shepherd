import type { DrainStatus, Epic, EpicChild } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";
import { byEpicOrder } from "#lib/epic-timing-text.js";
import { epicHoldLine } from "./epic-panel";
import { openBlockers } from "./epic-child";

/** What a session-less epic group (#3814) says: the run status against the agents actually
 *  working, and why it waits. */
export interface SessionlessEpicWait {
  /** "Running · no agent active here" / "Paused · no agent active here". */
  status: string;
  /** Why it waits, from ONE source — the pause, the drain's hold on this epic, or its children.
   *  The explicit "unknown" sentence when none explains it; never empty. */
  lines: string[];
}

/** The wait picture of a running or paused epic with no child session here. `drain` is the
 *  REPO's status; its hold and next-up only count while it runs this epic (`epicParent`).
 *  Claims are reported as facts only: a claimed child without session or PR reads as
 *  "ownership unknown", never as an ongoing review. */
export function sessionlessEpicWait(
  epic: Pick<Epic, "run" | "children" | "parentIssueNumber">,
  drain: DrainStatus | null | undefined,
): SessionlessEpicWait {
  const paused = epic.run.status === "paused";
  const lines = waitLines(epic, drain, paused);
  return {
    status: paused ? m.epic_sessionless_paused() : m.epic_sessionless_running(),
    lines: lines.length > 0 ? lines : [m.epic_sessionless_unknown()],
  };
}

function waitLines(
  epic: Pick<Epic, "children" | "parentIssueNumber">,
  drain: DrainStatus | null | undefined,
  paused: boolean,
): string[] {
  if (paused) return [m.epic_sessionless_reason_paused()];
  const own = drain?.epicParent === epic.parentIssueNumber ? drain : null;
  // `empty` is no hold of its own: the children below say what it waits on.
  const hold = own?.reason === "empty" ? null : epicHoldLine(own, true, epic.children);
  if (hold) return [hold];
  const children = [...epic.children].sort(byEpicOrder);
  const inFlight = children.filter((c) => c.state === "running" || c.state === "in-review");
  const flying = new Set(inFlight.map((c) => c.number));
  const lines = inFlight.map(inFlightLine);
  for (const c of children) {
    if (c.state !== "blocked") continue;
    const blockers = openBlockers(c, children);
    if (!blockers.some((b) => flying.has(b))) continue;
    lines.push(
      m.epic_sessionless_waits_on({
        number: c.number,
        blockers: blockers.map((b) => `#${b}`).join(", "),
      }),
    );
  }
  const next = own?.runSummary?.next[0];
  if (lines.length === 0 && next != null) lines.push(m.epic_sessionless_next({ number: next }));
  return lines;
}

/** An in-flight child with no session here: where it is handled, its PR, or that nobody known
 *  holds it. */
function inFlightLine(c: EpicChild): string {
  if (c.elsewhere)
    return m.epic_sessionless_elsewhere({ number: c.number, machine: c.elsewhere.host.name });
  const pr = c.retiredPrNumber ?? c.prNumber;
  if (pr != null) return m.epic_sessionless_pr_open({ number: c.number, pr });
  return c.claimed
    ? m.epic_sessionless_claimed_unknown({ number: c.number })
    : m.epic_sessionless_inflight_unknown({ number: c.number });
}
