# Actions tab: per-workflow run history — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Actions tab browse a workflow's prior runs — expand a workflow card to reveal older runs, each drillable to its per-job breakdown.

**Architecture:** Two new GitHub-only forge methods (`listWorkflowRunHistory`, `listRunJobs`) behind two new GET endpoints, surfaced by an "older runs" expander on `ActionRunRow` that lazily renders new `ActionHistoryRow` components. v1's latest-run-per-card behavior is untouched; history is purely additive and lazy.

**Tech Stack:** Bun + TypeScript server, `gh` CLI shell-outs, SvelteKit 5 (runes) UI, Paraglide i18n (EN+DE), `bun test` (server) / vitest (UI).

**Spec:** `docs/superpowers/specs/2026-06-03-actions-tab-historical-runs-design.md`

---

## File Structure

- `src/forge/types.ts` — add `workflowId` to `WorkflowRun`; two optional `GitForge` methods.
- `src/forge/github.ts` — extract `listRunJobs`; populate `workflowId`; add `listWorkflowRunHistory`.
- `src/server.ts` — `handleActionsHistory`, `handleActionsRunJobs`; register both.
- `ui/src/lib/types.ts` — mirror `workflowId` on `WorkflowRun`.
- `ui/src/lib/format.ts` — `relativeAge` compact-age helper.
- `ui/src/lib/api.ts` — `listWorkflowRunHistory`, `listRunJobs` client fns.
- `ui/messages/en.json` + `de.json` — new `actionspanel_*` keys.
- `ui/src/lib/components/ActionHistoryRow.svelte` — NEW: one historical run summary + lazy job expand.
- `ui/src/lib/components/ActionRunRow.svelte` — add "older runs" expander.
- Tests: `test/forge/github.test.ts`, `test/server-actions.test.ts`, `ui/src/lib/format.test.ts`.

---

## Task 1: Forge + UI types — `workflowId` and new method signatures

**Files:**
- Modify: `src/forge/types.ts` (`WorkflowRun` interface ~100-110; `GitForge` interface ~150-157)
- Modify: `ui/src/lib/types.ts` (`WorkflowRun` interface ~122-133)

- [ ] **Step 1: Add `workflowId` to the server `WorkflowRun`**

In `src/forge/types.ts`, inside `interface WorkflowRun`, add after `runId`:

```ts
  /** Host run id (gh's `databaseId`) — the handle re-run / cancel act on. */
  runId: number;
  /** The workflow's stable id (gh's `workflowDatabaseId`) — the handle the
   *  run-history call filters on (`gh run list --workflow <id>`). */
  workflowId: number;
  workflowName: string;
```

- [ ] **Step 2: Add the two optional `GitForge` methods**

In `src/forge/types.ts`, in `interface GitForge`, directly after the `cancelWorkflowRun?` declaration:

```ts
  cancelWorkflowRun?(runId: number): Promise<void>;
  /** Prior runs of one workflow on the default branch (summary rows; `jobs`
   *  empty), newest-first, capped by `limit`. Optional, GitHub-only like
   *  {@link listWorkflowRuns}; other forges omit it and the history UI degrades. */
  listWorkflowRunHistory?(workflowId: number, o: { limit: number }): Promise<WorkflowRun[]>;
  /** Per-job breakdown for a single run, lazy-loaded when a history row expands.
   *  Optional, same GitHub-only gating as {@link listWorkflowRunHistory}. */
  listRunJobs?(runId: number): Promise<WorkflowJob[]>;
```

- [ ] **Step 3: Mirror `workflowId` on the UI `WorkflowRun`**

In `ui/src/lib/types.ts`, in `interface WorkflowRun`, add `workflowId: number;` immediately after `runId: number;` (matching the server field + a one-line comment):

```ts
  runId: number;
  /** Workflow's stable id (server `workflowDatabaseId`); used to fetch history. */
  workflowId: number;
```

- [ ] **Step 4: Typecheck both packages compile (will fail until fixtures updated — expected)**

Run: `bunx tsc --noEmit`
Expected: errors ONLY in test files that build `WorkflowRun` literals without `workflowId` (`test/forge/github.test.ts`, `test/server-actions.test.ts`). Those are fixed in Tasks 3 and 5. No errors in `src/`.

- [ ] **Step 5: Commit**

```bash
git add src/forge/types.ts ui/src/lib/types.ts
git commit -m "feat(actions): add workflowId + run-history forge method signatures"
```

---

## Task 2: UI `relativeAge` helper

**Files:**
- Modify: `ui/src/lib/format.ts`
- Test: `ui/src/lib/format.test.ts`

- [ ] **Step 1: Write the failing test**

`ui/src/lib/format.test.ts` uses vitest `describe`/`it` and imports named exports from `./format`. Add `relativeAge` to the existing import (`import { hideStatusBadge, relativeAge } from "./format";`), then append this block at the end of the file:

