import { describe, expect, it } from "vitest";
import type { ActionsAccountBilling } from "#lib/types.js";
import {
  actionsBar,
  actionsTone,
  costlyRunner,
  daysWithoutCi,
  sortAccounts,
  usd,
  usedLabel,
} from "./github-actions";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 8);
const RESET = Date.UTC(2026, 11, 1);

function account(over: Partial<ActionsAccountBilling> = {}): ActionsAccountBilling {
  return {
    login: "acme",
    kind: "org",
    status: "ok",
    plan: "enterprise",
    includedUsd: 300,
    budget: { amountUsd: 55, stops: true },
    usedUsd: 124,
    paidUsd: 0,
    stopAtUsd: 355,
    projection: { monthEndUsd: 471, includedOutAt: NOW + 12 * DAY, stopAt: NOW + 15 * DAY },
    runners: [],
    topRepos: [],
    publicMinutes: 0,
    publicGrossUsd: 0,
    topPublicRepo: null,
    ...over,
  };
}

describe("actionsTone", () => {
  it("warns when the stop is projected before the reset, whatever the percentage", () => {
    expect(actionsTone(account(), NOW)).toBe("warn");
  });

  it("reads a stop already passed as stopped", () => {
    expect(
      actionsTone(
        account({
          projection: { monthEndUsd: 400, includedOutAt: NOW - 4 * DAY, stopAt: NOW - DAY },
        }),
        NOW,
      ),
    ).toBe("stopped");
  });

  it("reads billing on past the included amount as paid", () => {
    const a = account({
      includedUsd: 18,
      budget: null,
      stopAtUsd: null,
      usedUsd: 21.4,
      paidUsd: 3.4,
      projection: { monthEndUsd: 30, includedOutAt: NOW - DAY, stopAt: null },
    });
    expect(actionsTone(a, NOW)).toBe("paid");
  });

  it("is quiet without private runs and ok when the month lasts", () => {
    const lasts = { monthEndUsd: 9, includedOutAt: null, stopAt: null };
    expect(
      actionsTone(
        account({ includedUsd: 12, usedUsd: 0, projection: { ...lasts, monthEndUsd: 0 } }),
        NOW,
      ),
    ).toBe("quiet");
    expect(actionsTone(account({ includedUsd: 12, usedUsd: 4, projection: lasts }), NOW)).toBe(
      "ok",
    );
  });
});

describe("sortAccounts", () => {
  it("puts what needs the operator first and keeps the rest in order", () => {
    const quiet = account({
      login: "quiet",
      usedUsd: 0,
      projection: { monthEndUsd: 0, includedOutAt: null, stopAt: null },
    });
    const scope = account({ login: "me", kind: "user", status: "missing-scope" });
    const risky = account({ login: "risky" });
    const hidden = account({ login: "hidden", status: "no-access" });
    expect(sortAccounts([scope, quiet, hidden, risky], NOW).map((a) => a.login)).toEqual([
      "risky",
      "me",
      "quiet",
      "hidden",
    ]);
  });
});

describe("actionsBar", () => {
  it("scales to the stop: included edge, hatched budget, forecast to the end", () => {
    const bar = actionsBar(account());
    expect(bar.usedPct).toBeCloseTo(34.9, 1);
    expect(bar.includedTickPct).toBeCloseTo(84.5, 1);
    expect(bar.budgetFromPct).toBeCloseTo(84.5, 1);
    expect(bar.forecastToPct).toBe(100);
    expect(bar.over).toBeNull();
    expect(bar.stop).toBe(true);
  });

  it("draws spend past the included amount apart from the spend inside it", () => {
    const bar = actionsBar(account({ usedUsd: 341 }));
    expect(bar.usedPct).toBeCloseTo(84.5, 1);
    expect(bar.over?.from).toBeCloseTo(84.5, 1);
    expect(bar.over?.to).toBeCloseTo(96.1, 1);
  });

  it("without a stop, makes room for the forecast and marks the included edge", () => {
    const bar = actionsBar(
      account({
        includedUsd: 18,
        budget: null,
        stopAtUsd: null,
        usedUsd: 9,
        projection: { monthEndUsd: 36, includedOutAt: null, stopAt: null },
      }),
    );
    expect(bar.stop).toBe(false);
    expect(bar.includedTickPct).toBe(50);
    expect(bar.usedPct).toBe(25);
    expect(bar.forecastToPct).toBe(100);
    expect(bar.budgetFromPct).toBeNull();
  });

  it("has no tick when the stop is the included edge ($0 budget)", () => {
    const bar = actionsBar(
      account({
        includedUsd: 12,
        budget: { amountUsd: 0, stops: true },
        stopAtUsd: 12,
        usedUsd: 0,
      }),
    );
    expect(bar.includedTickPct).toBeNull();
    expect(bar.budgetFromPct).toBeNull();
    expect(bar.stop).toBe(true);
  });
});

describe("labels", () => {
  it("writes dollars like the credit gauge", () => {
    expect(usd(0)).toBe("$0");
    expect(usd(3.4)).toBe("$3.40");
    expect(usd(124.17)).toBe("$124");
  });

  it("shows the included share, then the budget share, then what was billed", () => {
    expect(usedLabel(account())).toBe("41%");
    expect(usedLabel(account({ usedUsd: 341 }))).toBe("75%");
    expect(usedLabel(account({ includedUsd: 18, budget: null, usedUsd: 21.4, paidUsd: 3.4 }))).toBe(
      "+$3.40",
    );
    expect(usedLabel(account({ includedUsd: null, usedUsd: 5 }))).toBe("$5.00");
  });

  it("counts the days CI stands still before the reset", () => {
    expect(
      daysWithoutCi(
        account({ projection: { monthEndUsd: 0, includedOutAt: null, stopAt: RESET - 7.4 * DAY } }),
        RESET,
      ),
    ).toBe(8);
    expect(
      daysWithoutCi(
        account({ projection: { monthEndUsd: 0, includedOutAt: null, stopAt: null } }),
        RESET,
      ),
    ).toBeNull();
  });

  it("names a runner whose cost far outruns its minutes", () => {
    const a = account({
      runners: [
        { os: "macos", minutes: 994, grossUsd: 61.6 },
        { os: "linux", minutes: 9771, grossUsd: 58.6 },
        { os: "windows", minutes: 392, grossUsd: 3.9 },
      ],
    });
    expect(costlyRunner(a)).toEqual({ os: "macos", minutesPct: 9, costPct: 50 });
    expect(
      costlyRunner(account({ runners: [{ os: "linux", minutes: 10, grossUsd: 1 }] })),
    ).toBeNull();
  });
});
