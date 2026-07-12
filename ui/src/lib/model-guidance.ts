import { modelLabel } from "$lib/model-label";
import { m } from "$lib/paraglide/messages";
import type { AgentProvider } from "$lib/types";

export type ModelGuidanceContext =
  "task" | "default" | "repo" | "role" | "classifier" | "downgrade";
type CostTier = "low" | "standard" | "high" | "premium";
type ModelTag = "budget" | "balanced" | "strong" | "max" | "longContext" | "providerDefault";

export type ModelGuidance = {
  costTier: CostTier;
  costLabel: string;
  costMark: string;
  tag: string;
  detail: string;
  contextNote: string | null;
};

function costLabel(tier: CostTier): string {
  switch (tier) {
    case "low":
      return m.model_cost_low();
    case "standard":
      return m.model_cost_standard();
    case "high":
      return m.model_cost_high();
    case "premium":
      return m.model_cost_premium();
  }
}

function costMark(tier: CostTier): string {
  switch (tier) {
    case "low":
      return "$";
    case "standard":
      return "$$";
    case "high":
      return "$$$";
    case "premium":
      return "$$$$";
  }
}

function tagLabel(tag: ModelTag): string {
  switch (tag) {
    case "budget":
      return m.model_tag_budget();
    case "balanced":
      return m.model_tag_balanced();
    case "strong":
      return m.model_tag_strong();
    case "max":
      return m.model_tag_max();
    case "longContext":
      return m.model_tag_long_context();
    case "providerDefault":
      return m.model_tag_provider_default();
  }
}

function baseGuidance(
  provider: AgentProvider,
  model: string,
): {
  costTier: CostTier;
  tag: ModelTag;
  detail: string;
} {
  if (model === "auto")
    return {
      costTier: "standard",
      tag: "providerDefault",
      detail: m.model_guidance_auto(),
    };
  if (model === "default" || model === "inherit")
    return {
      costTier: "standard",
      tag: "providerDefault",
      detail: model === "inherit" ? m.model_guidance_inherit() : m.model_guidance_default(),
    };

  if (provider === "claude") return claudeGuidance(model);
  return codexGuidance(model);
}

function claudeGuidance(model: string): {
  costTier: CostTier;
  tag: ModelTag;
  detail: string;
} {
  switch (model) {
    case "fable":
      return { costTier: "premium", tag: "max", detail: m.model_guidance_claude_fable() };
    case "opus":
      return { costTier: "high", tag: "strong", detail: m.model_guidance_claude_opus() };
    case "opus[1m]":
      return {
        costTier: "premium",
        tag: "longContext",
        detail: m.model_guidance_claude_opus_1m(),
      };
    case "sonnet":
      return { costTier: "standard", tag: "balanced", detail: m.model_guidance_claude_sonnet() };
    case "sonnet[1m]":
      return {
        costTier: "high",
        tag: "longContext",
        detail: m.model_guidance_claude_sonnet_1m(),
      };
    case "haiku":
      return { costTier: "low", tag: "budget", detail: m.model_guidance_claude_haiku() };
    default:
      return { costTier: "standard", tag: "balanced", detail: m.model_guidance_unknown() };
  }
}

function codexGuidance(model: string): {
  costTier: CostTier;
  tag: ModelTag;
  detail: string;
} {
  switch (model) {
    case "gpt-5.5":
      return { costTier: "premium", tag: "max", detail: m.model_guidance_codex_55() };
    case "gpt-5.6-sol":
      return { costTier: "premium", tag: "max", detail: m.model_guidance_codex_56_sol() };
    case "gpt-5.6-terra":
      return { costTier: "high", tag: "balanced", detail: m.model_guidance_codex_56_terra() };
    case "gpt-5.6-luna":
      return { costTier: "low", tag: "budget", detail: m.model_guidance_codex_56_luna() };
    case "gpt-5.4":
      return { costTier: "high", tag: "strong", detail: m.model_guidance_codex_54() };
    case "gpt-5.3-codex":
      return { costTier: "standard", tag: "balanced", detail: m.model_guidance_codex_53() };
    case "gpt-5.1-codex":
      return { costTier: "standard", tag: "balanced", detail: m.model_guidance_codex_51_codex() };
    case "gpt-5-codex":
      return { costTier: "low", tag: "budget", detail: m.model_guidance_codex_5_codex() };
    case "gpt-5.1":
      return { costTier: "standard", tag: "balanced", detail: m.model_guidance_codex_51() };
    case "gpt-5":
      return { costTier: "low", tag: "budget", detail: m.model_guidance_codex_5() };
    case "o3":
      return { costTier: "high", tag: "strong", detail: m.model_guidance_codex_o3() };
    default:
      return { costTier: "standard", tag: "balanced", detail: m.model_guidance_unknown() };
  }
}

function contextNote(context: ModelGuidanceContext): string | null {
  switch (context) {
    case "default":
    case "repo":
      return m.model_guidance_default_context_note();
    case "classifier":
      return m.model_guidance_classifier_context_note();
    case "downgrade":
      return m.model_guidance_downgrade_context_note();
    case "task":
    case "role":
      return null;
  }
}

export function modelGuidance(
  provider: AgentProvider,
  model: string,
  context: ModelGuidanceContext = "task",
): ModelGuidance {
  const base = baseGuidance(provider, model);
  return {
    costTier: base.costTier,
    costLabel: costLabel(base.costTier),
    costMark: costMark(base.costTier),
    tag: tagLabel(base.tag),
    detail: base.detail,
    contextNote: contextNote(context),
  };
}

export function modelGuidanceAlias(model: string, fableAvailable: boolean): string {
  return model === "fable" && !fableAvailable ? "opus[1m]" : model;
}

export function modelOptionLabel(provider: AgentProvider, model: string): string {
  const g = modelGuidance(provider, model);
  return `${modelLabel(model)} · ${g.tag} · ${g.costMark}`;
}
