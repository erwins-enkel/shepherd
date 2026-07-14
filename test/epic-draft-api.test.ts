import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, slowRequestTimeoutSec, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { config } from "../src/config";
import type { GitForge } from "../src/forge/types";

let tmpRoot: string;
let repoDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-epic-draft-api-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir);
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

function fakeForge(opts: { failCreate?: boolean } = {}) {
  let next = 100;
  const created: number[] = [];
  const subIssues = new Map<number, number[]>();
  const blockedBy = new Map<number, number[]>();
  const forge = {
    kind: "github",
    async createIssue({ title }: { title: string; body: string }) {
      if (opts.failCreate) throw new Error("boom");
      const number = next++;
      created.push(number);
      return { number, url: `https://example.test/issues/${number}`, title };
    },
    async listSubIssues(parent: number) {
      return (subIssues.get(parent) ?? []).map((n) => ({ number: n }));
    },
    async listBlockedBy(n: number) {
      return blockedBy.get(n) ?? [];
    },
    async addSubIssue(parent: number, child: number) {
      subIssues.set(parent, [...(subIssues.get(parent) ?? []), child]);
    },
    async addBlockedBy(n: number, blocker: number) {
      blockedBy.set(n, [...(blockedBy.get(n) ?? []), blocker]);
    },
  };
  return { forge: forge as unknown as GitForge, created, subIssues, blockedBy };
}

function harness(forge: GitForge | null) {
  const store = new SessionStore(":memory:");
  const emitted: { event: string; data: unknown }[] = [];
  const hub = new EventHub();
  hub.subscribe((event, data) => emitted.push({ event, data }));
  const setRuns: unknown[] = [];
  const drain = {
    async buildEpic(repoPath: string, run: any) {
      setRuns.push(run);
      return { repoPath, parentIssueNumber: run.parentIssueNumber, children: [], run } as any;
    },
  };
  const deps: AppDeps = {
    store,
    service: { reply: () => true } as any,
    events: hub,
    resolveForge: () => forge,
    drain: drain as any,
  } as any;
  return { app: makeApp(deps), store, emitted };
}

function makeSession(store: SessionStore) {
  return store.create({
    name: "epic-session",
    prompt: "author epic",
    repoPath: repoDir,
    baseBranch: "main",
    branch: "shepherd/epic-session",
    worktreePath: repoDir,
    isolated: false,
    herdrSession: "sess-x",
    herdrAgentId: "agent-x",
    claudeSessionId: "claude-x",
    model: null,
    epicAuthoring: true,
  });
}

const draftBody = {
  parent: { title: "Ship widget", body: "end to end", acceptanceCriteria: ["works"], nonGoals: [] },
  children: [
    { key: "c1", title: "API", body: "endpoint", acceptanceCriteria: ["200"], blockedBy: [] },
    { key: "c2", title: "UI", body: "view", acceptanceCriteria: [], blockedBy: ["c1"] },
  ],
};

