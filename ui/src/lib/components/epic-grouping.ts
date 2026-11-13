import type {
  Session,
  GitState,
  Epic,
  EpicChild,
  RemoteEpic,
  RemoteSettleReason,
  SessionHost,
} from "#lib/types.js";
import { partitionSessions, flattenByStage, mirroredGit } from "./herd-partition";

/** An epic a connected machine's drain leads carries its `host`; this Shepherd's own do not. */
export function isRemoteEpic(e: Epic): e is RemoteEpic {
  return "host" in e && !!(e as Partial<RemoteEpic>).host;
}

/** A remote epic's group key: its machine, that machine's checkout and the parent issue — never
 *  the shape of a local key (`${repoPath}#${parent}`, repoPath absolute). */
export function remoteEpicKey(e: RemoteEpic): string {
  return `remote:${e.host.instanceId}:${e.repoPath}#${e.parentIssueNumber}`;
}

/** This Shepherd's epics and active keys with the connected machines' epics added — every remote
 *  epic is active (its machine reports only the ones its drain leads). */
export function withRemoteEpics(
  epics: Record<string, Epic>,
  activeKeys: ReadonlySet<string>,
  remote: readonly RemoteEpic[],
): { epics: Record<string, Epic>; keys: Set<string> } {
  if (remote.length === 0) return { epics, keys: new Set(activeKeys) };
  const merged: Record<string, Epic> = { ...epics };
  const keys = new Set(activeKeys);
  for (const e of remote) {
    const key = remoteEpicKey(e);
    merged[key] = e;
    keys.add(key);
  }
  return { epics: merged, keys };
}

/** A mirrored session's identity as an epic child's `elsewhere` names it: the machine and the
 *  session there. */
const sentKey = (instanceId: string, sessionId: string) => `${instanceId}#${sessionId}`;

/** `sentKey` → epic key for every child of the given epics that the drain sent to another machine
 *  and whose start there is confirmed (`elsewhere.sessionId` set). */
function sentIndex(epics: Record<string, Epic>, keys: Iterable<string>): Map<string, string> {
  const index = new Map<string, string>();
  for (const epicKey of keys) {
    for (const c of epics[epicKey]?.children ?? []) {
      const sent = c.elsewhere;
      if (sent?.sessionId) index.set(sentKey(sent.host.instanceId, sent.sessionId), epicKey);
    }
  }
  return index;
}

/** The epic key a mirrored session belongs to, or undefined — never for a shelved one. */
function sentEpicOf(s: Session, index: ReadonlyMap<string, string>): string | undefined {
  return s.host && !s.shelved ? index.get(sentKey(s.host.instanceId, s.id)) : undefined;
}

/** `${repoPath}#${childIssueNumber}` → epic key, from the given epics' children (repo-scoped).
 *  Remote epics are skipped: a local session never joins one. */
function childIndex(epics: Record<string, Epic>, keys: Iterable<string>): Map<string, string> {
  const index = new Map<string, string>();
  for (const epicKey of keys) {
    const epic = epics[epicKey];
    if (!epic || isRemoteEpic(epic)) continue;
    for (const c of epic.children) index.set(`${epic.repoPath}#${c.number}`, epicKey);
  }
  return index;
}

/** `${instanceId}:${repoPath}#${childIssueNumber}` → epic key, from the given remote epics'
 *  children — keyed by the machine and its checkout, as its mirrored sessions name them. */
function remoteChildIndex(
  epics: Record<string, Epic>,
  keys: Iterable<string>,
): Map<string, string> {
  const index = new Map<string, string>();
  for (const epicKey of keys) {
    const epic = epics[epicKey];
    if (!epic || !isRemoteEpic(epic)) continue;
    for (const c of epic.children) {
      index.set(`${epic.host.instanceId}:${epic.repoPath}#${c.number}`, epicKey);
    }
  }
  return index;
}

/** The remote epic key a mirrored session belongs to as a child of its machine's epic, or
 *  undefined — never for a shelved one. */
function remoteEpicOf(s: Session, index: ReadonlyMap<string, string>): string | undefined {
  return !s.host || s.shelved || s.issueNumber == null
    ? undefined
    : index.get(`${s.host.instanceId}:${s.repoPath}#${s.issueNumber}`);
}

/** The epic key a local session belongs to, or undefined. A shelved child renders in the Shelved
 *  group, never its epic. */
function localEpicOf(s: Session, index: ReadonlyMap<string, string>): string | undefined {
  return s.shelved || s.issueNumber == null
    ? undefined
    : index.get(`${s.repoPath}#${s.issueNumber}`);
}

/** #3016: a session whose own PR is the one its epic integrated for its child — merged work, not
 *  active epic work. It leaves the epic's group for the lifecycle groups (Merged), where the herd
 *  names the epic and, for one on another machine, why its settle there is still open. An issue
 *  merely closed, a PR merged elsewhere, or an integration without a known PR never qualifies. */