```ts
describe("relativeAge", () => {
  const now = 1_000_000_000_000;
  it("formats compact units, floored", () => {
    expect(relativeAge(now, now)).toBe("now");
    expect(relativeAge(now - 30_000, now)).toBe("now"); // <60s
    expect(relativeAge(now - 5 * 60_000, now)).toBe("5m");
    expect(relativeAge(now - 2 * 3_600_000, now)).toBe("2h");
    expect(relativeAge(now - 3 * 86_400_000, now)).toBe("3d");
    expect(relativeAge(now + 10_000, now)).toBe("now"); // future clamps to 0
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && bun run test -- format`
Expected: FAIL — `relativeAge is not exported` / `is not a function`.

- [ ] **Step 3: Implement `relativeAge`**

Append to `ui/src/lib/format.ts`:

```ts
/** Compact age like "5m", "2h", "3d", or "now" under a minute. Units are
 *  abbreviations, intentionally untranslated — same precedent as `elapsed`. */
export function relativeAge(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  if (s < 60) return "now";
  const min = Math.floor(s / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && bun run test -- format`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/format.ts ui/src/lib/format.test.ts
git commit -m "feat(actions): add relativeAge compact-age helper"
```

---

## Task 3: github.ts — extract `listRunJobs`, populate `workflowId`

**Files:**
- Modify: `src/forge/github.ts` (`listWorkflowRuns` ~166-241)
- Test: `test/forge/github.test.ts` (~352-433)

- [ ] **Step 1: Update existing tests to expect `workflowId` + add a `listRunJobs` test**

In `test/forge/github.test.ts`, in the test `"GithubForge.listWorkflowRuns: newest run per workflow…"`:

(a) Add `workflowDatabaseId` to the three `runList` entries — CI rows get `workflowDatabaseId: 11`, the Deploy row gets `workflowDatabaseId: 22`. For example the first entry becomes:

```ts
    {
      databaseId: 200,
      workflowName: "CI",
      workflowDatabaseId: 11,
      status: "completed",
      conclusion: "failure",
      headSha: "sha2",
      createdAt: "2024-05-02T00:00:00Z",
      url: "https://gh/run/200",
    },
```

Apply the same `workflowDatabaseId` addition to the `#150` Deploy row (`22`) and the `#100` CI row (`11`).

(b) In the `expect(runs).toEqual([...])`, add `workflowId: 11` to the CI (`runId: 200`) object and `workflowId: 22` to the Deploy (`runId: 150`) object. The `200` object becomes:

```ts
    {
      runId: 200,
      workflowId: 11,
      workflowName: "CI",
      runUrl: "https://gh/run/200",
      headSha: "sha2",
      createdAt: Date.parse("2024-05-02T00:00:00Z"),
      state: "failure",
      jobs: [
        { name: "lint", state: "success", url: "https://gh/job/a" },
        { name: "test", state: "failure", url: "https://gh/job/b" },
      ],
    },
```

(c) Append a new test for the extracted method:

```ts
test("GithubForge.listRunJobs: maps a run's jobs to the four-light vocab", async () => {
  const run = (args: string[]): string => {
    if (args[0] === "run" && args[1] === "view" && args[2] === "200")
      return JSON.stringify({
        jobs: [
          { name: "lint", status: "completed", conclusion: "success", url: "https://gh/job/a" },
          { name: "test", status: "in_progress", conclusion: null },
        ],
      });
    return "{}";
  };
  const jobs = await new GithubForge("o/r", {}, run).listRunJobs(200);
  expect(jobs).toEqual([
    { name: "lint", state: "success", url: "https://gh/job/a" },
    { name: "test", state: "pending", url: undefined },
  ]);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test ./test/forge/github.test.ts`
Expected: FAIL — `listRunJobs` undefined; `listWorkflowRuns` result missing `workflowId`.

- [ ] **Step 3: Implement — extract `listRunJobs`, add `workflowId`**

In `src/forge/github.ts`, add `workflowDatabaseId` to the `--json` field list inside `listWorkflowRuns` and to the `raw` row type:

```ts
    const listOut = this.run([
      "run",
      "list",
      "--repo",
      this.slug,
      "--branch",
      branch,
      "--limit",
      "50",
      "--json",
      "databaseId,workflowName,workflowDatabaseId,status,conclusion,headSha,createdAt,url",
    ]);
    const raw = JSON.parse(listOut || "[]") as Array<{
      databaseId: number;
      workflowName?: string;
      workflowDatabaseId?: number;
      status?: string | null;
      conclusion?: string | null;
      headSha?: string;
      createdAt?: string;
      url?: string;
    }>;
```

Replace the `const runs = selected.map((r): WorkflowRun => { … })` block (the one that does the inline `gh run view … --json jobs`) with a `Promise.all` that delegates jobs to the new method:

