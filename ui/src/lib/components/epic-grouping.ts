import type { Session, GitState, Epic } from "#lib/types.js";
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
 *  `epics` is keyed `${repoPath}#${parentIssueNumber}`; it can hold stale/idle
 *  epics, and FINISHED epics are pruned from it (HerdStore.setEpic drops
 *  idle+all-merged records) — so an `activeEpicKeys` entry may briefly lack its
 *  record here (skipped below). `activeEpicKeys` (same key shape) gates which
 *  epics group. Groups are sorted by repo basename then `parentIssueNumber`; each group's
 *  sessions are ordered by lifecycle stage via `flattenByStage(partitionSessions(...))`.
 *  `rest` (non-members) preserves input order and is NOT reordered. */
export function groupSessionsByEpic(
  sessions: Session[],
  epics: Record<string, Epic>,
  activeEpicKeys: Set<string>,
  git: Record<string, GitState>,
  isReviewing: (id: string) => boolean,
  isReworkRunning: (session: Session) => boolean,
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
    // A shelved child renders in the Shelved group, never its epic.
    const epicKey =
      s.shelved || s.issueNumber == null
        ? undefined
        : childIndex.get(`${s.repoPath}#${s.issueNumber}`);
    if (epicKey === undefined) {
      rest.push(s);
      continue;
    }
    const bucket = members.get(epicKey);
    if (bucket) bucket.push(s);
    else members.set(epicKey, [s]);
  }

  const groups = [...members.entries()]
    .map(([key, memberSessions]) => ({
      key,
      // key came from childIndex, which is built only from epics present above → defined.
      epic: epics[key],
      sessions: flattenByStage(
        partitionSessions(memberSessions, git, isReviewing, isReworkRunning, now),
      ),
    }))
    .sort(byRepoThenParent);

  return { groups, rest };
}

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Group order: repo basename, then `parentIssueNumber`. */
function byRepoThenParent(a: { epic: Epic }, b: { epic: Epic }): number {
  const byRepo = basename(a.epic.repoPath).localeCompare(basename(b.epic.repoPath));
  if (byRepo !== 0) return byRepo;
  return a.epic.parentIssueNumber - b.epic.parentIssueNumber;
}

/** #3814: the active epics that have NO child session, as empty groups — so a running or paused
 *  epic stays visible in the herd while nothing works on it. `groupSessionsByEpic` only forms
 *  groups from members and stays the rail's source; these groups add no rows.
 *
 *  An epic qualifies when its key is in `activeEpicKeys`, its record is loaded, its run is
 *  running or paused, it is not all-merged, it is not in `completedKeys` (the integrated band
 *  shows it), its repo passes `repoFilter` (empty = all), and no session in `sessions` is one of
 *  its children (same `repoPath`, `issueNumber` = a child number). Pass every local session the
 *  view lists — shelved and experiment members included — so an epic whose child renders
 *  elsewhere in the list never also shows as session-less. Sorted like `groupSessionsByEpic`. */
export function sessionlessEpicGroups(
  sessions: readonly Session[],
  epics: Record<string, Epic>,
  activeEpicKeys: ReadonlySet<string>,
  repoFilter: ReadonlySet<string>,
  completedKeys: ReadonlySet<string>,
): Array<{ key: string; epic: Epic; sessions: Session[] }> {
  const withSession = new Set(
    sessions.flatMap((s) => (s.issueNumber == null ? [] : [`${s.repoPath}#${s.issueNumber}`])),
  );
  const groups: Array<{ key: string; epic: Epic; sessions: Session[] }> = [];
  for (const key of activeEpicKeys) {
    const epic = epics[key];
    if (!epic || completedKeys.has(key)) continue;
    if (epic.run.status !== "running" && epic.run.status !== "paused") continue;
    if (repoFilter.size > 0 && !repoFilter.has(epic.repoPath)) continue;
    const { children } = epic;
    if (children.length > 0 && children.every((c) => c.state === "merged")) continue;
    if (children.some((c) => withSession.has(`${epic.repoPath}#${c.number}`))) continue;
    groups.push({ key, epic, sessions: [] });
  }
  return groups.sort(byRepoThenParent);
}
