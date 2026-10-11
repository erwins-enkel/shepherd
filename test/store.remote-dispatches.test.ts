import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import type { RemoteDispatchRow } from "../src/remote-instances/dispatch";

// Persistence of tasks sent to connected machines (#2763): one row per client key, kept across
// restarts, and a known outcome is never overwritten by a later retry that got no answer.

function row(over: Partial<RemoteDispatchRow> = {}): RemoteDispatchRow {
  return {
    id: "d-1",
    clientKey: "key-1",
    instanceId: "m-1",
    payloadHash: "h",
    wireBody: '{"prompt":"x"}',
    state: "sending",
    sessionId: null,
    heldId: null,
    reason: null,
    code: null,
    httpStatus: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

const none = { sessionId: null, heldId: null, reason: null, code: null, httpStatus: null };

describe("remote_dispatches", () => {
  test("a client key and a dispatch id can each be stored once", () => {
    const store = new SessionStore(":memory:");
    expect(store.insertRemoteDispatch(row())).toBe(true);
    expect(store.insertRemoteDispatch(row({ id: "d-2" }))).toBe(false);
    expect(store.insertRemoteDispatch(row({ clientKey: "key-2" }))).toBe(false);
    expect(store.getRemoteDispatchByKey("key-1")).toEqual(row());
    expect(store.getRemoteDispatchByKey("nope")).toBeNull();
  });

  test("settling writes over sending and unknown, never over a known outcome", () => {
    const store = new SessionStore(":memory:");
    store.insertRemoteDispatch(row());
    store.settleRemoteDispatch("d-1", { ...none, state: "unknown" }, 5);
    expect(store.getRemoteDispatchByKey("key-1")).toMatchObject({ state: "unknown", updatedAt: 5 });
    store.settleRemoteDispatch("d-1", { ...none, state: "started", sessionId: "s-1" }, 6);
    store.settleRemoteDispatch("d-1", { ...none, state: "unknown" }, 7);
    expect(store.getRemoteDispatchByKey("key-1")).toMatchObject({
      state: "started",
      sessionId: "s-1",
      updatedAt: 6,
    });
  });

  test("a stored dispatch survives reopening the database", () => {
    const dir = mkdtempSync(join(tmpdir(), "shepherd-remote-dispatch-"));
    try {
      const path = join(dir, "shepherd.db");
      new SessionStore(path).insertRemoteDispatch(row());
      expect(new SessionStore(path).getRemoteDispatchByKey("key-1")).toEqual(row());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
