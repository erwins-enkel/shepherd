import type { AgentProvider, RepoAgentProviderSetting, Session } from "#lib/types.js";
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

interface RunDefaults {
  agentProvider: RepoAgentProviderSetting;
  defaultModel: string;
  defaultEffort: string;
  defaultExecutionEffort: string;
}

/** The repos with own values as they apply now (#3447): a stored model / effort the repo's
 *  effective CLI cannot run reads "inherit" (the spawn skips it, the repo settings show Inherit);
 *  a repo left with nothing of its own drops out. */
export function ownRunDefaults<T extends RunDefaults>(
  rows: readonly T[],
  globalProvider: AgentProvider,
): T[] {
  return rows
    .map((r) => {
      const cli = effectiveRepoProvider(r.agentProvider, globalProvider);
      return {
        ...r,
        defaultModel: repoModelFitsProvider(r.defaultModel, cli) ? r.defaultModel : "inherit",
        defaultEffort: repoEffortFitsProvider(r.defaultEffort, cli) ? r.defaultEffort : "inherit",
      };
    })
    .filter(
      (r) =>
        r.agentProvider !== "inherit" ||
        r.defaultModel !== "inherit" ||
        r.defaultEffort !== "inherit" ||
        r.defaultExecutionEffort !== "inherit",
    );
}

/** The repos a failover away from `provider` leaves behind (#3448): pinned to `provider`, with
 *  sessions on this machine. Counts the non-archived sessions, as the repo chip does; a repo
 *  without any drops out. Rows keep their order. Both sides carry the realpath'd repo path. */
export function reposStayingOn<
  T extends { repoPath: string; agentProvider: RepoAgentProviderSetting },
>(
  rows: readonly T[],
  sessions: readonly Pick<Session, "repoPath" | "status">[],
  provider: AgentProvider,
): (T & { sessions: number })[] {
  const counts = new Map<string, number>();
  for (const s of sessions)
    if (s.status !== "archived") counts.set(s.repoPath, (counts.get(s.repoPath) ?? 0) + 1);
  return rows.flatMap((r) => {
    const count = r.agentProvider === provider ? (counts.get(r.repoPath) ?? 0) : 0;
    return count > 0 ? [{ ...r, sessions: count }] : [];
  });
}
