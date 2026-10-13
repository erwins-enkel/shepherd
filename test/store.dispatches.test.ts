import { expect, test } from "bun:test";
import { SessionStore } from "../src/store";

const reserve = (s: SessionStore, id = "k1") =>
  s.reserveDispatch({ id, payloadHash: "h1", repoPath: "/r", now: 1000 });

test("dispatches: reserveDispatch claims an id exactly once", () => {
  const s = new SessionStore(":memory:");
  expect(reserve(s)).toBe(true);
  expect(reserve(s)).toBe(false);
  expect(s.getDispatch("k1")).toEqual({
    id: "k1",
    state: "pending",
    payloadHash: "h1",
    repoPath: "/r",
    sessionId: null,
    heldId: null,
    reason: null,
    code: null,
    httpStatus: null,
    createdAt: 1000,
    updatedAt: 1000,
  });
  expect(s.getDispatch("nope")).toBeNull();
});

test("dispatches: settleDispatch writes an outcome once, only over pending", () => {
  const s = new SessionStore(":memory:");
  reserve(s);
  const started = { sessionId: "s1", heldId: null, reason: null, code: null, httpStatus: null };
  s.settleDispatch("k1", { state: "started", ...started }, 2000);
  s.settleDispatch(
    "k1",
    { state: "failed", sessionId: null, heldId: null, reason: "x", code: null, httpStatus: 502 },
    3000,
  );
  expect(s.getDispatch("k1")).toMatchObject({ state: "started", sessionId: "s1", updatedAt: 2000 });
});

test("dispatches: cancelUnknownDispatch reserves a never-seen id as failed, never an existing one", () => {
  const s = new SessionStore(":memory:");
  expect(s.cancelUnknownDispatch("gone", 5)).toBe(true);
  expect(s.getDispatch("gone")).toMatchObject({
    state: "failed",
    payloadHash: null,
    repoPath: null,
    code: "dispatch_canceled",
    httpStatus: 409,
  });
  expect(s.cancelUnknownDispatch("gone")).toBe(false);
  reserve(s);
  expect(s.cancelUnknownDispatch("k1")).toBe(false);
  expect(s.getDispatch("k1")?.state).toBe("pending");
});

test("dispatches: a held dispatch moves to started or discarded by its held id", () => {
  const s = new SessionStore(":memory:");
  const held = { sessionId: null, reason: null, code: null, httpStatus: null };
  reserve(s, "a");
  s.settleDispatch("a", { state: "held", heldId: "h-a", ...held });
  reserve(s, "b");
  s.settleDispatch("b", { state: "held", heldId: "h-b", ...held });

  s.markHeldDispatchStarted("h-a", "sess-a");
  s.markHeldDispatchDiscarded("h-b");
  expect(s.getDispatch("a")).toMatchObject({
    state: "started",
    sessionId: "sess-a",
    heldId: "h-a",
  });
  expect(s.getDispatch("b")).toMatchObject({ state: "failed", code: "held_discarded" });

  // Only a still-held dispatch transitions: a second release/discard of the same hold is a no-op.
  s.markHeldDispatchDiscarded("h-a");
  expect(s.getDispatch("a")?.state).toBe("started");
});
