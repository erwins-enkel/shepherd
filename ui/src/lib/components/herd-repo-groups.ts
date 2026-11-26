import type { Session } from "#lib/types.js";
import { basename } from "#lib/basename.js";

/** One repo section of the herd's Repo layout (#4228). `iconPath` is the local checkout whose
 *  project icon the heading shows; null for a section only other machines' sessions fill. */
export type RepoGroup = {
  key: string;
  name: string;
  iconPath: string | null;
  sessions: Session[];
};

/** A row's stage named on the row itself, for the Repo layout where no stage heading says it:
 *  only stages no other badge on the row conveys (Merge, waiting on someone else, shelved). */
export type StageTag = { label: string; tone: "merge" | "waiting" | "shelved" };

const REMOTE_PREFIX = "remote:";

/** The section key each session groups under. A local session keys by its `repoPath`. A
 *  mirrored one (#3055) keys by repo name: it joins the local section among `local` whose
 *  basename matches (the first such path alphabetically), else a section of its own,
 *  `remote:<name>`. Render and keyboard nav build it from the same listed local sessions, so
 *  they agree on every key. */
export function repoKeyFn(local: readonly Session[]): (s: Session) => string {
  const pathByName = new Map<string, string>();
  const paths = [...new Set(local.filter((s) => !s.host).map((s) => s.repoPath))].sort();
  for (const path of paths) {
    const name = basename(path);
    if (!pathByName.has(name)) pathByName.set(name, path);
  }
  return (s) => {
    if (!s.host) return s.repoPath;
    const name = basename(s.repoPath);
    return pathByName.get(name) ?? `${REMOTE_PREFIX}${name}`;
  };
}

function groupOf(key: string): RepoGroup {
  const remote = key.startsWith(REMOTE_PREFIX);
  return {
    key,
    name: remote ? key.slice(REMOTE_PREFIX.length) : basename(key),
    iconPath: remote ? null : key,
    sessions: [],
  };
}

/** `ordered` split into repo sections, alphabetical by name (key breaks ties) so a section
 *  never moves when statuses change. Each section keeps the input order of its sessions. */
export function groupByRepo(
  ordered: readonly Session[],
  keyOf: (s: Session) => string,
): RepoGroup[] {
  const groups = new Map<string, RepoGroup>();
  for (const s of ordered) {
    const key = keyOf(s);
    let group = groups.get(key);
    if (!group) {
      group = groupOf(key);
      groups.set(key, group);
    }
    group.sessions.push(s);
  }
  return [...groups.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}
