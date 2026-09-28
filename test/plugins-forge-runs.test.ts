// Coverage for the `ctx.forge.runs` plugin capability (#2539): the in-flight cursor barrier,
// input validation, typed refusals, log tail + masking, rerun, and registry wiring.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { PluginRegistry } from "../src/plugins/loader";
import { makePluginForgeRuns } from "../src/plugins/forge-runs";
import { LocalForge } from "../src/forge/local";
import type { ForgeRun, GitForge } from "../src/forge/types";
import type { PluginForgeRuns } from "../src/plugins/types";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const HOUR = 60 * 60 * 1000;

let root: string;
let repo: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "shepherd-plugin-forge-runs-"));
  repo = join(root, "repo");
  await mkdir(repo);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function run(id: number, over: Partial<ForgeRun> = {}): ForgeRun {
  return {
    id,
    workflowName: "CI",
    workflowFile: ".github/workflows/ci.yml",
    event: "push",
    status: "completed",
    conclusion: "success",
    attempt: 1,
    headSha: "sha",
    createdAt: NOW - HOUR,
    url: `https://x/runs/${id}`,
    ...over,
  };
}

function fakeForge(rows: ForgeRun[], over: Partial<GitForge> = {}) {
  const calls: unknown[][] = [];
  const forge = {
    kind: "github",
    listDefaultBranchRuns: async (o: { sinceId?: number }) => {
      calls.push(["list", o]);
      return rows;
    },
    runJobs: async (id: number) => {
      calls.push(["jobs", id]);
      return [{ id: id * 10, name: "test", conclusion: "failure" }];
    },
    getRunDetail: async (id: number) => rows.find((r) => r.id === id) ?? null,
    failedRunStepLogs: async () => [],
    rerunWorkflowRun: async (id: number, o: { failedOnly: boolean }) =>
      void calls.push(["rerun", id, o]),
    ...over,
  } as unknown as GitForge;
  return { forge, calls };
}

function runsWith(forge: GitForge | null): PluginForgeRuns {
  return makePluginForgeRuns({ repoRoot: root, resolveForge: () => forge, now: () => NOW });
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  const err = (await p.then(
    () => null,
    (e: unknown) => e,
  )) as { name?: string; code?: string } | null;
  expect(err?.name).toBe("PluginForgeError");
  return err?.code ?? "";
}

const ids = (r: { runs: { id: number }[]; cursor: number }) => ({
  ids: r.runs.map((x) => x.id),
  cursor: r.cursor,
});

test("a slow lower-id run holds the cursor until it completes", async () => {
  // `test` (101) still running, `lint` (102) already done — lint is withheld, cursor stays.
  const inFlight = fakeForge([run(102), run(101, { status: "in_progress", conclusion: null })]);
  expect(ids(await runsWith(inFlight.forge).listDefaultBranchRuns(repo, { sinceId: 100 }))).toEqual(
    { ids: [], cursor: 100 },
  );
  // Next poll, after 101 finished: both come back, ascending, cursor past both.
  const done = fakeForge([run(102), run(101, { conclusion: "failure" })]);
  expect(ids(await runsWith(done.forge).listDefaultBranchRuns(repo, { sinceId: 100 }))).toEqual({
    ids: [101, 102],
    cursor: 102,
  });
});

test("runs below the barrier are returned; the cursor stops short of it", async () => {
  const { forge } = fakeForge([
    run(104),
    run(103, { status: "queued", conclusion: null }),
    run(102),
    run(101),
  ]);
  expect(ids(await runsWith(forge).listDefaultBranchRuns(repo, { sinceId: 100 }))).toEqual({
    ids: [101, 102],
    cursor: 102,
  });
});

test("an in-flight run older than 24h no longer holds the cursor and is skipped", async () => {
  const { forge } = fakeForge([
    run(102),
    run(101, { status: "in_progress", conclusion: null, createdAt: NOW - 25 * HOUR }),
  ]);
  expect(ids(await runsWith(forge).listDefaultBranchRuns(repo, { sinceId: 100 }))).toEqual({
    ids: [102],
    cursor: 102,
  });
});

test("limit truncates the ascending list; cursor = last returned", async () => {
  const { forge } = fakeForge([run(5), run(3), run(4), run(2), run(1)]);
  expect(ids(await runsWith(forge).listDefaultBranchRuns(repo, { sinceId: 1, limit: 2 }))).toEqual({
    ids: [2, 3],
    cursor: 3,
  });
});

test("summary rows get jobs via runJobs; rows with jobs are kept as-is", async () => {
  const withJobs = run(2, { jobs: [{ id: 7, name: "lint", conclusion: "success" }] });
  const { forge, calls } = fakeForge([run(1), withJobs]);
  const { runs } = await runsWith(forge).listDefaultBranchRuns(repo);
  expect(runs[0]!.jobs).toEqual([{ id: 10, name: "test", conclusion: "failure" }]);
  expect(runs[1]!.jobs).toEqual([{ id: 7, name: "lint", conclusion: "success" }]);
  expect(calls).toEqual([
    ["list", { sinceId: 0 }],
    ["jobs", 1],
  ]);
  expect(runs[0]).toEqual({
    id: 1,
    workflowName: "CI",
    workflowFile: ".github/workflows/ci.yml",
    event: "push",
    status: "completed",
    conclusion: "success",
    attempt: 1,
    headSha: "sha",
    createdAt: NOW - HOUR,
    url: "https://x/runs/1",
    jobs: [{ id: 10, name: "test", conclusion: "failure" }],
  });
});

