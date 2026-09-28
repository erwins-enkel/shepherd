# CI speed and job granularity

_Research, 2026-09-28. Data window: 2026-09-14 → 2026-09-28 (all 4,983 workflow runs, 1,332 job timing records for CI / native / CodeQL, 155 squash-merges to `main`)._

## TL;DR

The PR gate (`verify`) takes a steady **7.4 min median**. That's one job running about 20 steps in series.
The slowest pipeline is now `native`: since #2444 (2026-09-22) added the iOS-simulator job, a native run takes **28.6 min median** (it was 7.9 min before). Its jobs are chained with `needs:` even though no job uses another's output.

Recommended changes, cheapest and highest-impact first:

| #   | Change                                                                                            | Effect (est.)                                                           | Effort |
| --- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------ |
| 1   | `bun test --parallel` for the root suite (in `ci.yml` and `scripts/pre-push.ts`)                  | root tests 124 s → ~45 s on CI (measured locally 101 s → 31 s)          | XS     |
| 2   | Split `verify` into parallel jobs behind an aggregator job that keeps the **`verify`** name       | PR gate 7.4 → ~2.5–3 min                                                | S      |
| 3   | Path-aware job skipping via a `changes` job + job-level `if:` (not workflow `paths:`)             | test-root skips ~19 %, ui ~21 %, docs-site ~29 %, site/cli ~57 % of PRs | S–M    |
| 4   | `native`: drop the `needs:` chain; stop triggering on `ui/messages/*.json`                        | native 28.6 → ~12–15 min; ~20 % fewer macOS runs                        | S      |
| 5   | Noise: gate doc-automerge at job level, CodeQL `paths-ignore` for docs, cache Playwright browsers | ~1,000 fewer no-op runs / 2 wks; ~15 s per UI job                       | XS     |

Runner time is free here: the repo is public and the self-hosted runner is retired. What costs us is wall-clock time, and every open PR's autopilot/critic waits for it. So every item above trades extra runner-minutes for less waiting.

## What the history shows

### Volume (2 weeks)

| Workflow                | Runs  | Median  | Notes                                                                 |
| ----------------------- | ----- | ------- | --------------------------------------------------------------------- |
| Auto-merge doc PRs      | 1,105 | 0.2 min | `workflow_run` after **every** CI / PR-hygiene run; almost all no-ops |
| CI                      | 626   | 7.5 min | 129 skipped (release-please), 157 on push-to-main (34 cancelled)      |
| PR title                | 617   | 0.3 min |                                                                       |
| CodeQL                  | 595   | 3.6 min | not a required check; runs on every PR incl. docs-only                |
| Eval — prompt gate      | 472   | 0.4 min | fingerprint-gated, already cheap                                      |
| PR hygiene              | 468   | 0.3 min |                                                                       |
| Onboarding release gate | 434   | 0.2 min | 305 skipped — only acts on release PRs                                |
| native                  | 247   | 9.0 min | p90 29 min; see below                                                 |

About 339 CI runs came from 181 PR branches (median 1 run per PR, p90 3). Only 15 runs were re-run attempts, so flaky re-runs aren't what's costing time. The time goes into the length of each individual run.

### `verify` is serial: where the 7.4 min goes

Step medians over the 421 successful runs:

| Step                                                   | Median | Share |
| ------------------------------------------------------ | ------ | ----- |
| Test (ui) — vitest                                     | 162 s  | 37 %  |
| Test (root) — `bun test ./test`                        | 124 s  | 28 %  |
| Typecheck (ui svelte-check)                            | 33 s   | 8 %   |
| Lint (prettier + eslint)                               | 27 s   | 6 %   |
| Build (ui)                                             | 22 s   | 5 %   |
| Install Playwright Chromium                            | 20 s   | 5 %   |
| Typecheck (root tsc)                                   | 14 s   | 3 %   |
| installs, checkout, freshness gates, fallow, extension | ~40 s  | 9 %   |

