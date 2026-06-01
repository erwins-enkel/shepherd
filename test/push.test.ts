import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import {
  PushService,
  attachPush,
  attachReviewPush,
  attachGitPush,
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

/** A service with an injected clock + one "e1" subscription, for debounce tests. */
function svcAt(send: SendFn, now: () => number) {
  const store = new SessionStore(":memory:");
  const push = new PushService(store, send, keys, now);
  store.putPushSub(sub("e1"), "");
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
  expect(sent[0]).toContain('"title":"T — waiting"');
});

test("notify suppresses every send while a client reports it is active", async () => {
  let count = 0;
  const send: SendFn = async () => {
    count++;
    return {};
  };
  const store = new SessionStore(":memory:");
  // 5th arg: presence gate — the app is in active use, so the live UI already
  // shows this; an OS banner would be noise (and a SW can't drop it on Android).
  const push = new PushService(store, send, keys, undefined, () => true);
  store.putPushSub(sub("e1"), "");
  await push.notify({ kind: "done", sessionId: "s1", tag: "s1", name: "T" });
  await push.notify({ kind: "blocked", sessionId: "s2", tag: "s2", name: "T" });
  expect(count).toBe(0);
});

test("notify sends normally once no client is active", async () => {
  let active = true;
  let count = 0;
  const send: SendFn = async () => {
    count++;
    return {};
  };
  const store = new SessionStore(":memory:");
  const push = new PushService(store, send, keys, undefined, () => active);
  store.putPushSub(sub("e1"), "");
  await push.notify({ kind: "done", sessionId: "s1", tag: "s1", name: "T" });
  expect(count).toBe(0); // suppressed while active
  active = false;
  await push.notify({ kind: "done", sessionId: "s1", tag: "s1", name: "T" });
  expect(count).toBe(1); // flows once active clears
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

test("notify debounces repeats within the cooldown window, fires again after it", async () => {
  let count = 0;
  let t = 0;
  const send: SendFn = async () => {
    count++;
    return {};
  };
  const { push } = svcAt(send, () => t);

  const n: NotifyInput = { kind: "done", sessionId: "s1", tag: "s1", name: "T" };
  await push.notify(n); // sends
  t = 1; // 1ms later — well within the 120s default window
  await push.notify(n); // suppressed
  t = 60_000; // still inside the window
  await push.notify(n); // suppressed
  expect(count).toBe(1);

  t = 200_000; // past the 120s default window
  await push.notify(n); // sends again
  expect(count).toBe(2);
});

test("notify does not collapse different kinds for the same session", async () => {
  const sent: string[] = [];
  const send: SendFn = async (_s, payload) => {
    sent.push(payload);
    return {};
  };
  const { push } = svcAt(send, () => 0); // frozen clock

  await push.notify({ kind: "done", sessionId: "s1", tag: "s1", name: "T" });
  await push.notify({
    kind: "blocked",
    sessionId: "s1",
    tag: "s1",
    name: "T",
    reason: { shape: "yes-no", options: [], tail: [] },
  });
  // both fire even at the same instant: done and blocked use distinct keys
  expect(sent.length).toBe(2);
  expect(sent[0]).toContain('"kind":"done"');
  expect(sent[1]).toContain('"kind":"blocked"');
});

test("blockSummary maps shapes to human text", () => {
  expect(blockSummary({ shape: "menu", options: [], tail: [] })).toMatch(/menu/i);
  expect(blockSummary({ shape: "yes-no", options: [], tail: [] })).toMatch(/yes/i);
  expect(blockSummary({ shape: "awaiting-input", options: [], tail: [] })).toMatch(/input/i);
  // a stall reads as quiet/stuck, not a generic input prompt (EN + DE)
  expect(blockSummary({ shape: "stall", options: [], tail: [] })).toMatch(/quiet|stuck/i);
  expect(blockSummary({ shape: "stall", options: [], tail: [] }, "de")).toMatch(/ruhig|hängen/i);
});

test("buildPayload localizes title + body by subscriber locale", () => {
  const done: NotifyInput = { kind: "done", sessionId: "s", tag: "s", name: "Bob" };
  expect(buildPayload(done, "en")).toMatchObject({
    title: "Bob — waiting",
    body: "Agent finished its turn.",
  });
  expect(buildPayload(done, "de")).toMatchObject({
    title: "Bob — wartet",
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

test("buildPayload review kind localizes to German", () => {
  const review: NotifyInput = { kind: "review", sessionId: "s", tag: "t", name: "TASK-01" };
  expect(buildPayload(review, "de")).toMatchObject({
    title: "TASK-01 — Review",
    body: "Kritiker fordert Änderungen am PR an.",
  });
  expect(buildPayload(review, "en")).toMatchObject({
    title: "TASK-01 — review",
    body: "Critic requested changes on the PR.",
  });
});

test("buildPayload review kind varies copy by decision", () => {
  const commented: NotifyInput = {
    kind: "review",
    sessionId: "s",
    tag: "t",
    name: "TASK-02",
    decision: "commented",
  };
  expect(buildPayload(commented, "en").body).toBe("Critic left a comment on the PR.");
  expect(buildPayload(commented, "de").body).toBe("Kritiker hat den PR kommentiert.");
  // no decision → defaults to the changes-requested copy (back-compat)
  const noDecision: NotifyInput = { kind: "review", sessionId: "s", tag: "t", name: "TASK-02" };
  expect(buildPayload(noDecision, "en").body).toBe("Critic requested changes on the PR.");
});

test("attachReviewPush notifies on changes_requested and commented, ignores error/null", async () => {
  const calls: any[] = [];
  const { store, push } = svc(async () => ({}));
  (push as any).notify = async (p: any) => calls.push(p);
  const events = new EventHub();
  attachReviewPush(events, store, push);

  events.emit("session:review", { id: "r1", review: { decision: "changes_requested" } });
  events.emit("session:review", { id: "r2", review: { decision: "commented" } });
  // should NOT fire
  events.emit("session:review", { id: "r3", review: { decision: "error" } });
  events.emit("session:review", { id: "r4", review: null });

  await Promise.resolve();
  expect(calls.length).toBe(2);
  expect(calls[0]).toMatchObject({
    kind: "review",
    sessionId: "r1",
    decision: "changes_requested",
  });
  expect(calls[1]).toMatchObject({ kind: "review", sessionId: "r2", decision: "commented" });
});

function gitState(over: Partial<any> = {}) {
  return {
    kind: "github",
    state: "open",
    number: 1,
    checks: "pending",
    deployConfigured: false,
    ...over,
  };
}

test("attachGitPush notifies on each CI transition, not on 'none'", async () => {
  const calls: any[] = [];
  const { store, push } = svc(async () => ({}));
  (push as any).notify = async (p: any) => calls.push(p);
  const events = new EventHub();
  attachGitPush(events, store, push);

  events.emit("session:git", { id: "g1", git: gitState({ checks: "pending" }) });
  events.emit("session:git", { id: "g1", git: gitState({ checks: "success" }) });
  events.emit("session:git", { id: "g1", git: gitState({ checks: "success" }) }); // unchanged → no fire
  events.emit("session:git", { id: "g1", git: gitState({ checks: "none" }) }); // none → no fire
  await Promise.resolve();

  const ci = calls.filter((c) => c.kind === "ci");
  expect(ci.map((c) => c.ciState)).toEqual(["pending", "success"]);
  expect(ci[0].cooldownKey).toBe("ci:g1:pending");
  expect(ci[1].cooldownKey).toBe("ci:g1:success");
});

test("attachGitPush notifies on a newer human review only", async () => {
  const calls: any[] = [];
  const { store, push } = svc(async () => ({}));
  (push as any).notify = async (p: any) => calls.push(p);
  const events = new EventHub();
  attachGitPush(events, store, push);

  const r1 = { state: "commented", author: "a", submittedAt: 100 };
  const r2 = { state: "changes_requested", author: "b", submittedAt: 200 };
  events.emit("session:git", { id: "g2", git: gitState({ checks: "none", latestReview: r1 }) });
  events.emit("session:git", { id: "g2", git: gitState({ checks: "none", latestReview: r1 }) }); // same → no fire
  events.emit("session:git", { id: "g2", git: gitState({ checks: "none", latestReview: r2 }) });
  await Promise.resolve();

  const hr = calls.filter((c) => c.kind === "review-human");
  expect(hr.map((c) => c.reviewState)).toEqual(["commented", "changes_requested"]);
  expect(hr.map((c) => c.cooldownKey)).toEqual(["review-human:g2:100", "review-human:g2:200"]);
});

test("attachGitPush forgets a session's CI state on archive", async () => {
  const calls: any[] = [];
  const { store, push } = svc(async () => ({}));
  (push as any).notify = async (p: any) => calls.push(p);
  const events = new EventHub();
  attachGitPush(events, store, push);

  events.emit("session:git", { id: "g3", git: gitState({ checks: "success" }) });
  events.emit("session:archived", { id: "g3" });
  // same checks value again — but state was forgotten, so it fires anew
  events.emit("session:git", { id: "g3", git: gitState({ checks: "success" }) });
  await Promise.resolve();

  expect(calls.filter((c) => c.kind === "ci").length).toBe(2);
});

test("buildPayload localizes ci + review-human kinds", () => {
  const ci: NotifyInput = { kind: "ci", sessionId: "s", tag: "t", name: "N", ciState: "failure" };
  expect(buildPayload(ci, "en").body).toBe("CI failed.");
  expect(buildPayload(ci, "de").body).toBe("CI fehlgeschlagen.");
  const hr: NotifyInput = {
    kind: "review-human",
    sessionId: "s",
    tag: "t",
    name: "N",
    reviewState: "approved",
  };
  expect(buildPayload(hr, "en").body).toBe("A reviewer approved your PR.");
  expect(buildPayload(hr, "de").body).toBe("Ein Reviewer hat deinen PR genehmigt.");
});