```ts
    const runs = await Promise.all(
      selected.map(async (r): Promise<WorkflowRun> => {
        const jobs = await this.listRunJobs(r.databaseId);
        const ts = Date.parse(r.createdAt ?? "");
        return {
          runId: r.databaseId,
          workflowId: r.workflowDatabaseId ?? 0,
          workflowName: r.workflowName ?? "",
          runUrl: r.url ?? "",
          headSha: r.headSha ?? "",
          createdAt: Number.isFinite(ts) ? ts : Date.now(),
          state: mapCheckState(r.status, r.conclusion),
          jobs,
        };
      }),
    );

    // Newest workflow first.
    runs.sort((a, b) => b.createdAt - a.createdAt);
    return runs;
```

Then add the extracted method immediately after `listWorkflowRuns` (before `rerunWorkflowRun`):

```ts
  /** Per-job breakdown for a single run (`gh run view --json jobs`), mapped to
   *  the four-light CI vocab. Shared by the latest-run listing and history-row
   *  expansion. */
  async listRunJobs(runId: number): Promise<WorkflowJob[]> {
    const jobsOut = this.run([
      "run",
      "view",
      String(runId),
      "--repo",
      this.slug,
      "--json",
      "jobs",
    ]);
    const parsed = JSON.parse(jobsOut || "{}") as {
      jobs?: Array<{
        name?: string;
        status?: string | null;
        conclusion?: string | null;
        url?: string;
      }>;
    };
    return (parsed.jobs ?? []).map((j) => ({
      name: j.name ?? "",
      state: mapCheckState(j.status, j.conclusion),
      url: j.url || undefined,
    }));
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./test/forge/github.test.ts`
Expected: PASS (all workflow tests green, including the new `listRunJobs` test).

- [ ] **Step 5: Commit**

```bash
git add src/forge/github.ts test/forge/github.test.ts
git commit -m "feat(actions): extract listRunJobs + populate workflowId on runs"
```

---

## Task 4: github.ts — `listWorkflowRunHistory`

**Files:**
- Modify: `src/forge/github.ts`
- Test: `test/forge/github.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/forge/github.test.ts`:

```ts
test("GithubForge.listWorkflowRunHistory: filters by workflow + branch, jobs empty, newest-first", async () => {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "repo" && args[1] === "view")
      return JSON.stringify({ defaultBranchRef: { name: "main" } });
    if (args[0] === "run" && args[1] === "list")
      return JSON.stringify([
        {
          databaseId: 90,
          workflowName: "CI",
          workflowDatabaseId: 11,
          status: "completed",
          conclusion: "success",
          headSha: "shaA",
          createdAt: "2024-05-01T00:00:00Z",
          url: "https://gh/run/90",
        },
        {
          databaseId: 99,
          workflowName: "CI",
          workflowDatabaseId: 11,
          status: "completed",
          conclusion: "failure",
          headSha: "shaB",
          createdAt: "2024-05-03T00:00:00Z",
          url: "https://gh/run/99",
        },
      ]);
    return "";
  };
  const runs = await new GithubForge("o/r", {}, run).listWorkflowRunHistory(11, { limit: 10 });

  // newest-first; jobs deliberately empty (lazy)
  expect(runs).toEqual([
    {
      runId: 99,
      workflowId: 11,
      workflowName: "CI",
      runUrl: "https://gh/run/99",
      headSha: "shaB",
      createdAt: Date.parse("2024-05-03T00:00:00Z"),
      state: "failure",
      jobs: [],
    },
    {
      runId: 90,
      workflowId: 11,
      workflowName: "CI",
      runUrl: "https://gh/run/90",
      headSha: "shaA",
      createdAt: Date.parse("2024-05-01T00:00:00Z"),
      state: "success",
      jobs: [],
    },
  ]);
  const listCall = calls.find((c) => c[0] === "run" && c[1] === "list")!;
  expect(listCall).toContain("--workflow");
  expect(listCall).toContain("11");
  expect(listCall).toContain("--branch");
  expect(listCall).toContain("main");
  expect(listCall).toContain("--limit");
  expect(listCall).toContain("10");
  // never fans out to per-run job views for history
  expect(calls.some((c) => c[0] === "run" && c[1] === "view")).toBe(false);
});

test("GithubForge.listWorkflowRunHistory: no default branch → []", async () => {
  const run = (args: string[]): string => (args[0] === "repo" ? "{}" : "");
  expect(await new GithubForge("o/r", {}, run).listWorkflowRunHistory(11, { limit: 10 })).toEqual(
    [],
  );
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test ./test/forge/github.test.ts`
Expected: FAIL — `listWorkflowRunHistory is not a function`.

- [ ] **Step 3: Implement `listWorkflowRunHistory`**

In `src/forge/github.ts`, add after `listRunJobs` (before `rerunWorkflowRun`):

