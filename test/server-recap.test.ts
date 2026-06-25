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
    base: "main",
    verdict: "ready",
    headline: "Did the thing",
    body: "",
    openItems: [],
    changedFiles: [],
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

// ── GET /api/sessions/done ─────────────────────────────────────────────────────

test("GET /api/sessions/done returns recently-archived sessions, excludes live ones", async () => {
  const { app, store } = harness();
  const mk = (agent: string) =>
    store.create({
      name: agent,
      prompt: "go",
      repoPath: repoDir,
      baseBranch: "main",
      branch: `shepherd/${agent}`,
      worktreePath: join(repoDir, agent),
      isolated: true,
      herdrSession: `sess-${agent}`,
      herdrAgentId: `term_${agent}`,
      claudeSessionId: `claude-${agent}`,
      model: null,
    });
  const live = mk("live");
  const doneA = mk("done-a");
  store.archive(doneA.id);
  await Bun.sleep(2); // distinct archivedAt so newest-first ordering is deterministic
  const doneB = mk("done-b");
  store.archive(doneB.id);

  const res = await app.fetch(new Request("http://x/api/sessions/done"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as Session[];
  const ids = body.map((s) => s.id);
  // both freshly-archived sessions are within the 48h window, newest-first
  expect(ids).toEqual([doneB.id, doneA.id]);
  // the never-archived (live) session is excluded
  expect(ids).not.toContain(live.id);
});

test("GET /api/sessions/done enriches issueUrl when the repo resolves to a forge webUrl", async () => {
  // resolveForge is not wired by default — inject one exposing a webUrl so the handler
  // can derive {webUrl}/issues/{n} for the archived session's issueNumber.
  const { app, store } = harness({
    resolveForge: () => ({ webUrl: "https://github.com/o/r" }) as any,
  });
  const s = store.create({
    name: "done-issue",
    prompt: "go",
    repoPath: repoDir,
    baseBranch: "main",
    branch: "shepherd/done-issue",
    worktreePath: join(repoDir, "done-issue"),
    isolated: true,
    herdrSession: "sess-done-issue",
    herdrAgentId: "term_done-issue",
    claudeSessionId: "claude-done-issue",
    model: null,
    issueNumber: 42,
  });
  store.archive(s.id);

  const res = await app.fetch(new Request("http://x/api/sessions/done"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as Array<Session & { issueUrl?: string }>;
  expect(body).toHaveLength(1);
  expect(body[0]!.issueUrl).toBe("https://github.com/o/r/issues/42");
});

test("GET /api/sessions/done omits issueUrl when no forge resolves (default harness)", async () => {
  // No resolveForge dep → no webUrl → buildIssueUrl returns null → field omitted, even
  // though the session carries an issueNumber.
  const { app, store } = harness();
  const s = store.create({
    name: "done-noforge",
    prompt: "go",
    repoPath: repoDir,
    baseBranch: "main",
    branch: "shepherd/done-noforge",
    worktreePath: join(repoDir, "done-noforge"),
    isolated: true,
    herdrSession: "sess-done-noforge",
    herdrAgentId: "term_done-noforge",
    claudeSessionId: "claude-done-noforge",
    model: null,
    issueNumber: 7,
  });
  store.archive(s.id);

  const res = await app.fetch(new Request("http://x/api/sessions/done"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as Array<Session & { issueUrl?: string }>;
  expect(body).toHaveLength(1);
  expect(body[0]!.issueNumber).toBe(7);
  expect(body[0]!.issueUrl).toBeUndefined();
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
