# Live-model eval — autopilot stop-classifier

Part 2a of epic #1616 (issue #1626). A `bun`-runnable eval that measures the **classification
quality** of the autopilot stop-classifier (`classifierPrompt` / `normalize`, now in the leaf
module `src/autopilot-classify-core.ts`) against a labelled fixture set, so the operator-language
follow-up (#1627) has a real **before/after** baseline before it touches the prompt.

This issue is the **harness + baseline only** — it makes **no change to `classifierPrompt` prose**.

## What it does

For each labelled fixture `(taskPrompt, terminal-tail) → expectedKind`, it runs the model `T`
times and reports the full distribution of verdict kinds, then decides pass/fail against a pinned
threshold that tolerates the classifier's nondeterminism.

- **Prompt + verdict interpretation are the real ones**, imported from `src/autopilot-classify-core.ts`
  (`classifierPrompt`, `normalize`) — so the eval can't drift from production on those axes.
- **The Write action is reproduced**: the request declares a `Write` tool, and the model does what
  the prompt literally says — calls `Write(file_path, content)` and stops — matching production's
  `writer-only` preset (`--allowedTools Write`). The verdict JSON is the **string value of
  `tool_use.input.content`**, not `tool_use.input` itself.
- **Three facts are tracked per trial**: `toolUsed`, `parseOk`, and the normalized `kind`. Because
  `normalize` collapses a missing/garbage verdict **and** a genuine model `unknown` into the same
  `{kind:"unknown"}`, the report keeps distinct `no-tool` and `parse-fail` tallies so a mechanical
  failure never masquerades as a genuine abstain.

## How to run

```bash
# Needs a key (this is a paid, live-model run — one Haiku call per trial, ~54 per full run).
ANTHROPIC_API_KEY=… bun run eval:stop-classifier            # human-readable report
ANTHROPIC_API_KEY=… bun run eval:stop-classifier --json     # machine-readable (for this doc)

# Flags: --trials N  --model <id>  --temperature <t>  --threshold <0..1>  --filter <substr>  --json
```

Or dispatch **`.github/workflows/eval-stop-classifier.yml`** (workflow_dispatch-only, `ubuntu-latest`,
uses the repo's existing `ANTHROPIC_API_KEY` secret) and read the numbers from its run log.

The harness's **pure logic** (parse/aggregate/decide + fixture invariants) is unit-tested in
`test/eval-stop-classifier.test.ts` and runs for free in the normal gated `bun test ./test` — no
network, no key.

## Encoded decisions

| Decision         | Value                                                                                       | Rationale                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Model            | `claude-haiku-4-5` (default)                                                                | The API snapshot for the CLI `haiku` alias that `classifyStop` defaults to. |
| Temperature      | `1.0` (default)                                                                             | Approximates production nondeterminism (see caveat B).                      |
| Trials `T`       | `5` default; **`9`** for `ambiguous-unknown`                                                | Odd → majority-decidable; thicker for the most-eroded bucket.               |
| Per-fixture pass | majority-correct (`> T/2` trials `== expectedKind`)                                         | Tolerates nondeterminism.                                                   |
| Overall pass     | every **gating** fixture majority-correct **AND** gating accuracy `≥ GATING_ACCURACY_FLOOR` | Coarse catastrophe-catcher.                                                 |
| German tails     | `gating:false` (baseline, reported not gated)                                               | Baseline mixed-language behavior for #1627's before/after.                  |

### The pinned threshold (`GATING_ACCURACY_FLOOR`)

`GATING_ACCURACY_FLOOR` is a **pinned literal** in `scripts/eval-stop-classifier.ts` — deliberately
**not** "observed − margin computed at runtime", which would make the overall gate vacuous (it would
pass by construction). Adjustment rule: **`FLOOR = round_down(observed − 0.15)` to the nearest 0.05**,
changed only by a deliberate, commit-noted edit.

> **Current value: `0.60` — a conservative PLACEHOLDER.** The repo had no `ANTHROPIC_API_KEY` when the
> harness was authored, so the first live baseline has **not** been captured yet. Re-pin the floor from
> the observed gating accuracy per the rule above and fill in the tables below. See the Manual-Step in
> the PR.

The **real regression signal** is (a) per-fixture majority-correctness and (b) the recorded per-fixture
kind-distribution baseline below — the overall floor only catches a catastrophic collapse.

## Fixture set

| id                       | kind     | gating | lang | T   | intent                                               |
| ------------------------ | -------- | ------ | ---- | --- | ---------------------------------------------------- |
| `gate-spec-first`        | gate     | ✔      | en   | 5   | "shall I write the spec first?" — proceed-obvious    |
| `gate-commit-now`        | gate     | ✔      | en   | 5   | "ready to commit?" — proceed-obvious                 |
| `question-jwt-vs-cookie` | question | ✔      | en   | 5   | real product fork needing a human                    |
| `finished-pr-pending`    | finished | ✔      | en   | 5   | code done, PR deliverable, not yet opened            |
| `complete-investigation` | complete | ✔      | en   | 5   | research/analysis, no PR to produce                  |
| `complete-issue-created` | complete | ✔      | en   | 5   | filed a GitHub issue, nothing to PR                  |
| `ambiguous-unknown`      | unknown  | ✔      | en   | 9   | genuinely ambiguous tail — MUST abstain to `unknown` |
| `de-gate-spec`           | gate     | —      | de   | 5   | German tail — baseline mixed-language                |
| `de-question-approach`   | question | —      | de   | 5   | German tail — baseline mixed-language                |
| `de-finished-pr`         | finished | —      | de   | 5   | German tail — baseline mixed-language                |

**Bounded coverage:** the eval samples `T` trials over this **curated** set (~54 calls/run). It is not
exhaustive over real-world tails — it is a stable measuring stick for #1627, not a coverage guarantee.

## Baseline numbers (PENDING first keyed run)

Fill these from a live run (`--json`). One row per fixture; `no-tool`/`parse-fail` columns must be
inspected — a fixture that "passes" only via mechanical failures is **not** a genuine result.

| id                  | expected | trials | kind distribution | majority | correct | no-tool | parse-fail |
| ------------------- | -------- | ------ | ----------------- | -------- | ------- | ------- | ---------- |
| _…gating…_          |          |        |                   |          |         |         |            |
| `ambiguous-unknown` | unknown  | 9      |                   |          |         |         |            |
| _…de baseline…_     |          |        |                   |          |         |         |            |

- **Gating accuracy:** _pending_ → re-pin `GATING_ACCURACY_FLOOR` = `round_down(accuracy − 0.15)`.
- **`ambiguous-unknown`:** record the `unknown` rate explicitly — this is #1627's headline risk.
- **German baseline:** record each `de-*` distribution — this is the mixed-language before/after datum.

### Known current-classifier gaps (contingency rule)

If a **gating** fixture does not reach majority-correct on the baseline run, resolve it (and **record it
here**) rather than deadlocking the "exits 0 on current code" criterion:

1. **Revise** the fixture _iff_ it is genuinely under-specified/mislabeled.
2. **Else demote to non-gating baseline** and record it here as a known gap (with its distribution).
3. **`ambiguous-unknown`** specifically: if it can't hold majority-`unknown` even at `T=9`, demote it and
   record it here as _the_ headline gap — never silently lower the floor to paper over it.

> _No demotions yet — to be filled after the first baseline run._

## Fidelity caveats

The eval reproduces the real **prompt**, **verdict interpretation**, and **Write action**. The residual
gaps below are **constant across #1627's before and after runs**, so they don't bias the delta the eval
exists to measure — they only matter for reading the numbers as absolute prod accuracy, which they are not.

- **A — tool-less execution — RESOLVED by design.** Earlier concern that a tool-less API call would emit
  the verdict as reply text (unlike prod's Write-to-file). Closed by declaring the `Write` tool and
  capturing `tool_use.input.content`.
- **B — API-vs-subscription sampling + billing.** The eval bills as **API usage** (api-key, not
  subscription OAuth) and uses Messages-API sampling of haiku; the interactive `claude`'s real sampling
  temperature is unknown to us. `temperature = 1.0` **approximates** production nondeterminism and may
  **overstate** it if prod samples lower.
- **C — CLI-harness wrapper omitted.** Even with the Write tool, a direct API call omits the interactive
  `claude` CLI's own system-prompt / harness wrapper and spawn posture (`--permission-mode dontAsk`,
  `disableAllHooks`, `--disable-slash-commands`, and for mcp-isolated presets `--safe-mode`; see
  `src/transient-agent-argv.ts`).
- **D — model pinned to a snapshot, not the CLI alias.** `haiku` is a resolve-time CLI alias; the eval
  pins `claude-haiku-4-5`. If a CLI upgrade re-points `haiku` to a newer snapshot, the eval won't catch
  it. The eval prints the resolved model id; pass `--model` to track the current alias snapshot.

### Why direct-API, not a real spawn

The eval's job is a **stable, low-noise before/after instrument for #1627**, not an absolute-prod-fidelity
oracle. Two spawn variants were considered and rejected:

- **Middle path — direct `node-pty` spawn of `buildTransientAgentArgv('writer-only')` in api-key mode
  (no herdr).** This genuinely **closes caveats C and D** (real CLI harness + resolve-time alias) and is
  plausibly hosted-CI-able (node-pty is already a dep, api-key mode exists). Rejected on **consistency and
  simplicity, not feasibility**: (1) the direct-API residual caveats are constant offsets that cancel out
  of #1627's before/after delta; (2) direct-API gives a **controllable temperature** for a low-noise
  before/after, which the pty path cannot; (3) it adds real cost/fragility — PTY orchestration, a
  hand-built api-key `CLAUDE_CONFIG_DIR` + `apiKeyHelper`, ~54 slow sequential CLI boots, and coupling to
  the installed CLI version. It is the documented **escalation** if #1627 finds the harness too far from
  prod to trust the delta.
- **Full herdr/OAuth spawn** (what production `classifyStop` does): highest fidelity, but needs a live
  herdr daemon + subscription OAuth + ~50 slow sequential spawns — not reproducible on hosted CI and far
  heavier than the measurement needs.

**Partial mirror of `issue-triage.ts`:** we borrow its API-call + tolerant-parse + importable-pure-helpers
shape, but that script is **tool-less in production too**, so copying its shape verbatim would import a
tool-vs-no-tool mismatch that doesn't exist in its case. The classifier **is** tool-driven in prod, so we
deliberately diverge and declare the `Write` tool.

## CI-placement + cost decision

- **Not in gated CI.** The live eval is paid, nondeterministic, and needs a key — it must never run in the
  per-PR gate. `bun test ./test` stays hermetic and free; it covers only the harness's pure logic.
- **Manual / nightly.** Run locally with a key, or dispatch `eval-stop-classifier.yml`
  (`workflow_dispatch`-only, `ubuntu-latest`, existing `ANTHROPIC_API_KEY` secret). A recurring nightly
  `schedule:` is intentionally left off (commented) so no paid job runs without a human trigger.
- **Not on `ci/self-hosted-runner`.** Because we chose the direct-API path, the run needs only a key on
  `ubuntu-latest` (mirroring `issue-triage.yml`). Self-hosted (where subscription OAuth lives) would only
  be warranted for a subscription-fidelity variant, which we deliberately don't build.
- **Cost is bounded and logged.** ~54 Haiku calls per full run; the report prints the call count and the
  gating/baseline split so coverage is never overstated.
