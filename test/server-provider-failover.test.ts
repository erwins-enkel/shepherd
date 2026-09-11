import { afterEach, beforeEach, expect, test } from "bun:test";
import { config } from "../src/config";
import { EventHub } from "../src/events";
import { PROVIDER_FAILOVER_FROM_KEY } from "../src/provider-failover";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import type { AgentProvider, DiagnosticState } from "../src/types";

let savedProvider: AgentProvider;
let savedFailoverFrom: AgentProvider | null;

beforeEach(() => {
  savedProvider = config.defaultAgentProvider;
  savedFailoverFrom = config.providerFailoverFrom;
  config.defaultAgentProvider = "codex";
  config.providerFailoverFrom = null;
});

afterEach(() => {
  config.defaultAgentProvider = savedProvider;
  config.providerFailoverFrom = savedFailoverFrom;
});

/** Weekly windows expressed as REMAINING percent, so the cases read like the operator's popover.
 *  Shaped like the real `limits()` payload: Claude's confirmed value lives in the `observed`
 *  contract (always emitted), and `week` below it stays the local estimate the failover rule must
 *  NOT read once that contract is present. */
function harness(opts: {
  claudeFree?: number | null;
  codexFree?: number | null;
  claudeReady?: boolean;
}): { app: ReturnType<typeof makeApp>; store: SessionStore } {
  const week = (free: number | null | undefined) =>
    free === null || free === undefined ? null : { pct: 100 - free, resetAt: 0 };
  const observedWeek = (free: number | null | undefined) =>
    free === null || free === undefined ? null : { pct: 100 - free, resetAt: 0, scrapedAt: 0 };
  const store = new SessionStore(":memory:");
  const check = (id: string, ok: boolean) => ({
    id,
    state: (ok ? "ok" : "error") as DiagnosticState,
    hintKey: "",
  });
  const deps: AppDeps = {
    store,
    events: new EventHub(),
    service: {} as never,
    usageLimits: {
      limits: () => ({
        observed: { session5h: null, week: observedWeek(opts.claudeFree) },
        session5h: null,
        // A deliberately TEMPTING local estimate that contradicts the contract. With the contract
        // present nothing may read it, so `claudeFree: null` must still refuse — reading this
        // would show a healthy 79 % free and wrongly engage.
        week: week(79),
        perModelWeek: [],
        credits: null,
        stale: false,
        calibratedAt: null,
        subscriptionOnly: false,
        providers: [
          {
            provider: "claude",
            kind: "limits",
            observed: { session5h: null, week: observedWeek(opts.claudeFree) },
            session5h: null,
            week: week(79),
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
            week: week(opts.codexFree),
          },
        ],
      }),
    } as never,
    diagnostics: {
      current: async () => ({
        checks: [check("claude", opts.claudeReady !== false), check("codex", true)],
        generatedAt: 0,
        overall: "ok" as DiagnosticState,
      }),
    } as never,
  };
  return { app: makeApp(deps), store };
}

const post = (app: ReturnType<typeof makeApp>, action: string) =>
  app.fetch(
    new Request("http://x/api/provider-failover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    }),
  );

test("GET reports the idle state", async () => {
  const { app } = harness({ claudeFree: 79, codexFree: 23 });
  const res = await app.fetch(new Request("http://x/api/provider-failover"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ active: false, from: null, current: "codex" });
});

test("engage switches the default to the counterpart and persists both halves", async () => {
  const { app, store } = harness({ claudeFree: 79, codexFree: 23 });
  const res = await post(app, "engage");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ active: true, from: "codex", current: "claude" });
  expect(config.defaultAgentProvider).toBe("claude");
  expect(store.getSetting("defaultAgentProvider")).toBe("claude");
  expect(store.getSetting(PROVIDER_FAILOVER_FROM_KEY)).toBe("codex");
});

test("engage is refused when this process sees no offer — a stale HUD cannot force it", async () => {
  const { app, store } = harness({ claudeFree: 23, codexFree: 23 });
  const res = await post(app, "engage");
  expect(res.status).toBe(409);
  expect(config.defaultAgentProvider).toBe("codex");
  expect(store.getSetting("defaultAgentProvider")).toBeNull();
});

test("engage is refused when the counterpart is not ready", async () => {
  const { app } = harness({ claudeFree: 79, codexFree: 23, claudeReady: false });
  expect((await post(app, "engage")).status).toBe(409);
  expect(config.defaultAgentProvider).toBe("codex");
});

test("engage is refused when the counterpart's CONFIRMED weekly window is absent", async () => {
  // The contract is present with a null week while the local estimate says a healthy 79 % free.
  // The popover renders that provider as "no observation" and offers nothing, so the server must
  // refuse too — reading the estimate here is exactly the divergence the rule forbids.
  const { app } = harness({ claudeFree: null, codexFree: 23 });
  expect((await post(app, "engage")).status).toBe(409);
});

test("release restores the remembered origin", async () => {
  const { app, store } = harness({ claudeFree: 79, codexFree: 23 });
  await post(app, "engage");
  const res = await post(app, "release");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ active: false, from: null, current: "codex" });
  expect(config.defaultAgentProvider).toBe("codex");
  expect(store.getSetting(PROVIDER_FAILOVER_FROM_KEY)).toBe("");
});

test("release is idempotent when nothing is active", async () => {
  const { app } = harness({ claudeFree: 79, codexFree: 23 });
  const res = await post(app, "release");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ active: false, from: null, current: "codex" });
});

test("an unknown action is rejected", async () => {
  const { app } = harness({ claudeFree: 79, codexFree: 23 });
  expect((await post(app, "sideways")).status).toBe(400);
});

test("the settings payload carries the failover state", async () => {
  const { app } = harness({ claudeFree: 79, codexFree: 23 });
  await post(app, "engage");
  const body = await (await app.fetch(new Request("http://x/api/settings"))).json();
  expect(body.defaultAgentProvider).toBe("claude");
  expect(body.providerFailover).toEqual({ active: true, from: "codex", current: "claude" });
});

test("picking a default by hand forgets the failover origin", async () => {
  const { app, store } = harness({ claudeFree: 79, codexFree: 23 });
  await post(app, "engage");
  const res = await app.fetch(
    new Request("http://x/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultAgentProvider: "claude" }),
    }),
  );
  expect(res.status).toBe(200);
  expect(config.providerFailoverFrom).toBeNull();
  expect(store.getSetting(PROVIDER_FAILOVER_FROM_KEY)).toBe("");
});
