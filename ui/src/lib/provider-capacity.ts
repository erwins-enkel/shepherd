import {
  AGENT_PROVIDERS,
  type AgentProvider,
  type DiagnosticsSnapshot,
  type UsageLimits,
} from "./types";
import { providerDisplayCapacityRows } from "./components/usage-gauges";

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

export function readyAgentProviders(diagnostics: DiagnosticsSnapshot | null): AgentProvider[] {
  return AGENT_PROVIDERS.filter((provider) => providerReady(diagnostics, provider));
}

export function bothAgentProvidersReady(diagnostics: DiagnosticsSnapshot | null): boolean {
  return readyAgentProviders(diagnostics).length === AGENT_PROVIDERS.length;
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

// ── capacity failover ────────────────────────────────────────────────────────
// Mirror of `src/provider-failover.ts` so the usage popover knows whether to render the switch
// button. Same relationship as `claudeUsageHoldLikely` above and the server's `shouldHold`: the
// UI predicts, the server decides — POST /api/provider-failover re-derives the offer and answers
// 409 when this prediction was made on a stale snapshot.

/** Remaining-capacity floor, in percent. Keep in step with the server constant of the same name. */
const PROVIDER_FAILOVER_MIN_FREE_PCT = 30;

export interface ProviderFailoverOffer {
  /** The exhausted provider the operator would switch away from (today's default). */
  from: AgentProvider;
  /** The counterpart with room. */
  to: AgentProvider;
  fromFreePct: number;
  toFreePct: number;
}

/** Weekly remaining capacity as the operator SEES it, or null when nothing measured it. */
export function weeklyFreePct(limits: UsageLimits | null, provider: AgentProvider): number | null {
  const row = providerDisplayCapacityRows(limits).find((r) => r.provider === provider);
  const week = row?.windows.find((w) => w.key === "WK");
  return week?.remainingPct ?? null;
}

/**
 * The switch worth offering right now, or null. Only ever moves AWAY from the current default:
 * if the default already is the cool provider there is nothing to do, however hot the other runs.
 */
export function providerFailoverOffer(
  limits: UsageLimits | null,
  defaultProvider: AgentProvider,
  diagnostics: DiagnosticsSnapshot | null,
): ProviderFailoverOffer | null {
  const from = defaultProvider;
  const to = AGENT_PROVIDERS.find((p) => p !== from);
  if (!to || !readyAgentProviders(diagnostics).includes(to)) return null;

  const fromFreePct = weeklyFreePct(limits, from);
  const toFreePct = weeklyFreePct(limits, to);
  if (fromFreePct === null || toFreePct === null) return null;
  if (fromFreePct >= PROVIDER_FAILOVER_MIN_FREE_PCT) return null;
  if (toFreePct < PROVIDER_FAILOVER_MIN_FREE_PCT) return null;

  return { from, to, fromFreePct, toFreePct };
}
