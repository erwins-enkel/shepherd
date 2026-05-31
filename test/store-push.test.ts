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
