import { m } from "$lib/paraglide/messages";
import { EFFORTS, type AgentProvider } from "$lib/types";

/** The reasoning-effort tiers offered for a provider. Claude accepts all five; Codex's domain has
 *  no `xhigh`/`max`, so the picker hides them (provider-filter — deterministic since the provider
 *  is chosen explicitly). Model-level limits are handled by the server-side clamp, not the UI, so
 *  they are never hidden here. Mirrors the server's effortsForProvider. */
export function providerEfforts(provider: AgentProvider): readonly string[] {
  return provider === "codex" ? EFFORTS.filter((e) => e !== "xhigh" && e !== "max") : EFFORTS;
}

/** True when a tier is offerable for a provider. "default" (no effort flag) is always available. */
export function effortAvailableForProvider(provider: AgentProvider, value: string): boolean {
  if (value === "default") return true;
  return providerEfforts(provider).includes(value);
}

/** Human label for one effort tier (i18n). */
export function effortLabel(effort: string): string {
  switch (effort) {
    case "low":
      return m.effort_label_low();
    case "medium":
      return m.effort_label_medium();
    case "high":
      return m.effort_label_high();
    case "xhigh":
      return m.effort_label_xhigh();
    case "max":
      return m.effort_label_max();
    default:
      return effort;
  }
}
