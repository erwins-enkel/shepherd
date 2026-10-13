import { expect, test } from "bun:test";
import { config } from "../src/config";
import { EventHub } from "../src/events";
import { SessionStore } from "../src/store";
import { attachBadgePush, awaitingOperatorCount, PushService } from "../src/push";
import { apnsEndpoint, type ApnsResult } from "../src/apns";
import type { SessionStatus } from "../src/types";

const endpoint = apnsEndpoint("sandbox", "ab".repeat(32));
const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: "", auth: "" } });
const keys = () => ({ publicKey: "PUB", privateKey: "PRIV" });

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("badge update did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("awaitingOperatorCount includes blocked and idle only, including an empty list", () => {
  expect(awaitingOperatorCount([])).toBe(0);
  expect(
    awaitingOperatorCount(
      (["running", "idle", "blocked", "done", "archived", "idle"] as SessionStatus[]).map(
        (status) => ({ status }),
      ),
    ),
  ).toBe(3);
});

test("badge sends bypass presence, categories, reduced mode and cooldown without touching web subs", async () => {
  const store = new SessionStore(":memory:");
  const badges: number[] = [];
  let alerts = 0;
  let webSends = 0;
  let active = true;
  const push = new PushService(
    store,
    async () => {
      webSends++;
      return {};
    },
    keys,
    () => 1_000,
    () => active,
    {
      enabled: true,
      send: async () => {
        alerts++;
        return { status: 200 };
      },
      sendBadge: async (_env, _token, count) => {
        badges.push(count);
        return { status: 200 };
      },
    },
  );
  store.putPushSub(sub(endpoint), "");
  store.putPushSub(sub("https://web.example"), "");
  store.setPushPrefs(endpoint, { agent: false, reviews: false, ci: false });
  const oldReduced = config.reducedPushMode;
  const oldCooldown = config.pushCooldownMs;
  try {
    config.reducedPushMode = true;
    config.pushCooldownMs = 60_000;
    const alert = { kind: "done" as const, sessionId: "s", tag: "s", name: "Session" };
    expect(await push.notify(alert)).toBe(false);
    await push.sendBadge(2);
    await push.sendBadge(0);
    expect(badges).toEqual([2, 0]);
    expect(alerts).toBe(0);
    expect(webSends).toBe(0);
    active = false;
    config.reducedPushMode = false;
    store.setPushPrefs(endpoint, { agent: true, reviews: true, ci: true });
    expect(await push.notify(alert)).toBe(true);
    await push.sendBadge(1);
    expect(await push.notify(alert)).toBe(false);
    expect(alerts).toBe(1);
    expect(badges).toEqual([2, 0, 1]);
  } finally {
    config.reducedPushMode = oldReduced;
    config.pushCooldownMs = oldCooldown;
  }
});

test("badge sends prune dead tokens, retain transient failures and continue after transport errors", async () => {
  const store = new SessionStore(":memory:");
  const results: (ApnsResult | Error)[] = [
    { status: 410, reason: "Unregistered" },
    { status: 400, reason: "BadDeviceToken" },
    { status: 429 },
    new Error("offline"),
    { status: 200 },
  ];
  let sends = 0;
  const push = new PushService(
    store,
    async () => ({}),
    keys,
    undefined,
    () => true,
    {
      enabled: true,
      send: async () => ({ status: 200 }),
      sendBadge: async () => {
        sends++;
        const result = results.shift()!;
        if (result instanceof Error) throw result;
        return result;
      },
    },
  );
  for (const token of ["aa", "bb", "cc", "dd", "ee"]) {
    store.putPushSub(sub(apnsEndpoint("sandbox", token.repeat(32))), "");
  }
  await push.sendBadge(0);
  expect(sends).toBe(5);
  expect(store.listPushSubs()).toHaveLength(3);
});

test("badge attachment debounces store reads, dedupes, handles all lifecycle events and resets on iOS registration", async () => {
  const store = new SessionStore(":memory:");
  const push = new PushService(store, async () => ({}), keys);
  const events = new EventHub();
  const counts: number[] = [];
  let sessions: { status: SessionStatus }[] = [{ status: "idle" }];
  let reads = 0;
  push.sendBadge = async (count) => {
    counts.push(count);
  };
  const detach = attachBadgePush(
    events,
    {
      list: (opts) => {
        expect(opts).toEqual({ activeOnly: true });
        reads++;
        return sessions as ReturnType<SessionStore["list"]>;
      },
    },
    push,
    15,
  );
  try {
    await until(() => counts.length === 1);
    expect(counts).toEqual([1]);
    sessions = [{ status: "blocked" }, { status: "idle" }];
    const before = reads;
    events.emit("session:status", { id: "s", status: "done" }); // deliberately stale payload
    events.emit("session:block", { id: "s", block: null });
    events.emit("session:new", {});
    expect(reads).toBe(before);
    await until(() => counts.length === 2);
    expect(reads).toBe(before + 1);
    expect(counts).toEqual([1, 2]);
    events.emit("session:status", {});
    await until(() => reads === before + 2);
    expect(counts).toEqual([1, 2]);
    sessions = [];
    events.emit("session:archived", {});
    await until(() => counts.length === 3);
    expect(counts).toEqual([1, 2, 0]);
    const beforeWeb = reads;
    push.subscribe(sub("https://web.example"), "");
    expect(reads).toBe(beforeWeb);
    push.subscribe(sub(endpoint), "");
    await until(() => counts.length === 4);
    expect(counts).toEqual([1, 2, 0, 0]);
    // The same device re-registering after launch also repairs its count.
    push.subscribe(sub(endpoint), "");
    await until(() => counts.length === 5);
    expect(counts).toEqual([1, 2, 0, 0, 0]);
  } finally {
    detach();
  }
});
