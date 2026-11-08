import { AGENT_PROVIDERS, type AgentProvider } from "./types";
import { modelCompatibleWithProvider } from "./default-model";
import { effortsForProvider } from "./default-effort";

export function normalizeAgentProvider(value: unknown): AgentProvider | null {
  return (AGENT_PROVIDERS as readonly unknown[]).includes(value) ? (value as AgentProvider) : null;
}

/** A repo's coding-CLI SETTING (#3441): "inherit" (the default) follows the global
 *  `defaultAgentProvider`; a provider pins that repo's new spawns to it. */
export type RepoAgentProviderSetting = "inherit" | AgentProvider;

/** Normalize a stored / requested repo coding-CLI setting, or null if unrecognised. */
export function normalizeRepoAgentProviderSetting(value: unknown): RepoAgentProviderSetting | null {
  if (value === "inherit") return "inherit";
  return normalizeAgentProvider(value);
}

/**
 * The CLI a new spawn runs (#3441): an explicit choice (the task's own pick, a held row's frozen
 * provider, or a running epic's own CLI) → the repo's setting unless "inherit" (or unset/invalid)
 * → the global default. The global default is read by the caller at spawn time, so an inheriting
 * repo follows a later global switch (and the weekly-limit failover).
 */
export function resolveSpawnAgentProvider(
  explicit: AgentProvider | null | undefined,
  repoSetting: string | null | undefined,
  globalProvider: AgentProvider,
): AgentProvider {
  if (explicit) return explicit;
  return normalizeAgentProvider(repoSetting) ?? globalProvider;
}

/** Whether a repo default-model SETTING can run on `provider`: "inherit"/"auto"/"default" fit
 *  every CLI (no `--model` of their own); an alias must belong to that CLI. */
export function repoModelFitsProvider(setting: string, provider: AgentProvider): boolean {
  if (setting === "inherit" || setting === "auto" || setting === "default") return true;
  return modelCompatibleWithProvider(setting, provider);
}

/** Whether a repo default-effort SETTING can run on `provider` ("ultra" is Codex-only). */
export function repoEffortFitsProvider(setting: string, provider: AgentProvider): boolean {
  if (setting === "inherit" || setting === "default") return true;
  return effortsForProvider(provider).includes(setting);
}

/**
 * Write-time clamp for a repo-config edit that sets `agentProvider` (#3441): the repo's default
 * model / effort (the co-patched value, else the stored one) that the new effective CLI cannot run
 * falls back to "inherit" in the same write. Returns only the fields to override; empty when the
 * edit does not touch the CLI.
 */
export function clampRunDefaultsToCli(
  current: { defaultModel: string; defaultEffort: string },
  patch: {
    agentProvider?: RepoAgentProviderSetting;
    defaultModel?: string;
    defaultEffort?: string;
  },
  globalProvider: AgentProvider,
): { defaultModel?: "inherit"; defaultEffort?: "inherit" } {
  if (patch.agentProvider === undefined) return {};
  const cli = resolveSpawnAgentProvider(undefined, patch.agentProvider, globalProvider);
  const out: { defaultModel?: "inherit"; defaultEffort?: "inherit" } = {};
  if (!repoModelFitsProvider(patch.defaultModel ?? current.defaultModel, cli))
    out.defaultModel = "inherit";
  if (!repoEffortFitsProvider(patch.defaultEffort ?? current.defaultEffort, cli))
    out.defaultEffort = "inherit";
  return out;
}
