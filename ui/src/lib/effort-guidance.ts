import { m } from "$lib/paraglide/messages";
import { CODEX_MODELS, EFFORTS, type AgentProvider } from "$lib/types";

/** Codex 0.153.4 model catalog: Astra/Sol/Terra offer Ultra, Luna stops at Max.
 * Older curated models keep their four tiers. Unknown models and CLI-default choices are
 * left to the CLI rather than restricted by an assumed capability. Claude offers five tiers. */
export function providerEfforts(provider: AgentProvider, model?: string | null): readonly string[] {
  if (provider === "claude" || model === "gpt-5.6-luna")
    return EFFORTS.filter((e) => e !== "ultra");
  if (model === "gpt-6-astra" || model === "gpt-5.6-sol" || model === "gpt-5.6-terra")
    return EFFORTS;
  if (model && (CODEX_MODELS as readonly string[]).includes(model))
    return EFFORTS.filter((e) => e !== "max" && e !== "ultra");
  return EFFORTS;
}

/** True when a tier is offered for a provider/model. Default always emits no effort flag. */
export function effortAvailableForProvider(
  provider: AgentProvider,
  value: string,
  model?: string | null,
): boolean {
  if (value === "default") return true;
  return providerEfforts(provider, model).includes(value);
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
    case "ultra":
      return m.effort_label_ultra();
    default:
      return effort;
  }
}
