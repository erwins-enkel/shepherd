# Spike: Graphify as a per-repo agent memory layer (issue #350)

**Verdict: PARK** (do not adopt now). Decided by the pre-registered rule: median token win **1.15×** across a realistic mixed question set vs a required **≥3×**. Re-visit conditions are listed at the end.

This was an evidence-gathering spike, not implementation. Method and thresholds were frozen _before_ building the graph (see `.shepherd-plan.md`) to kill selection bias.

## What was tested

- **Tool:** `graphifyy` 0.8.35 (CLI `graphify`), installed via `uv tool install graphifyy`. Installed clean on this box in ~2s; uv provisioned its own Python 3.13 venv, so the host's Python 3.14 was a non-issue (the pre-registered `--python 3.12` fallback was not needed).
- **Mode:** **AST-only** (no LLM, no API key), per the subscription-spawn / no-key constraint. Confirmed zero cost: `graph.json` reports `input_tokens: 0, output_tokens: 0`; no `cost.json` written.
- **Corpus:** this Shepherd worktree (root server + `ui/` + `extension/`).

## Build result (AST-only)

- **1186 code files → 6668 nodes, 13186 edges, ~5.7s wall, $0.** `node_modules`/`.git`/`__pycache__` are hard-skipped; `.gitignore` is honoured (no `.svelte-kit`/build pollution).
- Edge mix: `contains` 4688, `imports`/`imports_from` 5605, `calls` 1282, `re_exports` 761, `method` 452, `references` 278, inheritance ~110.
- **Edge confidence: 99.1% EXTRACTED, 0.9% INFERRED, 0 AMBIGUOUS.** In AST-only mode the fuzzy semantic edges essentially don't exist — good for trust, but it also means the graph is a structural (import/call) index, not a semantic one.
- Artifacts in `graphify-out/`: `graph.json` (5.5 MB), `manifest.json` (230 KB), `cache/`. (No `GRAPH_REPORT.md`/`graph.html` because `--no-cluster`; clustering's community-naming wants an LLM.)

> **Q3 gotcha:** `graphify extract` **hard-refuses AST-only on a mixed repo** — if _any_ doc/image file is present it exits demanding an API key. To get a zero-key build you must exclude non-code first (`--exclude '*.md' '*.yaml' '*.svg' …` or a `.graphifyignore`). "Code-only needs no key" is true only after you've made the corpus code-only.

## Q1 — measured token delta (the deciding evidence)

Ratio = baseline tokens (grep + the source an agent must read) ÷ graph-path tokens (the `graphify` payload, + the baseline fallback when the graph misses). Tokens ≈ chars/4, applied identically to both sides. Median is the pre-registered statistic (robust to the structural-navigation outliers).

| #    | Category      | Question                                                       | Baseline tok | Graph-path tok |     Ratio | Graph correct?                                                                                                      |
| ---- | ------------- | -------------------------------------------------------------- | -----------: | -------------: | --------: | ------------------------------------------------------------------------------------------------------------------- |
| Q-D1 | discovery     | callers + callees of `ReviewService`                           |        ~8768 |           ~770 | **11.4×** | ✓ (importers right, diluted by 22-node BFS noise)                                                                   |
| Q-D2 | discovery     | shortest path `AutoMergeService` ↔ drain loop                  |        ~1937 |            ~29 | **66.8×** | ✓ _with exact labels_ — but the naïve term `"drain"` returned a **confidently-wrong** 8-hop path through test files |
| Q-E1 | edit flow     | add a field to the build-queue type + thread through consumers |        ~6855 |          ~5552 | **~1.2×** | partial (locates the cluster; editing still needs the source)                                                       |
| Q-E2 | edit flow     | change dedupe-key namespacing on a failure toast               |        ~2270 |          ~2083 | **1.09×** | ✓ located; win erased by the edit read                                                                              |
| Q-H1 | graph-hostile | is an i18n key in both `en.json` + `de.json`?                  |          ~93 |           ~107 | **0.87×** | ✓ for one key only; can't answer the real "all keys in parity" (that's a set-diff = `check:i18n`)                   |
| Q-H2 | graph-hostile | trace a toast from store dispatch → Svelte render              |         ~455 |           ~541 | **0.84×** | ✗ miss **and** a confidently-wrong path (reactive `$store`→template is not an AST edge)                             |

