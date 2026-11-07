import type { RepoEntry, Session } from "../types";
import { basename } from "#lib/basename.js";
import { inRepoFilter } from "#lib/remote-sessions.js";

/** The "decommission all merged" batch, split along the herd's repo filter. */
export interface ClearMergedScope {
  /** Merged sessions the filter shows — what the dialog's default action clears. */
  inside: Session[];
  /** Merged sessions in repos the filter hides; empty when the herd is unfiltered. */
  outside: Session[];
  /** `outside` counted per project, largest first, for the dialog's one-line summary. */
  outsideRepos: { name: string; count: number }[];
}

type ScopeRepo = Pick<RepoEntry, "path" | "realPath" | "remoteSlug">;

/** Split the server's merged set by the herd's repo filter (empty = every repo) with the herd's
 *  own matching, so "inside" is what the operator is looking at: a local session by `repoPath`, a
 *  session mirrored from a connected machine (#2765) by project slug (`inRepoFilter`), since its
 *  checkout never shares this host's path. */
export function scopeClearMerged(
  sessions: Session[],
  repoFilter: ReadonlySet<string>,
  repos: readonly ScopeRepo[],
): ClearMergedScope {
  if (repoFilter.size === 0) return { inside: sessions, outside: [], outsideRepos: [] };
  const keptMirrored = new Set(
    inRepoFilter(
      sessions.filter((s) => s.host),
      repoFilter,
      repos,
    ),
  );
  const shown = (s: Session) => (s.host ? keptMirrored.has(s) : repoFilter.has(s.repoPath));
  const inside = sessions.filter(shown);
  const outside = sessions.filter((s) => !shown(s));
  const counts = new Map<string, { name: string; count: number }>();
  for (const s of outside) {
    const { key, name } = projectOf(s, repos);
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { name, count: 1 });
  }
  const outsideRepos = [...counts.values()].sort((a, b) => b.count - a.count);
  return { inside, outside, outsideRepos };
}

/** The project a hidden session counts toward: its slug (a mirrored session's `remoteSlug`, a
 *  local one's checkout's), so this host's and another machine's checkout of one project count
 *  together, named after this host's checkout where it has one. Without a slug, its own path. */
function projectOf(s: Session, repos: readonly ScopeRepo[]): { key: string; name: string } {
  const slug = (
    s.host
      ? s.remoteSlug
      : repos.find((r) => r.path === s.repoPath || r.realPath === s.repoPath)?.remoteSlug
  )?.toLowerCase();
  if (!slug) return { key: `path:${s.repoPath}`, name: basename(s.repoPath) };
  const local = repos.find((r) => r.remoteSlug?.toLowerCase() === slug);
  return { key: `slug:${slug}`, name: basename(local?.path ?? s.repoPath) };
}

/** Leftover subprocesses the given sessions would take down; an id the server didn't count is 0. */
export function sumLeftovers(sessions: Session[], leftoversById: Record<string, number>): number {
  return sessions.reduce((n, s) => n + (leftoversById[s.id] ?? 0), 0);
}

/** Which parts of the merged set can't detect leftover processes (#3694): this host, and the
 *  connected machines (by `instanceId`) that said so. */
export interface ClearMergedProbes {
  here: boolean;
  machines: ReadonlySet<string>;
}

/** Where the given batch's leftover counts are unknown: `here` when it holds a local session and
 *  this host can't probe, plus the names of the blind machines whose sessions it holds (first
 *  appearance order). `exclude` drops what another caution already named. */
export function probeCaution(
  sessions: Session[],
  probes: ClearMergedProbes,
  exclude: { here: boolean; machines: string[] } = { here: false, machines: [] },
): { here: boolean; machines: string[] } {
  let here = false;
  const machines: string[] = [];
  for (const s of sessions) {
    if (!s.host) here ||= probes.here && !exclude.here;
    else if (
      probes.machines.has(s.host.instanceId) &&
      !machines.includes(s.host.name) &&
      !exclude.machines.includes(s.host.name)
    )
      machines.push(s.host.name);
  }
  return { here, machines };
}
