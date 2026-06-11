import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { config } from "../src/config";
import type { AdoptResult } from "../src/gitignore-adopt";

let tmpRoot: string;
let repoDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-adopt-test-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir);
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

function harness(gitignoreAdopter?: AppDeps["gitignoreAdopter"]): ReturnType<typeof makeApp> {
  const deps: AppDeps = {
    store: new SessionStore(":memory:"),
    service: {} as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
    gitignoreAdopter,
  };
  return makeApp(deps);
}

function post(repo: string): Request {
  return new Request(`http://x/api/adopt-gitignore?repo=${encodeURIComponent(repo)}`, {
    method: "POST",
  });
}

// ── POST /api/adopt-gitignore ────────────────────────────────────────────────

test("adopt applied → 200 {status:applied, prUrl}", async () => {
  const stub: AppDeps["gitignoreAdopter"] = {
    adopt: async (): Promise<AdoptResult> => ({ ok: true, status: "applied", url: "https://pr/9" }),
  };
  const res = await harness(stub).fetch(post(repoDir));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "applied", prUrl: "https://pr/9" });
});

test("adopt already → 200 {status:already}", async () => {
  const stub: AppDeps["gitignoreAdopter"] = {
    adopt: async (): Promise<AdoptResult> => ({ ok: true, status: "already" }),
  };
  const res = await harness(stub).fetch(post(repoDir));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "already" });
});

test("adopt no-access → 200 {status:no-access} (expected outcome, not an error)", async () => {
  const stub: AppDeps["gitignoreAdopter"] = {
    adopt: async (): Promise<AdoptResult> => ({ ok: false, reason: "no-access" }),
  };
  const res = await harness(stub).fetch(post(repoDir));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "no-access" });
});

test("adopt no-forge → 200 {status:no-forge} (expected outcome, not a retryable error)", async () => {
  const stub: AppDeps["gitignoreAdopter"] = {
    adopt: async (): Promise<AdoptResult> => ({ ok: false, reason: "no-forge" }),
  };
  const res = await harness(stub).fetch(post(repoDir));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "no-forge" });
});

test("adopt failure → propagates status code with error", async () => {
  const stub: AppDeps["gitignoreAdopter"] = {
    adopt: async (): Promise<AdoptResult> => ({
      ok: false,
      error: "could not resolve default branch",
      status: 502,
    }),
  };
  const res = await harness(stub).fetch(post(repoDir));
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: "could not resolve default branch" });
});

test("adopt with no gitignoreAdopter dep → 503", async () => {
  const res = await harness(undefined).fetch(post(repoDir));
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: "adopt unavailable" });
});

test("adopt with repo outside root → 400", async () => {
  const stub: AppDeps["gitignoreAdopter"] = {
    adopt: async (): Promise<AdoptResult> => ({ ok: true, status: "already" }),
  };
  const res = await harness(stub).fetch(post("/etc"));
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "invalid repo" });
});
