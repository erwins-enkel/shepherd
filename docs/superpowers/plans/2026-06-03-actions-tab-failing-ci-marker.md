# Actions tab failing-CI marker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a red "failing" marker on the Backlog → Actions tab label when the selected repo's default-branch CI is failing, sourced cheaply with zero extra `gh` calls.

**Architecture:** Fold the default branch's `statusCheckRollup.state` into the existing per-repo GitHub GraphQL counts query (`CountsService.fetchGitHub`) — already warmed, capped, and cached. Thread a new `ciStatus` field server → payload → UI, and render a per-selected-repo state marker on the Actions tab (consistent with the per-selected-repo Issues/PRs badges).

**Tech Stack:** Bun + TypeScript (server, `bun test`), SvelteKit 5 + Paraglide JS i18n + Vitest (UI).

**Spec:** `docs/superpowers/specs/2026-06-03-actions-tab-failing-ci-marker-design.md`

---

## File structure

- `src/backlog.ts` — add `CiStatus` type + `ciStatus` to `RepoCounts`; extend GraphQL query & map rollup state (GitHub); `null` for Gitea / NULL_COUNTS. **Source of the new data.**
- `test/backlog.test.ts` — mapping coverage (success/failure/error/pending/absent) + Gitea null.
- `src/server.ts` — add `ciStatus` to `BacklogProject`; pass through in `buildBacklogPayload`.
- `test/server-backlog.test.ts` — normalize the `makeDeps` counts fixture for the new required field; assert passthrough.
- `ui/src/lib/types.ts` — mirror `ciStatus` on the UI `BacklogProject`.
- `ui/src/lib/components/backlog-view.ts` — `actionsTabLabel` returns the failing label when `ciStatus === "failure"`.
- `ui/src/lib/components/backlog-view.test.ts` — failing-label cases; fixture gains `ciStatus`.
- `ui/src/lib/components/BacklogView.svelte` — render `m.backlog_tab_actions_failing()` + `class:failing` on both Actions tab buttons; `.tab-btn.failing` CSS.
- `ui/messages/en.json`, `ui/messages/de.json` — new `backlog_tab_actions_failing` key (both catalogs).

---

## Task 1: Server — `ciStatus` on RepoCounts + GraphQL rollup mapping

**Files:**
- Modify: `src/backlog.ts` (`RepoCounts` ~8-11, `NULL_COUNTS` ~36, `fetchGitHub` ~180-207, `fetchGitea` ~209-233)
- Test: `test/backlog.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/backlog.test.ts` (before the final closing — these are top-level `test(...)` calls):

