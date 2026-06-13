import type { Session, GitState, Epic } from "$lib/types";
import { partitionSessions, flattenByStage } from "./herd-partition";

/** Group sessions under their parent epic. Pure; shared by the Herd render and the
 *  keyboard-nav rail so the two can never drift on membership or order.
 *
 *  Membership (the bug #585 got wrong): a session belongs to epic `E` iff
 *  `E`'s key is in `activeEpicKeys`, `E.repoPath === session.repoPath`, and some
 *  `E.children[].number === session.issueNumber`. Match on the **child** issue
 *  number, never the parent — a session whose `issueNumber` equals an epic's
 *  `parentIssueNumber` must NOT group. A `null` `issueNumber` is never a child.
 *
 *  `epics` is keyed `${repoPath}#${parentIssueNumber}` and is never pruned, so it
 *  can hold stale/idle epics; `activeEpicKeys` (same key shape) gates which epics
 *  group. Groups are sorted by repo basename then `parentIssueNumber`; each group's
 *  sessions are ordered by lifecycle stage via `flattenByStage(partitionSessions(...))`.
 *  `rest` (non-members) preserves input order and is NOT reordered. */
export function groupSessionsByEpic(
  sessions: Session[],
  epics: Record<string, Epic>,
  activeEpicKeys: Set<string>,
  git: Record<string, GitState>,
  isReviewing: (id: string) => boolean,
  now: number,
): { groups: Array<{ key: string; epic: Epic; sessions: Session[] }>; rest: Session[] } {
  // Build a child→epicKey index from the ACTIVE epics only.
  // Keyed `${repoPath}#${childIssueNumber}` so membership respects repoPath.
  const childIndex = new Map<string, string>();
  for (const epicKey of activeEpicKeys) {
    const epic = epics[epicKey];
    if (!epic) continue;
    for (const c of epic.children) {
      childIndex.set(`${epic.repoPath}#${c.number}`, epicKey);
    }
  }

  const members = new Map<string, Session[]>(); // epicKey → member sessions (input order)
  const rest: Session[] = [];

  for (const s of sessions) {
    const epicKey =
      s.issueNumber == null ? undefined : childIndex.get(`${s.repoPath}#${s.issueNumber}`);
    if (epicKey === undefined) {
      rest.push(s);
      continue;
    }
    const bucket = members.get(epicKey);
    if (bucket) bucket.push(s);
    else members.set(epicKey, [s]);
  }

  const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

  const groups = [...members.entries()]
    .map(([key, memberSessions]) => ({
      key,
      // key came from childIndex, which is built only from epics present above → defined.
      epic: epics[key],
      sessions: flattenByStage(partitionSessions(memberSessions, git, isReviewing, now)),
    }))
    .sort((a, b) => {
      const byRepo = basename(a.epic.repoPath).localeCompare(basename(b.epic.repoPath));
      if (byRepo !== 0) return byRepo;
      return a.epic.parentIssueNumber - b.epic.parentIssueNumber;
    });

  return { groups, rest };
}
