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

/**
 * Critic guardrail predicate (#1430): does a role-effort SETTING resolve BELOW the `high` tier?
 * Operates on the SETTING space ("default" | <tier>): "default" → true (no `--effort` flag → the
 * CLI's own below-high native default, which is why the critic is seeded to "high"); a tier below
 * `high`'s index (low/medium) → true; "high"/"xhigh"/"max" and unknown strings → false. Mirrors the
 * server's effortBelowHigh in src/default-effort.ts — keep the two byte-identical in behavior. */
export function effortBelowHigh(setting: string): boolean {
  if (setting === "default") return true;
  const order: readonly string[] = EFFORTS;
  const idx = order.indexOf(setting);
  return idx !== -1 && idx < order.indexOf("high");
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