test("typed refusals", async () => {
  const { forge } = fakeForge([]);
  expect(await codeOf(makePluginForgeRuns(undefined).getRun(repo, 1))).toBe("no-forge");
  expect(await codeOf(runsWith(forge).getRun("/etc", 1))).toBe("invalid-repo");
  expect(await codeOf(runsWith(null).getRun(repo, 1))).toBe("no-forge");
  const local = new LocalForge(repo, new SessionStore(":memory:"));
  expect(await codeOf(runsWith(local).listDefaultBranchRuns(repo))).toBe("lightweight");
  const bare = fakeForge([], { failedRunStepLogs: undefined, rerunWorkflowRun: undefined }).forge;
  expect(await codeOf(runsWith(bare).failedJobLogs(repo, 1))).toBe("unsupported");
  expect(await codeOf(runsWith(bare).rerunFailed(repo, 1))).toBe("unsupported");
});

test("input validation", async () => {
  const r = runsWith(fakeForge([]).forge);
  expect(await codeOf(r.getRun(repo, 0))).toBe("invalid-input");
  expect(await codeOf(r.getRun(repo, 1.5))).toBe("invalid-input");
  expect(await codeOf(r.listDefaultBranchRuns(repo, { sinceId: -1 }))).toBe("invalid-input");
  expect(await codeOf(r.listDefaultBranchRuns(repo, { limit: 51 }))).toBe("invalid-input");
  expect(await codeOf(r.failedJobLogs(repo, 1, { maxLinesPerStep: 501 }))).toBe("invalid-input");
});

test("getRun maps the run; unknown → null", async () => {
  const r = runsWith(fakeForge([run(9, { attempt: 2 })]).forge);
  expect((await r.getRun(repo, 9))?.attempt).toBe(2);
  expect(await r.getRun(repo, 8)).toBeNull();
});

test("failedJobLogs tails each step, strips ANSI + timestamps, masks secrets", async () => {
  const lines = Array.from({ length: 250 }, (_, i) => `2026-09-28T12:44:00.1234567Z line ${i}`);
  const { forge } = fakeForge([], {
    failedRunStepLogs: async () => [
      { job: "eval", step: "Run eval", lines },
      {
        job: "eval",
        step: "Deploy",
        lines: [
          "\u001b[31mError:\u001b[0m boom",
          "using ghp_abcdefghijklmnopqrstuvwx",
          "API_KEY=supersecretvalue",
          "curl -H 'Authorization: Bearer abc.def.ghi'",
          "git clone https://bot:hunter2pw@github.com/o/r",
          "x".repeat(3000),
        ],
      },
    ],
  });
  const r = runsWith(forge);
  const [big, small] = await r.failedJobLogs(repo, 1);
  expect(big!.lines).toHaveLength(200);
  expect(big!.lines[0]).toBe("line 50");
  expect(big!.lines.at(-1)).toBe("line 249");
  expect(big!.truncated).toBe(true);
  expect(small!.truncated).toBe(false);
  const text = small!.lines.join("\n");
  expect(small!.lines[0]).toBe("Error: boom");
  for (const secret of [
    "ghp_abcdefghijklmnopqrstuvwx",
    "supersecretvalue",
    "abc.def.ghi",
    "hunter2pw",
  ]) {
    expect(text).not.toContain(secret);
  }
  expect(small!.lines.at(-1)!.length).toBe(2000);
  const [custom] = await r.failedJobLogs(repo, 1, { maxLinesPerStep: 5 });
  expect(custom!.lines).toEqual(["line 245", "line 246", "line 247", "line 248", "line 249"]);
});

test("rerunFailed reruns only the failed jobs", async () => {
  const { forge, calls } = fakeForge([]);
  await runsWith(forge).rerunFailed(repo, 42);
  expect(calls).toEqual([["rerun", 42, { failedOnly: true }]]);
});

test("ctx.forge.runs is wired through the registry; unwired → no-forge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shepherd-plugin-forge-runs-reg-"));
  const pluginDir = join(dir, "probe");
  await mkdir(pluginDir);
  await writeFile(
    join(pluginDir, "plugin.json"),
    JSON.stringify({ id: "probe", name: "Probe", version: "1.0.0", apiVersion: 1 }),
  );
  await writeFile(
    join(pluginDir, "index.ts"),
    `export function register(ctx) {
       ctx.route("POST", "runs", async (req) => {
         const { repo } = await req.json();
         try {
           return Response.json(await ctx.forge.runs.listDefaultBranchRuns(repo, { sinceId: 0 }));
         } catch (e) {
           return Response.json({ name: e.name, code: e.code });
         }
       });
     }`,
  );
  const call = async (registry: PluginRegistry) =>
    (
      await registry.handleRoute(
        "POST",
        "probe",
        "runs",
        new Request("http://x/runs", { method: "POST", body: JSON.stringify({ repo }) }),
      )
    )?.json();
  const { forge } = fakeForge([run(1, { jobs: [] })]);
  const wired = new PluginRegistry({
    pluginsDir: dir,
    store: new SessionStore(":memory:"),
    events: new EventHub(),
    forge: { repoRoot: root, resolveForge: () => forge },
  });
  const unwired = new PluginRegistry({
    pluginsDir: dir,
    store: new SessionStore(":memory:"),
    events: new EventHub(),
  });
  try {
    await wired.loadAll();
    await unwired.loadAll();
    expect(await call(wired)).toMatchObject({ runs: [{ id: 1 }], cursor: 1 });
    expect(await call(unwired)).toEqual({ name: "PluginForgeError", code: "no-forge" });
  } finally {
    wired.teardown();
    unwired.teardown();
    await rm(dir, { recursive: true, force: true });
  }
});
