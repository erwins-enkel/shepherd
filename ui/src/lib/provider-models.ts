import { CODEX_MODELS, MODELS, type AgentProvider } from "#lib/types.js";
import { accountModels } from "#lib/account-models.svelte.js";

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

/** Whether a model value selects Claude Mythos — an account-gated model the logged-in Claude
 *  account may or may not be entitled to. Mirrors `isMythosModel` in src/claude-account-models.ts. */
function isMythosModel(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith("claude-mythos-");
}

/** Whether a model alias is offerable for a provider. "default" (provider default) is always
 *  available; Claude's Fable entries are hidden when Fable is globally unavailable, Mythos unless
 *  the logged-in account has it; otherwise it must be in the provider's curated list. Shared by
 *  the New Task settings and the variant/compare picker. */
export function modelAvailableForProvider(
  provider: AgentProvider,
  value: string,
  fableAvailable: boolean,
): boolean {
  if (value === "default") return true;
  if (provider === "claude" && isFableModel(value) && !fableAvailable) return false;
  if (isMythosModel(value) && !accountModels.mythosAvailable) return false;
  return (providerModels(provider) as readonly string[]).includes(value);
}

/** The models a picker lists for `provider`: the curated list minus an account-gated model the
 *  logged-in account lacks — except `current`, kept so a saved value stays visible (and
 *  changeable) instead of leaving the select blank. */
export function pickerModels(provider: AgentProvider, current?: string | null): readonly string[] {
  return providerModels(provider).filter(
    (mdl) => !isMythosModel(mdl) || accountModels.mythosAvailable || mdl === current,
  );
}
