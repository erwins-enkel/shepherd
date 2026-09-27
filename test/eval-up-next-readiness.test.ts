import { test, expect } from "bun:test";
import {
  DEFAULT_SIM,
  MIN_PER_CLASS,
  bandedOrder,
  baselineOrder,
  decide,
  readinessAuroc,
  rng,
  simulate,
  thresholdSweep,
  type ReadinessFixture,
} from "../scripts/eval-up-next-readiness-core";
import { labelFor } from "../scripts/gen-up-next-readiness-fixtures";

// Synthetic pool: the OLDEST issues are not ready, so today's oldest-first order buries ready work.
function pool(p: (ready: boolean, i: number) => number | null, n = 30): ReadinessFixture[] {
  return Array.from({ length: n }, (_, i) => {
    const ready = i % 3 !== 0;
    return {
      repo: i < n / 2 ? "a" : "b",
      number: i + 1,
      title: `t${i}`,
      body: "",
      labels: [],
      createdAt: ready ? 1000 + i : i,
      kind: "feature" as const,
      label: ready ? ("ready" as const) : ("notReady" as const),
      p: p(ready, i),
    };
  });
}
const t = { readyAt: 0.6, notReadyBelow: 0.3 };
const opts = { ...DEFAULT_SIM, ...t, draws: 200 };

test("rng is deterministic per seed", () => {
  const a = rng(1);
  const b = rng(1);
  expect([a(), a(), a()]).toEqual([b(), b(), b()]);
});

test("baseline = today's in-repo order; banded keeps it inside a band", () => {
  const f = pool(() => 0.9, 6);
  expect(baselineOrder(f).map((x) => x.number)).toEqual(
    [...f].sort((x, y) => x.createdAt - y.createdAt).map((x) => x.number),
  );
  expect(bandedOrder(f, t).map((x) => x.number)).toEqual(baselineOrder(f).map((x) => x.number));
});

test("perfect p lifts ready@N and separates perfectly", () => {
  const f = pool((ready) => (ready ? 0.9 : 0.1));
  const { overall } = simulate(f, opts);
  expect(overall.groups).toBeGreaterThan(0);
  expect(overall.lift!).toBeGreaterThan(1);
  expect(overall.banded).toBe(1);
  expect(readinessAuroc(f).auroc).toBe(1);
});

test("a constant p is the identity (lift 1)", () => {
  const { overall } = simulate(
    pool(() => 0.5),
    opts,
  );
  expect(overall.lift).toBe(1);
});

test("simulation is deterministic for a seed", () => {
  const f = pool((ready, i) => (ready ? 0.5 + (i % 5) / 10 : (i % 4) / 10));
  expect(simulate(f, opts).overall).toEqual(simulate(f, opts).overall);
});

test("sweep skips inverted thresholds", () => {
  const rows = thresholdSweep(
    pool((r) => (r ? 0.9 : 0.1)),
    { ...DEFAULT_SIM, draws: 20 },
  );
  expect(rows.every((r) => r.notReadyBelow < r.readyAt)).toBe(true);
  expect(rows.length).toBeGreaterThan(0);
});

test("decide needs lift AND auroc AND support", () => {
  const big = pool((r) => (r ? 0.9 : 0.1), MIN_PER_CLASS * 3);
  const sim = simulate(big, opts).overall;
  expect(decide(big, sim, readinessAuroc(big)).go).toBe(true);
  expect(decide(big, { ...sim, lift: 1.1 }, readinessAuroc(big)).go).toBe(false);
  expect(decide(big, sim, { auroc: 0.65, positives: 1, negatives: 1 }).go).toBe(false);
  const small = pool((r) => (r ? 0.9 : 0.1));
  expect(decide(small, sim, readinessAuroc(small)).reasons[0]).toContain("too few");
});

test("fixture label rule", () => {
  const base = { merged: 0, open: 0, abandoned: 0, sessions: 1, reviews: 0, planRound: null };
  expect(labelFor({ ...base, merged: 1, reviews: 2 })).toBe("ready");
  expect(labelFor({ ...base, merged: 1, reviews: 3 })).toBeNull();
  expect(labelFor({ ...base, merged: 1, reviews: 4 })).toBe("notReady");
  expect(labelFor({ ...base, merged: 1, planRound: 2 })).toBe("notReady");
  expect(labelFor({ ...base, abandoned: 1 })).toBe("notReady");
  expect(labelFor({ ...base, abandoned: 1, open: 1 })).toBeNull();
  expect(labelFor({ ...base, sessions: 2, abandoned: 1 })).toBeNull();
});
