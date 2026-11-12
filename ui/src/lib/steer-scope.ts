import type { AgentProvider, RemoteRepo, Steer } from "./types";

/** A repo name, the names a repo goes by, or null when the repo can't be resolved. */
export type SteerRepoNames = string | readonly string[] | null;

/** Does this steer apply to a repo, given the repo's resolved NAME(s) (null when the
 *  repo can't be resolved / not loaded)? Empty/absent allowlist = universal. A
 *  non-empty allowlist with a null, empty or non-member name = hidden (NOT universal). */
function steerApplies(
  steer: Steer,
  { repoNames, provider }: { repoNames: SteerRepoNames; provider?: AgentProvider },
): boolean {
  const names = repoNames == null ? [] : typeof repoNames === "string" ? [repoNames] : repoNames;
  const repoOk =
    !steer.repos || steer.repos.length === 0 || names.some((n) => steer.repos!.includes(n));
  if (!repoOk) return false;
  if (!provider || !steer.agentProviders || steer.agentProviders.length === 0) return true;
  return steer.agentProviders.includes(provider);
}

export function steerAppliesToRepo(
  steer: Steer,
  repoNames: SteerRepoNames,
  provider?: AgentProvider,
): boolean {
  return steerApplies(steer, { repoNames, provider });
}

/** A checkout as the steer scope sees it: its path (either form), its name here and its
 *  forge slug, both null when this Shepherd doesn't know the path. */
export interface SteerScopeRepo {
  path: string;
  localName: string | null;
  slug: string | null;
}

/** The repo names a settings source's steers (#3967) call a checkout by. Those steers name
 *  the SOURCE machine's repos, so a checkout resolves through it: one of the source's own
 *  checkouts (a mirrored session's path, either form) is its name there; any other checkout
 *  is every source repo with the same forge slug (case-insensitive), never a directory name.
 *  Without a source, the local name as before. Mirrors native `SteerScope.repoNames`. */
export function steerRepoNames(
  repo: SteerScopeRepo,
  sourceRepos: readonly RemoteRepo[] | null,
): string[] {
  if (!sourceRepos) return repo.localName ? [repo.localName] : [];
  const own = sourceRepos.find((r) => r.path === repo.path || r.realPath === repo.path);
  if (own) return [own.name];
  const slug = repo.slug?.toLowerCase();
  if (!slug) return [];
  return [
    ...new Set(sourceRepos.filter((r) => r.remoteSlug?.toLowerCase() === slug).map((r) => r.name)),
  ];
}
