import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { config } from "../src/config";
import type { Session, Recap } from "../src/types";

let tmpRoot: string;
let repoDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-recap-test-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir);
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

function harness(over: Partial<AppDeps> = {}): {
  app: ReturnType<typeof makeApp>;
  store: SessionStore;
} {
  const store = new SessionStore(":memory:");
  const deps: AppDeps = {
    store,
    service: {} as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
    ...over,
  };
  return { app: makeApp(deps), store };
}

// ── GET /api/recaps ───────────────────────────────────────────────────────────

test("GET /api/recaps returns snapshot when recapCache is present", async () => {
  const recap: Recap = {
    sessionId: "sess-1",
    state: "ready",
    headSha: "abc123",
    verdict: "ready",
    headline: "Did the thing",
    body: "",
    openItems: [],
    spawnSessionId: "spawn-abc",
    cwd: "/tmp/recap-test",
    model: null,
    spawnedAt: 900,
    generatedAt: 1000,
    updatedAt: 1000,
  };
  const { app } = harness({ recapCache: { snapshot: () => ({ "sess-1": recap }) } });
  const res = await app.fetch(new Request("http://x/api/recaps"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ "sess-1": recap });
});

test("GET /api/recaps returns {} when recapCache is absent", async () => {
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/recaps"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({});
});

// ── POST /api/sessions/:id/recap/regenerate ───────────────────────────────────

test("POST /api/sessions/:id/recap/regenerate → 202, calls regenerate, relays status:started", async () => {
  const regenerated: Session[] = [];
  const { app, store } = harness({
    recap: {
      regenerate: async (s: Session) => {
        regenerated.push(s);
        return "started" as const;
      },
    },
  });
  const seeded = store.create({
    name: "x",
    prompt: "go",
    repoPath: repoDir,
    baseBranch: "main",
    branch: "shepherd/x",
    worktreePath: join(repoDir, "wt"),
    isolated: true,
    herdrSession: "sess-x",
    herdrAgentId: "term_x",
    claudeSessionId: "claude-x",
    model: null,
  });
  const id = seeded.id;
  const res = await app.fetch(
    new Request(`http://x/api/sessions/${id}/recap/regenerate`, { method: "POST" }),
  );
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true, status: "started" });
  expect(regenerated.length).toBe(1);
  expect(regenerated[0]!.id).toBe(id);
});

test("POST /api/sessions/:id/recap/regenerate → 404 for unknown id", async () => {
  let called = false;
  const { app } = harness({
    recap: {
      regenerate: async () => {
        called = true;
        return "started" as const;
      },
    },
  });
  const res = await app.fetch(
    new Request("http://x/api/sessions/nope/recap/regenerate", { method: "POST" }),
  );
  expect(res.status).toBe(404);
  expect(called).toBe(false);
});

test("POST /api/sessions/:id/recap/regenerate → status:error when recap dep is absent", async () => {
  const { app, store } = harness(); // no recap dep
  const seeded = store.create({
    name: "z",
    prompt: "go",
    repoPath: repoDir,
    baseBranch: "main",
    branch: "shepherd/z",
    worktreePath: join(repoDir, "wt3"),
    isolated: true,
    herdrSession: "sess-z",
    herdrAgentId: "term_z",
    claudeSessionId: "claude-z",
    model: null,
  });
  const res = await app.fetch(
    new Request(`http://x/api/sessions/${seeded.id}/recap/regenerate`, { method: "POST" }),
  );
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true, status: "error" });
});
