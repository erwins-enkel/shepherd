import { CODEX_MODELS, MODELS, type AgentProvider } from "$lib/types";

/** The selectable model aliases for a provider (Claude vs Codex curated lists). */
export function providerModels(provider: AgentProvider): readonly string[] {
  return provider === "codex" ? CODEX_MODELS : MODELS;
}

/** Whether a model value selects the Fable family — the floating alias `fable` or any pinned
 *  Fable model id (`claude-fable-5-1`). Mirrors `isFableModel` in src/default-model.ts: the
 *  availability guard keys off the FAMILY, so a pinned id is hidden and rerouted exactly like
 *  the alias. */
export function isFableModel(value: string | null | undefined): boolean {
  return value === "fable" || (typeof value === "string" && value.startsWith("claude-fable-"));
}

/** Whether a model alias is offerable for a provider. "default" (provider default) is always
 *  available; Claude's Fable entries are hidden when Fable is globally unavailable; otherwise it
 *  must be in the provider's curated list. Shared by the New Task settings and the
 *  variant/compare picker. */
export function modelAvailableForProvider(
  provider: AgentProvider,
  value: string,
  fableAvailable: boolean,
): boolean {
  if (value === "default") return true;
  if (provider === "claude" && isFableModel(value) && !fableAvailable) return false;
  return (providerModels(provider) as readonly string[]).includes(value);
}
