import type { Steer } from "./types";
import type { AgentProvider } from "./types";

/** Does this steer apply to a repo, given the repo's resolved NAME (null when the
 *  repo can't be resolved / not loaded)? Empty/absent allowlist = universal. A
 *  non-empty allowlist with a null or non-member name = hidden (NOT universal). */
export function steerApplies(
  steer: Steer,
  { repoName, provider }: { repoName: string | null; provider?: AgentProvider },
): boolean {
  const repoOk =
    !steer.repos ||
    steer.repos.length === 0 ||
    (repoName != null && steer.repos.includes(repoName));
  if (!repoOk) return false;
  if (!provider || !steer.agentProviders || steer.agentProviders.length === 0) return true;
  return steer.agentProviders.includes(provider);
}

export function steerAppliesToRepo(
  steer: Steer,
  repoName: string | null,
  provider?: AgentProvider,
): boolean {
  return steerApplies(steer, { repoName, provider });
}
