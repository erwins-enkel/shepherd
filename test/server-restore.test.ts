import { test, expect } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import { RestoreError } from "../src/service";
import { WorktreeRestoreError } from "../src/worktree";
import type { SessionStore } from "../src/store";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";
import type { Session } from "../src/types";

type Spy = { event: string; data: unknown };

function harness(opts: {
  session?: Partial<Session> | null; // null → store.get returns undefined (404)
  restoreResult?: Session | null; // what service.restore resolves to
  restoreThrows?: unknown;
}) {
  const emitted: Spy[] = [];
  const calls = { restore: [] as string[] };

  const baseSession =
    opts.session === null
      ? undefined
      : ({
          id: "sess",
          status: "archived",
          archivedAt: Date.now() - 1000,
          claudeSessionId: "abc-123",
          agentProvider: "claude",
          repoPath: "/r",
          ...opts.session,
        } as unknown as Session);

  const restoredSession =
    opts.restoreResult !== undefined
      ? opts.restoreResult
      : ({
          id: "sess",
          status: "running",
          archivedAt: null,
          claudeSessionId: "abc-123",
          agentProvider: "claude",
          repoPath: "/r",
        } as unknown as Session);

  const store = {
    get: (id: string) => (id === "sess" ? baseSession : undefined),
  } as unknown as SessionStore;

  const service = {
    restore: async (id: string) => {
      calls.restore.push(id);
      if (opts.restoreThrows) throw opts.restoreThrows;
      return restoredSession;
    },
  } as unknown as SessionService;

  const events = {
    emit: (event: string, data: unknown) => {
      emitted.push({ event, data });
    },
  } as unknown as EventHub;

  const deps: AppDeps = {
    store,
    service,
    events,
    usageLimits: { limits: () => ({}) } as never,
  };

  return { app: makeApp(deps), emitted, calls };
}

function restoreReq(id = "sess"): Request {
  return new Request(`http://localhost/api/sessions/${id}/restore`, { method: "POST" });
}

test("happy path: emits session:new, returns the restored session (200)", async () => {
  const h = harness({});
  const res = await h.app.fetch(restoreReq());
  expect(res.status).toBe(200);
  const body = (await res.json()) as Session;
  expect(body.id).toBe("sess");
  expect(body.status).toBe("running");
  expect(h.emitted).toHaveLength(1);
  expect(h.emitted[0]?.event).toBe("session:new");
  expect(h.emitted[0]?.data).toMatchObject({ id: "sess" });
  expect(h.calls.restore).toEqual(["sess"]);
});

test("missing session: service returns null + store has no row → 404", async () => {
  const h = harness({ session: null, restoreResult: null });
  const res = await h.app.fetch(restoreReq());
  expect(res.status).toBe(404);
});

test("RestoreError not_archived → 409 with code", async () => {
  const h = harness({ restoreThrows: new RestoreError("not_archived") });
  const res = await h.app.fetch(restoreReq());
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.code).toBe("not_archived");
});

test("RestoreError cannot_restore → 409 with code", async () => {
  const h = harness({ restoreThrows: new RestoreError("cannot_restore") });
  const res = await h.app.fetch(restoreReq());
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.code).toBe("cannot_restore");
});

test("WorktreeRestoreError branch_gone → 409 with code", async () => {
  const h = harness({ restoreThrows: new WorktreeRestoreError("branch_gone") });
  const res = await h.app.fetch(restoreReq());
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.code).toBe("branch_gone");
});

test("WorktreeRestoreError branch_in_use → 409 with code", async () => {
  const h = harness({ restoreThrows: new WorktreeRestoreError("branch_in_use") });
  const res = await h.app.fetch(restoreReq());
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.code).toBe("branch_in_use");
});

test("null return from service + row exists → 409 spawn_refused", async () => {
  const h = harness({ restoreResult: null });
  const res = await h.app.fetch(restoreReq());
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.code).toBe("spawn_refused");
});

test("null return from service + row missing (unknown id) → 404", async () => {
  const h = harness({ session: null, restoreResult: null });
  const res = await h.app.fetch(
    new Request("http://localhost/api/sessions/unknown/restore", { method: "POST" }),
  );
  // "unknown" never matches store.get → 404
  expect(res.status).toBe(404);
});

test("wrong method → no match (null)", async () => {
  const h = harness({});
  const res = await h.app.fetch(
    new Request("http://localhost/api/sessions/sess/restore", { method: "GET" }),
  );
  // GET /restore is not handled → falls through to 404 from makeApp
  expect(res.status).toBe(404);
});

test("in_progress guard: concurrent restore of same id → 409", async () => {
  // Make service.restore hang until released so two requests overlap.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let restoreCalls = 0;

  const deps: AppDeps = {
    store: {
      get: (id: string) =>
        id === "sess"
          ? ({
              id: "sess",
              status: "archived",
              archivedAt: Date.now() - 1000,
              claudeSessionId: "abc-123",
              agentProvider: "claude",
              repoPath: "/r",
            } as unknown as Session)
          : undefined,
    } as unknown as SessionStore,
    service: {
      restore: async () => {
        restoreCalls++;
        await gate;
        return {
          id: "sess",
          status: "running",
          archivedAt: null,
          claudeSessionId: "abc-123",
          agentProvider: "claude",
          repoPath: "/r",
        } as unknown as Session;
      },
    } as unknown as SessionService,
    events: {
      emit: () => {},
    } as unknown as EventHub,
    usageLimits: { limits: () => ({}) } as never,
  };
  const app = makeApp(deps);

  const first = app.fetch(restoreReq()); // starts, hangs waiting for gate
  // give the first request time to advance through the dispatch chain and register in inFlightRestore
  await new Promise((r) => setTimeout(r, 10));
  const secondRes = await app.fetch(restoreReq());
  expect(secondRes.status).toBe(409);
  expect((await secondRes.json()).code).toBe("in_progress");
  expect(restoreCalls).toBe(1); // second did NOT invoke restore

  release();
  const firstRes = await first;
  expect(firstRes.status).toBe(200);
});