Inside **Test (ui)** (a vitest log from a `main` run on 2026-09-28):

- `node` project: 172 files in about 21 s.
- `browser` project: 159 files in about **100 s**. It is capped at 2 files in parallel on CI because an uncapped run got OOM-killed. There are also ~17 s of browser startup.
- `browser-touch`: 2 files, about 4 s.

**Test (root)**: 11,298 tests in 516 files, 129 s, run **one file at a time**. Bun doesn't parallelise across files unless you pass `--parallel`.

The two test steps take 65 % of the job. Neither depends on the other, or on lint, typecheck or build.

### `native` got 3.6× slower on 2026-09-22

| Period                                | Runs | Wall-clock median | p90      |
| ------------------------------------- | ---- | ----------------- | -------- |
| Before #2444 (ShepherdKit + XCUITest) | 136  | 7.9 min           | 11.9 min |
| After #2444 (+ iOS Simulator job)     | 39   | **28.6 min**      | 33.8 min |

The three jobs run as a chain: `ShepherdKit` (9.4 min) → `ShepherdAppCore (iOS Simulator)` (9.9 min) → `XCUITest` (3.1 min, `continue-on-error`). The simulator job doesn't consume anything from `ShepherdKit`: it checks out, installs and rebuilds from scratch, and re-runs the same freshness checks. So the `needs:` only makes it wait.

The path filter also includes `ui/messages/*.json`, but only so the Mac string-catalog freshness check can run (`bun run check:strings`, a Bun script). Of the 74 merges to `main` that triggered `native`, **15 (20 %) matched only because of `ui/messages`**. Each one paid for a ~28 min macOS pipeline to run what is effectively a 1-second catalog diff.

### Which areas merges actually touch

Of the 155 squash-merges to `main` (a merge can touch several areas):

- server (`src/`, `test/`): 78
- native: 57
- docs / markdown: 49
- ui: 46
- ui/messages: 39
- contracts: 26
- docs-site: 24
- `.github`: 22
- cli: 5
- extension: 5
- **site: 2**

- **14 merges touched only docs/markdown.** They still ran the full 7.4 min of `verify`, plus site, docs-site and cli.
- **14 merges touched only `native/`.** They also ran the full `verify`.
- `site` ran 480 times for 2 site-touching merges. `cli` ran on every PR for 5 cli merges.

### Failure causes (for sizing the lanes)

| Workflow | Job / step                   | Failures | Share                                            |
| -------- | ---------------------------- | -------- | ------------------------------------------------ |
| CI       | Lint                         | 9        | ⅓ of `verify` failures                           |
| CI       | Fallow audit                 | 6        |                                                  |
| CI       | Test (root)                  | 4        |                                                  |
| CI       | cli                          | 3        |                                                  |
| native   | ShepherdKit + simulator jobs | ~40      | spread across build/test/contract-copy/DMG steps |

Today a lint failure is only reported after ~7 min, because the job runs to completion and reports once. As its own job it would fail in about 1 min.

## Recommendations

### 1. `bun test --parallel` for the root suite

