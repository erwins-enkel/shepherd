import {
  AGENT_PROVIDERS,
  type AgentProvider,
  type DiagnosticsSnapshot,
  type UsageLimits,
} from "./types";

export function claudeUsageHoldLikely(
  limits: UsageLimits | null,
  enabled: boolean,
  holdPct: number,
): boolean {
  return enabled && Math.max(limits?.session5h?.pct ?? 0, limits?.week?.pct ?? 0) >= holdPct;
}

function providerReady(diagnostics: DiagnosticsSnapshot | null, provider: AgentProvider): boolean {
  return (
    diagnostics?.checks.some((check) => check.id === provider && check.state === "ok") ?? false
  );
}

export function bothAgentProvidersReady(diagnostics: DiagnosticsSnapshot | null): boolean {
  return providerReady(diagnostics, "claude") && providerReady(diagnostics, "codex");
}

export function capacitySuggestedProvider(
  defaultProvider: AgentProvider,
  diagnostics: DiagnosticsSnapshot | null,
  heldProviders: ReadonlySet<AgentProvider>,
): AgentProvider {
  if (!bothAgentProvidersReady(diagnostics) || !heldProviders.has(defaultProvider)) {
    return defaultProvider;
  }
  return AGENT_PROVIDERS.find((provider) => !heldProviders.has(provider)) ?? defaultProvider;
}