```ts
  /** Prior runs of one workflow on the default branch, newest-first, capped by
   *  `limit`. Summary rows only — `jobs` is empty; callers lazy-load per-run
   *  jobs via {@link listRunJobs}. */
  async listWorkflowRunHistory(workflowId: number, o: { limit: number }): Promise<WorkflowRun[]> {
    const branch = await this.defaultBranch().catch(() => null);
    if (!branch) return [];
    const listOut = this.run([
      "run",
      "list",
      "--repo",
      this.slug,
      "--branch",
      branch,
      "--workflow",
      String(workflowId),
      "--limit",
      String(o.limit),
      "--json",
      "databaseId,workflowName,workflowDatabaseId,status,conclusion,headSha,createdAt,url",
    ]);
    const raw = JSON.parse(listOut || "[]") as Array<{
      databaseId: number;
      workflowName?: string;
      workflowDatabaseId?: number;
      status?: string | null;
      conclusion?: string | null;
      headSha?: string;
      createdAt?: string;
      url?: string;
    }>;
    const runs = raw.map((r): WorkflowRun => {
      const ts = Date.parse(r.createdAt ?? "");
      return {
        runId: r.databaseId,
        workflowId: r.workflowDatabaseId ?? workflowId,
        workflowName: r.workflowName ?? "",
        runUrl: r.url ?? "",
        headSha: r.headSha ?? "",
        createdAt: Number.isFinite(ts) ? ts : Date.now(),
        state: mapCheckState(r.status, r.conclusion),
        jobs: [],
      };
    });
    runs.sort((a, b) => b.createdAt - a.createdAt);
    return runs;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./test/forge/github.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/forge/github.ts test/forge/github.test.ts
git commit -m "feat(actions): add listWorkflowRunHistory forge method"
```

---

## Task 5: server.ts — history + run-jobs endpoints

**Files:**
- Modify: `src/server.ts` (handlers near `handleActionsCancel` ~1287; registration list ~1519)
- Test: `test/server-actions.test.ts`

- [ ] **Step 1: Write the failing tests + fix the `RUN` fixture**

In `test/server-actions.test.ts`:

(a) Add `workflowId` to the `RUN` fixture (after `runId: 1,`):

```ts
const RUN: WorkflowRun = {
  runId: 1,
  workflowId: 5,
  workflowName: "CI",
```

(b) Append GET-request helpers + tests at the end of the file:

```ts
function historyReq(repo: string, workflowId: number, limit = 10): Request {
  return new Request(
    `http://localhost/api/actions/history?repo=${encodeURIComponent(repo)}&workflowId=${workflowId}&limit=${limit}`,
  );
}
function jobsReq(repo: string, runId: number): Request {
  return new Request(
    `http://localhost/api/actions/run-jobs?repo=${encodeURIComponent(repo)}&runId=${runId}`,
  );
}

test("GET /api/actions/history returns the workflow's prior runs", async () => {
  let got: { workflowId: number; limit: number } | null = null;
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        listWorkflowRunHistory: async (workflowId, o) => {
          got = { workflowId, limit: o.limit };
          return [RUN];
        },
      }),
    ),
  );
  const res = await app.fetch(historyReq(repoDir, 5, 25));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ runs: [RUN] });
  expect(got!).toEqual({ workflowId: 5, limit: 25 });
});

test("GET /api/actions/history clamps limit to 50 and requires a workflowId", async () => {
  let seenLimit = 0;
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        listWorkflowRunHistory: async (_w, o) => {
          seenLimit = o.limit;
          return [];
        },
      }),
    ),
  );
  await app.fetch(historyReq(repoDir, 5, 999));
  expect(seenLimit).toBe(50);
  const bad = await app.fetch(
    new Request(`http://localhost/api/actions/history?repo=${encodeURIComponent(repoDir)}`),
  );
  expect(bad.status).toBe(400);
});

test("GET /api/actions/history for a forge without the method → empty", async () => {
  const app = makeApp(
    makeDeps(() => fakeForge({ kind: "gitea", listWorkflowRunHistory: undefined })),
  );
  const res = await app.fetch(historyReq(repoDir, 5));
  expect(await res.json()).toEqual({ runs: [] });
});

test("GET /api/actions/history swallows forge errors → empty", async () => {
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        listWorkflowRunHistory: async () => {
          throw new Error("gh boom");
        },
      }),
    ),
  );
  expect(await (await app.fetch(historyReq(repoDir, 5))).json()).toEqual({ runs: [] });
});

test("GET /api/actions/run-jobs returns a run's jobs", async () => {
  let gotRunId = 0;
  const app = makeApp(
    makeDeps(() =>
      fakeForge({
        listRunJobs: async (runId) => {
          gotRunId = runId;
          return RUN.jobs;
        },
      }),
    ),
  );
  const res = await app.fetch(jobsReq(repoDir, 42));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ jobs: RUN.jobs });
  expect(gotRunId).toBe(42);
});