export function isIntegratedMember(
  child: EpicChild | undefined,
  git: GitState | undefined,
): boolean {
  const pr = child?.integratedPrNumber;
  return pr != null && git?.state === "merged" && git.number === pr;
}

/** #3016: what the herd shows on a session {@link isIntegratedMember} moved out of its epic group:
 *  its epic and — for one on another machine whose settle there is still open — that machine and
 *  why (`null` when nothing is open, and for a local session). */
export interface IntegratedNote {
  parentIssueNumber: number;
  host: SessionHost | null;
  settle: RemoteSettleReason | null;
}

/** The child of `epic` a session is the work of: the one its `elsewhere` names for a mirrored
 *  session the drain sent, else the one its issue number is. */
function childOf(epic: Epic | undefined, s: Session): EpicChild | undefined {
  if (!epic) return undefined;
  const sent = s.host
    ? epic.children.find(
        (c) =>
          c.elsewhere?.sessionId === s.id && c.elsewhere.host.instanceId === s.host!.instanceId,
      )
    : undefined;
  return sent ?? epic.children.find((c) => c.number === s.issueNumber);
}

/** Adds each session `epicOf` places to its epic's bucket in `members`; returns the others in
 *  input order. */
function collectMembers(
  sessions: readonly Session[],
  epicOf: (s: Session) => string | undefined,
  members: Map<string, Session[]>,
): Session[] {
  const rest: Session[] = [];
  for (const s of sessions) {
    const epicKey = epicOf(s);
    if (epicKey === undefined) rest.push(s);
    else members.set(epicKey, [...(members.get(epicKey) ?? []), s]);
  }
  return rest;
}

/** Group sessions under their parent epic. Pure; shared by the Herd render and the
 *  keyboard-nav rail so the two can never drift on membership or order.
 *
 *  Membership (the bug #585 got wrong): a session belongs to epic `E` iff
 *  `E`'s key is in `activeEpicKeys`, `E.repoPath === session.repoPath`, and some
 *  `E.children[].number === session.issueNumber`. Match on the **child** issue
 *  number, never the parent — a session whose `issueNumber` equals an epic's
 *  `parentIssueNumber` must NOT group. A `null` `issueNumber` is never a child.
 *
 *  A session mirrored from a connected machine (`mirrored`, #3055) carries that machine's
 *  checkout as `repoPath`, so it matches differently: it belongs to `E` iff `E`'s key is in
 *  `activeEpicKeys` and some child's `elsewhere` (the drain sent it there) names this session —
 *  same `host.instanceId` and `sessionId === session.id`. Failing that, it belongs to a remote
 *  epic (one a connected machine's drain leads, carrying `host`) iff same `host.instanceId`, same
 *  `repoPath` (that machine's checkout) and `issueNumber` is a child number. A shelved one never
 *  groups; a local session never joins a remote epic. Mirrored members are staged by the PR state
 *  their machine reports (`session.git`).
 *
 *  `epics` is keyed `${repoPath}#${parentIssueNumber}`; it can hold stale/idle
 *  epics, and FINISHED epics are pruned from it (HerdStore.setEpic drops
 *  idle+all-merged records) — so an `activeEpicKeys` entry may briefly lack its
 *  record here (skipped below). `activeEpicKeys` (same key shape) gates which
 *  epics group. Groups are sorted by repo basename then `parentIssueNumber`; each group's
 *  sessions are ordered by lifecycle stage via `flattenByStage(partitionSessions(...))`.
 *  `rest` (local non-members) and `mirroredRest` (mirrored non-members) preserve input order and
 *  are NOT reordered. */
