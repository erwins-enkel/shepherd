import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore, type ReviewFeedbackRow } from "../src/store";
import { EventHub } from "../src/events";
import { config } from "../src/config";
import { signCookie, hashPassword, SESSION_COOKIE } from "../src/operator-auth";

// #4126: the review-feedback routes and the repo-config fields behind them.

const SECRET = "test-cookie-signing-secret";

let tmpRoot: string;
let repoA: string;
let repoB: string;
let store: SessionStore;
let prev: { secret: string | null; hash: string | null; token: string | null; root: string };

beforeEach(async () => {
  prev = {
    secret: config.cookieSecret,
    hash: config.passwordHash,
    token: config.token,
    root: config.repoRoot,
  };
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-review-feedback-test-"));
  repoA = join(tmpRoot, "a");
  repoB = join(tmpRoot, "b");
  mkdirSync(repoA, { recursive: true });
  mkdirSync(repoB, { recursive: true });
  store = new SessionStore(":memory:");
});

afterEach(() => {
  config.cookieSecret = prev.secret;
  config.passwordHash = prev.hash;
  config.token = prev.token;
  config.repoRoot = prev.root;
  rmSync(tmpRoot, { recursive: true, force: true });
});

const base = {
  name: "rf",
  prompt: "p",
  baseBranch: "main",
  branch: "shepherd/rf",
  worktreePath: "/wt",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "term_1",
};

type FakeFeedback = NonNullable<AppDeps["reviewFeedback"]>;

function fakeFeedback(over: Partial<FakeFeedback> = {}): FakeFeedback & {
  sends: [string, string[] | undefined][];
  dismissals: [string, string[]][];
} {
  const sends: [string, string[] | undefined][] = [];
  const dismissals: [string, string[]][] = [];
  return {
    sends,
    dismissals,
    pendingAll: () => ({}),
    sendNow: async (id, ids) => (sends.push([id, ids]), true),
    dismiss: (id, ids) => void dismissals.push([id, ids]),
    ...over,
  };
}

function app(reviewFeedback?: FakeFeedback) {
  const deps: AppDeps = {
    store,
    service: {} as AppDeps["service"],
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as unknown as AppDeps["usageLimits"],
    resolveForge: () => null,
    reviewFeedback,
  };
  return makeApp(deps);
}

const post = (path: string, body?: unknown) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: "http://localhost" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const putCfg = (body: unknown) =>
  app().fetch(
    new Request(`http://x/api/repo-config?repo=${encodeURIComponent(repoA)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const item = (id: string): ReviewFeedbackRow => ({
  id,
  kind: "ic",
  author: "alice",
  isBot: false,
  body: "please fix",
  createdAt: 1,
  status: "pending",
  sentAt: null,
  sentBy: null,
});

// ── repo config ────────────────────────────────────────────────────────────

test("repo config GET fills the review-feedback defaults", async () => {
  const r = await app().fetch(
    new Request(`http://x/api/repo-config?repo=${encodeURIComponent(repoA)}`),
  );
  const cfg = (await r.json()) as Record<string, unknown>;
  expect(cfg.reviewFeedbackMode).toBe("autopilot");
  expect(cfg.reviewFeedbackBots).toEqual([
    "coderabbitai",
    "copilot-pull-request-reviewer",
    "copilot",
    "claude",
  ]);
});

test("repo config PUT stores the mode and normalized, deduped bots", async () => {
  const r = await putCfg({
    reviewFeedbackMode: "always",
    reviewFeedbackBots: ["CodeRabbitAI[bot]", " coderabbitai ", "", "my-bot"],
  });
  expect(r.status).toBe(200);
  const body = (await r.json()) as Record<string, unknown>;
  expect(body.reviewFeedbackMode).toBe("always");
  expect(body.reviewFeedbackBots).toEqual(["coderabbitai", "my-bot"]);
  expect(store.getRepoConfig(repoA).reviewFeedbackMode).toBe("always");
  expect(store.getRepoConfig(repoA).reviewFeedbackBots).toEqual(["coderabbitai", "my-bot"]);
  // A patch of the bots alone keeps the mode.
  expect((await putCfg({ reviewFeedbackBots: [] })).status).toBe(200);
  expect(store.getRepoConfig(repoA).reviewFeedbackMode).toBe("always");
  expect(store.getRepoConfig(repoA).reviewFeedbackBots).toEqual([]);
});

test("repo config PUT rejects a bad mode or bot list", async () => {
  for (const bad of [
    { reviewFeedbackMode: "sometimes" },
    { reviewFeedbackMode: null },
    { reviewFeedbackBots: "coderabbitai" },
    { reviewFeedbackBots: [1] },
    { reviewFeedbackBots: ["bad login"] },
    { reviewFeedbackBots: ["-leading"] },
    { reviewFeedbackBots: ["x".repeat(40)] },
    { reviewFeedbackBots: Array.from({ length: 21 }, (_, i) => `bot${i}`) },
  ]) {
    const r = await putCfg(bad);
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toContain(Object.keys(bad)[0]!);
  }
  expect(store.getRepoConfig(repoA).reviewFeedbackMode).toBe("autopilot");
});