- **Median 1.15× (mean 13.7×).** The mean is inflated by the two structural-navigation wins; the median — pre-registered precisely to resist them — reflects typical task-agent work and sits far below 3×.
- **Where graphify genuinely wins:** "map the structure" questions (who imports/calls X, is there a path A→B) — correct and 10–60× cheaper, _when given exact node labels_.
- **Where it doesn't:** edit flows (savings collapse to ~1.1× because you still read source to change it) and any non-AST relationship (i18n parity, Svelte reactive render, runtime/dynamic dispatch) — no win or net-negative.

## Q2 / Q6 — runtime & spawn fit

- **No MCP server** in the shipped CLI (0.8.35), despite README claims. Consumption is plain CLI subcommands (`query` / `path` / `explain`) or the Claude Code skill.
- The Claude Code skill is a **PreToolUse hook** that injects a nudge ("prefer `graphify query` over grep"). **Our locked-down spawns run `--settings disableAllHooks`, which disables that nudge.** So in the spawn model the agent gets no automatic steer — you'd need an explicit `Bash(graphify query:*)` in `--allowedTools` plus a house-rule nudge in the prompt. Left to its own devices the agent greps.
- **Fuzzy-label fragility:** `explain`/`path`/`query` resolve approximate terms to the nearest token and will silently return a confidently-wrong answer (homonym variable instead of the class; a test-file token instead of the drain loop). Correct, cheap answers require knowing exact node ids — which a cold agent must first discover, adding a round-trip.

## Q4 — hook coexistence

`graphify hook install` is **Husky-aware** (`hooks.py` respects `core.hooksPath`, installs into the parent `.husky/`) and **appends** to an existing hook rather than overwriting; it only touches `post-commit`/`post-checkout`, never our `commit-msg`/`pre-commit`/`pre-push`. **No clobber risk** (verified from source). The `graph.json` union **merge driver** is moot if `graphify-out/` is gitignored (no tracked `graph.json` to conflict), so it never interacts with the no-merge-commits branch-hygiene rule.

## Q5 — lifecycle

`graph.json` is 5.5 MB — **never commit it**; it would bloat every diff and churn constantly. If adopted it'd be gitignored and rebuilt per-worktree (`graphify extract` ~6s) or maintained by the post-commit hook (`graphify update`, AST-only, no LLM).

## Q7 — staleness & correctness

- **Staleness is real for the worktree model.** Demonstrated: after an uncommitted `pump`→`pumpRenamed` rename, the graph still reported the stale `.pump()` while grep showed the truth. The graph reflects the **last commit**; task agents edit continuously and commit ~once per task, so the graph is stalest for exactly the code under active edit. Mitigable with a pre-query `graphify update .` (AST-only, ~6s) but that must be wired and remembered.
- **Over-trust risk is low for INFERRED/AMBIGUOUS** (AST-only has ~none) but **high for fuzzy resolution** — the confidently-wrong paths above are the real failure mode, and they look authoritative.

## Recommendation — PARK

For Shepherd's AST-only, spawn-in-worktree model the measured benefit (median ~1.1×) does not justify the integration cost: the value is concentrated in structural-navigation queries (a minority of task-agent work), the auto-nudge is disabled by our `disableAllHooks` spawns, fuzzy resolution produces authoritative-looking wrong answers, and the graph is stale for in-flight edits. `ripgrep` already covers the common case cheaply and never lies.

**Re-visit if** any of these change:

1. We start running many **read-only, structural-comprehension** agents (architecture mapping, impact analysis) where 10–60× on "who-calls/what-path" questions compounds — there the win is real.
2. Graphify ships a **stable MCP server** with **exact-id** addressing (kills the fuzzy-resolver failure mode).
3. We're willing to spend on the **semantic pass** (the published 71–79× numbers are multi-modal and depend on it; AST-only on a mostly-TS repo does not reproduce them).

No follow-up implementation issue is filed (verdict is park). Evidence is reproducible from this note + `.shepherd-plan.md`.
