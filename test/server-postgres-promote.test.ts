import { test, expect, beforeEach } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { PostgresError } from "../src/postgres";
import { sessionDb } from "../src/postgres-core";

// #4240: POST /api/sessions/:id/postgres/promote + the transient `postgresDb` session flag.

let store: SessionStore;
let promote: (id: string) => Promise<{ template: string }>;

beforeEach(() => {
  store = new SessionStore(":memory:");
  promote = async () => ({ template: "r_demo_12345678_base" });
});

function app() {
  const deps: AppDeps = {
    store,
    service: {} as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
    resolveForge: () => null,
    postgres: {
      applySettings: async () => {},
      request: async () => ({ status: "starting" }),
      reset: async () => ({ status: "starting" }),
      sessionStatus: async () => ({ server: "off", database: "none" }),
      settings: () => ({ enabled: true, port: 54318, idleMinutes: 15, image: "postgres:18" }),
      promote: (id) => promote(id),
    },
  };
  return makeApp(deps);
}

function mkSession(): string {
  return store.create({
    name: "t",
    prompt: "p",
    repoPath: "/repos/demo",
    baseBranch: "main",
    branch: "shepherd/t",
    worktreePath: "/repos/demo-wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: `a${Math.random()}`,
  }).id;
}

const post = (id: string) =>
  app().fetch(new Request(`http://x/api/sessions/${id}/postgres/promote`, { method: "POST" }));

test("promote answers the new template", async () => {
  const seen: string[] = [];
  promote = async (id) => {
    seen.push(id);
    return { template: "r_demo_12345678_base" };
  };
  const res = await post("abc");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, template: "r_demo_12345678_base" });
  expect(seen).toEqual(["abc"]);
});

test("no database / unknown session is 404, other failures 503", async () => {
  promote = async () => {
    throw new PostgresError("no-database", "This session has no database");
  };
  let res = await post("abc");
  expect(res.status).toBe(404);
  expect(await res.json()).toMatchObject({ code: "no-database" });
  promote = async () => {
    throw new PostgresError("docker", "Docker unreachable");
  };
  res = await post("abc");
  expect(res.status).toBe(503);
  expect(await res.json()).toMatchObject({ code: "docker", error: "Docker unreachable" });
});

test("only POST on the exact path", async () => {
  const res = await app().fetch(new Request("http://x/api/sessions/abc/postgres/promote"));
  expect(res.status).not.toBe(200);
});

test("sessions carry postgresDb while their lease is active", async () => {
  const id = mkSession();
  const flag = async () => {
    const res = await app().fetch(new Request("http://x/api/sessions"));
    const rows = (await res.json()) as { id: string; postgresDb?: boolean }[];
    return rows.find((r) => r.id === id)?.postgresDb;
  };
  expect(await flag()).toBe(false);
  store.upsertPostgresLease({
    sessionId: id,
    repoPath: "/repos/demo",
    db: sessionDb(id),
    role: "r",
  });
  expect(await flag()).toBe(true);
  store.setPostgresLeaseState(id, "dropping");
  expect(await flag()).toBe(false);
});
