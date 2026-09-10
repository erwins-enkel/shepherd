/**
 * Capacity failover between the two coding CLIs.
 *
 * When the WEEKLY window of the operator's default CLI drops below
 * PROVIDER_FAILOVER_MIN_FREE_PCT remaining and the other CLI measurably has room, the usage
 * popover offers a one-click switch of `config.defaultAgentProvider` to that counterpart. The
 * origin is remembered so the 30s usage tick can switch back on its own once the exhausted
 * provider has weekly headroom again.
 *
 * Deliberately weekly-only: a 5h window recovers within hours, so switching the global default
 * "until it frees up" would churn the setting for a squeeze that resolves itself.
 *
 * Unmeasurable is NOT free. `weeklyFreePct` returns null when a provider reports no weekly
 * window (api-key mode, a provider that never produced a sample, a failed scrape), and both the
 * offer and the release treat null as "don't act": we never switch INTO an unknown, and we never
 * switch BACK to one either — the popover's manual revert is the escape hatch. Staleness, by
 * contrast, participates normally; it dims presentation, it never reroutes a decision (same rule
 * as `hottestCapacityWindow` in the UI).
 *
 * The UI predicts `providerFailoverOffer` in `ui/src/lib/provider-capacity.ts` so it knows whether
 * to render the button — the same shape as `claudeUsageHoldLikely` predicting `shouldHold`. THIS
 * module is authoritative: the route re-derives the offer and rejects a stale HUD's request.
 */
import { config } from "./config";
import type { SessionStore } from "./store";
import {
  AGENT_PROVIDERS,
  type AgentProvider,
  type DiagnosticsSnapshot,
  type ProviderFailoverStatus,
} from "./types";
import type { UsageLimits, UsageObservations } from "./usage-limits";

/** Remaining-capacity floor, in percent. Hardcoded on purpose — no setting, no env. */
const PROVIDER_FAILOVER_MIN_FREE_PCT = 30;

/** Persisted origin of an active failover ("" once cleared — the store has no delete). */
export const PROVIDER_FAILOVER_FROM_KEY = "providerFailoverFrom";

/**
 * Weekly remaining capacity for one provider, or null when nothing measured it.
 *
 * Claude reads the OPERATOR-VISIBLE number, matching `claudeDisplayGauges` in the UI: the
 * provider-confirmed observation is authoritative wherever the contract is present, and only a
 * payload carrying no contract at all falls back to the locally computed window. The button sits
 * two lines under that number in the same popover; deciding on a different one would let it
 * contradict what the operator is reading.
 */
export function weeklyFreePct(limits: UsageLimits | null, provider: AgentProvider): number | null {
  const pct = weeklyUsedPct(limits, provider);
  // Clamped like the UI's `capacityWindows`, so an over-cap sample reads 0 % free on both sides.
  return pct === null ? null : Math.min(Math.max(100 - pct, 0), 100);
}

/** `claudeObservedWindows` from the UI's usage-gauges: the contract is picked per SOURCE, not per
 *  field — a present `observed` object wins whole, null windows included. */
function claudeObservations(limits: UsageLimits): UsageObservations | undefined {
  if (limits.observed !== undefined) return limits.observed;
  const claude = limits.providers?.find((p) => p.provider === "claude" && p.kind === "limits");
  return claude?.kind === "limits" ? claude.observed : undefined;
}

function weeklyUsedPct(limits: UsageLimits | null, provider: AgentProvider): number | null {
  if (!limits) return null;
  if (provider === "codex") {
    const codex = limits.providers?.find((p) => p.provider === "codex" && p.kind === "tokens");
    return codex?.kind === "tokens" ? (codex.week?.pct ?? null) : null;
  }
  const observed = claudeObservations(limits);
  // Contract present ⇒ authoritative, INCLUDING a null week: that means "the provider never
  // confirmed this window", not "fall back to the local estimate". `limits()` always emits the
  // contract, so before the first /usage scrape this is the live case — reading the JSONL-computed
  // window here would call Claude measured while the popover renders it as no observation, and
  // the two sides must never disagree about what counts. Only a payload with NO contract at all
  // falls back, and then to the same top-level windows `gaugeList` reads.
  if (observed !== undefined) return observed.week?.pct ?? null;
  return limits.week?.pct ?? null;
}

