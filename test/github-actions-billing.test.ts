/**
 * Tests for src/forge/github-actions-billing.ts — the monthly GitHub Actions allowance per account:
 * private-repo spend against the plan's included compute, the Actions budget's stop, the
 * projection to the next reset, and the per-account access states (missing `user` scope, no
 * billing rights). A fake `gh` runner and an injected clock keep every case deterministic.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  actionsBudget,
  classifyBillingError,
  fetchGithubActionsBilling,
  includedUsdForPlan,
  summarizeActions,
  type UsageItem,
  __resetGithubActionsBillingCache,
} from "../src/forge/github-actions-billing";

const DAY = 86_400_000;
const PERIOD_START = Date.UTC(2026, 10, 1); // 1 Nov 2026
const RESET_AT = Date.UTC(2026, 11, 1); // 1 Dec 2026
/** 8 Nov 2026 00:00 UTC — 7 whole days into the month. */
const NOW = PERIOD_START + 7 * DAY;

function item(over: Partial<UsageItem>): UsageItem {
  return {
    date: "2026-11-01T00:00:00Z",
    product: "actions",
    sku: "Actions Linux",
    unitType: "Minutes",
    quantity: 0,
    grossAmount: 0,
    netAmount: 0,
    repositoryName: "app",
    ...over,
  };
}

beforeEach(() => __resetGithubActionsBillingCache());

describe("includedUsdForPlan", () => {
  it("maps each plan to its monthly included compute in USD", () => {
    expect(includedUsdForPlan("free")).toBe(12);
    expect(includedUsdForPlan("pro")).toBe(18);
    expect(includedUsdForPlan("team")).toBe(18);
    expect(includedUsdForPlan("enterprise")).toBe(300);
  });

  it("is null for an unknown or unreadable plan", () => {
    expect(includedUsdForPlan(null)).toBeNull();
    expect(includedUsdForPlan("galactic")).toBeNull();
  });
});

describe("actionsBudget", () => {
  it("picks the product-wide Actions budget and whether it stops usage", () => {
    const budgets = {
      budgets: [
        { budget_type: "ProductPricing", budget_product_sku: "codespaces", budget_amount: 0 },
        {
          budget_type: "ProductPricing",
          budget_product_sku: "actions",
          budget_amount: 55,
          prevent_further_usage: true,
        },
      ],
    };
    expect(actionsBudget(budgets)).toEqual({ amountUsd: 55, stops: true });
  });

  it("is null without an Actions budget or for a malformed body", () => {
    expect(actionsBudget({ budgets: [] })).toBeNull();
    expect(actionsBudget("nope")).toBeNull();
  });
});