```ts
// 10. CI rollup: graphql FAILURE state → ciStatus "failure"
test("CountsService: maps default-branch statusCheckRollup FAILURE → ciStatus failure", async () => {
  const repoDir = gitInit(join(tmpBase, "gh-ci-fail"), "https://github.com/o/ci-fail");
  const { run } = fakeRunner(
    JSON.stringify({
      data: {
        repository: {
          issues: { totalCount: 1 },
          pullRequests: { totalCount: 0 },
          defaultBranchRef: { target: { statusCheckRollup: { state: "FAILURE" } } },
        },
      },
    }),
  );
  const svc = new CountsService({}, run);
  const result = await svc.counts(repoDir);
  expect(result.ciStatus).toBe("failure");
});

// 11. CI rollup: ERROR also maps to "failure" (errored CI is not healthy)
test("CountsService: maps statusCheckRollup ERROR → ciStatus failure", async () => {
  const repoDir = gitInit(join(tmpBase, "gh-ci-error"), "https://github.com/o/ci-error");
  const { run } = fakeRunner(
    JSON.stringify({
      data: {
        repository: {
          issues: { totalCount: 0 },
          pullRequests: { totalCount: 0 },
          defaultBranchRef: { target: { statusCheckRollup: { state: "ERROR" } } },
        },
      },
    }),
  );
  const svc = new CountsService({}, run);
  expect((await svc.counts(repoDir)).ciStatus).toBe("failure");
});

// 12. CI rollup: SUCCESS → "success", PENDING → "pending"
test("CountsService: maps SUCCESS → success and PENDING → pending", async () => {
  const okDir = gitInit(join(tmpBase, "gh-ci-ok"), "https://github.com/o/ci-ok");
  const pendDir = gitInit(join(tmpBase, "gh-ci-pend"), "https://github.com/o/ci-pend");
  const mk = (state: string) =>
    JSON.stringify({
      data: {
        repository: {
          issues: { totalCount: 0 },
          pullRequests: { totalCount: 0 },
          defaultBranchRef: { target: { statusCheckRollup: { state } } },
        },
      },
    });
  const okSvc = new CountsService({}, () => mk("SUCCESS"));
  const pendSvc = new CountsService({}, () => mk("PENDING"));
  expect((await okSvc.counts(okDir)).ciStatus).toBe("success");
  expect((await pendSvc.counts(pendDir)).ciStatus).toBe("pending");
});

// 13. CI rollup: absent (no rollup / no default branch) → ciStatus null
test("CountsService: missing statusCheckRollup → ciStatus null", async () => {
  const repoDir = gitInit(join(tmpBase, "gh-ci-none"), "https://github.com/o/ci-none");
  const { run } = fakeRunner(
    JSON.stringify({
      data: {
        repository: {
          issues: { totalCount: 2 },
          pullRequests: { totalCount: 1 },
          defaultBranchRef: { target: { statusCheckRollup: null } },
        },
      },
    }),
  );
  const svc = new CountsService({}, run);
  const result = await svc.counts(repoDir);
  expect(result.ciStatus).toBeNull();
  expect(result.openIssues).toBe(2); // counts still parsed
});

// 14. Gitea repos have no Actions rollup → ciStatus null
test("CountsService: Gitea repo → ciStatus null", async () => {
  const repoDir = gitInit(join(tmpBase, "gitea-ci"), "https://git.example.com/team/proj");
  const forges: ForgeMap = {
    "git.example.com": { type: "gitea", baseUrl: "https://git.example.com", token: "tok" },
  };
  const { fn } = fakeFetch({ open_issues_count: 5, open_pr_counter: 1 });
  const svc = new CountsService(forges, () => "", fn);
  expect((await svc.counts(repoDir)).ciStatus).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./test/backlog.test.ts`
Expected: FAIL — `result.ciStatus` is `undefined` (property does not exist yet); TypeScript/assertion errors on `ciStatus`.

- [ ] **Step 3: Implement — add the type, field, query field, and mapping**

In `src/backlog.ts`:

(a) Replace the `RepoCounts` interface (top of file) with:

```ts
/** Default-branch CI rollup state, or null when unknown / no CI / non-GitHub. */
export type CiStatus = "success" | "failure" | "pending" | null;

export interface RepoCounts {
  openIssues: number | null;
  openPRs: number | null;
  /** Default-branch CI health for the Actions tab marker. GitHub-only; null otherwise. */
  ciStatus: CiStatus;
}
```

(b) Update `NULL_COUNTS`:

```ts
const NULL_COUNTS: RepoCounts = { openIssues: null, openPRs: null, ciStatus: null };
```

(c) Add the mapping helper (place it just above the `CountsService` class):

```ts
/** GitHub StatusState rollup → our CiStatus. Unknown/absent → null. */
function mapRollupState(state: string | undefined | null): CiStatus {
  switch (state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return null;
  }
}
```

(d) Replace `fetchGitHub` with the rollup-aware version:

```ts
  private async fetchGitHub(slug: string): Promise<RepoCounts> {
    const [owner, name] = slug.split("/");
    const out = await this.run([
      "api",
      "graphql",
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-f",
      "query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){issues(states:OPEN){totalCount} pullRequests(states:OPEN){totalCount} defaultBranchRef{target{... on Commit{statusCheckRollup{state}}}}}}",
    ]);
    const json = JSON.parse(out) as {
      data?: {
        repository?: {
          issues?: { totalCount?: number };
          pullRequests?: { totalCount?: number };
          defaultBranchRef?: {
            target?: { statusCheckRollup?: { state?: string } | null } | null;
          } | null;
        };
      };
    };
    const repo = json.data?.repository;
    const issues = repo?.issues?.totalCount;
    const prs = repo?.pullRequests?.totalCount;
    return {
      openIssues: typeof issues === "number" ? issues : null,
      openPRs: typeof prs === "number" ? prs : null,
      ciStatus: mapRollupState(repo?.defaultBranchRef?.target?.statusCheckRollup?.state),
    };
  }
```

(e) Update the `fetchGitea` return statement to include `ciStatus: null`:

```ts
    return {
      openIssues: typeof data.open_issues_count === "number" ? data.open_issues_count : null,
      openPRs: typeof data.open_pr_counter === "number" ? data.open_pr_counter : null,
      ciStatus: null,
    };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./test/backlog.test.ts`
Expected: PASS (all existing + 5 new tests).

- [ ] **Step 5: Commit**

```bash
git add src/backlog.ts test/backlog.test.ts
git commit -m "feat(backlog): fetch default-branch CI rollup into RepoCounts (#235)"
```

---

## Task 2: Server — thread `ciStatus` through BacklogProject

**Files:**
- Modify: `src/server.ts` (`BacklogProject` ~1186-1197, `buildBacklogPayload` mapping ~1244-1258)
- Test: `test/server-backlog.test.ts` (`makeDeps` helper ~88-92, add one assertion test)

- [ ] **Step 1: Write the failing test**

In `test/server-backlog.test.ts`, first update the `makeDeps` counts fixture so it tolerates fixtures that omit `ciStatus` (existing call sites pass only `openIssues`/`openPRs`). Replace the counts function (around lines 90-91) with:

```ts
      counts: async (path: string): Promise<RepoCounts> => {
        const c = backlogCounts[path] ?? { openIssues: null, openPRs: null };
        return { openIssues: c.openIssues, openPRs: c.openPRs, ciStatus: c.ciStatus ?? null };
      },
```

And widen the `backlogCounts` parameter type (around line 71) so omitting `ciStatus` typechecks:

```ts
  backlogCounts: Record<
    string,
    Pick<RepoCounts, "openIssues" | "openPRs"> & Partial<Pick<RepoCounts, "ciStatus">>
  >,
```

Then add this test (after the existing passthrough-style tests):

```ts
test("buildBacklogPayload: surfaces per-repo ciStatus onto each project", async () => {
  const app = makeApp(
    makeDeps({
      [repoA]: { openIssues: 1, openPRs: 0, ciStatus: "failure" },
      [repoB]: { openIssues: 2, openPRs: 0, ciStatus: "success" },
    }),
  );
  const res = await app.fetch(new Request("http://x/api/backlog"));
  const body = (await res.json()) as { projects: { path: string; ciStatus: string | null }[] };
  const byPath = Object.fromEntries(body.projects.map((p) => [p.path, p.ciStatus]));
  expect(byPath[repoA]).toBe("failure");
  expect(byPath[repoB]).toBe("success");
});
```

> Note: `repoA`/`repoB`/`makeApp`/`makeDeps` already exist in this file. If `makeDeps`/`makeApp` are defined below this insertion point, place the test after their definitions (match the location of the other `makeApp(makeDeps(...))` tests).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/server-backlog.test.ts`
Expected: FAIL — `ciStatus` is `undefined` on the projects (field not yet added to `BacklogProject`/payload).

- [ ] **Step 3: Implement — add field + passthrough**

In `src/server.ts`, add `ciStatus` to the `BacklogProject` interface (after `workflows`):

```ts
export interface BacklogProject {
  path: string;
  display: string;
  slug: string | null;
  kind: string;
  lastUsedAt: number | null;
  openIssues: number | null;
  openPRs: number | null;
  /** Workflows defined under .github/workflows; null for non-GitHub forges. */
  workflows: number | null;
  /** Default-branch CI rollup state for the Actions tab marker; null = unknown / non-GitHub. */
  ciStatus: "success" | "failure" | "pending" | null;
}
```

In `buildBacklogPayload`, add `ciStatus` to the mapped project object (after the `workflows` line):

```ts
      workflows: r.forge.kind === "github" ? countDefinedWorkflows(r.path) : null,
      ciStatus: counts.ciStatus,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/server-backlog.test.ts`
Expected: PASS (existing tests + the new ciStatus test).

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server-backlog.test.ts
git commit -m "feat(backlog): thread ciStatus through BacklogProject payload (#235)"
```

---

## Task 3: UI types — mirror `ciStatus`

**Files:**
- Modify: `ui/src/lib/types.ts` (`BacklogProject` ~243-247)

- [ ] **Step 1: Add the field**

In `ui/src/lib/types.ts`, add `ciStatus` to `BacklogProject` (after the `workflows` field — match the exact shape used by the server payload):

```ts
  workflows: number | null;
  /** Default-branch CI rollup for the Actions tab marker; null = unknown / non-GitHub. */
  ciStatus: "success" | "failure" | "pending" | null;
```