async function putDraft(app: ReturnType<typeof makeApp>, id: string, body: unknown = draftBody) {
  return app.fetch(
    new Request(`http://x/api/sessions/${id}/epic-draft`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}
const approve = (app: ReturnType<typeof makeApp>, id: string) =>
  app.fetch(new Request(`http://x/api/sessions/${id}/epic-draft/approve`, { method: "POST" }));

test("PUT rejects a malformed draft (missing children)", async () => {
  const { app, store } = harness(fakeForge().forge);
  const s = makeSession(store);
  const res = await putDraft(app, s.id, {
    parent: { title: "x", body: "", acceptanceCriteria: [], nonGoals: [] },
  });
  expect(res.status).toBe(400);
});

test("PUT rejects a dependency cycle (semantic)", async () => {
  const { app, store } = harness(fakeForge().forge);
  const s = makeSession(store);
  const res = await putDraft(app, s.id, {
    parent: draftBody.parent,
    children: [
      { key: "c1", title: "A", body: "", acceptanceCriteria: [], blockedBy: ["c2"] },
      { key: "c2", title: "B", body: "", acceptanceCriteria: [], blockedBy: ["c1"] },
    ],
  });
  expect(res.status).toBe(400);
});

test("PUT stores a valid draft and emits session:epic-draft", async () => {
  const { app, store, emitted } = harness(fakeForge().forge);
  const s = makeSession(store);
  const res = await putDraft(app, s.id);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.status).toBe("draft");
  expect(body.children).toHaveLength(2);
  expect(emitted.some((e) => e.event === "session:epic-draft")).toBe(true);
  expect(store.getEpicDraft(s.id)?.parent.title).toBe("Ship widget");
});

test("approve materializes children+parent, wires links, registers the run, emits epic:update", async () => {
  const fk = fakeForge();
  const { app, store, emitted } = harness(fk.forge);
  const s = makeSession(store);
  await putDraft(app, s.id);
  const res = await approve(app, s.id);
  expect(res.status).toBe(200);
  const body = await res.json();
  // children (100,101) created before parent (102)
  expect(fk.created).toEqual([100, 101, 102]);
  expect(body.parentNumber).toBe(102);
  expect(body.childNumbers).toEqual({ c1: 100, c2: 101 });
  expect(fk.subIssues.get(102)?.sort()).toEqual([100, 101]);
  expect(fk.blockedBy.get(101)).toEqual([100]);
  // epic run registered + epic:update emitted (recognition)
  expect(store.getEpicRun(repoDir)?.parentIssueNumber).toBe(102);
  expect(emitted.some((e) => e.event === "epic:update")).toBe(true);
  // draft is now approved
  expect(store.getEpicDraft(s.id)?.status).toBe("approved");
});

test("approve is idempotent — a repeat returns the stored result, no new issues", async () => {
  const fk = fakeForge();
  const { app, store } = harness(fk.forge);
  const s = makeSession(store);
  await putDraft(app, s.id);
  await approve(app, s.id);
  const before = [...fk.created];
  const res = await approve(app, s.id);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.parentNumber).toBe(102);
  expect(fk.created).toEqual(before); // no additional createIssue calls
});

test("approve 409s when a materialize is already in progress", async () => {
  const { app, store } = harness(fakeForge().forge);
  const s = makeSession(store);
  await putDraft(app, s.id);
  // Simulate an in-flight materialize by winning the CAS out-of-band.
  expect(store.beginEpicDraftMaterialize(s.id)).toBe(true);
  const res = await approve(app, s.id);
  expect(res.status).toBe(409);
});

test("approve 400s when the forge cannot create issues", async () => {
  const bare = { kind: "local" } as unknown as GitForge;
  const { app, store } = harness(bare);
  const s = makeSession(store);
  await putDraft(app, s.id);
  const res = await approve(app, s.id);
  expect(res.status).toBe(400);
});

test("a failed materialize reverts the draft to 'draft' so a retry can resume", async () => {
  const { app, store } = harness(fakeForge({ failCreate: true }).forge);
  const s = makeSession(store);
  await putDraft(app, s.id);
  const res = await approve(app, s.id);
  expect(res.status).toBe(500);
  expect(store.getEpicDraft(s.id)?.status).toBe("draft"); // reverted, not stuck at materializing
});

// The approve request itself outruns Bun's 10s default idle timeout (~25 sequential GitHub calls for
// a 12-child epic), so `serve()` lifts it per-request. Guard the route matching: a rename here would
// silently sever the socket mid-materialize again, and the operator would see a bogus failure for an
// approve that actually succeeded.
test("slowRequestTimeoutSec budgets the known-slow routes and leaves others on the default", () => {
  const sec = (method: string, path: string) =>
    slowRequestTimeoutSec(new Request(`http://x${path}`, { method }), new URL(`http://x${path}`));

  expect(sec("POST", "/api/sessions/abc-123/epic-draft/approve")).toBe(255); // Bun's ceiling
  expect(sec("POST", "/api/usage/refresh")).toBe(60); // pre-existing budget, unchanged

  // Everything else keeps the 10s default — including the draft's other verbs and near-miss paths.
  expect(sec("GET", "/api/sessions/abc-123/epic-draft/approve")).toBeNull();
  expect(sec("POST", "/api/sessions/abc-123/epic-draft")).toBeNull();
  expect(sec("POST", "/api/sessions/abc-123/epic-draft/approve/extra")).toBeNull();
  expect(sec("POST", "/api/sessions")).toBeNull();
});