describe("summarizeActions", () => {
  const base = {
    periodStart: PERIOD_START,
    resetAt: RESET_AT,
    now: NOW,
  };

  it("counts only private-repo minutes against the allowance; public ones run free", () => {
    const s = summarizeActions({
      ...base,
      items: [
        item({ repositoryName: "shepherd", quantity: 1000, grossAmount: 6 }),
        item({
          repositoryName: "kronisto",
          sku: "Actions macOS 3-core",
          quantity: 100,
          grossAmount: 6.2,
        }),
        item({ repositoryName: "relay", quantity: 300, grossAmount: 1.8, netAmount: 0.5 }),
        // Storage is not compute and never counts here.
        item({ unitType: "GigabyteHours", sku: "Actions storage", grossAmount: 3 }),
        // Other products never count either.
        item({ product: "packages", sku: "Packages storage", grossAmount: 9 }),
      ],
      publicRepos: new Set(["shepherd"]),
      includedUsd: 300,
      budget: null,
    });
    expect(s.usedUsd).toBe(8);
    expect(s.paidUsd).toBe(0.5);
    expect(s.publicMinutes).toBe(1000);
    expect(s.publicGrossUsd).toBe(6);
    expect(s.topPublicRepo).toEqual({ repo: "shepherd", minutes: 1000 });
    expect(s.runners).toEqual([
      { os: "macos", minutes: 100, grossUsd: 6.2 },
      { os: "linux", minutes: 300, grossUsd: 1.8 },
    ]);
    expect(s.topRepos.map((r) => r.repo)).toEqual(["kronisto", "relay"]);
  });

  it("keeps the four most expensive private repos", () => {
    const items = ["a", "b", "c", "d", "e"].map((repo, i) =>
      item({ repositoryName: repo, quantity: 10, grossAmount: i + 1 }),
    );
    const s = summarizeActions({
      ...base,
      items,
      publicRepos: new Set(),
      includedUsd: 300,
      budget: null,
    });
    expect(s.topRepos.map((r) => r.repo)).toEqual(["e", "d", "c", "b"]);
  });

  it("projects when the allowance runs out and when the stopping budget halts CI", () => {
    // $70 in 7 days → $10/day. Included $100 runs out on day 10, budget $20 stops on day 12.
    const s = summarizeActions({
      ...base,
      items: [item({ quantity: 7000, grossAmount: 70 })],
      publicRepos: new Set(),
      includedUsd: 100,
      budget: { amountUsd: 20, stops: true },
    });
    expect(s.stopAtUsd).toBe(120);
    expect(s.projection.monthEndUsd).toBe(300);
    expect(s.projection.includedOutAt).toBe(PERIOD_START + 10 * DAY);
    expect(s.projection.stopAt).toBe(PERIOD_START + 12 * DAY);
  });

  it("has no crossings when the pace lasts past the reset", () => {
    const s = summarizeActions({
      ...base,
      items: [item({ quantity: 700, grossAmount: 7 })],
      publicRepos: new Set(),
      includedUsd: 300,
      budget: { amountUsd: 0, stops: true },
    });
    expect(s.projection.includedOutAt).toBeNull();
    expect(s.projection.stopAt).toBeNull();
  });

  it("dates a crossing already passed by the day the daily totals reached it", () => {
    const s = summarizeActions({
      ...base,
      items: [
        item({ date: "2026-11-01T00:00:00Z", grossAmount: 8 }),
        item({ date: "2026-11-03T00:00:00Z", grossAmount: 5 }),
        item({ date: "2026-11-04T00:00:00Z", grossAmount: 1 }),
      ],
      publicRepos: new Set(),
      includedUsd: 12,
      budget: { amountUsd: 0, stops: true },
    });
    expect(s.projection.includedOutAt).toBe(Date.parse("2026-11-03T00:00:00Z"));
    expect(s.projection.stopAt).toBe(Date.parse("2026-11-03T00:00:00Z"));
  });

  it("knows no stop without a stopping budget", () => {
    const s = summarizeActions({
      ...base,
      items: [item({ grossAmount: 70 })],
      publicRepos: new Set(),
      includedUsd: 18,
      budget: { amountUsd: 50, stops: false },
    });
    expect(s.stopAtUsd).toBeNull();
    expect(s.projection.stopAt).toBeNull();
  });

  it("projects at least one elapsed day so the first hours of a month don't explode", () => {
    const s = summarizeActions({
      ...base,
      now: PERIOD_START + 2 * 3_600_000,
      items: [item({ grossAmount: 1 })],
      publicRepos: new Set(),
      includedUsd: 12,
      budget: null,
    });
    expect(s.projection.monthEndUsd).toBe(30);
  });
});

describe("classifyBillingError", () => {
  it("reads a missing token scope from gh's stderr", () => {
    const err = Object.assign(new Error("exit 1"), {
      stderr:
        'gh: Not Found (HTTP 404)\ngh: This API operation needs the "user" scope. To request it, run:  gh auth refresh -h github.com -s user',
    });
    expect(classifyBillingError(err)).toBe("missing-scope");
  });

  it("reads 403/404 as no billing access", () => {
    expect(classifyBillingError({ stderr: "gh: Not Found (HTTP 404)" })).toBe("no-access");
    expect(classifyBillingError({ stderr: "gh: Must have admin rights (HTTP 403)" })).toBe(
      "no-access",
    );
  });

  it("treats anything else as a transient error", () => {
    expect(classifyBillingError({ stderr: "gh: API rate limit exceeded (HTTP 403)" })).toBe(
      "error",
    );
    expect(classifyBillingError(new Error("spawn gh ENOENT"))).toBe("error");
  });
});

/** A fake `gh` keyed on the endpoint path (the first non-flag arg after `api`). */
function fakeGh(routes: Record<string, string | Error>) {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    const path = args.slice(1).find((a) => !a.startsWith("-") && !a.startsWith("."));
    const bare = path?.split("?")[0] ?? "";
    const out = routes[bare] ?? new Error(`unrouted ${path}`);
    if (out instanceof Error) throw out;
    return out;
  };
  return { run, calls };
}

const missingScope = Object.assign(new Error("exit 1"), {
  stderr: 'gh: Not Found (HTTP 404)\ngh: This API operation needs the "user" scope.',
});