test("GET /api/actions/run-jobs requires a runId; missing method → empty", async () => {
  const app = makeApp(makeDeps(() => fakeForge({ listRunJobs: undefined })));
  expect(await (await app.fetch(jobsReq(repoDir, 42))).json()).toEqual({ jobs: [] });
  const bad = await app.fetch(
    new Request(`http://localhost/api/actions/run-jobs?repo=${encodeURIComponent(repoDir)}`),
  );
  expect(bad.status).toBe(400);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test ./test/server-actions.test.ts`
Expected: FAIL — history/run-jobs routes return null → fall through to a 404, and `listWorkflowRunHistory`/`listRunJobs` aren't called.

- [ ] **Step 3: Implement the two handlers**

In `src/server.ts`, add directly after `handleActionsCancel` (after its closing `}` ~line 1307):

```ts
// GET /api/actions/history?repo=&workflowId=&limit= — prior runs of one workflow
// on the default branch (summary rows, jobs empty; lazy-loaded history). GitHub
// only; other forges lack the method → empty. limit defaults to 10, clamped 1..50.
async function handleActionsHistory({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (
    req.method !== "GET" ||
    parts[0] !== "api" ||
    parts[1] !== "actions" ||
    parts[2] !== "history"
  )
    return null;
  const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  const wfRaw = url.searchParams.get("workflowId");
  const workflowId = Number(wfRaw);
  if (!wfRaw || !Number.isFinite(workflowId)) return json({ error: "workflowId required" }, 400);
  const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit")) || 10), 50);
  const forge = deps.resolveForge?.(dir) ?? null;
  if (!forge?.listWorkflowRunHistory) return json({ runs: [] });
  try {
    return json({ runs: await forge.listWorkflowRunHistory(workflowId, { limit }) });
  } catch {
    // missing/un-authed CLI or network error → graceful empty (matches list path)
    return json({ runs: [] });
  }
}

// GET /api/actions/run-jobs?repo=&runId= — per-job breakdown for a single run,
// lazy-loaded when a history row is expanded. GitHub only; others → empty.
async function handleActionsRunJobs({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (
    req.method !== "GET" ||
    parts[0] !== "api" ||
    parts[1] !== "actions" ||
    parts[2] !== "run-jobs"
  )
    return null;
  const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
  if (!dir) return json({ error: "invalid repo" }, 400);
  const runRaw = url.searchParams.get("runId");
  const runId = Number(runRaw);
  if (!runRaw || !Number.isFinite(runId)) return json({ error: "runId required" }, 400);
  const forge = deps.resolveForge?.(dir) ?? null;
  if (!forge?.listRunJobs) return json({ jobs: [] });
  try {
    return json({ jobs: await forge.listRunJobs(runId) });
  } catch {
    return json({ jobs: [] });
  }
}
```

- [ ] **Step 4: Register both handlers**

In `src/server.ts`, in the handlers list (~1519, where `handleActionsList, handleActionsRerun, handleActionsCancel,` appear), add the two new handlers right after `handleActionsCancel,`:

```ts
  handleActionsList,
  handleActionsRerun,
  handleActionsCancel,
  handleActionsHistory,
  handleActionsRunJobs,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test ./test/server-actions.test.ts`
Expected: PASS (all old + new tests green).

- [ ] **Step 6: Commit**

```bash
git add src/server.ts test/server-actions.test.ts
git commit -m "feat(actions): add /api/actions/history + /api/actions/run-jobs endpoints"
```

---

## Task 6: UI api client functions

**Files:**
- Modify: `ui/src/lib/api.ts` (imports ~30; new fns after `listWorkflowRuns` ~318)

- [ ] **Step 1: Ensure `WorkflowJob` is imported**

In `ui/src/lib/api.ts`, the type import block already pulls `WorkflowRun`. Add `WorkflowJob` to that same import list (alongside `WorkflowRun`).

- [ ] **Step 2: Add the two client functions**

In `ui/src/lib/api.ts`, immediately after `listWorkflowRuns` (the function ending ~line 318):

```ts
/** Prior runs of one workflow on the default branch (summary rows; `jobs` empty).
 *  GitHub only — other forges return no runs. `limit` caps how many are fetched. */
export async function listWorkflowRunHistory(
  repoPath: string,
  workflowId: number,
  limit: number,
): Promise<{ runs: WorkflowRun[] }> {
  const r = await fetch(
    `/api/actions/history?repo=${encodeURIComponent(repoPath)}&workflowId=${workflowId}&limit=${limit}`,
  );
  if (!r.ok) throw await failed(r, "actions history");
  return r.json();
}

/** Per-job breakdown for a single run, lazy-loaded when a history row expands. */
export async function listRunJobs(
  repoPath: string,
  runId: number,
): Promise<{ jobs: WorkflowJob[] }> {
  const r = await fetch(`/api/actions/run-jobs?repo=${encodeURIComponent(repoPath)}&runId=${runId}`);
  if (!r.ok) throw await failed(r, "run jobs");
  return r.json();
}
```

- [ ] **Step 3: Typecheck**

Run: `cd ui && bun run check`
Expected: PASS (no type errors; `WorkflowJob` resolves).

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/api.ts
git commit -m "feat(actions): api client for run history + run jobs"
```

---

## Task 7: i18n keys (EN + DE)

**Files:**
- Modify: `ui/messages/en.json`, `ui/messages/de.json`

- [ ] **Step 1: Add keys to `en.json`**

In `ui/messages/en.json`, after `"actionspanel_action_failed"` (~line 462), add:

```json
  "actionspanel_action_failed": "action failed",
  "actionspanel_older_runs": "older runs",
  "actionspanel_load_more": "load more",
  "actionspanel_history_empty": "no older runs",
  "actionspanel_history_failed": "failed to load — retry",
```

(Keep the trailing comma correct relative to the next existing key.)

- [ ] **Step 2: Add the same keys to `de.json`**

In `ui/messages/de.json`, after `"actionspanel_action_failed"`, add the German counterparts:

```json
  "actionspanel_older_runs": "ältere Läufe",
  "actionspanel_load_more": "mehr laden",
  "actionspanel_history_empty": "keine älteren Läufe",
  "actionspanel_history_failed": "Laden fehlgeschlagen – erneut",
```

- [ ] **Step 3: Verify catalog parity**

Run: `cd ui && bun run check:i18n`
Expected: PASS — both catalogs share an identical key set.

- [ ] **Step 4: Commit**

```bash
git add ui/messages/en.json ui/messages/de.json
git commit -m "feat(actions): i18n keys for run-history UI (EN+DE)"
```

---

## Task 8: `ActionHistoryRow.svelte` — one historical run + lazy job expand

**Files:**
- Create: `ui/src/lib/components/ActionHistoryRow.svelte`

- [ ] **Step 1: Create the component**

Create `ui/src/lib/components/ActionHistoryRow.svelte`:

```svelte
<script lang="ts">
  import type { WorkflowRun, WorkflowJob } from "$lib/types";
  import { m } from "$lib/paraglide/messages";
  import { listRunJobs } from "$lib/api";
  import { relativeAge } from "$lib/format";
  import { clock } from "$lib/now.svelte";

  let { repoPath, run }: { repoPath: string; run: WorkflowRun } = $props();

  // Jobs are fetched lazily the first time this row is expanded; thereafter the
  // result is cached (`loaded`) so re-expanding never re-hits `gh`.
  let open = $state(false);
  let jobs = $state<WorkflowJob[]>([]);
  let loading = $state(false);
  let loaded = $state(false);
  let failed = $state(false);

  const age = $derived(relativeAge(run.createdAt, clock.current));
  const shortSha = $derived(run.headSha.slice(0, 7));
  const ciStatus = $derived(m.gitrail_ci_status({ status: run.state }));

  async function loadJobs() {
    loading = true;
    failed = false;
    try {
      const r = await listRunJobs(repoPath, run.runId);
      jobs = r.jobs;
      loaded = true;
    } catch {
      failed = true;
    } finally {
      loading = false;
    }
  }

  async function toggle() {
    open = !open;
    if (open && !loaded && !loading) await loadJobs();
  }
</script>

<div class="hist-run">
  <div class="hist-head">
    <button
      class="hist-summary"
      onclick={toggle}
      aria-expanded={open}
      title={ciStatus}
      type="button"
    >
      <span class="dot dot-{run.state}" aria-label={ciStatus}></span>
      <span class="hist-num">#{run.runId}</span>
      <span class="hist-age">{age}</span>
      <span class="hist-sha">{shortSha}</span>
      <span class="hist-caret" class:open>▸</span>
    </button>
    <!-- eslint-disable svelte/no-navigation-without-resolve -- external forge URL -->
    <a
      class="hist-link"
      href={run.runUrl}
      target="_blank"
      rel="noopener"
      title={m.actionspanel_run_link()}>↗</a
    >
    <!-- eslint-enable svelte/no-navigation-without-resolve -->
  </div>

  {#if open}
    {#if loading && !loaded}
      <div class="muted">{m.common_loading()}</div>
    {:else if failed}
      <button class="muted retry" type="button" onclick={loadJobs}
        >{m.actionspanel_history_failed()}</button
      >
    {:else}
      <div class="jobs">
        {#each jobs as job, i (job.name + " " + i)}
          <div class="job">
            <span
              class="dot dot-{job.state}"
              title={m.gitrail_ci_status({ status: job.state })}
              aria-label={m.gitrail_ci_status({ status: job.state })}
            ></span>
            {#if job.url}
              <!-- eslint-disable svelte/no-navigation-without-resolve -- external forge URL -->
              <a
                class="job-name"
                href={job.url}
                target="_blank"
                rel="noopener"
                title={m.actionspanel_job_link()}>{job.name}</a
              >
              <!-- eslint-enable svelte/no-navigation-without-resolve -->
            {:else}
              <span class="job-name">{job.name}</span>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .hist-run {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .hist-head {
    display: flex;
    align-items: center;
    gap: 7px;
  }

  .hist-summary {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 7px;
    background: transparent;
    border: none;
    padding: 1px 0;
    cursor: pointer;
    font-family: var(--font-mono);
    color: var(--color-ink);
    text-align: left;
  }
  .hist-summary:hover .hist-num {
    color: var(--color-ink-bright);
  }

  .hist-num {
    font-size: 11.5px;
    color: var(--color-ink);
  }
  .hist-age,
  .hist-sha {
    font-size: 10.5px;
    color: var(--color-faint);
  }
  .hist-sha {
    font-variant-ligatures: none;
  }

  .hist-caret {
    margin-left: auto;
    font-size: 9px;
    color: var(--color-faint);
    transition: transform 0.12s;
  }
  .hist-caret.open {
    transform: rotate(90deg);
  }

  .hist-link {
    flex-shrink: 0;
    font-size: 11px;
    color: var(--color-faint);
    text-decoration: none;
    transition: color 0.12s;
  }
  .hist-link:hover {
    color: var(--color-ink-bright);
  }

  .jobs {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding-left: 13px;
  }
  .job {
    display: flex;
    align-items: center;
    gap: 7px;
    min-height: 12px;
  }
  .job-name {
    font-size: 11.5px;
    color: var(--color-ink);
    text-decoration: none;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    transition: color 0.12s;
  }
  a.job-name:hover {
    color: var(--color-ink-bright);
  }

  .muted {
    font-size: 11px;
    color: var(--color-faint);
    padding: 2px 0 2px 13px;
  }
  .retry {
    background: transparent;
    border: none;
    cursor: pointer;
    font-family: var(--font-mono);
    text-align: left;
  }
  .retry:hover {
    color: var(--color-amber);
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    display: inline-block;
    background: var(--color-faint);
    flex-shrink: 0;
  }
  .dot-pending {
    background: var(--color-amber);
    animation: dot-pulse 1.1s ease-in-out infinite !important;
  }
  .dot-success {
    background: var(--color-green);
  }
  .dot-failure {
    background: var(--color-red);
  }
</style>
```

- [ ] **Step 2: Typecheck**

Run: `cd ui && bun run check`
Expected: PASS (component compiles; unused until wired in Task 9 — that's fine).

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/components/ActionHistoryRow.svelte
git commit -m "feat(actions): ActionHistoryRow — historical run summary + lazy jobs"
```

---

## Task 9: `ActionRunRow.svelte` — "older runs" expander

**Files:**
- Modify: `ui/src/lib/components/ActionRunRow.svelte`

- [ ] **Step 1: Extend the `<script>`**

In `ui/src/lib/components/ActionRunRow.svelte`, add to the imports:

```ts
  import { rerunWorkflowRun, cancelWorkflowRun, listWorkflowRunHistory } from "$lib/api";
  import ActionHistoryRow from "./ActionHistoryRow.svelte";
```

(Replace the existing `import { rerunWorkflowRun, cancelWorkflowRun } from "$lib/api";` line with the extended one above.)

Then add the history state + handlers after the existing `act(...)` function (before `</script>`):

```ts
  // "Older runs" history: lazy, additive, never polled. Fetched the first time
  // the expander opens; "load more" grows the limit and re-lists from the top
  // (`gh run list` has no cursor), then drops the latest run (already shown at
  // the card head) so the list is strictly older runs.
  const HISTORY_STEP = 10;
  const HISTORY_MAX = 50;

  let histOpen = $state(false);
  let history = $state<WorkflowRun[]>([]);
  let histLoading = $state(false);
  let histLoaded = $state(false);
  let histFailed = $state(false);
  let histLimit = $state(HISTORY_STEP);

  // More to fetch only while the server returned a full page and we're under cap.
  const canLoadMore = $derived(
    histLoaded && history.length + 1 >= histLimit && histLimit < HISTORY_MAX,
  );

  async function loadHistory() {
    histLoading = true;
    histFailed = false;
    try {
      const r = await listWorkflowRunHistory(repoPath, run.workflowId, histLimit);
      history = r.runs.filter((h) => h.runId !== run.runId);
      histLoaded = true;
    } catch {
      histFailed = true;
    } finally {
      histLoading = false;
    }
  }

  async function toggleHistory() {
    histOpen = !histOpen;
    if (histOpen && !histLoaded && !histLoading) await loadHistory();
  }

  async function loadMore() {
    histLimit = Math.min(histLimit + HISTORY_STEP, HISTORY_MAX);
    await loadHistory();
  }
```

- [ ] **Step 2: Add the expander markup**

In `ui/src/lib/components/ActionRunRow.svelte`, inside the `.wf` container, immediately after the closing `</div>` of `.jobs` (and before the closing `</div>` of `.wf`), add:

```svelte
  {#if run.workflowId}
    <div class="history">
      <button
        class="hist-toggle"
        type="button"
        onclick={toggleHistory}
        aria-expanded={histOpen}
      >
        <span class="hist-caret" class:open={histOpen}>▸</span>
        {m.actionspanel_older_runs()}
      </button>
      {#if histOpen}
        {#if histLoading && !histLoaded}
          <div class="hist-muted">{m.common_loading()}</div>
        {:else if histFailed}
          <button class="hist-muted retry" type="button" onclick={loadHistory}
            >{m.actionspanel_history_failed()}</button
          >
        {:else if history.length === 0}
          <div class="hist-muted">{m.actionspanel_history_empty()}</div>
        {:else}
          <div class="hist-list">
            {#each history as h (h.runId)}
              <ActionHistoryRow {repoPath} run={h} />
            {/each}
          </div>
          {#if canLoadMore}
            <button class="hist-more" type="button" disabled={histLoading} onclick={loadMore}>
              {m.actionspanel_load_more()}
            </button>
          {/if}
        {/if}
      {/if}
    </div>
  {/if}
```

- [ ] **Step 3: Add the expander styles**

In `ui/src/lib/components/ActionRunRow.svelte`, append inside `<style>`:

```css
  .history {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 2px;
    padding-top: 5px;
    border-top: 1px dashed var(--color-line);
  }

  .hist-toggle {
    display: flex;
    align-items: center;
    gap: 5px;
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
    transition: color 0.12s;
  }
  .hist-toggle:hover {
    color: var(--color-ink-bright);
  }

  .hist-caret {
    font-size: 9px;
    color: var(--color-faint);
    transition: transform 0.12s;
  }
  .hist-caret.open {
    transform: rotate(90deg);
  }

  .hist-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-left: 13px;
  }

  .hist-muted {
    font-size: 11px;
    color: var(--color-faint);
    padding: 2px 0 2px 13px;
    text-align: left;
  }
  .retry {
    background: transparent;
    border: none;
    cursor: pointer;
    font-family: var(--font-mono);
  }
  .retry:hover {
    color: var(--color-amber);
  }

  .hist-more {
    align-self: flex-start;
    margin-left: 13px;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    padding: 2px 8px;
    cursor: pointer;
    transition:
      border-color 0.12s,
      color 0.12s;
  }
  .hist-more:hover:not(:disabled) {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .hist-more:disabled {
    color: var(--color-faint);
    cursor: not-allowed;
  }
```

- [ ] **Step 4: Typecheck + lint**

Run: `cd ui && bun run check && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/components/ActionRunRow.svelte
git commit -m "feat(actions): older-runs expander on ActionRunRow (#236)"
```

---

## Task 10: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Root server checks**

Run: `bun run lint && bunx tsc --noEmit && bun test ./test`
Expected: PASS — all server tests green, no type errors.

- [ ] **Step 2: UI checks**

Run: `cd ui && bun run check && bun run check:i18n && bun run lint && bun run test`
Expected: PASS — typecheck, catalog parity, lint, vitest all green.

- [ ] **Step 3: Manual smoke (optional but recommended)**

Start the app, open the backlog Actions tab for a GitHub repo, expand a workflow's "older runs", confirm summary rows appear; expand one row → its jobs load; "load more" fetches additional rows up to the cap. A non-GitHub repo shows no expander regression (latest-run-only behavior unchanged).

- [ ] **Step 4: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "chore(actions): verification fixups for run-history"
```

---

## Self-Review notes

- **Spec coverage:** `workflowId` (T1), `listWorkflowRunHistory` + `listRunJobs` forge methods (T3,T4), `/api/actions/history` + `/api/actions/run-jobs` (T5), UI api client (T6), i18n EN+DE (T7), `ActionHistoryRow` (T8), older-runs expander preserving v1 latest-run block (T9), default-branch-only + read-only history + no-polling + load-more cap 50 (T4/T5/T9). All spec sections mapped.
- **Type consistency:** `WorkflowRun.workflowId: number` defined in T1, populated in T3/T4, consumed in T8/T9; `listRunJobs(runId)`/`listWorkflowRunHistory(workflowId, {limit})` signatures identical across types.ts, github.ts, server.ts, api.ts, tests.
- **No placeholders:** every code step shows full content.
- **Latest-run filter:** history list is `gh`-newest-first and includes the latest run; both `ActionRunRow.loadHistory` (drops `run.runId`) and the `canLoadMore` `+1` accounting compensate for that one dropped row.
```