/** The agent CLIs the environment probe currently reports as usable. */
export function readyAgentProviders(
  diagnostics: DiagnosticsSnapshot | null,
): readonly AgentProvider[] {
  return AGENT_PROVIDERS.filter((provider) =>
    diagnostics?.checks.some((check) => check.id === provider && check.state === "ok"),
  );
}

export interface ProviderFailoverOffer {
  /** The exhausted provider the operator would switch away from (today's default). */
  from: AgentProvider;
  /** The counterpart with room. */
  to: AgentProvider;
  fromFreePct: number;
  toFreePct: number;
}

const OTHER: Record<AgentProvider, AgentProvider> = { claude: "codex", codex: "claude" };

/**
 * The switch worth offering right now, or null.
 *
 * Only ever offers moving AWAY from the current default: if the default already is the cool
 * provider there is nothing to do, however hot the other one runs.
 */
export function providerFailoverOffer(input: {
  limits: UsageLimits | null;
  defaultProvider: AgentProvider;
  readyProviders: readonly AgentProvider[];
}): ProviderFailoverOffer | null {
  const from = input.defaultProvider;
  const to = OTHER[from];
  if (!input.readyProviders.includes(to)) return null;

  const fromFreePct = weeklyFreePct(input.limits, from);
  const toFreePct = weeklyFreePct(input.limits, to);
  if (fromFreePct === null || toFreePct === null) return null;
  if (fromFreePct >= PROVIDER_FAILOVER_MIN_FREE_PCT) return null;
  if (toFreePct < PROVIDER_FAILOVER_MIN_FREE_PCT) return null;

  return { from, to, fromFreePct, toFreePct };
}

/** True once the provider we switched away from has measurable weekly headroom again. */
export function shouldReleaseFailover(limits: UsageLimits | null, from: AgentProvider): boolean {
  const freePct = weeklyFreePct(limits, from);
  return freePct !== null && freePct >= PROVIDER_FAILOVER_MIN_FREE_PCT;
}

export function providerFailoverStatus(): ProviderFailoverStatus {
  return {
    active: config.providerFailoverFrom !== null,
    from: config.providerFailoverFrom,
    current: config.defaultAgentProvider,
  };
}

type FailoverStore = Pick<SessionStore, "setSetting">;

/** Persist the default provider and the remembered origin together (origin "" = none). */
export function writeProviderFailover(
  store: FailoverStore,
  next: { defaultProvider: AgentProvider; from: AgentProvider | null },
): ProviderFailoverStatus {
  config.defaultAgentProvider = next.defaultProvider;
  config.providerFailoverFrom = next.from;
  store.setSetting("defaultAgentProvider", next.defaultProvider);
  store.setSetting(PROVIDER_FAILOVER_FROM_KEY, next.from ?? "");
  return providerFailoverStatus();
}

/** Forget an active failover without touching the default — the operator just chose one himself. */
export function clearProviderFailover(store: FailoverStore): void {
  if (config.providerFailoverFrom === null) return;
  config.providerFailoverFrom = null;
  store.setSetting(PROVIDER_FAILOVER_FROM_KEY, "");
}

export interface ProviderFailoverReleaseDeps {
  store: FailoverStore;
  usageLimits: { limits(now: number): UsageLimits };
}

/**
 * The 30s tick's half of the feature: restore the operator's original default once the provider
 * we switched away from has room again. No-op while no failover is active, and — per the
 * unmeasurable rule above — while the origin reports no weekly window at all.
 */
export function releaseProviderFailover(
  deps: ProviderFailoverReleaseDeps,
  now: number,
): { released: boolean } {
  const from = config.providerFailoverFrom;
  if (from === null) return { released: false };
  if (!shouldReleaseFailover(deps.usageLimits.limits(now), from)) return { released: false };

  writeProviderFailover(deps.store, { defaultProvider: from, from: null });
  return { released: true };
}
