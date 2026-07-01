import type { Steer } from "./types";

/** Does this steer apply to a repo, given the repo's resolved NAME (null when the
 *  repo can't be resolved / not loaded)? Empty/absent allowlist = universal. A
 *  non-empty allowlist with a null or non-member name = hidden (NOT universal). */
export function steerAppliesToRepo(steer: Steer, repoName: string | null): boolean {
  if (!steer.repos || steer.repos.length === 0) return true;
  return repoName != null && steer.repos.includes(repoName);
}
