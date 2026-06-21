import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { config } from "../src/config";
import type { DocAgentResult } from "../src/doc-agent";
import type { DocAgentRun } from "../src/types";

let tmpRoot: string;
let repoDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-docagent-test-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir);
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

function withFlag(on: boolean, fn: () => Promise<void>): Promise<void> {
  const prev = config.docAgentEnabled;
  config.docAgentEnabled = on;
  return fn().finally(() => {
    config.docAgentEnabled = prev;
  });
}

function harness(
  consider?: (repoPath: string) => Promise<DocAgentResult>,
  opts?: { isRunning?: (repoPath: string) => boolean; runs?: DocAgentRun[] },
) {
  const store = new SessionStore(":memory:");
  if (opts?.runs?.length) {
    // pre-seed runs for the given repoDir
    for (const run of [...opts.runs].reverse()) {
      store.recordDocAgentRun(repoDir, run);
    }
  }
  const deps: AppDeps = {
    store,
    service: {} as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
    docAgent: consider
      ? {
          consider,
          isRunning: opts?.isRunning ?? (() => false),
        }
      : undefined,
  };
  return { app: makeApp(deps), store };
}

const repoUrl = (repo: string) => `http://x/api/doc-agent?repo=${encodeURIComponent(repo)}`;
const runsUrl = (repo: string) => `http://x/api/doc-agent/runs?repo=${encodeURIComponent(repo)}`;

// ── existing POST tests ──────────────────────────────────────────────────────

test("flag OFF → 404 (endpoint unadvertised) even when wired", async () => {
  await withFlag(false, async () => {
    const { app } = harness(async () => ({ status: "started" }));
    const res = await app.fetch(new Request(repoUrl(repoDir), { method: "POST" }));
    expect(res.status).toBe(404);
  });
});

test("flag ON but service unwired → 404", async () => {
  await withFlag(true, async () => {
    const { app } = harness(undefined);
    const res = await app.fetch(new Request(repoUrl(repoDir), { method: "POST" }));
    expect(res.status).toBe(404);
  });
});

test("flag ON + started → 202", async () => {
  await withFlag(true, async () => {
    let calledWith = "";
    const { app } = harness(async (r) => {
      calledWith = r;
      return { status: "started" };
    });
    const res = await app.fetch(new Request(repoUrl(repoDir), { method: "POST" }));
    expect(res.status).toBe(202);
    expect(calledWith).toContain("repo");
  });
});

test("flag ON + skipped → 409", async () => {
  await withFlag(true, async () => {
    const { app } = harness(async () => ({ status: "skipped", reason: "already running" }));
    const res = await app.fetch(new Request(repoUrl(repoDir), { method: "POST" }));
    expect(res.status).toBe(409);
  });
});

test("flag ON + error → 400", async () => {
  await withFlag(true, async () => {
    const { app } = harness(async () => ({ status: "error", reason: "no forge" }));
    const res = await app.fetch(new Request(repoUrl(repoDir), { method: "POST" }));
    expect(res.status).toBe(400);
  });
});

test("flag ON + invalid/missing repo → 400, consider not called", async () => {
  await withFlag(true, async () => {
    let called = false;
    const { app } = harness(async () => {
      called = true;
      return { status: "started" };
    });
    const res = await app.fetch(new Request("http://x/api/doc-agent", { method: "POST" }));
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });
});

test("GET is not handled (POST-only trigger)", async () => {
  await withFlag(true, async () => {
    const { app } = harness(async () => ({ status: "started" }));
    const res = await app.fetch(new Request(repoUrl(repoDir), { method: "GET" }));
    expect(res.status).toBe(404);
  });
});

// ── GET /api/doc-agent/runs tests ────────────────────────────────────────────

test("runs: flag OFF → 404", async () => {
  await withFlag(false, async () => {
    const { app } = harness(async () => ({ status: "started" }));
    const res = await app.fetch(new Request(runsUrl(repoDir), { method: "GET" }));
    expect(res.status).toBe(404);
  });
});

test("runs: flag ON but service unwired → 404", async () => {
  await withFlag(true, async () => {
    const { app } = harness(undefined);
    const res = await app.fetch(new Request(runsUrl(repoDir), { method: "GET" }));
    expect(res.status).toBe(404);
  });
});

test("runs: flag ON + bad/missing repo → 400", async () => {
  await withFlag(true, async () => {
    const { app } = harness(async () => ({ status: "started" }));
    const res = await app.fetch(new Request("http://x/api/doc-agent/runs", { method: "GET" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid repo");
  });
});

test("runs: flag ON + valid repo → {running, runs}", async () => {
  const seededRuns: DocAgentRun[] = [
    { at: 2000, url: "https://forge/pr/1", outcome: "pr" },
    { at: 1000, url: null, outcome: "nochange" },
  ];
  await withFlag(true, async () => {
    const { app } = harness(async () => ({ status: "started" }), {
      isRunning: () => false,
      runs: seededRuns,
    });
    const res = await app.fetch(new Request(runsUrl(repoDir), { method: "GET" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { running: boolean; runs: DocAgentRun[] };
    expect(body.running).toBe(false);
    expect(body.runs).toHaveLength(2);
    expect(body.runs[0]!.outcome).toBe("pr");
  });
});

test("runs: isRunning=true reflected in response", async () => {
  await withFlag(true, async () => {
    const { app } = harness(async () => ({ status: "started" }), { isRunning: () => true });
    const res = await app.fetch(new Request(runsUrl(repoDir), { method: "GET" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { running: boolean; runs: DocAgentRun[] };
    expect(body.running).toBe(true);
    expect(body.runs).toEqual([]);
  });
});
