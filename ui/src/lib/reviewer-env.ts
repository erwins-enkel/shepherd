import { m } from "$lib/paraglide/messages";
import { modelLabel } from "$lib/model-label";
import { effortLabel } from "$lib/effort-guidance";
import type { AgentProvider } from "$lib/types";

/** Localized CLI label for an agent provider (Claude Code / Codex). */
export function providerLabel(provider: AgentProvider): string {
  return provider === "codex" ? m.agent_provider_codex() : m.agent_provider_claude();
}

/** Compose a `CLI · model · effort` label for a plan/reviewer environment. A null/absent provider
 *  degrades to a localized "unavailable" (optionally suffixed with whatever model/effort is known);
 *  callers that must NOT surface that string (e.g. the in-flight reviewing button) should gate on a
 *  non-null provider first. `model`/`effort` fall back to their localized "default" when absent. */
export function environmentLabel(
  provider: AgentProvider | null | undefined,
  model: string | null | undefined,
  effort: string | null | undefined,
): string {
  if (!provider) {
    const parts: string[] = [m.planpanel_env_unavailable()];
    if (model) parts.push(modelLabel(model));
    if (effort) parts.push(effortLabel(effort));
    return parts.join(" · ");
  }
  const modelText = model ? modelLabel(model) : m.newtask_model_default();
  const effortText = effort ? effortLabel(effort) : m.effort_default();
  return `${providerLabel(provider)} · ${modelText} · ${effortText}`;
}
