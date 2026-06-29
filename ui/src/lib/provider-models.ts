import { CODEX_MODELS, MODELS, type AgentProvider } from "$lib/types";

/** The selectable model aliases for a provider (Claude vs Codex curated lists). */
export function providerModels(provider: AgentProvider): readonly string[] {
  return provider === "codex" ? CODEX_MODELS : MODELS;
}

/** Whether a model alias is offerable for a provider. "default" (provider default) is always
 *  available; Claude's `fable` is hidden when globally unavailable; otherwise it must be in the
 *  provider's curated list. Shared by the New Task settings and the variant/compare picker. */
export function modelAvailableForProvider(
  provider: AgentProvider,
  value: string,
  fableAvailable: boolean,
): boolean {
  if (value === "default") return true;
  if (provider === "claude" && value === "fable" && !fableAvailable) return false;
  return (providerModels(provider) as readonly string[]).includes(value);
}
