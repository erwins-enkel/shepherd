import { expect, test } from "bun:test";
import { CodexResetCoordinator, decideCodexReset } from "../src/codex-reset";
import type {
  CodexAccountSnapshot,
  CodexResetRequest,
  CodexResetOutcome,
} from "../src/codex-account";

const minute = 60_000;
const now = 1_800_000_000_000;
function sample(pct = 95, at = now): CodexAccountSnapshot {
  return {
    accountId: "account-a",
    checkedAt: at,
    week: { pct, resetAt: now + 1440 * minute },
    session5h: null,
    resets: {
      availableCount: 3,
      credits: [
        { id: "later", expiresAt: now + 1440 * minute },
        { id: "first", expiresAt: now + 30 * minute },
      ],
    },
  };
}
function decide(
  pct: number,
  opts: { demand?: boolean; before?: number; expires?: number; reset?: number } = {},
) {
  const measurement = sample(pct);
  if (opts.expires != null)
    measurement.resets!.credits![1]!.expiresAt = now + opts.expires * minute;
  if (opts.reset != null) measurement.week!.resetAt = now + opts.reset * minute;
  const old = sample(opts.before ?? pct, now - 5 * minute);
  old.week!.resetAt = measurement.week!.resetAt;
  return decideCodexReset({
    measurement,
    demand: opts.demand ?? true,
    rateHistory: opts.before == null ? [] : [old, measurement],
    now,
  });
}

test("Codex reset: reserve threshold requires actual demand and chooses earliest known expiry", () => {
  expect(decide(94)).toBeNull();
  expect(decide(95)).toEqual({ reason: "capacity", creditId: "first" });
  expect(decide(99, { demand: false })).toBeNull();
});
test("Codex reset: predicts exhaustion before the reserve and honors an earlier natural renewal", () => {
  expect(decide(86, { before: 81, expires: 61 })).toMatchObject({ reason: "capacity" });
  expect(decide(84, { before: 79, expires: 61 })).toBeNull();
  expect(decide(86, { before: 81, reset: 10 })).toBeNull();
});
test("Codex reset: expiry is worthwhile only with demand, half-used capacity and a measured deficit", () => {
  expect(decide(80, { before: 79, expires: 59 })).toMatchObject({
    reason: "expiry",
    creditId: "first",
  });
  expect(decide(80, { before: 79, expires: 61 })).toBeNull();
  expect(decide(49, { before: 48 })).toBeNull();
  expect(decide(50, { before: 49 })).toMatchObject({ reason: "expiry" });
  expect(decide(80)).toBeNull();
  expect(decide(80, { before: 79, demand: false })).toBeNull();
  expect(decide(80, { before: 81 })).toBeNull();
});
test("Codex reset: stale accounts, unknown identity and expired details never authorize automatic spending", () => {
  for (const measurement of [
    sample(99, now - 91_000),
    { ...sample(), accountId: null },
    {
      ...sample(),
      resets: { availableCount: 1, credits: [{ id: "expired", expiresAt: now - 1 }] },
    },
  ]) {
    expect(decideCodexReset({ measurement, demand: true, rateHistory: [], now })).toBeNull();
  }
});

