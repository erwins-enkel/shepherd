import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import type { ReviewVerdict } from "../src/types";
import { config } from "../src/config";

let tmpRoot: string;
let repoDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-reviews-test-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir);
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

function harness(reviewCache?: AppDeps["reviewCache"]): {
  app: ReturnType<typeof makeApp>;
  store: SessionStore;
} {
  const store = new SessionStore(":memory:");
  const deps: AppDeps = {
    store,
    service: {} as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
    reviewCache,
  };
  return { app: makeApp(deps), store };
}

// ── GET /api/reviews ──────────────────────────────────────────────────────────

test("GET /api/reviews returns snapshot when reviewCache is present", async () => {
  const verdict: ReviewVerdict = {
    sessionId: "sess-1",
    headSha: "abc123",
    decision: "commented",
    summary: "Looks good",
    body: "Full body here",
    updatedAt: 1000,
  };
  const { app } = harness({ snapshot: () => ({ "sess-1": verdict }) });
  const res = await app.fetch(new Request("http://x/api/reviews"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ "sess-1": verdict });
});

test("GET /api/reviews returns {} when reviewCache is absent", async () => {
  const { app } = harness(undefined);
  const res = await app.fetch(new Request("http://x/api/reviews"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({});
});

// ── GET /api/repo-config ──────────────────────────────────────────────────────

test("GET /api/repo-config returns { criticEnabled: true } by default", async () => {
  const { app } = harness();
  const res = await app.fetch(
    new Request(`http://x/api/repo-config?repo=${encodeURIComponent(repoDir)}`),
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ criticEnabled: true });
});

test("GET /api/repo-config with empty repo param → 400", async () => {
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/repo-config"));
  expect(res.status).toBe(400);
});

test("GET /api/repo-config with repo outside root → 400", async () => {
  const { app } = harness();
  const res = await app.fetch(
    new Request(`http://x/api/repo-config?repo=${encodeURIComponent("/etc")}`),
  );
  expect(res.status).toBe(400);
});

// ── PUT /api/repo-config ──────────────────────────────────────────────────────

test("PUT /api/repo-config sets criticEnabled=false, GET reflects it", async () => {
  const { app } = harness();
  const url = `http://x/api/repo-config?repo=${encodeURIComponent(repoDir)}`;

  const put = await app.fetch(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ criticEnabled: false }),
    }),
  );
  expect(put.status).toBe(200);
  expect(await put.json()).toEqual({ criticEnabled: false });

  const get = await app.fetch(new Request(url));
  expect(get.status).toBe(200);
  expect(await get.json()).toEqual({ criticEnabled: false });
});

test("PUT /api/repo-config with non-boolean body → 400", async () => {
  const { app } = harness();
  const url = `http://x/api/repo-config?repo=${encodeURIComponent(repoDir)}`;
  const res = await app.fetch(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ criticEnabled: "yes" }),
    }),
  );
  expect(res.status).toBe(400);
});

test("PUT /api/repo-config with null body → 400", async () => {
  const { app } = harness();
  const url = `http://x/api/repo-config?repo=${encodeURIComponent(repoDir)}`;
  const res = await app.fetch(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "not json",
    }),
  );
  expect(res.status).toBe(400);
});

test("PUT /api/repo-config with repo outside root → 400", async () => {
  const { app } = harness();
  const res = await app.fetch(
    new Request(`http://x/api/repo-config?repo=${encodeURIComponent("/etc")}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ criticEnabled: false }),
    }),
  );
  expect(res.status).toBe(400);
});
