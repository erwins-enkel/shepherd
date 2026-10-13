import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";

const sub = (endpoint: string) => ({
  endpoint,
  keys: { p256dh: "p-" + endpoint, auth: "a-" + endpoint },
});

test("putPushSub inserts and listPushSubs returns it", () => {
  const s = new SessionStore(":memory:");
  s.putPushSub(sub("e1"), "ua1");
  const rows = s.listPushSubs();
  expect(rows.length).toBe(1);
  expect(rows[0]).toMatchObject({ endpoint: "e1", p256dh: "p-e1", auth: "a-e1", ua: "ua1" });
  expect(typeof rows[0]!.createdAt).toBe("number");
});

test("putPushSub upserts by endpoint (no duplicates)", () => {
  const s = new SessionStore(":memory:");
  s.putPushSub(sub("e1"), "ua1");
  s.putPushSub({ endpoint: "e1", keys: { p256dh: "new", auth: "new2" } }, "ua2");
  const rows = s.listPushSubs();
  expect(rows.length).toBe(1);
  expect(rows[0]).toMatchObject({ p256dh: "new", auth: "new2", ua: "ua2" });
});

test("deletePushSub removes by endpoint", () => {
  const s = new SessionStore(":memory:");
  s.putPushSub(sub("e1"), "");
  s.putPushSub(sub("e2"), "");
  s.deletePushSub("e1");
  expect(s.listPushSubs().map((r) => r.endpoint)).toEqual(["e2"]);
});

test("new subscriptions default to all categories on", () => {
  const s = new SessionStore(":memory:");
  s.putPushSub(sub("e1"), "");
  expect(s.listPushSubs()[0]!.cats).toEqual({ agent: true, reviews: true, ci: true });
  expect(s.getPushPrefs("e1")).toEqual({ agent: true, reviews: true, ci: true });
});

test("getPushPrefs returns null for an unknown endpoint", () => {
  const s = new SessionStore(":memory:");
  expect(s.getPushPrefs("nope")).toBeNull();
});

test("setPushPrefs persists the category selection and reports the hit", () => {
  const s = new SessionStore(":memory:");
  s.putPushSub(sub("e1"), "");
  expect(s.setPushPrefs("e1", { agent: false, reviews: true, ci: false })).toBe(true);
  expect(s.getPushPrefs("e1")).toEqual({ agent: false, reviews: true, ci: false });
  expect(s.listPushSubs()[0]!.cats).toEqual({ agent: false, reviews: true, ci: false });
});

test("setPushPrefs returns false for an unknown endpoint", () => {
  const s = new SessionStore(":memory:");
  expect(s.setPushPrefs("ghost", { agent: true, reviews: true, ci: true })).toBe(false);
});

test("putPushSub upsert preserves an existing category selection", () => {
  const s = new SessionStore(":memory:");
  s.putPushSub(sub("e1"), "ua1");
  s.setPushPrefs("e1", { agent: false, reviews: false, ci: true });
  // re-subscribe (e.g. key rotation) must not silently reset muted categories
  s.putPushSub({ endpoint: "e1", keys: { p256dh: "new", auth: "new2" } }, "ua2");
  expect(s.getPushPrefs("e1")).toEqual({ agent: false, reviews: false, ci: true });
});

test("a registration without relay fields gets no relayed notifications (#3058)", () => {
  const s = new SessionStore(":memory:");
  s.putPushSub(sub("e1"), "");
  expect(s.listPushSubs()[0]).toMatchObject({ relayRemote: false, coveredInstances: [] });
});

test("relay preferences persist and the latest registration replaces them (#3058)", () => {
  const s = new SessionStore(":memory:");
  s.putPushSub({ ...sub("e1"), relay: { coveredInstances: ["b", "c"], relayRemote: true } }, "");
  s.setPushPrefs("e1", { agent: false, reviews: true, ci: true });
  expect(s.listPushSubs()[0]).toMatchObject({ relayRemote: true, coveredInstances: ["b", "c"] });
  s.putPushSub({ ...sub("e1"), relay: { coveredInstances: [], relayRemote: false } }, "");
  expect(s.listPushSubs()[0]).toMatchObject({ relayRemote: false, coveredInstances: [] });
  // An older client re-registering drops back to no relay; categories still survive.
  s.putPushSub({ ...sub("e1"), relay: { coveredInstances: ["b"], relayRemote: true } }, "");
  s.putPushSub(sub("e1"), "");
  expect(s.listPushSubs()[0]).toMatchObject({ relayRemote: false, coveredInstances: [] });
  expect(s.getPushPrefs("e1")).toEqual({ agent: false, reviews: true, ci: true });
});