- [ ] **Step 2: Type-check**

Run: `cd ui && bun install && bun run check`
Expected: PASS for this file (other UI files may now flag missing `ciStatus` in fixtures — those are fixed in Task 4). If `check` reports errors only in `backlog-view.test.ts` fixtures, that is expected and resolved next task.

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/types.ts
git commit -m "feat(backlog): mirror ciStatus on UI BacklogProject type (#235)"
```

---

## Task 4: UI helper — `actionsTabLabel` failing case

**Files:**
- Modify: `ui/src/lib/components/backlog-view.ts` (`actionsTabLabel` ~52-59)
- Test: `ui/src/lib/components/backlog-view.test.ts` (`project()` helper ~25-32; `actionsTabLabel` describe block ~130-146)

- [ ] **Step 1: Write the failing test**

In `ui/src/lib/components/backlog-view.test.ts`, update the `project()` helper to accept an optional `ciStatus` (defaulting to null) so existing call sites are unaffected:

```ts
function project(
  path: string,
  openIssues: number | null,
  openPRs: number | null,
  workflows: number | null = null,
  ciStatus: BacklogProject["ciStatus"] = null,
): BacklogProject {
  return {
    path,
    display: path,
    slug: "org/repo",
    kind: "github",
    openIssues,
    openPRs,
    workflows,
    ciStatus,
  };
}
```

Add these cases inside the `describe("actionsTabLabel", ...)` block:

```ts
  it("shows the failing marker when the selected repo's CI is failing", () => {
    // ciStatus "failure" wins over the workflows-defined count.
    expect(actionsTabLabel(project("/repos/a", 0, 0, 3, "failure"))).toMatch(/failing/i);
  });

  it("shows the workflows count (not failing) when CI is healthy", () => {
    expect(actionsTabLabel(project("/repos/a", 0, 0, 3, "success"))).toMatch(/Actions\s*·\s*3/);
  });

  it("shows the workflows count when CI status is unknown (null)", () => {
    expect(actionsTabLabel(project("/repos/a", 0, 0, 3, null))).toMatch(/Actions\s*·\s*3/);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && bun run test -- backlog-view`
Expected: FAIL — the failing-marker test fails because `actionsTabLabel` still returns "Actions · 3" regardless of `ciStatus`.

- [ ] **Step 3: Implement**

In `ui/src/lib/components/backlog-view.ts`, replace `actionsTabLabel`:

```ts
/**
 * Build the Actions tab label for the selected project.
 * - Failing default-branch CI → "Actions · failing" (the marker; red in the UI).
 * - Otherwise: the number of workflows defined (github-only; null on other
 *   forges → bare label).
 * Mirrors: failure → m.backlog_tab_actions_failing,
 *          count → m.backlog_tab_actions_count, else m.backlog_tab_actions.
 */
export function actionsTabLabel(sel: BacklogProject | null): string {
  if (sel && sel.ciStatus === "failure") return "Actions · failing";
  return sel && sel.workflows !== null ? `Actions · ${sel.workflows}` : "Actions";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && bun run test -- backlog-view`
Expected: PASS (all `actionsTabLabel` cases, including the prior workflows-count cases).

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/components/backlog-view.ts ui/src/lib/components/backlog-view.test.ts
git commit -m "feat(backlog): actionsTabLabel failing marker for selected repo (#235)"
```

---

## Task 5: UI render + i18n — failing marker on the Actions tab

**Files:**
- Modify: `ui/messages/en.json` (after `backlog_tab_actions_count` ~line 409)
- Modify: `ui/messages/de.json` (after `backlog_tab_actions_count` ~line 409)
- Modify: `ui/src/lib/components/BacklogView.svelte` (mobile Actions button ~122-131; desktop Actions button ~177-186; `.tab-btn` CSS block ~278-301)

- [ ] **Step 1: Add the i18n key to both catalogs**

In `ui/messages/en.json`, add after the `"backlog_tab_actions_count"` line:

```json
  "backlog_tab_actions_failing": "Actions · failing",
```

In `ui/messages/de.json`, add after the `"backlog_tab_actions_count"` line:

```json
  "backlog_tab_actions_failing": "Actions · fehlerhaft",
```

(Keep valid JSON — ensure the preceding line keeps its trailing comma and the new line matches surrounding indentation.)

- [ ] **Step 2: Update the desktop Actions tab button**

In `ui/src/lib/components/BacklogView.svelte`, replace the desktop Actions `<button>` (the one in `.tab-bar`, currently lines ~177-186) with:

```svelte
      <button
        class="tab-btn"
        class:active={activeTab === "actions"}
        class:failing={selected?.ciStatus === "failure"}
        type="button"
        onclick={() => (activeTab = "actions")}
      >
        {#if selected?.ciStatus === "failure"}
          {m.backlog_tab_actions_failing()}
        {:else if selected && selected.workflows !== null}
          {m.backlog_tab_actions_count({ count: selected.workflows })}
        {:else}
          {m.backlog_tab_actions()}
        {/if}
      </button>
```

- [ ] **Step 3: Update the mobile Actions tab button**

In the same file, replace the mobile Actions `<button>` (in `.overlay-tabs`, currently lines ~122-131) with the identical structure:

```svelte
            <button
              class="tab-btn"
              class:active={activeTab === "actions"}
              class:failing={selected?.ciStatus === "failure"}
              type="button"
              onclick={() => (activeTab = "actions")}
            >
              {#if selected?.ciStatus === "failure"}
                {m.backlog_tab_actions_failing()}
              {:else if selected && selected.workflows !== null}
                {m.backlog_tab_actions_count({ count: selected.workflows })}
              {:else}
                {m.backlog_tab_actions()}
              {/if}
            </button>
```

- [ ] **Step 4: Add the failing CSS**

In the `<style>` block, add after the `.tab-btn.active { ... }` rule (around line 301):

```css
  .tab-btn.failing {
    color: var(--color-red);
    border-color: color-mix(in srgb, var(--color-red) 45%, transparent);
  }

  .tab-btn.failing.active {
    color: var(--color-red);
    border-color: var(--color-red);
    background: var(--color-inset);
  }
```

- [ ] **Step 5: Verify type-check, i18n parity, and lint**

Run: `cd ui && bun run check && bun run check:i18n`
Expected: PASS — types resolve, EN/DE catalogs share an identical key set.

- [ ] **Step 6: Commit**

```bash
git add ui/messages/en.json ui/messages/de.json ui/src/lib/components/BacklogView.svelte
git commit -m "feat(backlog): render failing-CI marker on Actions tab label (#235)"
```

---

## Task 6: Full validation (both packages)

**Files:** none (verification only)

- [ ] **Step 1: Root server — lint + type-check + tests**

Run:
```bash
bun install
bun run lint
bunx tsc --noEmit
bun test ./test
```
Expected: all PASS.

- [ ] **Step 2: UI — check + i18n + tests**

Run:
```bash
cd ui && bun install && bun run check && bun run check:i18n && bun run test
```
Expected: all PASS.

- [ ] **Step 3: Branch hygiene**

Run: `bash scripts/check-branch-hygiene.sh`
Expected: PASS (no merge commits relative to main).

- [ ] **Step 4: Manual smoke (optional but recommended)**

Confirm in the running app that the Backlog → Actions tab shows red "Actions · failing" for a repo whose default branch CI is red, and the normal "Actions · N" / "Actions" label otherwise. (`/run` or the project's app-launch skill.)

---

## Self-review

- **Spec coverage:** RepoCounts.ciStatus + GraphQL rollup (Task 1) ✓; BacklogProject passthrough (Task 2) ✓; UI type mirror (Task 3) ✓; actionsTabLabel helper (Task 4) ✓; BacklogView render both buttons + CSS + i18n both catalogs (Task 5) ✓; tests server+UI (Tasks 1,2,4) ✓; validation (Task 6) ✓. Gitea→null (Task 1 test 14) ✓. ERROR→failure (Task 1 test 11) ✓.
- **Placeholders:** none — all steps carry concrete code/commands.
- **Type consistency:** `CiStatus` union `"success" | "failure" | "pending" | null` is identical in `RepoCounts` (Task 1), `BacklogProject` server (Task 2), and UI type (Task 3). `ciStatus` field name consistent throughout. `mapRollupState` signature matches its single caller. `actionsTabLabel(sel)` signature unchanged (still `BacklogProject | null`).
- **i18n:** `backlog_tab_actions_failing` added to both en.json and de.json (parity gate). Agent-facing prompts: none touched.
