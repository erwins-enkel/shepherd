import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { config } from "../src/config";

// #3221: GET /api/repo-config carries the derived `noPrCi` flag for the automation-pane hint.

let tmpRoot: string;
let repoDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-noprci-test-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(join(repoDir, ".github", "workflows"), { recursive: true });
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

function app(kind: string | null) {
  const deps: AppDeps = {
    store: new SessionStore(":memory:"),
    service: {} as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
    resolveForge: () => (kind ? ({ kind } as any) : null),
  };
  return makeApp(deps);
}

async function noPrCi(kind: string | null): Promise<unknown> {
  const r = await app(kind).fetch(
    new Request(`http://x/api/repo-config?repo=${encodeURIComponent(repoDir)}`),
  );
  return ((await r.json()) as { noPrCi?: unknown }).noPrCi;
}

test("schedule-only workflows on GitHub → noPrCi true", async () => {
  writeFileSync(join(repoDir, ".github", "workflows", "db-backup.yml"), "on: [schedule]\n");
  expect(await noPrCi("github")).toBe(true);
});

test("a pull_request workflow → noPrCi false", async () => {
  writeFileSync(join(repoDir, ".github", "workflows", "ci.yml"), "on: [pull_request]\n");
  expect(await noPrCi("github")).toBe(false);
});

test("non-GitHub or no forge → noPrCi false", async () => {
  expect(await noPrCi("gitea")).toBe(false);
  expect(await noPrCi(null)).toBe(false);
});
