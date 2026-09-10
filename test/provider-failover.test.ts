import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { config } from "../src/config";
import {
  clearProviderFailover,
  providerFailoverOffer,
  providerFailoverStatus,
  releaseProviderFailover,
  shouldReleaseFailover,
  weeklyFreePct,
  writeProviderFailover,
  PROVIDER_FAILOVER_FROM_KEY,
} from "../src/provider-failover";
import type { AgentProvider } from "../src/types";
import type { UsageLimits } from "../src/usage-limits";

/** `null` for a provider means "no weekly window at all" — the unmeasurable case. */
function limits(free: { claude: number | null; codex: number | null }): UsageLimits {
  const claudeWeek = free.claude === null ? null : { pct: 100 - free.claude, resetAt: 0 };
  const codexWeek = free.codex === null ? null : { pct: 100 - free.codex, resetAt: 0 };
  return {
    session5h: null,
    week: claudeWeek,
    perModelWeek: [],
    credits: null,
    stale: false,
    calibratedAt: null,
    subscriptionOnly: false,
    providers: [
      {
        provider: "claude",
        kind: "limits",
        session5h: null,
        week: claudeWeek,
        perModelWeek: [],
        credits: null,
        stale: false,
        calibratedAt: null,
        subscriptionOnly: false,
      },
      {
        provider: "codex",
        kind: "tokens",
        totalTokens: 0,
        session5hTokens: 0,
        weekTokens: 0,
        updatedAt: null,
        stale: false,
        session5h: null,
        week: codexWeek,
      },
    ],
  };
}

const BOTH: AgentProvider[] = ["claude", "codex"];

describe("weeklyFreePct", () => {
  test("prefers the provider-confirmed observation over the computed window", () => {
    const l = limits({ claude: 79, codex: 23 });
    l.observed = { session5h: null, week: { pct: 90, resetAt: 0, scrapedAt: 0 } };
    expect(weeklyFreePct(l, "claude")).toBe(10);
  });

  test("falls back to the per-provider observation when the top-level one is absent", () => {
    const l = limits({ claude: 79, codex: 23 });
    for (const p of l.providers ?? []) {
      if (p.provider === "claude" && p.kind === "limits") {
        p.observed = { session5h: null, week: { pct: 90, resetAt: 0, scrapedAt: 0 } };
      }
    }
    expect(weeklyFreePct(l, "claude")).toBe(10);
  });

  test("falls back to the computed window when nothing was observed", () => {
    expect(weeklyFreePct(limits({ claude: 79, codex: 23 }), "claude")).toBe(79);
  });

  test("reads codex from its provider snapshot", () => {
    expect(weeklyFreePct(limits({ claude: 79, codex: 23 }), "codex")).toBe(23);
  });

  test("null when the provider has no weekly window", () => {
    expect(weeklyFreePct(limits({ claude: null, codex: 23 }), "claude")).toBeNull();
    expect(weeklyFreePct(limits({ claude: 79, codex: null }), "codex")).toBeNull();
    expect(weeklyFreePct(null, "claude")).toBeNull();
  });

  test("a present contract with a null week is UNMEASURED, computed window notwithstanding", () => {
    // `limits()` always emits the contract, so this is the live shape before the first /usage
    // scrape. Reading the JSONL-computed window here would call Claude measured while the popover
    // renders "no observation" — the divergence this rule exists to prevent.
    const l = limits({ claude: 79, codex: 23 });
    l.observed = { session5h: null, week: null };
    expect(weeklyFreePct(l, "claude")).toBeNull();
    expect(
      providerFailoverOffer({ limits: l, defaultProvider: "codex", readyProviders: BOTH }),
    ).toBeNull();
  });

  test("a per-provider contract with a null week is unmeasured too", () => {
    const l = limits({ claude: 79, codex: 23 });
    for (const p of l.providers ?? []) {
      if (p.provider === "claude" && p.kind === "limits") {
        p.observed = { session5h: null, week: null };
      }
    }
    expect(weeklyFreePct(l, "claude")).toBeNull();
  });

  test("a top-level contract wins whole — a null week does not fall through to the provider's", () => {
    const l = limits({ claude: 79, codex: 23 });
    l.observed = { session5h: null, week: null };
    for (const p of l.providers ?? []) {
      if (p.provider === "claude" && p.kind === "limits") {
        p.observed = { session5h: null, week: { pct: 10, resetAt: 0, scrapedAt: 0 } };
      }
    }
    expect(weeklyFreePct(l, "claude")).toBeNull();
  });

  test("claude survives a limits payload with no providers array", () => {
    const l = limits({ claude: 79, codex: 23 });
    delete l.providers;
    expect(weeklyFreePct(l, "claude")).toBe(79);
    expect(weeklyFreePct(l, "codex")).toBeNull();
  });
});

