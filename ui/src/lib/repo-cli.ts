import type { AgentProvider, RepoAgentProviderSetting } from "#lib/types.js";
import { providerModels } from "#lib/provider-models.js";
import { providerEfforts } from "#lib/effort-guidance.js";

// A repo's own coding CLI (#3441). Mirrors resolveSpawnAgentProvider / repoModelFitsProvider /
// repoEffortFitsProvider in src/agent-provider.ts — keep the two aligned.

/** The CLI a repo's new tasks start on: its own setting, else the global default. */
export function effectiveRepoProvider(
  setting: RepoAgentProviderSetting | undefined,
  globalProvider: AgentProvider,
): AgentProvider {
  return setting && setting !== "inherit" ? setting : globalProvider;
}

/** The repo's own CLI when it pins one, else null (it inherits the global default). */
export function repoPinnedProvider(
  setting: RepoAgentProviderSetting | undefined,
): AgentProvider | null {
  return setting && setting !== "inherit" ? setting : null;
}

/** Whether a repo default-model SETTING can run on `provider`: the sentinels fit every CLI, an
 *  alias only its own. */
export function repoModelFitsProvider(setting: string, provider: AgentProvider): boolean {
  if (setting === "inherit" || setting === "auto" || setting === "default") return true;
  return (providerModels(provider) as readonly string[]).includes(setting);
}

/** Whether a repo default-effort SETTING can run on `provider` ("ultra" is Codex-only). */
export function repoEffortFitsProvider(setting: string, provider: AgentProvider): boolean {
  if (setting === "inherit" || setting === "default") return true;
  return providerEfforts(provider).includes(setting);
}
