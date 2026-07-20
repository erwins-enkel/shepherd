import type { AgentProvider, ProviderTokenConstraint } from "$lib/types";
import { promoDefaultModel } from "$lib/fable-promo";
import { modelAvailableForProvider } from "$lib/provider-models";
import { effortAvailableForProvider } from "$lib/effort-guidance";

/** Picker preselect for a model SETTING ("auto" | "default" | <alias>): explicit setting wins,
 *  else the fresh-client promo (Claude) / "default" (Codex); fable falls back when unavailable. */
export function preselectModel(
  configured: string | undefined,
  provider: AgentProvider,
  fableAvailable: boolean,
): string {
  const pick =
    configured && configured !== "auto"
      ? configured
      : provider === "claude"
        ? promoDefaultModel()
        : "default";
  return pick === "fable" && !fableAvailable ? "default" : pick;
}

/** Effort SETTING ("default" | "inherit" | <tier>) → picker value. */
export function preselectEffort(setting: string | undefined): string {
  return setting && setting !== "default" && setting !== "inherit" ? setting : "default";
}

export interface ReseedInput {
  provider: AgentProvider;
  modelTouched: boolean;
  effortTouched: boolean;
  /** True when an explicit initialModel/initialEffort prop pins the picker (CTA seeds). */
  hasInitialModel: boolean;
  hasInitialEffort: boolean;
  /** Repo override (unless "inherit") → global default, resolved by the caller. */
  effectiveModelSetting: string;
  effectiveEffortSetting: string;
  fableAvailable: boolean;
}

/** The untouched-reseed rule: while a picker is neither pinned by an explicit initial prop
 *  nor touched by hand, it re-derives from the setting chain on repo/provider change.
 *  Returns only the fields to overwrite. */
export function reseedRunConfig(i: ReseedInput): { model?: string; effort?: string } {
  const out: { model?: string; effort?: string } = {};
  if (!i.hasInitialModel && !i.modelTouched)
    out.model = preselectModel(i.effectiveModelSetting, i.provider, i.fableAvailable);
  if (!i.hasInitialEffort && !i.effortTouched)
    out.effort = preselectEffort(i.effectiveEffortSetting);
  return out;
}

export interface NormalizeInput {
  provider: AgentProvider;
  model: string;
  effort: string;
  fableAvailable: boolean;
  /** Active slash-command provider constraint, if any. */
  constraint: ProviderTokenConstraint | null;
  /** Model SETTING per provider so the corrected provider's default is derivable. */
  claudeModelSetting: string;
  codexModelSetting: string;
}

/** The validity-correction rule, applied always (touched or not): a constraint-excluded
 *  provider flips to the constraint's first allowed provider; an unavailable model snaps to
 *  the provider default (or "default"); an unsupported effort tier snaps to "default". */
export function normalizeRunConfig(i: NormalizeInput): {
  provider: AgentProvider;
  model: string;
  effort: string;
} {
  let provider = i.provider;
  if (i.constraint && !i.constraint.providers.includes(provider)) {
    provider = i.constraint.providers[0] ?? "claude";
  }
  let model = i.model;
  if (!modelAvailableForProvider(provider, model, i.fableAvailable)) {
    const setting = provider === "codex" ? i.codexModelSetting : i.claudeModelSetting;
    const fallback = preselectModel(setting, provider, i.fableAvailable);
    model = modelAvailableForProvider(provider, fallback, i.fableAvailable) ? fallback : "default";
  }
  let effort = i.effort;
  if (!effortAvailableForProvider(provider, effort)) effort = "default";
  return { provider, model, effort };
}

/** Manual CLI-select change: today's semantics preserved verbatim — the model resets to the
 *  new provider's default unconditionally (touched or not). */
export function modelForManualProviderChange(
  provider: AgentProvider,
  effectiveModelSetting: string,
  fableAvailable: boolean,
): string {
  const fallback = preselectModel(effectiveModelSetting, provider, fableAvailable);
  return modelAvailableForProvider(provider, fallback, fableAvailable) ? fallback : "default";
}
