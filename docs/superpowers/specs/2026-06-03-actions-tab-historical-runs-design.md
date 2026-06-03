# Actions tab: per-workflow run history

**Issue:** [#236](https://github.com/erwins-enkel/shepherd/issues/236)
**Date:** 2026-06-03
**Follow-up to:** the v1 per-job GitHub Actions backlog tab (#235 era).

## Problem

The Actions tab (`ActionsPanel` → `ActionRunRow`) shows only the **newest run
per workflow** on the default branch. There is no way to browse a workflow's
prior runs. Issue #236 asks for that — "a way to browse prior runs / a run's
history."

## Decision (from brainstorming)

Surface **per-workflow run history**: from a workflow card, expand to reveal its
prior runs over time, each drillable to its per-job breakdown. Not a flat
cross-workflow feed, not per-run attempts.

### Behavior

Each workflow card is unchanged from v1: the **latest run with its job breakdown
stays always visible** at the top, with re-run/cancel on the card head. Added is
an **"— older runs ▾ —"** expander at the bottom of each card. Expansion is
**two-level and lazy**:

1. **Workflow → older runs.** One `gh run list --workflow <id>` call. Prior runs
   render as **summary rows**: state dot, run number, relative time, short SHA,
   ↗ link. No jobs fetched at this level.
2. **Run → jobs.** Clicking a summary row lazily fetches that run's per-job
   breakdown (`gh run view <id> --json jobs`, reusing v1's `mapCheckState`
   mapping).

### Settled defaults

- **Default branch only** — matches v1's CI-health semantics.
- **History rows are read-only** — no re-run/cancel on old runs (browse intent,
  avoids clutter). Actions stay on the card head (the latest run).
- **No polling of history** — historical runs are settled; v1's live poll on the
  latest run already covers in-flight work. History is fetched once per expand.
- **"Load more"** grows the limit (initial 10, +10 per click, cap 50).
  `gh run list` has no cursor, so load-more re-fetches at a larger `--limit` —
  cheap for these short lists. (Alternative `gh api .../actions/runs?page=` for
  true pagination was considered and rejected to keep a single JSON shape and a
  single state-mapping path shared with v1.)

## Changes

### Server — `src/forge/types.ts`

- `WorkflowRun` gains `workflowId: number` — the `gh` `workflowDatabaseId`, the
  stable handle the history call filters on (`gh run list --workflow <id>`).
- Two new **optional** `GitForge` methods, gated GitHub-only exactly like the
  existing `listWorkflowRuns` (other forges omit them; the tab degrades):
  - `listWorkflowRunHistory(workflowId: number, opts: { limit: number }): Promise<WorkflowRun[]>`
    — returns summary rows with **`jobs: []`** (jobs not fetched at this level),
    newest-first.
  - `listRunJobs(runId: number): Promise<WorkflowJob[]>` — per-job breakdown for
    one run.

### Server — `src/forge/github.ts`

- `listWorkflowRuns`: add `workflowDatabaseId` to the `--json` field set and
  populate `workflowId` on each `WorkflowRun`. Extract the inline
  `gh run view <id> --json jobs` + `mapCheckState` block into the new shared
  `listRunJobs` and call it from here (no behavior change to v1).
- `listWorkflowRunHistory`: resolve the default branch (reuse the helper
  `listWorkflowRuns` already uses), then
  `gh run list --repo <slug> --branch <branch> --workflow <id> --limit <N>
  --json databaseId,workflowName,workflowDatabaseId,status,conclusion,headSha,createdAt,url`,
  map each row to a `WorkflowRun` with `jobs: []`, sorted newest-first.
- `listRunJobs`: the extracted reusable job-fetch + mapping.

### Server — `src/server.ts`

Two new GET handlers mirroring `handleActionsList`'s forge-resolution,
GitHub-gating, and graceful-empty-on-error contract:

- `GET /api/actions/history?repo=&workflowId=&limit=` →
  `{ runs: WorkflowRun[] }`. Validate `workflowId` is a number; clamp `limit`
  (default 10, max 50). Forge lacking `listWorkflowRunHistory` → `{ runs: [] }`.
- `GET /api/actions/run-jobs?repo=&runId=` → `{ jobs: WorkflowJob[] }`. Validate
  `runId` is a number. Forge lacking `listRunJobs` → `{ jobs: [] }`.

Register both in the handler chain next to the existing actions routes.

### UI — `ui/src/lib/types.ts`

- Mirror `workflowId: number` on the UI `WorkflowRun` interface (server/UI
  payload parity).

### UI — `ui/src/lib/api.ts`

- `listWorkflowRunHistory(repoPath, workflowId, limit): Promise<{ runs: WorkflowRun[] }>`.
- `listRunJobs(repoPath, runId): Promise<{ jobs: WorkflowJob[] }>`.
- Both follow the existing `fetch` + `failed()` error pattern in the file.

### UI — `ui/src/lib/components/ActionRunRow.svelte`

- Keep the latest-run block (head + always-visible jobs + re-run/cancel)
  untouched.
- Add an **"older runs"** expander row at the bottom with local state:
  `historyOpen`, `history: WorkflowRun[]`, `historyLoading`, `historyFailed`,
  `limit`. First expand calls `listWorkflowRunHistory(repoPath, run.workflowId,
  limit)`. "Load more" bumps `limit` and re-fetches (replace, not append, since
  the call re-lists from the top). Render each prior run via the new
  `ActionHistoryRow`.
- States to handle: loading, failed (with retry affordance), empty
  ("no older runs").

### UI — `ui/src/lib/components/ActionHistoryRow.svelte` (new)

- Props: `repoPath`, `run` (a history `WorkflowRun`, `jobs` empty).
- Renders the summary row (state dot, run number, relative time, short SHA, ↗
  link) and its own lazy job-expand: `jobsOpen`, `jobs`, `jobsLoading`,
  `jobsFailed`. First expand calls `listRunJobs(repoPath, run.runId)`.
- Reuses the dot + job-row markup/vocabulary from `ActionRunRow` (shared CSS
  idiom: `.dot`, `.dot-pending/success/failure`, `.job`, `.job-name`).

### i18n — `ui/messages/en.json` + `de.json`

New `actionspanel_`-prefixed keys (both catalogs, snake_case; parity gate
enforced in CI + pre-push):

- `actionspanel_older_runs` — expander label ("older runs").
- `actionspanel_load_more` — "load more".
- `actionspanel_history_loading` — loading state (or reuse `common_loading`).
- `actionspanel_history_empty` — "no older runs".
- `actionspanel_history_failed` — fetch-failed state.
- `actionspanel_run_number` — `{number}` run-number formatting if needed.

Reuse existing keys where one fits (`common_loading`, `actionspanel_run_link`,
`actionspanel_job_link`, `gitrail_ci_status`).

### Tests

- `src/forge/github.test.ts` (or the existing forge test file): unit-test
  `listWorkflowRunHistory` and `listRunJobs` mapping with a stubbed `run`,
  mirroring how existing forge methods are tested — assert the gh argv
  (`--workflow <id>`, `--branch`, `--limit`) and the `WorkflowRun`/`WorkflowJob`
  mapping (incl. `jobs: []` for history rows and `workflowId` propagation).
- Component/state test for the expand state machine if it fits the existing
  `backlog-view.test.ts` pattern; otherwise cover the load-more/limit logic in a
  small pure helper.

## Out of scope

- Flat cross-workflow activity feed (#236 alt, rejected in brainstorming).
- Per-run re-run-attempt history.
- Re-run/cancel on historical runs.
- Non-GitHub forges (degrade exactly as the v1 Actions tab does).
- True API cursor pagination (limit-growth is sufficient for this surface).
