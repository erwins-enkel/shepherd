import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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
    uploads: null,
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

  test("open dispatches are the unconfirmed ones, oldest first, readable by id", () => {
    const store = new SessionStore(":memory:");
    store.insertRemoteDispatch(
      row({ id: "d-3", clientKey: "k-3", state: "unknown", createdAt: 3 }),
    );
    store.insertRemoteDispatch(
      row({ id: "d-1", clientKey: "k-1", state: "sending", createdAt: 1 }),
    );
    store.insertRemoteDispatch(
      row({ id: "d-2", clientKey: "k-2", state: "started", createdAt: 2 }),
    );
    store.insertRemoteDispatch(
      row({ id: "d-4", clientKey: "k-4", state: "canceling", createdAt: 4 }),
    );
    store.insertRemoteDispatch(
      row({ id: "d-5", clientKey: "k-5", state: "canceled", createdAt: 5 }),
    );
    expect(store.listOpenRemoteDispatches().map((r) => r.id)).toEqual(["d-1", "d-3", "d-4"]);
    expect(store.getRemoteDispatch("d-2")).toMatchObject({ clientKey: "k-2", state: "started" });
    expect(store.getRemoteDispatch("nope")).toBeNull();
  });

  test("a cancel marks only an unconfirmed dispatch, and settles from there", () => {
    const store = new SessionStore(":memory:");
    store.insertRemoteDispatch(row({ state: "unknown" }));
    store.insertRemoteDispatch(row({ id: "d-2", clientKey: "key-2", state: "started" }));
    expect(store.markRemoteDispatchCanceling("d-1", 5)).toBe(true);
    expect(store.markRemoteDispatchCanceling("d-2", 5)).toBe(false);
    expect(store.markRemoteDispatchCanceling("d-1", 6)).toBe(false);
    expect(store.getRemoteDispatch("d-1")).toMatchObject({ state: "canceling", updatedAt: 5 });
    expect(store.getRemoteDispatch("d-2")!.state).toBe("started");

    store.settleRemoteDispatch("d-1", { ...none, state: "canceled" }, 7);
    store.settleRemoteDispatch("d-1", { ...none, state: "unknown" }, 8);
    expect(store.getRemoteDispatch("d-1")).toMatchObject({ state: "canceled", updatedAt: 7 });
  });

  test("where the attachments landed is written once and kept", () => {
    const store = new SessionStore(":memory:");
    store.insertRemoteDispatch(row());
    store.setRemoteDispatchUploads("d-1", '["/mac/a.png"]', 5);
    store.setRemoteDispatchUploads("d-1", '["/mac/other.png"]', 6);
    expect(store.getRemoteDispatchByKey("key-1")).toMatchObject({
      uploads: '["/mac/a.png"]',
      updatedAt: 5,
    });
  });

  test("a table from before #2766 gains the uploads column", () => {
    const dir = mkdtempSync(join(tmpdir(), "shepherd-remote-dispatch-"));
    try {
      const path = join(dir, "shepherd.db");
      const old = new Database(path);
      old.run(`CREATE TABLE remote_dispatches (
        id TEXT PRIMARY KEY, clientKey TEXT NOT NULL UNIQUE, instanceId TEXT NOT NULL,
        payloadHash TEXT NOT NULL, wireBody TEXT NOT NULL, state TEXT NOT NULL,
        sessionId TEXT, heldId TEXT, reason TEXT, code TEXT, httpStatus INTEGER,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`);
      old.run(`INSERT INTO remote_dispatches VALUES
        ('d-0', 'key-0', 'm-1', 'h', '{}', 'started', 's-0', NULL, NULL, NULL, NULL, 1, 1)`);
      old.close();
      const store = new SessionStore(path);
      expect(store.getRemoteDispatchByKey("key-0")).toMatchObject({
        state: "started",
        uploads: null,
      });
      expect(store.insertRemoteDispatch(row({ uploads: '["/mac/a.png"]' }))).toBe(true);
      expect(store.getRemoteDispatchByKey("key-1")!.uploads).toBe('["/mac/a.png"]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