describe("providerFailoverOffer", () => {
  // The shared case table — mirrored verbatim in ui/src/lib/provider-capacity.test.ts.
  test("offers the counterpart when the default is out of weekly headroom", () => {
    expect(
      providerFailoverOffer({
        limits: limits({ claude: 79, codex: 23 }),
        defaultProvider: "codex",
        readyProviders: BOTH,
      }),
    ).toEqual({ from: "codex", to: "claude", fromFreePct: 23, toFreePct: 79 });
  });

  test("no offer when the default already is the cool provider", () => {
    expect(
      providerFailoverOffer({
        limits: limits({ claude: 79, codex: 23 }),
        defaultProvider: "claude",
        readyProviders: BOTH,
      }),
    ).toBeNull();
  });

  test("no offer when both are exhausted", () => {
    expect(
      providerFailoverOffer({
        limits: limits({ claude: 23, codex: 23 }),
        defaultProvider: "codex",
        readyProviders: BOTH,
      }),
    ).toBeNull();
  });

  test("no offer when the counterpart is unmeasured", () => {
    expect(
      providerFailoverOffer({
        limits: limits({ claude: null, codex: 23 }),
        defaultProvider: "codex",
        readyProviders: BOTH,
      }),
    ).toBeNull();
  });

  test("no offer when the default itself is unmeasured", () => {
    expect(
      providerFailoverOffer({
        limits: limits({ claude: 79, codex: null }),
        defaultProvider: "codex",
        readyProviders: BOTH,
      }),
    ).toBeNull();
  });

  test("counterpart at exactly the floor still counts as room", () => {
    expect(
      providerFailoverOffer({
        limits: limits({ claude: 30, codex: 23 }),
        defaultProvider: "codex",
        readyProviders: BOTH,
      }),
    ).not.toBeNull();
  });

  test("default at exactly the floor is not exhausted yet", () => {
    expect(
      providerFailoverOffer({
        limits: limits({ claude: 79, codex: 30 }),
        defaultProvider: "codex",
        readyProviders: BOTH,
      }),
    ).toBeNull();
  });

  test("no offer when the counterpart is not ready", () => {
    expect(
      providerFailoverOffer({
        limits: limits({ claude: 79, codex: 23 }),
        defaultProvider: "codex",
        readyProviders: ["codex"],
      }),
    ).toBeNull();
  });

  test("stale readings still decide (staleness dims, it never reroutes)", () => {
    const l = limits({ claude: 79, codex: 23 });
    l.stale = true;
    for (const p of l.providers ?? []) {
      if (p.provider === "codex" && p.kind === "tokens") p.stale = true;
    }
    expect(
      providerFailoverOffer({ limits: l, defaultProvider: "codex", readyProviders: BOTH }),
    ).not.toBeNull();
  });
});

describe("shouldReleaseFailover", () => {
  test("releases once the origin has weekly headroom again", () => {
    expect(shouldReleaseFailover(limits({ claude: 79, codex: 88 }), "codex")).toBe(true);
  });

  test("holds while the origin is still exhausted", () => {
    expect(shouldReleaseFailover(limits({ claude: 79, codex: 23 }), "codex")).toBe(false);
  });

  test("holds at exactly the floor", () => {
    expect(shouldReleaseFailover(limits({ claude: 79, codex: 30 }), "codex")).toBe(true);
    expect(shouldReleaseFailover(limits({ claude: 79, codex: 29 }), "codex")).toBe(false);
  });

  test("holds when the origin became unmeasurable — never switch back into an unknown", () => {
    expect(shouldReleaseFailover(limits({ claude: 79, codex: null }), "codex")).toBe(false);
  });
});

describe("failover state", () => {
  // These mutate the shared config singleton; put it back so later files see it untouched.
  const savedProvider = config.defaultAgentProvider;
  const savedFrom = config.providerFailoverFrom;
  afterAll(() => {
    config.defaultAgentProvider = savedProvider;
    config.providerFailoverFrom = savedFrom;
  });

  let written: Record<string, string>;
  const store = {
    setSetting(key: string, value: string) {
      written[key] = value;
    },
  };
  const usageLimits = (free: { claude: number | null; codex: number | null }) => ({
    limits: () => limits(free),
  });

  beforeEach(() => {
    written = {};
    config.defaultAgentProvider = "codex";
    config.providerFailoverFrom = null;
  });

  test("engaging persists both the new default and the remembered origin", () => {
    const status = writeProviderFailover(store, { defaultProvider: "claude", from: "codex" });
    expect(status).toEqual({ active: true, from: "codex", current: "claude" });
    expect(config.defaultAgentProvider).toBe("claude");
    expect(written).toEqual({
      defaultAgentProvider: "claude",
      [PROVIDER_FAILOVER_FROM_KEY]: "codex",
    });
  });

  test("clearing forgets the origin without touching the default", () => {
    writeProviderFailover(store, { defaultProvider: "claude", from: "codex" });
    written = {};
    clearProviderFailover(store);
    expect(config.defaultAgentProvider).toBe("claude");
    expect(providerFailoverStatus()).toEqual({ active: false, from: null, current: "claude" });
    expect(written).toEqual({ [PROVIDER_FAILOVER_FROM_KEY]: "" });
  });

  test("clearing is a no-op when no failover is active", () => {
    clearProviderFailover(store);
    expect(written).toEqual({});
  });

  test("the sweeper restores the origin once it has room", () => {
    writeProviderFailover(store, { defaultProvider: "claude", from: "codex" });
    written = {};
    expect(
      releaseProviderFailover({ store, usageLimits: usageLimits({ claude: 79, codex: 88 }) }, 0),
    ).toEqual({ released: true });
    expect(config.defaultAgentProvider).toBe("codex");
    expect(written).toEqual({
      defaultAgentProvider: "codex",
      [PROVIDER_FAILOVER_FROM_KEY]: "",
    });
  });

  test("the sweeper leaves an exhausted origin alone", () => {
    writeProviderFailover(store, { defaultProvider: "claude", from: "codex" });
    expect(
      releaseProviderFailover({ store, usageLimits: usageLimits({ claude: 79, codex: 23 }) }, 0),
    ).toEqual({ released: false });
    expect(config.defaultAgentProvider).toBe("claude");
  });

  test("the sweeper is a no-op with no failover active", () => {
    expect(
      releaseProviderFailover({ store, usageLimits: usageLimits({ claude: 79, codex: 88 }) }, 0),
    ).toEqual({ released: false });
    expect(written).toEqual({});
  });
});
