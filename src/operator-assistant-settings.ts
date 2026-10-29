/** HUD runtime preferences are independent of coding defaults. */
import { clampCodexModelForAuth, modelCompatibleWithProvider } from "./default-model";
import { effortsForProvider } from "./default-effort";
import type { AgentProvider } from "./types";
import type { UsageLimits } from "./usage-limits";

export interface AssistantProviderSettings {
  model: string | null;
  effort: string | null;
}
export interface AssistantRuntimeSettings {
  enabled: boolean;
  preferredProvider: AgentProvider;
  automaticFallback: boolean;
  claude: AssistantProviderSettings;
  codex: AssistantProviderSettings;
}
export type AssistantRuntimeBlock =
  "missing" | "runtime_unsupported" | "model_unsupported" | "capacity";
export interface AssistantRuntimeResolution {
  provider: AgentProvider | null;
  model: string | null;
  effort: string | null;
  reason: AssistantRuntimeBlock | "disabled" | null;
  fallback: AssistantRuntimeBlock | null;
}

export function normalizeStoredAssistantRuntime(
  raw: string | null,
  seed: AssistantProviderSettings = { model: null, effort: null },
): AssistantRuntimeSettings {
  const defaults: AssistantRuntimeSettings = {
    enabled: true,
    preferredProvider: "claude",
    automaticFallback: true,
    claude: {
      model: modelCompatibleWithProvider(seed.model, "claude") ? seed.model : null,
      effort:
        seed.effort && effortsForProvider("claude").includes(seed.effort) ? seed.effort : null,
    },
    codex: { model: null, effort: null },
  };
  if (!raw) return defaults;
  try {
    const stored: unknown = JSON.parse(raw);
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return defaults;
    let normalized = defaults;
    for (const [key, value] of Object.entries(stored)) {
      const parsed = parseAssistantRuntimePatch({ [key]: value }, normalized);
      if (parsed.ok) normalized = parsed.value;
    }
    return normalized;
  } catch {
    return defaults;
  }
}

function parseProviderSettings(
  provider: AgentProvider,
  raw: unknown,
  current: AssistantProviderSettings,
): AssistantProviderSettings | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = { ...current };
  for (const [field, value] of Object.entries(raw)) {
    if (value !== null && typeof value !== "string") return null;
    switch (field) {
      case "model":
        if (!modelCompatibleWithProvider(value, provider)) return null;
        out.model = value;
        break;
      case "effort":
        if (value !== null && !effortsForProvider(provider).includes(value)) return null;
        out.effort = value;
        break;
      default:
        return null;
    }
  }
  return out;
}

export function parseAssistantRuntimePatch(
  raw: unknown,
  current: AssistantRuntimeSettings,
): { ok: true; value: AssistantRuntimeSettings } | { ok: false; error: string } {
  const bad = { ok: false as const, error: "invalid assistant runtime settings" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad;
  const out = { ...current, claude: { ...current.claude }, codex: { ...current.codex } };
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case "enabled":
      case "automaticFallback":
        if (typeof value !== "boolean") return bad;
        out[key] = value;
        break;
      case "preferredProvider":
        if (value !== "claude" && value !== "codex") return bad;
        out.preferredProvider = value;
        break;
      case "claude":
      case "codex": {
        const parsed = parseProviderSettings(key, value, out[key]);
        if (!parsed) return bad;
        out[key] = parsed;
        break;
      }
      default:
        return bad;
    }
  }
  return { ok: true, value: out };
}

export function resolveAssistantRuntime(
  settings: AssistantRuntimeSettings,
  blocked: Partial<Record<AgentProvider, AssistantRuntimeBlock>>,
): AssistantRuntimeResolution {
  const unavailable = (
    reason: AssistantRuntimeResolution["reason"],
  ): AssistantRuntimeResolution => ({
    provider: null,
    model: null,
    effort: null,
    reason,
    fallback: null,
  });
  if (!settings.enabled) return unavailable("disabled");
  const preferred = settings.preferredProvider;
  const other = preferred === "claude" ? "codex" : "claude";
  const provider = !blocked[preferred]
    ? preferred
    : settings.automaticFallback && !blocked[other]
      ? other
      : null;
  if (!provider) return unavailable(blocked[preferred] ?? "missing");
  return {
    provider,
    ...settings[provider],
    reason: null,
    fallback: provider === preferred ? null : (blocked[preferred] ?? null),
  };
}

/** Only fresh provider-confirmed windows can cause a pre-flight capacity switch. */
export function assistantProviderExhausted(
  limits: UsageLimits | null,
  provider: AgentProvider,
  now: number,
): boolean {
  if (!limits) return false;
  if (provider === "codex") {
    const p = limits.providers?.find((p) => p.provider === "codex");
    return (
      p?.kind === "tokens" &&
      !p.stale &&
      (p.rateLimitLatestEventAt ?? p.rateLimitCheckedAt) != null &&
      now - (p.rateLimitLatestEventAt ?? p.rateLimitCheckedAt)! < 60 * 60_000 &&
      [p.session5h, p.week].some((w) => w !== null && w.pct >= 100 && w.resetAt > now)
    );
  }
  return [limits.observed?.session5h, limits.observed?.week].some(
    (w) => !!w && w.pct >= 100 && w.resetAt > now && now - w.scrapedAt < 60 * 60_000,
  );
}

export function assistantRuntimeBlocks(input: {
  checks?: readonly { id: string; state: string }[];
  limits?: UsageLimits | null;
  settings: AssistantRuntimeSettings;
  now: number;
  codexAuthMode?: import("./default-model").CodexAuthMode;
}): Partial<Record<AgentProvider, AssistantRuntimeBlock>> {
  const blocked: Partial<Record<AgentProvider, AssistantRuntimeBlock>> = {};
  for (const provider of ["claude", "codex"] as const) {
    const check = input.checks?.find((c) => c.id === provider);
    if (input.checks && (!check || check.state !== "ok")) blocked[provider] = "missing";
    else if (assistantProviderExhausted(input.limits ?? null, provider, input.now))
      blocked[provider] = "capacity";
  }
  if (
    input.settings.codex.model &&
    clampCodexModelForAuth(
      input.settings.codex.model,
      "codex",
      input.codexAuthMode ?? "unknown",
    ) === null
  )
    blocked.codex = "model_unsupported";
  return blocked;
}
