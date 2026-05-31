import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import {
  PushService,
  attachPush,
  blockSummary,
  buildPayload,
  type NotifyInput,
  type SendFn,
} from "../src/push";
import type { BlockReason } from "../src/blocked";

const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: "p", auth: "a" } });
const keys = () => ({ publicKey: "PUB", privateKey: "PRIV" });

function svc(send: SendFn) {
  const store = new SessionStore(":memory:");
  const push = new PushService(store, send, keys);
  return { store, push };
}

test("generates and persists VAPID keys when settings empty", () => {
  const store = new SessionStore(":memory:");
  new PushService(store, async () => ({}), keys);
  expect(store.getSetting("vapidPublic")).toBe("PUB");
  expect(store.getSetting("vapidPrivate")).toBe("PRIV");
});

test("reuses persisted VAPID keys (does not regenerate)", () => {
  const store = new SessionStore(":memory:");
  store.setSetting("vapidPublic", "EXIST");
  store.setSetting("vapidPrivate", "EXIST2");
  const push = new PushService(
    store,
    async () => ({}),
    () => {
      throw new Error("should not generate");
    },
  );
  expect(push.publicKey()).toBe("EXIST");
});

test("notify sends to all subscriptions", async () => {
  const sent: string[] = [];
  const send: SendFn = async (s, payload) => {
    sent.push(s.endpoint + ":" + payload);
    return {};
  };
  const { store, push } = svc(send);
  store.putPushSub(sub("e1"), "");
  store.putPushSub(sub("e2"), "");
  await push.notify({ kind: "done", sessionId: "s1", tag: "s1", name: "T" });
  expect(sent.length).toBe(2);
  expect(sent[0]).toContain('"title":"T — finished"');
});

test("notify prunes a subscription that returns 410", async () => {
  const send: SendFn = async (s) => {
    if (s.endpoint === "dead") throw Object.assign(new Error("gone"), { statusCode: 410 });
    return {};
  };
  const { store, push } = svc(send);
  store.putPushSub(sub("dead"), "");
  store.putPushSub(sub("live"), "");
  await push.notify({ kind: "blocked", sessionId: "s", tag: "s", name: "T" });
  expect(store.listPushSubs().map((r) => r.endpoint)).toEqual(["live"]);
});

test("attachPush pushes on session:status=done", async () => {
  const calls: any[] = [];
  const { store, push } = svc(async () => ({}));
  (push as any).notify = async (p: any) => calls.push(p);
  const events = new EventHub();
  attachPush(events, store, push);
  events.emit("session:status", { id: "abc", status: "done" });
  await Promise.resolve();
  expect(calls.length).toBe(1);
  expect(calls[0]).toMatchObject({ kind: "done", sessionId: "abc", tag: "abc" });
});

test("attachPush ignores non-done statuses", async () => {
  const calls: any[] = [];
  const { store, push } = svc(async () => ({}));
  (push as any).notify = async (p: any) => calls.push(p);
  const events = new EventHub();
  attachPush(events, store, push);
  events.emit("session:status", { id: "abc", status: "running" });
  await Promise.resolve();
  expect(calls.length).toBe(0);
});

test("attachPush pushes on session:block with a reason, ignores null", async () => {
  const calls: any[] = [];
  const { store, push } = svc(async () => ({}));
  (push as any).notify = async (p: any) => calls.push(p);
  const events = new EventHub();
  attachPush(events, store, push);
  const reason: BlockReason = { shape: "yes-no", options: [], tail: [] };
  events.emit("session:block", { id: "z", block: reason });
  events.emit("session:block", { id: "z", block: null });
  await Promise.resolve();
  expect(calls.length).toBe(1);
  expect(calls[0]).toMatchObject({ kind: "blocked", sessionId: "z" });
});

test("blockSummary maps shapes to human text", () => {
  expect(blockSummary({ shape: "menu", options: [], tail: [] })).toMatch(/menu/i);
  expect(blockSummary({ shape: "yes-no", options: [], tail: [] })).toMatch(/yes/i);
  expect(blockSummary({ shape: "awaiting-input", options: [], tail: [] })).toMatch(/input/i);
});

test("buildPayload localizes title + body by subscriber locale", () => {
  const done: NotifyInput = { kind: "done", sessionId: "s", tag: "s", name: "Bob" };
  expect(buildPayload(done, "en")).toMatchObject({
    title: "Bob — finished",
    body: "Agent finished its turn.",
  });
  expect(buildPayload(done, "de")).toMatchObject({
    title: "Bob — fertig",
    body: "Agent hat seinen Zug beendet.",
  });
  // blocked body falls through to the localized block summary; unknown locale → en
  const blocked: NotifyInput = {
    kind: "blocked",
    sessionId: "s",
    tag: "s",
    name: "B",
    reason: { shape: "menu", options: [], tail: [] },
  };
  expect(buildPayload(blocked, "de").body).toBe("Wartet auf eine Menüauswahl.");
  expect(buildPayload(blocked, "fr").body).toBe("Waiting on a menu choice.");
});