test("repo config PUT accepts exactly 20 bots", async () => {
  const bots = Array.from({ length: 20 }, (_, i) => `bot${i}`);
  expect((await putCfg({ reviewFeedbackBots: bots })).status).toBe(200);
  expect(store.getRepoConfig(repoA).reviewFeedbackBots).toEqual(bots);
});

// ── routes ─────────────────────────────────────────────────────────────────

test("GET pending returns the service map, {} without a service", async () => {
  const map = { s1: { items: [item("ic:1")], autoPaused: true } };
  const r = await app(fakeFeedback({ pendingAll: () => map })).fetch(
    new Request("http://localhost/api/review-feedback/pending"),
  );
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual(map);
  const none = await app().fetch(new Request("http://localhost/api/review-feedback/pending"));
  expect(await none.json()).toEqual({});
});

test("GET pending is filtered to a repository-scoped token's sessions", async () => {
  config.repoRoot = tmpRoot;
  config.cookieSecret = SECRET;
  config.passwordHash = await hashPassword("pw");
  config.token = null;
  const own = store.create({ ...base, repoPath: repoA });
  const other = store.create({ ...base, repoPath: repoB, herdrAgentId: "term_2" });
  const fb = fakeFeedback({
    pendingAll: () => ({
      [own.id]: { items: [item("ic:1")], autoPaused: false },
      [other.id]: { items: [item("ic:2")], autoPaused: false },
    }),
  });
  const a = app(fb);
  const mint = await a.fetch(
    new Request("http://x/api/access-tokens", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Cookie: `${SESSION_COOKIE}=${signCookie(SECRET)}`,
      },
      body: JSON.stringify({ name: "scoped", scope: "full", repoPaths: [repoA] }),
    }),
  );
  expect(mint.status).toBe(201);
  const { token } = (await mint.json()) as { token: string };
  const r = await a.fetch(
    new Request("http://x/api/review-feedback/pending", {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
  expect(r.status).toBe(200);
  expect(Object.keys((await r.json()) as object)).toEqual([own.id]);
  const send = await a.fetch(
    new Request(`http://x/api/sessions/${other.id}/review-feedback/send`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: "{}",
    }),
  );
  // Another repository's session reads as absent, and nothing is sent.
  expect(send.status).toBe(404);
  expect(fb.sends).toEqual([]);
});

test("send: 200 when delivered, forwarding the selected ids", async () => {
  const s = store.create({ ...base, repoPath: repoA });
  const fb = fakeFeedback();
  const r = await app(fb).fetch(
    post(`/api/sessions/${s.id}/review-feedback/send`, { ids: ["ic:1"] }),
  );
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ sent: true });
  const all = await app(fb).fetch(post(`/api/sessions/${s.id}/review-feedback/send`));
  expect(all.status).toBe(200);
  expect(fb.sends).toEqual([
    [s.id, ["ic:1"]],
    [s.id, undefined],
  ]);
});

test("send: 409 when not delivered, 404 for an unknown session, 400 for bad ids", async () => {
  const s = store.create({ ...base, repoPath: repoA });
  const r = await app(fakeFeedback({ sendNow: async () => false })).fetch(
    post(`/api/sessions/${s.id}/review-feedback/send`, {}),
  );
  expect(r.status).toBe(409);
  expect(await r.json()).toEqual({ sent: false });
  const missing = await app(fakeFeedback()).fetch(post("/api/sessions/nope/review-feedback/send"));
  expect(missing.status).toBe(404);
  for (const ids of [
    "ic:1",
    [1],
    ["x".repeat(65)],
    Array.from({ length: 201 }, (_, i) => `${i}`),
  ]) {
    const bad = await app(fakeFeedback()).fetch(
      post(`/api/sessions/${s.id}/review-feedback/send`, { ids }),
    );
    expect(bad.status).toBe(400);
  }
});

test("dismiss: 200 with ids, 400 without, 404 for an unknown session", async () => {
  const s = store.create({ ...base, repoPath: repoA });
  const fb = fakeFeedback();
  const r = await app(fb).fetch(
    post(`/api/sessions/${s.id}/review-feedback/dismiss`, { ids: ["ic:1", "rc:2"] }),
  );
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ ok: true });
  expect(fb.dismissals).toEqual([[s.id, ["ic:1", "rc:2"]]]);
  for (const body of [undefined, {}, { ids: [] }, { ids: "ic:1" }]) {
    const bad = await app(fb).fetch(post(`/api/sessions/${s.id}/review-feedback/dismiss`, body));
    expect(bad.status).toBe(400);
  }
  expect(fb.dismissals).toHaveLength(1);
  const missing = await app(fb).fetch(
    post("/api/sessions/nope/review-feedback/dismiss", { ids: ["ic:1"] }),
  );
  expect(missing.status).toBe(404);
});