describe("fetchGithubActionsBilling", () => {
  const routes = (): Record<string, string | Error> => ({
    "user/orgs": JSON.stringify([{ login: "acme" }, { login: "partner" }]),
    user: JSON.stringify({ login: "kai" }),
    "users/kai/settings/billing/usage": missingScope,
    "users/kai/repos": "",
    "orgs/acme/repos": "site\n",
    "orgs/acme": JSON.stringify({ login: "acme", plan: { name: "free" } }),
    "organizations/acme/settings/billing/usage": JSON.stringify({
      usageItems: [
        item({ repositoryName: "site", quantity: 500, grossAmount: 3 }),
        item({ repositoryName: "api", quantity: 600, grossAmount: 3.6 }),
      ],
    }),
    "organizations/acme/settings/billing/budgets": JSON.stringify({
      budgets: [
        {
          budget_type: "ProductPricing",
          budget_product_sku: "actions",
          budget_amount: 0,
          prevent_further_usage: true,
        },
      ],
    }),
    "orgs/partner/repos": "",
    "orgs/partner": JSON.stringify({ login: "partner" }),
    "organizations/partner/settings/billing/usage": Object.assign(new Error("exit 1"), {
      stderr: "gh: Not Found (HTTP 404)",
    }),
    "organizations/partner/settings/billing/budgets": Object.assign(new Error("exit 1"), {
      stderr: "gh: Not Found (HTTP 404)",
    }),
  });

  it("reports the personal account and every org, each with its own access state", async () => {
    const { run } = fakeGh(routes());
    const out = await fetchGithubActionsBilling(run, () => NOW);
    expect(out.periodStart).toBe(PERIOD_START);
    expect(out.resetAt).toBe(RESET_AT);
    expect(out.accounts.map((a) => [a.login, a.kind, a.status])).toEqual([
      ["kai", "user", "missing-scope"],
      ["acme", "org", "ok"],
      ["partner", "org", "no-access"],
    ]);
    const acme = out.accounts[1]!;
    expect(acme.plan).toBe("free");
    expect(acme.includedUsd).toBe(12);
    expect(acme.usedUsd).toBe(3.6);
    expect(acme.budget).toEqual({ amountUsd: 0, stops: true });
    expect(acme.stopAtUsd).toBe(12);
    expect(acme.publicMinutes).toBe(500);
  });

  it("asks for the current UTC month", async () => {
    const { run, calls } = fakeGh(routes());
    await fetchGithubActionsBilling(run, () => NOW);
    const usage = calls.find((c) =>
      c.some((a) => a.startsWith("organizations/acme/settings/billing/usage")),
    );
    expect(usage?.join(" ")).toContain("year=2026&month=11");
  });

  it("marks an org as errored when its public repos can't be listed, never miscounting them", async () => {
    const r = routes();
    r["orgs/acme/repos"] = new Error("network");
    const { run } = fakeGh(r);
    const out = await fetchGithubActionsBilling(run, () => NOW);
    expect(out.accounts.find((a) => a.login === "acme")?.status).toBe("error");
  });

  it("serves a cached reading inside the TTL", async () => {
    const { run, calls } = fakeGh(routes());
    await fetchGithubActionsBilling(run, () => NOW);
    const first = calls.length;
    await fetchGithubActionsBilling(run, () => NOW + 60_000);
    expect(calls.length).toBe(first);
    await fetchGithubActionsBilling(run, () => NOW + 11 * 60_000);
    expect(calls.length).toBeGreaterThan(first);
  });

  it("returns no accounts when the signed-in user can't be read", async () => {
    const { run } = fakeGh({ user: new Error("gh: not logged in") });
    const out = await fetchGithubActionsBilling(run, () => NOW);
    expect(out.accounts).toEqual([]);
  });
});

describe("GET /api/usage/github-actions", () => {
  async function get(deps: Partial<import("../src/server").AppDeps>) {
    const { makeApp } = await import("../src/server");
    const { SessionStore } = await import("../src/store");
    const { EventHub } = await import("../src/events");
    const app = makeApp({
      store: new SessionStore(":memory:"),
      service: {} as never,
      events: new EventHub(),
      usageLimits: { limits: () => ({}) } as never,
      ...deps,
    });
    return app.fetch(new Request("http://x/api/usage/github-actions"));
  }

  it("serves the reading", async () => {
    const payload = { fetchedAt: 1, periodStart: 0, resetAt: 2, accounts: [] };
    const res = await get({ githubActionsBilling: async () => payload });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
  });

  it("503s without the dependency", async () => {
    expect((await get({})).status).toBe(503);
  });
});