Bun 1.4 (the version CI installs, `bun-version: latest` → 1.4.2) has `--parallel[=N]`. It runs test files in worker processes, one fresh global per file (it implies `--isolate`). It also has `--shard=i/N` and `--timings`, which balance shards by duration ([Bun docs: parallel & isolated runs](https://bun.com/docs/test/parallel)).

Local spike on this branch, with the same env as the CI step:

| Command                                  | Result                                     |
| ---------------------------------------- | ------------------------------------------ |
| `bun test ./test`                        | 101 s, 0 fail                              |
| `bun test --parallel=4 ./test` (×4)      | **31.2 s every time, 0 fail, 11,283 pass** |
| `bun test --parallel=4 --randomize` (×3) | 11–14 fail                                 |

The `--randomize` failures are **not** caused by parallelism. The contract "coverage gate" tests assert that every operation was exercised by earlier tests in the same file, so they depend on test order within a file. Don't combine the two flags.

On CI, root tests run about 1.28× slower than locally (129 s vs 101 s), and `ubuntu-latest` has 4 vCPUs. That puts **~40–50 s** within reach.

There are two places to edit, and `package.json`'s `test` script is not one of them: neither CI nor the hook calls it.

- **`.github/workflows/ci.yml`**: the `Test (root)` step runs `bun test ./test` directly. Change it to `bun test --parallel ./test`; on the 4-vCPU runner that means 4 workers.
- **`scripts/pre-push.ts`**: the `root-tests` lane spawns `bun` with `["test", "./test"]`. Pass `--parallel=${maxWorkers}` using the value `computeConcurrency()` already returns. A bare `--parallel` starts one worker per core, which breaks the hook's `laneCap × maxWorkers ≤ cores` budget while the other lanes run alongside it.

Before landing it, loop the suite 10+ times under `--parallel` on a CI runner. The tests share `SHEPHERD_REPO_ROOT` and real git repos, so check for temp-dir or port collisions (`BUN_TEST_WORKER_ID` is available to give each worker its own resources). Also watch #1731 (test storms exhausting the host): locally, `--parallel` with no N means one worker per core, which is 31 on the operator box.

### 2. Split `verify` into parallel jobs, keep the `verify` name as the gate

The ruleset requires the contexts `verify`, `docs-site`, `site`, `pr title`, `branch hygiene` and `eval-prompts`, with `strict: false`. Turn `verify` into an **aggregator**: `needs:` all the new jobs, `if: always()`, and fail unless every needed job is `success` or an allowed `skipped` (hand-rolled or [`re-actors/alls-green`](https://github.com/marketplace/actions/alls-green)). Because the aggregator keeps the name `verify`, **the ruleset needs no change**, and new lanes can be added later without editing required checks.

Proposed jobs:

| Job                  | Contents                                                                                                                        | Est.       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `static`             | prettier + eslint, tsc, both svelte-checks, i18n parity, all freshness gates, env-schema, fallow audit (keeps `fetch-depth: 0`) | ~2 min     |
| `test-root`          | `bun test --parallel ./test`                                                                                                    | ~1.5 min   |
| `test-ui`            | vitest `--project node --project browser-touch` + `check-ui-build.sh` + extension test/build                                    | ~1.5 min   |
| `test-ui-browser` ×3 | `vitest run --project browser --shard=${i}/3` (+ Playwright install)                                                            | ~1.5–2 min |
| `verify`             | aggregator                                                                                                                      | 5 s        |

Each extra job pays about 30 s for checkout, Bun setup and installs. The critical path becomes the slowest lane, about **2.5–3 min instead of 7.4**.

Vitest supports `--shard` together with `--project`; the shards can upload `--reporter=blob` output and a job can merge it with `--merge-reports` if one combined report is wanted ([vitest: improving performance](https://github.com/vitest-dev/vitest/blob/main/docs/guide/improving-performance.md)). Sharding also removes the pressure that forced the 2-file cap: each shard runner has its own 16 GB.

Costs and risks:

- **Concurrency.** The org is on the Team plan: 60 concurrent jobs, **5 macOS**. The observed Linux peak (CI + native + CodeQL only) was 23 concurrent jobs. Going from 4 CI jobs to 8 per PR could approach 60 during agent bursts, and the jobs would then queue. Start with 2 browser shards, and watch job queue time (currently 2 s median).
- **Pre-push sync.** `ci.yml` and `scripts/pre-push.ts` are hand-mirrored (see the comment at the top of `verify`). The split is a CI-only restructuring, but the parallel root test goes into both (see #1).

### 3. Path-aware skipping without breaking required checks

Workflow-level `paths:` stays off for required checks (#1859): a check that never reports blocks the merge forever. But a job skipped by a **job-level `if:`** reports "skipped", which the ruleset counts as passing (`ci.yml` already relies on this for release-please). The standard pattern:

1. Add a `changes` job, about 10 s. It runs `git diff --name-only origin/$base...HEAD` in a small in-repo script, so it needs `fetch-depth: 0` (or at least the merge base). That avoids a new third-party action on a public repo; `dorny/paths-filter` works too, pinned by SHA.
2. The script outputs booleans such as `server`, `ui`, `extension`, `docs_site`, `site`, `cli` and `docs_only`.
3. Each heavy job gets `needs: changes` and `if: needs.changes.outputs.X == 'true'`.
4. The aggregator lists which of its jobs are allowed to be skipped.

Rules should fail **open**:

- **Global triggers run everything:** any change to `package.json`, lockfiles, `bunfig.toml`, `tsconfig*`, `eslint*`, `.prettier*`, `.github/**`, `scripts/**`, or `contracts/**`.
- **Push to `main` always runs everything:** `strict: false` means a PR can merge without being up to date, so the push run is the only check on the merged tree.
- **The `static` lane always runs:** prettier also formats Markdown, and it's cheap.

Suggested mapping:

| Output      | Paths                                                                                                         | Gates                              |
| ----------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `server`    | `src/**`, `test/**`, `deploy/**`, `ci/**`, `examples/**`, `native/**`, `docs-site/**` + global                | test-root                          |
| `ui`        | `ui/**`, `src/**` (ui imports server types), `test/**` (ui tests load `test/fixtures/*-parity.json`) + global | test-ui, test-ui-browser           |
| `extension` | `extension/**` + global                                                                                       | extension test/build               |
| `site`      | `site/**` + global                                                                                            | `site` job (required; skip = pass) |
| `docs_site` | `docs-site/**`, `docs/**`, `src/**` (TypeDoc reads it), anything `sync-docs.mjs` reads + global               | `docs-site` job                    |
| `cli`       | `cli/**`, `contracts/openapi*.yaml`, `scripts/check-cli.sh` + global                                          | `cli` job                          |

`native/**` and `docs-site/**` belong in the `server` trigger because the root suite reads files there, and nothing else runs those tests. Examples: `test/contract/native-app-core-boundary.test.ts`, `test/contract/native-ui-isolation.test.ts`, `test/native-test-conservation.test.ts`, `test/native-fixture-conservation.test.ts`, `test/docs-site-gitignore.test.ts`, `test/host-capacity-doc-anchor.test.ts`.

Applied to the 155 merges, this mapping gives:

| Lane             | Runs on | Skips on |
| ---------------- | ------- | -------- |
| test-root        | 81 %    | **19 %** |
| test-ui + shards | 79 %    | **21 %** |
| docs-site        | 71 %    | **29 %** |
| site             | 43 %    | **57 %** |
| cli              | 43 %    | **57 %** |

The global triggers decide most of this: they fire on **64 of 155 merges (41 %)**. That comes mostly from `scripts/**` (the eval scripts, `pre-push.ts`, the generators), `package.json`/`bun.lock`, `.github/**` and `contracts/**`. Tightening them is the main lever. For example, `scripts/eval-*` only needs the lanes that import it, not every lane. It's also the main risk, so keep the default broad and narrow it one path at a time.

So #3 gives a real but modest gain. It saves runner slots and keeps queues short more than it cuts wall-clock time, because #2 already brings the critical path down to about 3 min.

### 4. `native`: parallelise and narrow the trigger

- **Remove `needs: shepherdkit` from `shepherd-app-core-simulator`, and `needs: shepherd-app-core-simulator` from `shepherd-mac-ui`.** Each job is already self-contained. Wall-clock drops from the sum (~22 min of jobs plus queueing) to the slowest job, **~10–15 min**. The trade-off is up to 3 concurrent macOS jobs per PR against the Team limit of 5 (the observed peak was already about 5–7, so expect occasional queueing when two native PRs overlap). If that becomes a problem, keep only `shepherd-mac-ui` behind a `needs:`, since it's non-blocking anyway.
- **Drop `ui/messages/*.json` from the `native` path filter, and run `bun run check:strings` in the Linux `static` lane.** It's a Bun script. Confirm it doesn't need macOS tooling first; if it does, keep the filter. This saves about 1 in 5 native runs.
- Optional, later: `ShepherdKit` itself is serial at ~9.4 min (package tests → app build → app unit tests). The app build and unit tests (~6 min) could be split into their own macOS job, but that costs one more macOS slot.

### 5. Low-effort noise reduction

- **Auto-merge doc PRs:** 1,105 runs in 2 weeks, nearly all no-ops. Add a job-level `if:` so the job only runs when `github.event.workflow_run.head_branch` starts with `shepherd/docs-update-`, or when the event isn't `workflow_run` (schedule or dispatch). The daily schedule and the per-PR re-derivation still catch anything missed.
- **CodeQL:** not a required check, so `paths-ignore: ['docs/**', '**/*.md']` on `pull_request` is safe. Push-to-main and the weekly scan keep full coverage.
- **Cache `~/.cache/ms-playwright`**, keyed on the Playwright version in `ui/bun.lock`, in the browser lane(s). That saves most of the 20 s install. `--with-deps` still needs the apt step on a cache miss.
- **Keep `fetch-depth: 0`** in `static` (fallow's base diff), `test-root` (`test/native-fixture-conservation.test.ts` fetches pinned commits `83e8d45`/`c4961c4` from the checkout) and `changes` (it diffs against `origin/$base`). Only `test-ui`, the browser shards, `site`, `docs-site` and `cli` can use shallow checkouts. The saving is small, since checkout takes 6 s at full depth.

## Considered and not recommended

- **Workflow-level `paths:` on required workflows:** causes the #1859 never-reports deadlock.
- **GitHub merge queue:** Shepherd already runs its own merge train with a behind-base gate (AutoMergeService). A merge queue would double-gate it and add `merge_group` runs.
- **Larger GitHub-hosted runners:** billed even on public repos, and the problem is serialisation, not CPU. Splitting into jobs gets more parallel CPU for free.
- **Self-hosted runner:** retired on purpose. It would run fork-PR code on the host.
- **Skipping CI on push to `main`:** with `strict: false`, it's the only check on the merged tree.

## Suggested rollout

1. PR A: `--parallel` for root tests (`ci.yml` step + `pre-push.ts` lane with `--parallel=${maxWorkers}`), after a 10× loop on a CI runner.
2. PR B: `native` `needs:` removal and the trigger narrowing.
3. PR C: `verify` → aggregator plus parallel lanes, including browser shards.
4. PR D: `changes` job and job-level gating.
5. PR E: noise items.

Measure each step with the same method as this report (`gh api …/actions/runs/{id}/jobs` step timings over a week).

## Sources

- Run and job data: `gh api repos/erwins-enkel/shepherd/actions/runs` (per-day windows to stay under the 1,000-result search cap) and `…/runs/{id}/jobs`; ruleset `main` (id 17942643).
- [Bun — Parallel & isolated test runs](https://bun.com/docs/test/parallel); [Bun v1.3.13 release notes (`--shard`)](https://bun.com/blog/bun-v1.3.13)
- [Vitest — Improving performance / sharding](https://github.com/vitest-dev/vitest/blob/main/docs/guide/improving-performance.md)
- [GitHub Actions limits (concurrency per plan)](https://docs.github.com/en/actions/reference/limits)
- [community discussion #44490 — required checks and path filtering](https://github.com/orgs/community/discussions/44490); [re-actors/alls-green](https://github.com/marketplace/actions/alls-green)