function harness(outcome: CodexResetOutcome | "lost" = "reset") {
  let time = now;
  let current = sample();
  const settings = new Map<string, string>();
  const sent: CodexResetRequest[] = [];
  let readFailure = false;
  const deps = {
    now: () => time,
    enabled: () => true,
    store: {
      getSetting: (key: string) => settings.get(key) ?? null,
      setSetting: (key: string, value: string) => {
        settings.set(key, value);
      },
    },
    client: {
      readLimits: async () => {
        if (readFailure) throw new Error("offline");
        return { ...current, checkedAt: time };
      },
      consumeReset: async (request: CodexResetRequest): Promise<CodexResetOutcome> => {
        sent.push(request);
        if (outcome === "lost") throw new Error("lost reply");
        if (outcome === "reset" || outcome === "alreadyRedeemed") current = sample(0, time);
        return outcome;
      },
    },
  };
  return {
    deps,
    settings,
    sent,
    advance: (ms: number) => {
      time += ms;
    },
    set: (s: CodexAccountSnapshot) => {
      current = s;
    },
    failReads: () => {
      readFailure = true;
    },
  };
}
test("Codex reset: concurrent requests share one redemption and capacity needs a fresh confirmation", async () => {
  const h = harness();
  const c = new CodexResetCoordinator(h.deps);
  await Promise.all(Array.from({ length: 10 }, () => c.ensureCapacity(true)));
  expect(h.sent).toHaveLength(1);
  expect(c.canRun()).toBe(true);
  expect(c.snapshot().resetStatus.lastOutcome).toBe("reset");
});
test("Codex reset: lost response survives restart with the same idempotency key and credit", async () => {
  const h = harness("lost");
  const c = new CodexResetCoordinator(h.deps);
  await c.ensureCapacity(true);
  expect(c.canRun()).toBe(false);
  h.advance(31_000);
  const restarted = new CodexResetCoordinator(h.deps);
  await restarted.ensureCapacity(true);
  expect(h.sent).toHaveLength(2);
  expect(h.sent[1]).toEqual(h.sent[0]);
});
test("Codex reset: account switch cannot spend an old unresolved operation on another account", async () => {
  const h = harness("lost");
  const c = new CodexResetCoordinator(h.deps);
  await c.ensureCapacity(true);
  h.advance(31_000);
  h.set({ ...sample(), accountId: "account-b" });
  await new CodexResetCoordinator(h.deps).ensureCapacity(true);
  expect(h.sent).toHaveLength(1);
});
test("Codex reset: no credit and ineligible windows wait without repeated attempts on unchanged measurements", async () => {
  for (const outcome of ["noCredit", "nothingToReset"] as const) {
    const h = harness(outcome);
    const c = new CodexResetCoordinator(h.deps);
    await c.ensureCapacity(true);
    h.advance(61_000);
    await c.ensureCapacity(true);
    expect(h.sent).toHaveLength(1);
    expect(c.canRun()).toBe(false);
    expect(c.snapshot().resetStatus.lastOutcome).toBe(outcome);
  }
});
test("Codex reset: successful response without refreshed limits does not release or spend another credit", async () => {
  const h = harness();
  const consume = h.deps.client.consumeReset;
  h.deps.client.consumeReset = async (r) => {
    const out = await consume(r);
    h.failReads();
    return out;
  };
  const c = new CodexResetCoordinator(h.deps);
  await c.ensureCapacity(true);
  h.advance(61_000);
  await c.ensureCapacity(true);
  expect(h.sent).toHaveLength(1);
  expect(c.canRun()).toBe(false);
});
test("Codex reset: duplicate manual request after completion never consumes again", async () => {
  const h = harness();
  const c = new CodexResetCoordinator(h.deps);
  await c.redeemManual("manual-one");
  h.set(sample());
  await new CodexResetCoordinator(h.deps).redeemManual("manual-one");
  expect(h.sent).toHaveLength(1);
});

