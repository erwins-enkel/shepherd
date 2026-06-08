import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import type { SessionStore } from "../src/store";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";
import { config } from "../src/config";

let tmpRoot: string;
let repoDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-readiness-test-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir);
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

function deps(): AppDeps {
  return {
    store: {} as SessionStore,
    service: {} as SessionService,
    events: { emit: () => {} } as unknown as EventHub,
    usageLimits: { limits: () => ({}) } as never,
  };
}

function req(repo: string): Request {
  return new Request(`http://localhost/api/readiness?repo=${encodeURIComponent(repo)}`);
}

test("GET /api/readiness scans the repo and returns a scorecard", async () => {
  writeFileSync(
    join(repoDir, "package.json"),
    JSON.stringify({ name: "r", scripts: { lint: "eslint ." } }),
  );
  const app = makeApp(deps());
  const res = await app.fetch(req(repoDir));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.applicable).toBe(true);
  expect(Array.isArray(body.checks)).toBe(true);
  expect(body.checks.find((c: { id: string }) => c.id === "linter").present).toBe(true);
  expect(typeof body.claudeMd).toBe("string");
});

test("GET /api/readiness for a non-JS repo → applicable:false", async () => {
  const app = makeApp(deps());
  const res = await app.fetch(req(repoDir));
  expect(res.status).toBe(200);
  expect((await res.json()).applicable).toBe(false);
});

test("GET /api/readiness?repo outside root → 400", async () => {
  const app = makeApp(deps());
  const res = await app.fetch(req("/etc"));
  expect(res.status).toBe(400);
});
