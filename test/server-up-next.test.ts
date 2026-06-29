import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { config } from "../src/config";
import type { UpNextSnapshot, UpNextSection } from "../src/up-next-core";
import type { Session } from "../src/types";

let tmpRoot: string;
let repoDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-upnext-test-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir);
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

const SNAP: UpNextSnapshot = {
  generatedAt: 123,
  repoCount: 1,
  fallback: null,
  failedRepoCount: 0,
  sections: [],
};

function harness(
  opts: {
    snapshot?: UpNextSnapshot | null;
    hiddenRepoPathsRaw?: () => Set<string>;
    create?: (input: { repoPath: string; issueRef?: { number: number } }) => Promise<Session>;
    defaultBranch?: () => Promise<string>;
  } = {},
) {
  const store = new SessionStore(":memory:");
  const createCalls: Array<{ at: number; repoPath: string; number: number | undefined }> = [];
  const labelCalls: number[] = [];
  let refreshCalls = 0;
  let n = 0;
  const deps: AppDeps = {
    store,
    service: {
      create:
        opts.create ??
        (async (input: { repoPath: string; issueRef?: { number: number } }) => {
          createCalls.push({ at: ++n, repoPath: input.repoPath, number: input.issueRef?.number });
          return { id: `s${n}` } as Session;
        }),
    } as unknown as AppDeps["service"],
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as unknown as AppDeps["usageLimits"],
    resolveForge: () =>
      ({
        defaultBranch: opts.defaultBranch ?? (async () => "main"),
        addIssueLabel: async (num: number) => {
          labelCalls.push(num);
        },
      }) as unknown as ReturnType<NonNullable<AppDeps["resolveForge"]>>,
    upNext: {
      snapshot: () => opts.snapshot ?? null,
      refresh: async () => {
        refreshCalls++;
        return SNAP;
      },
      hiddenRepoPathsRaw: opts.hiddenRepoPathsRaw ?? (() => new Set<string>()),
    },
  };
  return { app: makeApp(deps), createCalls, labelCalls, refreshCalls: () => refreshCalls };
}

const startReq = (items: unknown) =>
  new Request("http://x/api/up-next/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items }),
  });

test("GET /api/up-next returns the cached snapshot and kicks a recompute", async () => {
  const { app, refreshCalls } = harness({ snapshot: SNAP });
  const res = await app.fetch(new Request("http://x/api/up-next"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(SNAP);
  expect(refreshCalls()).toBe(1); // lens-open path kicks a recompute
});

test("GET /api/up-next?peek paints cached only (no recompute)", async () => {
  const { app, refreshCalls } = harness({ snapshot: SNAP });
  const res = await app.fetch(new Request("http://x/api/up-next?peek=1"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(SNAP);
  expect(refreshCalls()).toBe(0); // app-load path costs zero cross-repo gh fan-out
});

test("POST /api/up-next/refresh returns 202", async () => {
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/up-next/refresh", { method: "POST" }));
  expect(res.status).toBe(202);
});

test("POST /api/up-next/start spawns one session and stamps the claim", async () => {
  const { app, createCalls, labelCalls } = harness();
  const res = await app.fetch(
    startReq([{ repoPath: repoDir, issueRef: { number: 7, url: "u", title: "t", body: "b" } }]),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { created: unknown[]; errors: unknown[] };
  expect(body.created).toHaveLength(1);
  expect(body.errors).toHaveLength(0);
  expect(createCalls).toHaveLength(1);
  expect(createCalls[0]!.number).toBe(7);
  // claim is stamped asynchronously (setTimeout 0 inside claimLinkedIssue's caller is not used
  // here — we call it directly), so it should have recorded #7.
  await new Promise((r) => setTimeout(r, 5));
  expect(labelCalls).toContain(7);
});

test("POST /api/up-next/start serializes multiple spawns (no overlap)", async () => {
  let active = 0;
  let maxActive = 0;
  const { app, createCalls } = harness({
    create: async (input) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { id: `s${input.issueRef?.number}` } as Session;
    },
  });
  const items = [1, 2, 3].map((num) => ({
    repoPath: repoDir,
    issueRef: { number: num, url: "u", title: `t${num}`, body: "" },
  }));
  const res = await app.fetch(startReq(items));
  expect(res.status).toBe(201);
  void createCalls; // create is overridden in this case; serialization is asserted via maxActive
  expect(maxActive).toBe(1);
});

test("POST /api/up-next/start rejects an empty / malformed body", async () => {
  const { app } = harness();
  expect((await app.fetch(startReq([]))).status).toBe(400);
  const bad = await app.fetch(startReq([{ repoPath: repoDir, issueRef: { number: "x" } }]));
  expect(bad.status).toBe(400);
});

test("GET /api/up-next?peek strips hidden-repo sections via hiddenRepoPathsRaw", async () => {
  const hiddenPath = "/r/hidden";
  const visiblePath = "/r/visible";
  const hiddenSection: UpNextSection = {
    kind: "repo",
    repoPath: hiddenPath,
    repoSlug: "hidden",
    repoLabel: "hidden",
    items: [],
    totalCount: 0,
  };
  const visibleSection: UpNextSection = {
    kind: "repo",
    repoPath: visiblePath,
    repoSlug: "visible",
    repoLabel: "visible",
    items: [],
    totalCount: 0,
  };
  const snap: UpNextSnapshot = {
    generatedAt: 999,
    repoCount: 2,
    fallback: null,
    failedRepoCount: 0,
    sections: [hiddenSection, visibleSection],
  };
  const { app } = harness({
    snapshot: snap,
    hiddenRepoPathsRaw: () => new Set([hiddenPath]),
  });
  const res = await app.fetch(new Request("http://x/api/up-next?peek=1"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as UpNextSnapshot;
  const repoPaths = body.sections.map((s) => s.repoPath);
  expect(repoPaths).not.toContain(hiddenPath);
  expect(repoPaths).toContain(visiblePath);
});