test("Codex reset: manual request joining automation stays idempotent after restart", async () => {
  const h = harness();
  const c = new CodexResetCoordinator(h.deps);
  await Promise.all([c.ensureCapacity(true), c.redeemManual("joined")]);
  h.set(sample());
  h.advance(61_000);
  await new CodexResetCoordinator(h.deps).redeemManual("joined");
  expect(h.sent).toHaveLength(1);
});
test("Codex reset: partial reduction under pressure cannot spend a second credit", async () => {
  const h = harness();
  h.deps.client.consumeReset = async (r) => {
    h.sent.push(r);
    h.set(sample(96));
    return "reset";
  };
  h.set(sample(99));
  const c = new CodexResetCoordinator(h.deps);
  await c.ensureCapacity(true);
  h.advance(61_000);
  await c.ensureCapacity(true);
  expect(h.sent).toHaveLength(1);
  expect(c.canRun()).toBe(false);
});
test("Codex reset: admission reuses fresh measurement but spending reads again", async () => {
  const h = harness();
  h.set(sample(10));
  let reads = 0;
  const read = h.deps.client.readLimits;
  h.deps.client.readLimits = async () => {
    reads++;
    return read();
  };
  const c = new CodexResetCoordinator(h.deps);
  await c.ensureCapacity(true);
  await c.ensureCapacity(true);
  expect(reads).toBe(1);
  h.advance(31_000);
  await c.ensureCapacity(true);
  expect(reads).toBe(2);
});

test("Codex reset: unavailable refresh never releases known exhausted capacity with automation off", async () => {
  const h = harness();
  h.deps.enabled = () => false;
  h.set(sample(100));
  const c = new CodexResetCoordinator(h.deps);
  await c.refresh();
  h.failReads();
  await c.refresh();
  expect(c.canRun()).toBe(false);
});

test("Codex reset: old-account demand cannot spend a new account's credits", async () => {
  const h = harness();
  h.set({ ...sample(99), accountId: "account-b" });
  const c = new CodexResetCoordinator(h.deps);
  await c.ensureCapacity(true, "account-a");
  expect(h.sent).toHaveLength(0);
});

test("Codex reset: a positive count with truncated empty details permits server selection", () => {
  const measurement = sample(95);
  measurement.resets = { availableCount: 2, credits: [] };
  expect(decideCodexReset({ measurement, demand: true, rateHistory: [], now })).toEqual({
    reason: "capacity",
  });
  measurement.week!.pct = 80;
  expect(decideCodexReset({ measurement, demand: true, rateHistory: [], now })).toBeNull();
});

test("Codex reset: account switch during the final spending read cannot transfer a held demand", async () => {
  let reads = 0;
  const sent: CodexResetRequest[] = [];
  const settings = new Map<string, string>();
  const reset = new CodexResetCoordinator({
    now: () => now,
    enabled: () => true,
    store: {
      getSetting: (k) => settings.get(k) ?? null,
      setSetting: (k, v) => {
        settings.set(k, v);
      },
    },
    client: {
      readLimits: async () => ({
        ...sample(),
        accountId: ++reads === 1 ? "account-a" : "account-b",
      }),
      consumeReset: async (r) => {
        sent.push(r);
        return "reset";
      },
    },
  });
  await reset.ensureCapacity(true, "account-a");
  expect(sent).toHaveLength(0);
});

test("Codex reset: a manual request joining after the consume response remains idempotent", async () => {
  let reads = 0,
    pct = 95;
  let entered!: () => void, release!: () => void;
  const verifying = new Promise<void>((r) => {
    entered = r;
  });
  const unblock = new Promise<void>((r) => {
    release = r;
  });
  const sent: CodexResetRequest[] = [];
  const settings = new Map<string, string>();
  const reset = new CodexResetCoordinator({
    now: () => now,
    enabled: () => true,
    store: {
      getSetting: (k) => settings.get(k) ?? null,
      setSetting: (k, v) => {
        settings.set(k, v);
      },
    },
    client: {
      readLimits: async () => {
        if (++reads === 3) {
          entered();
          await unblock;
        }
        return sample(pct);
      },
      consumeReset: async (r) => {
        sent.push(r);
        return "reset";
      },
    },
  });
  const automatic = reset.ensureCapacity(true);
  await verifying;
  const manual = reset.redeemManual("joined-after-response");
  pct = 20;
  release();
  await Promise.all([automatic, manual]);
  pct = 95;
  await reset.redeemManual("joined-after-response");
  expect(sent).toHaveLength(1);
});
