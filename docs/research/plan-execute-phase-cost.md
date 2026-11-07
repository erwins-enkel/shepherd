# Plan/execute phase cost — measuring before building R1

Measure-first follow-up to [#1951](https://github.com/erwins-enkel/shepherd/issues/1951) /
[`cursor-agent-swarm-model-economics.md`](./cursor-agent-swarm-model-economics.md). Before building
R1 (respawn on a cheaper executor at plan approval), this measures what the plan/execute split is
actually worth on our own sessions, and what the #3434 effort split already buys.

Every table and figure below is printed by `bun run scripts/usage-report.ts --phase-split --md`
(logic: [`scripts/usage-phase-split.ts`](../../scripts/usage-phase-split.ts)), run against the live
DB on 2026-11-07. Nothing is post-processed by hand: the cohort summary, the cost split by token
kind, the context-size percentiles (nearest rank), the savings-by-length buckets and the in-pane
switch scenario all come straight from the script's output. Cost is the **relative** per-Mtok proxy from `src/pricing.ts` (`weightedUnits`), never
dollars. Only ratios matter.

## Sample and method

- **Sample:** 204 plan-gated Claude task sessions, 2026-10-25 → 2026-11-07 (the `sessions` table's
  retention window). 272 Claude sessions were scanned; operational archetypes and Codex sessions are
  excluded. Almost all ran on `claude-opus-5-5[1m]`.
- **Phase boundary:** the first main-thread user turn that starts with the Go steer ("Plan approved.
  Execute `.shepherd-plan.md` now", optionally inside Shepherd's paste wrapper). It comes from the
  transcript because `plan_gates` rows are dropped on archive. Records are deduped by `requestId`.
  Planning + execution cost equals the transcript total (unit-tested; spot-checked on live sessions).
- **Cohorts:**
  - `switched` (n=141): the #3434 execution effort was in force at archive and differed from the
    planning effort. All of these went high → medium.
  - `baseline` (n=63): every other gated session. These were concurrent sessions with no execution
    effort set; only one predates #3434.
- **R1 counterfactuals** price the recorded execution-phase tokens differently. Token counts are held
  fixed, so all four are **upper bounds**:
  - **Tier:** execution records re-priced at Sonnet 5.5.
  - **Reset:** a fresh executor that does not carry the planning context. Each main-thread execution
    turn handles `max(0, ctx@Go − opener)` fewer prefix tokens. They come off its cache reads first,
    then off its cache writes, because a turn that rebuilt a cold cache re-wrote the prefix. The
    opener (first request's context + the plan's size) is paid once as a cold write
    (`coldResumeUnits`, 1h TTL). If the first execution turn was itself a cold rebuild (more than half
    its context written), its trimmed write already stands in for that opener write, so it isn't
    charged twice.
  - **Both:** reset, then re-priced at Sonnet 5.5.
  - **In-pane:** tier reached by switching the model inside the running session. The context stays,
    but the new model can't reuse the old model's prompt cache, so the context at Go is rebuilt once
    at Sonnet 5.5 rates (same cold-first-turn exception).
  - A session whose Go was its last turn has nothing to respawn and scores zero savings.

## Results

| Cohort   | n   | Exec share (Σ) | Exec share (median) | Exec cost*/req (median) | Exec output/req (median) | Tier save (Σ) | Reset save (Σ) | Both save (Σ) | In-pane save (Σ) |
| -------- | --- | -------------- | ------------------- | ----------------------- | ------------------------ | ------------- | -------------- | ------------- | ---------------- |
| switched | 141 | 64.8%          | 61.1%               | 0.0624                  | 704                      | 15.2%         | 3.9%           | 23.3%         | 4.5%             |
| baseline | 63  | 71.5%          | 59.9%               | 0.0663                  | 783                      | 14.9%         | 6.6%           | 24.5%         | 7.2%             |
| all      | 204 | 67.5%          | 60.8%               | 0.0638                  | 716                      | 15.1%         | 5.0%           | 23.8%         | 5.6%             |

"Save" means execution-phase cost saved ÷ **whole-session** cost (planning + execution). No session
was re-gated after Go.

**Execution-phase cost by token kind** (all 204): cacheRead 55.3%, cacheWrite 22.5%, output 22.2%,
input ≈0%.

**Context sizes** (tokens, p10 / p50 / p90):

| What                                       | p10    | p50     | p90     |
| ------------------------------------------ | ------ | ------- | ------- |
| Opener (system prompt + task + plan)       | 59,056 | 74,158  | 82,916  |
| Context at Go                              | 87,565 | 131,756 | 201,098 |
| Carried planning context (ctx@Go − opener) | 16,745 | 58,385  | 117,500 |
| Execution requests                         | 10     | 28      | 80      |

**Savings by execution length** (share of whole-session cost):

| Exec requests | n   | Share of all cost | Tier  | Reset  | Both  | In-pane |
| ------------- | --- | ----------------- | ----- | ------ | ----- | ------- |
| < 20          | 66  | 12.7%             | 11.7% | −13.7% | 7.7%  | −7.2%   |
| 20–49         | 84  | 34.8%             | 16.0% | 1.4%   | 22.0% | 4.3%    |
| 50–99         | 43  | 33.6%             | 16.7% | 11.4%  | 30.0% | 9.5%    |
| ≥ 100         | 11  | 18.9%             | 12.9% | 12.9%  | 26.9% | 9.8%    |

## Answers

**1. Phase split: execution is about two thirds of the bill.** It's 67% pooled and 61% at the
median. The planning phase, including research, plan-gate rework and its own context growth, is the
other third. So any execution-side lever acts on roughly 2/3 of the session's cost.

**2. Effort split (#3434): small, real, already shipped.** Against concurrent baseline sessions, the
switched cohort's execution turns emit about 10% less output (704 vs 783 tokens/request, median) and
cost about 6% less per request. On a session, that's in the low single digits of total cost. The
cohorts aren't randomized: `switched` sessions mostly come from drain with the global default, and
baseline sessions mostly from attended launches. Read this as direction, not effect size.

**3. R1 ceiling: about 24% of session cost, not 8×.** The "Both" scenario is an upper bound with no
added turns.

- **Tier alone is only ~15%, because cache reads cost the same.** Opus 5.5 and Sonnet 5.5 both price
  cache reads at 0.2 per Mtok (`src/pricing.ts`). Cache reads are 55% of execution cost, so a cheaper
  executor only halves the other 45% (output and cache writes). Cursor's 23× came from a much cheaper
  worker (Composer) against Opus 4.8's pricing, not Opus→Sonnet at today's rates.
- **Context reset alone is ~5%, and negative for short executions.** The fresh-agent opener is
  already about 74k tokens, mostly system prompt and project context. The carried planning context
  is only about 58k at the median, and re-reading it costs the cheap cache-read rate. A reset only
  pays for its cold opener write after about 20+ execution turns. Below that it **costs** money
  (−13.7% for the shortest third).
- **An in-pane `/model` switch (tier only, no respawn) shrinks to ~5.6%.** A model switch can't reuse
  the old model's prompt cache, so the context at Go is rebuilt once at Sonnet rates. Like the reset,
  it loses money on short executions (−7.2% below 20 turns).

## What this means for R1

- The realistic prize is **well under 24%**. Cursor's own finding is that a cheaper executor can burn
  several times the tokens, and a fresh agent re-discovers context the planner already had. Both eat
  into the upper bound.
- If R1 is built anyway, gate the respawn on **expected execution length**: the reset loses money on
  short plans. A plan-size or step-count threshold would be the obvious proxy.
- The biggest cost lever left is **context size, not model tier**. A ~74k-token opener on every turn
  of every session is larger than the carried planning context R1 would drop. That points back to
  lever #1 in [`../token-usage-analysis.md`](../token-usage-analysis.md) (trim the per-turn
  preamble), which a cheaper tier can't fix because cache reads cost the same on both models.
- **R1 prerequisite (accounting):** `snapshotSessionUsage` (`src/usage-snapshot.ts`) reads only the
  session's current `claudeSessionId` transcript. A respawned executor would silently drop the
  planning spend from `session_usage`, so any R1 A/B needs lineage-aware accounting first.

## Caveats

- These are upper bounds: tokens are held fixed, and a cheaper or fresh executor may need more
  turns.
- The cohorts are confounded by launch path and task mix. The window is two weeks and almost
  entirely Opus 5.5.
- Only each session's current transcript is read. Interrupted or replaced sessions lose their earlier
  transcripts (the same limit as the rest of `usage-report.ts`).
- The plan size is estimated as `chars/4` from the last `Write` of `.shepherd-plan.md`. Plans revised
  only via `Edit` keep the last full write's size (2 sessions had no write and count as 0).
- The cold-opener estimate assumes the measured 24k warm prefix (`WARM_PREFIX_TOKENS`). Sessions in
  the same repo may share more, which would make the reset slightly cheaper than modelled.
- Aggregates only: the script's per-session table stays local, because the sample spans other repos.

## Reproduce

```sh
bun run scripts/usage-report.ts --phase-split --md          # all sessions in the DB
bun run scripts/usage-report.ts --phase-split --recent 50   # newest 50 Claude task sessions
bun run scripts/usage-report.ts --phase-split TASK-5228     # explicit sessions
```