export function groupSessionsByEpic(
  sessions: Session[],
  epics: Record<string, Epic>,
  activeEpicKeys: Set<string>,
  git: Record<string, GitState>,
  isReviewing: (id: string) => boolean,
  isReworkRunning: (session: Session) => boolean,
  now: number,
  mirrored: readonly Session[] = [],
): {
  groups: Array<{ key: string; epic: Epic; sessions: Session[] }>;
  rest: Session[];
  mirroredRest: Session[];
  /** #3016: sessions left out of their epic as integrated work, by id ({@link isIntegratedMember}). */
  integrated: Map<string, IntegratedNote>;
} {
  const members = new Map<string, Session[]>(); // epicKey → member sessions (input order)
  const groupGit = mirrored.length > 0 ? { ...git, ...mirroredGit(mirrored) } : git;
  const integrated = new Map<string, IntegratedNote>();
  /** `epicKey`, unless the session is integrated work of that epic (then noted, not placed). */
  const unlessIntegrated = (s: Session, epicKey: string | undefined): string | undefined => {
    if (epicKey === undefined) return undefined;
    const epic = epics[epicKey];
    const child = childOf(epic, s);
    if (!epic || !isIntegratedMember(child, groupGit[s.id])) return epicKey;
    const settle = child?.remoteSettle?.sessionId === s.id ? child.remoteSettle : undefined;
    integrated.set(s.id, {
      parentIssueNumber: epic.parentIssueNumber,
      host: s.host ?? null,
      settle: settle?.reason ?? null,
    });
    return undefined;
  };
  const local = childIndex(epics, activeEpicKeys);
  const rest = collectMembers(sessions, (s) => unlessIntegrated(s, localEpicOf(s, local)), members);
  const sent = sentIndex(epics, activeEpicKeys);
  const remote = remoteChildIndex(epics, activeEpicKeys);
  const mirroredRest = collectMembers(
    mirrored,
    (s) => unlessIntegrated(s, sentEpicOf(s, sent) ?? remoteEpicOf(s, remote)),
    members,
  );

  const groups = [...members.entries()]
    .map(([key, memberSessions]) => ({
      key,
      // key came from childIndex, sentIndex or remoteChildIndex, all built only from loaded epics.
      epic: epics[key],
      sessions: flattenByStage(
        partitionSessions(memberSessions, groupGit, isReviewing, isReworkRunning, now),
      ),
    }))
    .sort(byRepoThenParent);

  return { groups, rest, mirroredRest, integrated };
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
 *  its children (same `repoPath`, `issueNumber` = a child number) and no session in `mirrored` is
 *  one the drain sent for a child (matched as in `groupSessionsByEpic`). For a remote epic the
 *  first check is instead a mirrored session from its own machine that is one of its children (a
 *  local session never counts); the sent-child check (`elsewhere`, any machine) applies to it as
 *  well. Pass every local session the view lists — shelved and experiment members included — and
 *  the mirrored ones it lists, so an epic whose child renders elsewhere in the list never also shows as session-less. Sorted like
 *  `groupSessionsByEpic`. `integrated` (#3016): the ids `groupSessionsByEpic` moved out as
 *  integrated work — they list no child, so an epic left with only those shows as session-less. */
export function sessionlessEpicGroups(
  sessions: readonly Session[],
  epics: Record<string, Epic>,
  activeEpicKeys: ReadonlySet<string>,
  repoFilter: ReadonlySet<string>,
  completedKeys: ReadonlySet<string>,
  mirrored: readonly Session[] = [],
  integrated: ReadonlySet<string> = new Set(),
): Array<{ key: string; epic: Epic; sessions: Session[] }> {
  // #3016: integrated work left its epic's group (groupSessionsByEpic) — it lists no child here.
  const live = sessions.filter((s) => !integrated.has(s.id));
  const liveThere = mirrored.filter((s) => !integrated.has(s.id));
  const withSession = new Set(
    live.flatMap((s) => (s.issueNumber == null ? [] : [`${s.repoPath}#${s.issueNumber}`])),
  );
  const listedThere = new Set(
    liveThere.flatMap((s) => (s.host ? [sentKey(s.host.instanceId, s.id)] : [])),
  );
  const remoteListed = new Set(
    liveThere.flatMap((s) =>
      s.host && s.issueNumber != null
        ? [`${s.host.instanceId}:${s.repoPath}#${s.issueNumber}`]
        : [],
    ),
  );
  // A child is listed by its own session (a local one for a local epic, one from the epic's machine
  // for a remote epic) or by the session its `elsewhere` names on another machine — the same two
  // ways `groupSessionsByEpic` places a member, so a grouped epic never also shows session-less.
  const ownListed = (epic: Epic, c: Epic["children"][number]) =>
    isRemoteEpic(epic)
      ? remoteListed.has(`${epic.host.instanceId}:${epic.repoPath}#${c.number}`)
      : withSession.has(`${epic.repoPath}#${c.number}`);
  const listed = (epic: Epic) =>
    epic.children.some(
      (c) =>
        ownListed(epic, c) ||
        (!!c.elsewhere?.sessionId &&
          listedThere.has(sentKey(c.elsewhere.host.instanceId, c.elsewhere.sessionId))),
    );
  const groups: Array<{ key: string; epic: Epic; sessions: Session[] }> = [];
  for (const key of activeEpicKeys) {
    const epic = epics[key];
    if (!epic || completedKeys.has(key) || !waitsInView(epic, repoFilter) || listed(epic)) continue;
    groups.push({ key, epic, sessions: [] });
  }
  return groups.sort(byRepoThenParent);
}

/** A running or paused epic, not all-merged, whose repo passes `repoFilter` (empty = all). A
 *  remote epic's checkout is never one of this Shepherd's paths: the caller filters those by
 *  project slug (`inRepoFilter`) before they get here. */
function waitsInView(epic: Epic, repoFilter: ReadonlySet<string>): boolean {
  if (epic.run.status !== "running" && epic.run.status !== "paused") return false;
  if (repoFilter.size > 0 && !isRemoteEpic(epic) && !repoFilter.has(epic.repoPath)) return false;
  const { children } = epic;
  return !(children.length > 0 && children.every((c) => c.state === "merged"));
}
