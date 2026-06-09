import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import {
  PushService,
  attachPush,
  attachReviewPush,
  attachGitPush,
  attachMergePush,
  attachUsagePush,
  blockSummary,
  buildPayload,
  USAGE_WARN_PCT,
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

test("notify skips a subscription that muted the kind's category", async () => {
  const sent: string[] = [];
  const send: SendFn = async (s) => {
    sent.push(s.endpoint);
    return {};
  };
  const { store, push } = svc(send);
  store.putPushSub(sub("agent-on"), "");
  store.putPushSub(sub("agent-off"), "");
  store.setPushPrefs("agent-off", { agent: false, reviews: true, ci: true });
  // "done" is an agent-category kind → only the device that kept agent on hears it
  await push.notify({ kind: "done", sessionId: "s1", tag: "s1", name: "T" });
  expect(sent).toEqual(["agent-on"]);
});

test("notify routes each kind to its category", async () => {
  const sent: string[] = [];
  const send: SendFn = async (s) => {
    sent.push(s.endpoint);
    return {};
  };
  const { store, push } = svc(send);
  store.putPushSub(sub("only-ci"), "");
  store.setPushPrefs("only-ci", { agent: false, reviews: false, ci: true });
  await push.notify({ kind: "done", sessionId: "s1", tag: "s1", name: "T" }); // agent → skip
  await push.notify({ kind: "review", sessionId: "s2", tag: "s2", name: "T" }); // reviews → skip
  await push.notify({ kind: "ci", sessionId: "s3", tag: "s3", name: "T", ciState: "success" }); // ci → send
  expect(sent).toEqual(["only-ci"]);
});

test("notify leaves the cooldown clock untouched when every sub filtered it out", async () => {
  let count = 0;
  let t = 0;
  const send: SendFn = async () => {
    count++;
    return {};
  };
  const store = new SessionStore(":memory:");
  const push = new PushService(store, send, keys, () => t);
  store.putPushSub(sub("e1"), "");
  store.setPushPrefs("e1", { agent: false, reviews: true, ci: true });
  const n: NotifyInput = { kind: "done", sessionId: "s1", tag: "s1", name: "T" };
  await push.notify(n); // filtered out → nothing sent
  expect(count).toBe(0);
  // category re-enabled; the earlier suppressed attempt must not have armed cooldown
  store.setPushPrefs("e1", { agent: true, reviews: true, ci: true });
  t = 1;
  await push.notify(n);
  expect(count).toBe(1);
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

  events.emit("session:git", { id: "g1", git: gitState({ checks: "none" }) }); // first sighting → primed, no fire
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
  // First sighting carries no review → primed without seeding a review ts, so a
  // review landing afterward still notifies (priming only suppresses what was
  // already present at startup, not genuinely-new reviews).
  events.emit("session:git", { id: "g2", git: gitState({ checks: "none" }) });
  events.emit("session:git", { id: "g2", git: gitState({ checks: "none", latestReview: r1 }) });
  events.emit("session:git", { id: "g2", git: gitState({ checks: "none", latestReview: r1 }) }); // same → no fire
  events.emit("session:git", { id: "g2", git: gitState({ checks: "none", latestReview: r2 }) });
  await Promise.resolve();

  const hr = calls.filter((c) => c.kind === "review-human");
  expect(hr.map((c) => c.reviewState)).toEqual(["commented", "changes_requested"]);
  expect(hr.map((c) => c.cooldownKey)).toEqual(["review-human:g2:100", "review-human:g2:200"]);
});

test("attachGitPush primes first sighting without notifying (no restart storm)", async () => {
  const calls: any[] = [];
  const { store, push } = svc(async () => ({}));
  (push as any).notify = async (p: any) => calls.push(p);
  const events = new EventHub();
  attachGitPush(events, store, push);

  // Simulate a restart: the very first poll re-emits each open PR's *current*
  // settled state. Nothing should fire — these aren't fresh transitions.
  const review = { state: "changes_requested", author: "a", submittedAt: 100 };
  events.emit("session:git", {
    id: "g4",
    git: gitState({ checks: "success", latestReview: review }),
  });
  events.emit("session:git", {
    id: "g4",
    git: gitState({ checks: "success", latestReview: review }),
  });
  await Promise.resolve();
  expect(calls.length).toBe(0);

  // A genuine transition after priming still notifies.
  events.emit("session:git", {
    id: "g4",
    git: gitState({ checks: "failure", latestReview: review }),
  });
  await Promise.resolve();
  expect(calls.filter((c) => c.kind === "ci").map((c) => c.ciState)).toEqual(["failure"]);
});

test("attachGitPush forgets a session's dedup state on archive (re-primes, no stale fire)", async () => {
  const calls: any[] = [];
  const { store, push } = svc(async () => ({}));
  (push as any).notify = async (p: any) => calls.push(p);
  const events = new EventHub();
  attachGitPush(events, store, push);

  events.emit("session:git", { id: "g3", git: gitState({ checks: "success" }) }); // prime, no fire
  events.emit("session:git", { id: "g3", git: gitState({ checks: "failure" }) }); // transition → fire
  events.emit("session:archived", { id: "g3" }); // prune primed + dedup maps
  // id reused by a fresh session: its first sighting must re-prime, NOT be read
  // as a failure→success transition (which would fire a spurious "success").
  events.emit("session:git", { id: "g3", git: gitState({ checks: "success" }) }); // re-prime, no fire
  events.emit("session:git", { id: "g3", git: gitState({ checks: "pending" }) }); // transition → fire
  await Promise.resolve();

  expect(calls.filter((c) => c.kind === "ci").map((c) => c.ciState)).toEqual([
    "failure",
    "pending",
  ]);
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

test("buildPayload merge_attention localizes merge_error EN+DE", () => {
  const mergeErr: NotifyInput = {
    kind: "merge_attention",
    sessionId: "s",
    tag: "t",
    name: "TASK-07",
    mergeState: "merge_error",
    desig: "TASK-07",
  };
  expect(buildPayload(mergeErr, "en")).toMatchObject({
    title: "Merge failed",
    body: "TASK-07: the merge train needs your help",
  });
  expect(buildPayload(mergeErr, "de")).toMatchObject({
    title: "Merge fehlgeschlagen",
    body: "TASK-07: der Merge-Train braucht deine Hilfe",
  });
});

test("buildPayload merge_attention localizes rebase_cap EN+DE", () => {
  const rebaseCap: NotifyInput = {
    kind: "merge_attention",
    sessionId: "s",
    tag: "t",
    name: "TASK-08",
    mergeState: "rebase_cap",
    desig: "TASK-08",
  };
  expect(buildPayload(rebaseCap, "en")).toMatchObject({
    title: "Rebase limit reached",
    body: "TASK-08: too many rebase attempts — over to you",
  });
  expect(buildPayload(rebaseCap, "de")).toMatchObject({
    title: "Rebase-Limit erreicht",
    body: "TASK-08: zu viele Rebase-Versuche — du bist dran",
  });
});

test("merge_attention routes to ci category", async () => {
  const sent: string[] = [];
  const send: SendFn = async (s) => {
    sent.push(s.endpoint);
    return {};
  };
  const { store, push } = svc(send);
  store.putPushSub(sub("only-ci"), "");
  store.setPushPrefs("only-ci", { agent: false, reviews: false, ci: true });
  await push.notify({
    kind: "merge_attention",
    sessionId: "s1",
    tag: "t1",
    name: "TASK-07",
    mergeState: "merge_error",
    desig: "TASK-07",
  });
  expect(sent).toEqual(["only-ci"]);
});

test("buildPayload usage_limit localizes EN+DE and includes the reset time", () => {
  const n: NotifyInput = {
    kind: "usage_limit",
    sessionId: "",
    tag: "usage-5h",
    name: "5h",
    pct: 85,
    resetAt: Date.UTC(2026, 5, 9, 19, 30),
  };
  const en = buildPayload(n, "en");
  expect(en.title).toBe("5-hour limit at 85%");
  expect(en.body).toMatch(/^Approaching the usage cap — resets at .+\.$/);
  const de = buildPayload(n, "de");
  expect(de.title).toBe("5-Stunden-Limit bei 85 %");
  expect(de.body).toMatch(/^Limit fast erreicht — Reset um .+\.$/);
  // no resetAt → body without the time suffix
  const bare = buildPayload({ ...n, resetAt: undefined }, "en");
  expect(bare.body).toBe("Approaching the usage cap.");
});

test("usage_limit routes to agent category", async () => {
  const sent: string[] = [];
  const send: SendFn = async (s) => {
    sent.push(s.endpoint);
    return {};
  };
  const { store, push } = svc(send);
  store.putPushSub(sub("agent-on"), "");
  store.putPushSub(sub("agent-off"), "");
  store.setPushPrefs("agent-off", { agent: false, reviews: true, ci: true });
  await push.notify({ kind: "usage_limit", sessionId: "", tag: "usage-5h", name: "5h", pct: 90 });
  expect(sent).toEqual(["agent-on"]);
});

const limitsEvent = (pct: number, resetAt: number) => ({
  session5h: { pct, resetAt },
  week: null,
  stale: false,
  calibratedAt: 1,
});

/** Flush the notify→then→setSetting chain (plain microtasks aren't enough). */
const tick = () => new Promise((r) => setTimeout(r, 0));

test("attachUsagePush fires once per window at the threshold, re-arms after reset", async () => {
  const calls: any[] = [];
  const { store, push } = svc(async () => ({}));
  (push as any).notify = async (p: any) => {
    calls.push(p);
    return true; // delivered
  };
  const events = new EventHub();
  let t = 1_000;
  attachUsagePush(events, store, push, () => t);

  const resetAt = 10_000;
  events.emit("usage:limits", limitsEvent(USAGE_WARN_PCT - 1, resetAt)); // below → no fire
  events.emit("usage:limits", limitsEvent(USAGE_WARN_PCT, resetAt)); // crossing → fire
  await tick();
  events.emit("usage:limits", limitsEvent(92, resetAt)); // same window → suppressed
  events.emit("usage:limits", { session5h: null, week: null, stale: false, calibratedAt: 1 });
  await tick();
  expect(calls.length).toBe(1);
  expect(calls[0]).toMatchObject({
    kind: "usage_limit",
    tag: "usage-5h",
    pct: USAGE_WARN_PCT,
    resetAt,
    cooldownKey: "usage_limit:5h",
  });

  // window reset: now passes the stored resetAt and the next crossing fires again
  t = 11_000;
  events.emit("usage:limits", limitsEvent(81, 21_000));
  await tick();
  expect(calls.length).toBe(2);
  expect(calls[1]).toMatchObject({ pct: 81, resetAt: 21_000 });
});

test("attachUsagePush survives a restart without re-announcing (persisted marker)", async () => {
  const calls: any[] = [];
  const { store, push } = svc(async () => ({}));
  (push as any).notify = async (p: any) => {
    calls.push(p);
    return true;
  };
  let events = new EventHub();
  attachUsagePush(events, store, push, () => 1_000);
  events.emit("usage:limits", limitsEvent(85, 10_000));
  await tick();
  expect(calls.length).toBe(1);

  // "restart": fresh hub + fresh attach over the SAME store — marker persists
  events = new EventHub();
  attachUsagePush(events, store, push, () => 2_000);
  events.emit("usage:limits", limitsEvent(85, 10_000));
  await tick();
  expect(calls.length).toBe(1);
});

test("attachUsagePush retries while the push is suppressed, marks only on delivery", async () => {
  const calls: any[] = [];
  let delivered = false;
  const { store, push } = svc(async () => ({}));
  (push as any).notify = async (p: any) => {
    calls.push(p);
    return delivered;
  };
  const events = new EventHub();
  attachUsagePush(events, store, push, () => 1_000);

  events.emit("usage:limits", limitsEvent(85, 10_000)); // suppressed (e.g. app active)
  await tick();
  events.emit("usage:limits", limitsEvent(86, 10_000)); // still over → retried
  await tick();
  expect(calls.length).toBe(2);

  delivered = true;
  events.emit("usage:limits", limitsEvent(87, 10_000)); // delivered → window marked
  await tick();
  events.emit("usage:limits", limitsEvent(88, 10_000)); // marked → no more calls
  await tick();
  expect(calls.length).toBe(3);
});

test("attachMergePush notifies on merge_error and rebase_cap, ignores other states", async () => {
  const calls: any[] = [];
  const { push } = svc(async () => ({}));
  (push as any).notify = async (p: any) => calls.push(p);
  const events = new EventHub();
  attachMergePush(events, push);

  events.emit("automerge:status", {
    repoPath: "/repo/a",
    enabled: true,
    state: "merge_error",
    detail: "TASK-07",
    sessionId: "sess-a",
  });
  events.emit("automerge:status", {
    repoPath: "/repo/b",
    enabled: true,
    state: "rebase_cap",
    detail: "TASK-08",
    sessionId: "sess-b",
  });
  // Second session in the SAME repo, same attention state: must surface independently
  // (distinct tag + cooldownKey keyed by session, not collapsed/suppressed by repo).
  events.emit("automerge:status", {
    repoPath: "/repo/a",
    enabled: true,
    state: "merge_error",
    detail: "TASK-09",
    sessionId: "sess-c",
  });
  events.emit("automerge:status", {
    repoPath: "/repo/c",
    enabled: true,
    state: "merging",
    detail: null,
    sessionId: "sess-d",
  }); // not an attention state → no notify
  events.emit("automerge:status", {
    repoPath: "/repo/d",
    enabled: true,
    state: null,
    detail: null,
    sessionId: null,
  }); // idle → no notify
  await Promise.resolve();

  expect(calls.length).toBe(3);
  expect(calls[0]).toMatchObject({
    kind: "merge_attention",
    sessionId: "sess-a",
    mergeState: "merge_error",
    desig: "TASK-07",
    tag: "merge_attention:sess-a",
    cooldownKey: "merge_error:sess-a",
  });
  expect(calls[1]).toMatchObject({
    kind: "merge_attention",
    sessionId: "sess-b",
    mergeState: "rebase_cap",
    desig: "TASK-08",
    tag: "merge_attention:sess-b",
    cooldownKey: "rebase_cap:sess-b",
  });
  // Same repo + same state as calls[0], different session → distinct keys, not suppressed.
  expect(calls[2]).toMatchObject({
    kind: "merge_attention",
    sessionId: "sess-c",
    mergeState: "merge_error",
    desig: "TASK-09",
    tag: "merge_attention:sess-c",
    cooldownKey: "merge_error:sess-c",
  });
});
