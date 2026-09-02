# Live-model eval — autopilot stop-classifier

> Since **#2156** this eval runs on the shared harness in `scripts/eval-core.ts`, alongside three
> more prompt evals (plan-gate reviewer, PR critic, rundown). The harness, the PR gate and the
> incident→fixture procedure are documented in **[`eval-harness.md`](./eval-harness.md)**; this page
> keeps the classifier's own methodology, baseline numbers and #1627 A/B history. Its behaviour is
> unchanged by the refactor: one `Write` tool, single-turn, first write wins.

Part 2a of epic #1616 (issue #1626). A `bun`-runnable eval that measures the **classification
quality** of the autopilot stop-classifier (`classifierPrompt` / `normalize`, now in the leaf
module `src/autopilot-classify-core.ts`) against a labelled fixture set, so the operator-language
follow-up (#1627) has a real **before/after** baseline before it touches the prompt.

Issue #1626 was the **harness + baseline only** — it made **no change to `classifierPrompt` prose**.
Issue **#1627** (this follow-up) is the first change to touch the prompt: it adds an
`operatorLanguage` parameter to `classifierPrompt` (German `summary` + input-robustness line, with
`kind` pinned to the exact English enum) and turns the German fixtures into the load-bearing gate for
that change. See **[Operator-language A/B (#1627)](#operator-language-ab-1627)** below.

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
#        --operator-language-off   (#1627 A/B: force operator-language OFF for every fixture — the
#                                   *before* leg ≡ #1626 baseline; omit it for the *after* leg)
```

The two A/B legs (#1627) — run on the same branch/commit for a clean before/after:

```bash
ANTHROPIC_API_KEY=… bun run eval:stop-classifier --trials 9 --operator-language-off --json   # before
ANTHROPIC_API_KEY=… bun run eval:stop-classifier --trials 9 --json                            # after
```

Or dispatch **`.github/workflows/eval-stop-classifier.yml`** (`ubuntu-latest`, uses the repo's
existing `ANTHROPIC_API_KEY` secret) and read the numbers from its run log. That workflow also runs
**nightly** at 06:00 UTC since #2156 — see [CI-placement](#ci-placement--cost-decision) below. It takes
an `operator_language_off` input (`"true"`/`"false"`, default `"false"`) that maps to the
`--operator-language-off` flag, so both A/B legs are reproducible from CI. **Note:** because
`workflow_dispatch` inputs are validated against the workflow file on the **default branch**, the
`operator_language_off` input only becomes dispatchable once this PR merges; before merge, capture the
_after_ leg by dispatch (default inputs) and use the recorded #1626 German baseline as the _before_,
or run both legs locally with a key.

The harness's **pure logic** (parse/aggregate/decide + fixture invariants) is unit-tested in
`test/eval-stop-classifier.test.ts` and `test/eval-core.test.ts`, and runs for free in the normal
gated `bun test ./test` — no network, no key.

## Encoded decisions

| Decision         | Value                                                                                           | Rationale                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Model            | `claude-haiku-4-5` (default)                                                                    | The API snapshot for the CLI `haiku` alias that `classifyStop` defaults to. |
| Temperature      | `1.0` (default)                                                                                 | Approximates production nondeterminism (see caveat B).                      |
| Trials `T`       | `5` default; **`9`** for `ambiguous-unknown`                                                    | Odd → majority-decidable; thicker for the most-eroded bucket.               |
| Per-fixture pass | majority-correct (`> T/2` trials `== expectedKind`)                                             | Tolerates nondeterminism.                                                   |
| Overall pass     | every **gating** fixture majority-correct **AND** gating accuracy `≥ GATING_ACCURACY_FLOOR`     | Coarse catastrophe-catcher.                                                 |
| German tails     | **#1627:** gate/question/unknown buckets `gating:true` at `T=9`; spec-first + finished baseline | The de directive is load-bearing, so its buckets gate; see A/B section.     |

### The pinned threshold (`GATING_ACCURACY_FLOOR`)

`GATING_ACCURACY_FLOOR` is a **pinned literal** in `scripts/eval-stop-classifier.ts` — deliberately
**not** "observed − margin computed at runtime", which would make the overall gate vacuous (it would
pass by construction). Adjustment rule: **`FLOOR = round_down(observed − 0.15)` to the nearest 0.05**,
changed only by a deliberate, commit-noted edit.

> **Current value: `0.80`**, pinned from the first live baseline (below): after demoting
> `gate-spec-first` per the contingency rule, gating accuracy was `33/34 = 0.971` →
> `round_down(0.971 − 0.15)` to the nearest 0.05 = **0.80**.

The **real regression signal** is (a) per-fixture majority-correctness and (b) the recorded per-fixture
kind-distribution baseline below — the overall floor only catches a catastrophic collapse.

## Fixture set

| id                       | kind     | gating | lang | T   | intent                                                            |
| ------------------------ | -------- | ------ | ---- | --- | ----------------------------------------------------------------- |
| `gate-commit-now`        | gate     | ✔      | en   | 5   | "ready to commit?" — proceed-obvious                              |
| `question-jwt-vs-cookie` | question | ✔      | en   | 5   | real product fork needing a human                                 |
| `finished-pr-pending`    | finished | ✔      | en   | 5   | code done, PR deliverable, not yet opened                         |
| `complete-investigation` | complete | ✔      | en   | 5   | research/analysis, no PR to produce                               |
| `complete-issue-created` | complete | ✔      | en   | 5   | filed a GitHub issue, nothing to PR                               |
| `ambiguous-unknown`      | unknown  | ✔      | en   | 9   | genuinely ambiguous tail — MUST abstain to `unknown`              |
| `gate-spec-first`        | gate     | —      | en   | 5   | prompt's own gate exemplar — **known gap** (leans question)       |
| `de-gate-commit`         | gate     | ✔      | de   | 9   | **#1627** German proceed-obvious gate (twin of `gate-commit-now`) |
| `de-question-approach`   | question | ✔      | de   | 9   | **#1627** German product fork — promoted from baseline            |
| `de-ambiguous-unknown`   | unknown  | ✔      | de   | 9   | **#1627** abstain bucket under German input — headline datum      |
| `de-gate-spec`           | gate     | —      | de   | 5   | German twin of the known-gap spec-first — baseline only           |
| `de-finished-pr`         | finished | —      | de   | 5   | German tail — baseline before/after datum                         |

`gate-spec-first` started gating and was demoted to baseline per the contingency rule after the first
run (see **Known gaps** below).

**Bounded coverage:** the eval samples `T` trials over this **curated** set (~54 calls/run). It is not
exhaustive over real-world tails — it is a stable measuring stick for #1627, not a coverage guarantee.

## Baseline numbers

**First run** — `claude-haiku-4-5`, temperature `1.0`, `bun run eval:stop-classifier --json` (2026-07-11;
throwaway key). No mechanical failures anywhere (`no-tool` / `parse-fail` all 0), so every `unknown` below
is a genuine verdict, not a masked miss. `gate-spec-first` is shown at the bottom (demoted — see Known gaps).

| id                       | seg      | expected | T   | kind distribution | majority | correct |
| ------------------------ | -------- | -------- | --- | ----------------- | -------- | ------- |
| `gate-commit-now`        | gating   | gate     | 5   | gate:4 finished:1 | gate     | 4/5     |
| `question-jwt-vs-cookie` | gating   | question | 5   | question:5        | question | 5/5     |
| `finished-pr-pending`    | gating   | finished | 5   | finished:5        | finished | 5/5     |
| `complete-investigation` | gating   | complete | 5   | complete:5        | complete | 5/5     |
| `complete-issue-created` | gating   | complete | 5   | complete:5        | complete | 5/5     |
| `ambiguous-unknown`      | gating   | unknown  | 9   | **unknown:9**     | unknown  | **9/9** |
| `de-gate-spec`           | baseline | gate     | 5   | gate:4 question:1 | gate     | 4/5     |
| `de-question-approach`   | baseline | question | 5   | question:5        | question | 5/5     |
| `de-finished-pr`         | baseline | finished | 5   | finished:5        | finished | 5/5     |
| `gate-spec-first`        | baseline | gate     | 5   | question:3 gate:2 | question | 2/5     |

- **Gating accuracy (after demotion): `33/34 = 97.1%`** → `GATING_ACCURACY_FLOOR` pinned at **0.80**
  (`round_down(0.971 − 0.15)`). `RESULT: PASS`.
- **`ambiguous-unknown`: 9/9 `unknown`** — the conservative abstain bucket #1627 most risks eroding is
  currently rock-solid. This is the headline before/after datum: #1627 must not regress it.
- **German baseline is strong today:** `de-question` 5/5 and `de-finished` 5/5, `de-gate` 4/5 (one
  `question`) — mirroring the English `gate` softness rather than a German-specific failure. #1627's
  output-language / robustness change has a real before/after here.

### Known current-classifier gaps (contingency rule)

- **`gate-spec-first` — DEMOTED to non-gating baseline (first run).** Distribution `question:3 gate:2`
  (2/5 correct). This is the classifier prompt's **own canonical `gate` exemplar** ("shall I write the
  spec first?"), yet haiku leans `question` — it reads spec-first-vs-dive-in as a methodology fork. The
  fixture is faithful to the exemplar (not under-specified), so it was **demoted, not revised** — silently
  rewording it to force `gate` would just game the prompt's own example. It stays in the set (run +
  reported) as a **known gap** and a prime before/after datum for #1627: watch whether the operator-language
  / robustness change nudges this toward `gate` (fix) or further toward `question` (regression).

- **`de-ambiguous-unknown` — DEMOTED to non-gating baseline (#2156).** #1627 gated this as the
  headline German abstain datum and it held then (and at 9/9 on the #1626-era capture). Two runs on
  2026-09-02 recorded `unknown` **7/9** and then **4/9** (`gate:5 unknown:4` — majority lost). That
  satisfies this document's own noise band in the bad direction: a ≥2-trial move that crosses the
  majority boundary AND survives a confirmation run. Its English twin `ambiguous-unknown` scored
  **9/9 on both runs**, so this is a real language-specific erosion of the abstain bucket — exactly
  what #1627's input-robustness line exists to prevent — and not a mislabelled fixture. Per the
  contingency rule it was demoted and recorded, not revised, and the floor was NOT lowered. The
  fixture keeps running at `T=9` as the before/after datum for whoever closes the gap. Tracked in
  **#2169**.

> The contingency rule (applied above): (1) revise a fixture only if genuinely under-specified/mislabeled;
> (2) else demote to non-gating baseline + record here; (3) never silently lower the floor to paper over a
> gap. `ambiguous-unknown` held majority at `T=9`, so no demotion was needed there.

## Operator-language A/B (#1627)

#1627 makes `classifierPrompt` operator-language-aware: for `operatorLanguage === "de"` it splices in
two lines — render `summary` in German, and an **input-robustness** line so a German/mixed tail
doesn't erode the `unknown` abstain bucket — while **pinning `kind` to the exact English enum** (a
translated kind silently collapses to `unknown` via `normalize`'s `KINDS.includes`). The `"en"` path
is **byte-identical** to the #1626 prompt (unit-tested).

**The de path gates — it is not observational-only.** Three German fixtures are `gating:true` at
`T=9`, one per abstain-critical bucket: `de-gate-commit` (new), `de-question-approach` (promoted),
and `de-ambiguous-unknown` (new — the headline abstain-bucket datum). `de-gate-spec` (German twin of
the known-gap spec-first exemplar) and `de-finished-pr` stay baseline.

**A/B mechanism.** `--operator-language-off` forces `operatorLanguage="en"` for every fixture (the
_before_ leg — byte-identical to #1626); omitting it runs the _after_ leg with the German directive
live for `de` fixtures. English fixtures are `"en"` either way, so the English gating set is unchanged
across legs (its `ambiguous-unknown` 9/9 abstain is preserved **by construction** — the prompt it
sees is byte-identical).

- **Before (German fixtures, operator-language OFF)** — the #1626 baseline already recorded it:
  `de-gate` 4/5, `de-question` 5/5, `de-finished` 5/5 (English prompt against a German tail). Re-run
  it exactly with `--operator-language-off`.
- **After (German directive live)** — captured under **[#2169](#german-abstain-bucket-rewrite-2169)**,
  which also rewrote the directive being measured. Every German gating fixture is majority-correct at
  `T=9` and gating accuracy is `27/27 = 100%` across two runs. The run is paid, keyed and
  nondeterministic, so it stays scheduled/dispatched rather than a per-PR correctness gate — but
  since #2156 a prompt change like this one does trip the per-PR fingerprint gate, which runs the
  eval in smoke mode (see [`eval-harness.md`](./eval-harness.md)).

### Noise band (react to signal, not model noise)

At `temperature = 1.0` a single-run `T=5` majority can flip on one trial of sampling noise. So the
German gating fixtures run at **`T=9`**, and a shift between legs counts as **signal** only when it
**crosses the majority boundary** OR moves by **≥2 trials**, AND survives a **confirmation re-run**. A
lone ±1-trial wobble is noise — never reword the directive in response to it.

> **#2169 amendment — this band is too narrow for `T=9`.** `de-ambiguous-unknown` produced `9, 7, 4,
6, 8, 8` out of 9 on the _same_ prompt, so a "≥2-trial move surviving a confirmation run" is
> reachable by sampling alone: the #2169 criterion was met in the bad direction by a fixture whose
> pooled rate turned out to be ordinary. Treat a single `T=9` run as a coarse filter only. To
> compare two prompt variants, **pool ≥27 trials per condition** (a fixture's pinned `trials`
> overrides `--trials`, so pool repeated runs rather than raising the flag) and measure both
> conditions in the same session — model-side drift between sessions is not controlled for.

### Verification split — what the eval does and does NOT cover

- **Input-robustness / abstain half — behaviorally gated.** The eval scores `kind`, and the German
  gating fixtures exercise it end-to-end against the live model. A regression here fails the gate.
- **German-`summary` output half — NOT behaviorally verified.** The eval scores `kind` only; it never
  inspects `summary` language, and the unit tests assert the prompt _contains_ the German-summary
  instruction, not that the model _obeys_ it. "Summary renders in German" rests on prompt content +
  the shipped recap precedent (recap already ships the same directive shape for its `body`/`headline`),
  **not** on measurement. **Do not read an eval PASS as evidence the summary output is correct.**

### Contingency for a German non-hold

If the after-run shows a promoted German fixture below majority (past the noise band), treat it as a
**finding**, not a reason to silently un-gate: (1) iterate the directive wording and re-run; (2) demote
to baseline **only** with an explicit justification recorded as a known gap — exactly the treatment
`gate-spec-first` received. Re-pin `GATING_ACCURACY_FLOOR` only if the adjustment rule
(`round_down(observed − 0.15)` to 0.05) requires, with a commit note.

## German abstain-bucket rewrite (#2169)

`de-ambiguous-unknown` lost its `unknown` majority (`unknown:9` → `gate:2 unknown:7` →
`gate:5 unknown:4`) while its English twin held 9/9, and was filed as #2169. All numbers below are
`claude-haiku-4-5`, temperature `1.0`, 2026-09-02, with **zero** `no-tool` / `parse-fail` anywhere —
every `unknown` is a genuine verdict, never a masked mechanical miss.

### The prompt had already drifted under the baseline

The 9/9 datum was measured **before** commit `561e577c` (#2002), which hoisted
`UNTRUSTED_CONTENT_DIRECTIVE` out of `fenceUntrusted`: the tail fence went from carrying ~250 chars
of in-band prose to label + nonce only. That is the **only** edit to `classifierPrompt` between the
#1626/#1627 baseline and the eroded runs, and it lands directly on Anchor A — the splice point of
the German input-robustness line. So "the classifier prompt was not touched" is true of #2156's
harness work, but **not** of the interval between the two measurements. English lost the same prose
and did not collapse, so this is context for reading the baseline, not the cause.

### Diagnostic: was the German directive the cure or the cause?

`--filter ambiguous --trials 9`, both A/B legs, on the unmodified prompt:

| leg                             | `ambiguous-unknown` (en) | `de-ambiguous-unknown`   |
| ------------------------------- | ------------------------ | ------------------------ |
| OFF (`--operator-language-off`) | `unknown:9` — 9/9        | `unknown:8 gate:1` — 8/9 |
| ON (German directive live)      | `unknown:9` — 9/9        | `unknown:6 gate:3` — 6/9 |

Pooled to 27 trials per condition (3 × `T=9`, because a fixture's pinned `trials` overrides
`--trials` — the flag cannot thicken these fixtures):

| condition                              | `de-ambiguous-unknown` | runs      |
| -------------------------------------- | ---------------------- | --------- |
| OFF — no German lines at all           | **24/27** (89%)        | 8 / 7 / 9 |
| V0 — the directive as #1627 shipped it | **22/27** (81%)        | 6 / 8 / 8 |
| `ambiguous-unknown` (en), same session | 25/27 (93%)            | 9 / 9 / 7 |

**Two conclusions, and the second corrects the issue's premise.**

1. The directive as written was doing nothing useful — 22/27 with it, 24/27 without it. A line added
   to _protect_ the abstain bucket did not measurably protect it.
2. **The English twin is not rock-solid either.** It posted `gate:1 question:1 unknown:7` in the same
   session — its first sub-9/9 result on record. Pooled today, `en` 25/27 vs `de` 22/27 is well
   inside noise. The fixture's `9 → 7 → 4` history is the tail of a wide distribution, not a clean
   language-specific signal, and the `4/9` that triggered the issue was its extreme.

### What changed and why

The directive's original closing clause — _"never upgrade an uncertain read to a confident `gate` or
`question` just to avoid abstaining"_ — is an abstract instruction about the model's own confidence,
and it names `gate` twice inside a negation. It was replaced with a **positive, checkable test**
applied to the tail itself: `gate` and `question` both presuppose that the agent RAISED something, so
a tail that only narrates progress can be neither.

The closing clause (_"if such a tail also does not clearly report finished or delivered work"_) is
load-bearing. Without it the rule collapses to "raises no question → `unknown`", which would swallow
the legitimately question-free `finished` and `complete` tails — `de-finished-pr` asks nothing either.
That would trade the `finished` bucket for the `unknown` one: the same erosion, inverted.
`test/autopilot-llm.test.ts` pins the clause so it cannot be silently shortened.

### Results

Screen on `de-ambiguous-unknown`, 3 × `T=9`: **27/27** (9 / 9 / 9). Since nothing can beat a perfect
screen, the remaining candidates (anchor-move-only, and removing the line entirely) were not run.

Validation — the full German set, twice, `--filter de- --trials 5`:

| id                     | seg      | expected | T   | run A              | run B                     |
| ---------------------- | -------- | -------- | --- | ------------------ | ------------------------- |
| `de-gate-commit`       | gating   | gate     | 9   | `gate:9` — 9/9     | `gate:9` — 9/9            |
| `de-question-approach` | gating   | question | 9   | `question:9` — 9/9 | `question:9` — 9/9        |
| `de-ambiguous-unknown` | gating   | unknown  | 9   | `unknown:9` — 9/9  | `unknown:9` — 9/9         |
| `de-gate-spec`         | baseline | gate     | 5   | `gate:5` — 5/5     | `gate:2 question:3` — 2/5 |
| `de-finished-pr`       | baseline | finished | 5   | `finished:5` — 5/5 | `finished:5` — 5/5        |

- **Gating accuracy `27/27 = 100%` in both runs; `RESULT: PASS`.** `GATING_ACCURACY_FLOOR` is
  unchanged at `0.80` — the adjustment rule (`round_down(observed − 0.15)` to 0.05) would allow
  `0.85`, but one fixture set measured twice is a thin basis for tightening a catastrophe-catcher,
  and raising it buys nothing this PR needs.
- **`de-ambiguous-unknown`: 45/45 `unknown`** across screen + both validation runs, against 22/27
  for the shipped directive. This is the datum the issue asked for.
- **No bucket trading.** `de-finished-pr` held `finished:5` in both runs — the specific risk the
  scoping clause exists to prevent did not materialize.
- **`de-gate-spec` is unchanged, not regressed.** Four runs under the new wording: 5/5, 2/5, 4/5,
  2/5 = **13/20**, straddling its own 4/5 baseline and the 2/5 its English twin `gate-spec-first`
  posts. It remains the recorded known gap, still non-gating, and no claim is made that this change
  moved it either way.

### Deliberate limits of this change

- **The rule is not German-specific, but ships only on the `de` path.** "A tail that raises nothing
  is not a `gate`" would arguably help English too. It is not applied there: the `en` prompt must
  stay byte-identical so the English gating baseline survives by construction, and the English twin
  is at 25/27 with nothing to fix. The `de` and `en` prompts are therefore now semantically
  divergent, not merely translated — recorded here deliberately.
- **`en` byte-identity is verified, not assumed.** The shipped prompt was diffed against its
  pre-change form at `HEAD` for both the default and explicit `"en"` calls (nonce normalized);
  both identical. `test/autopilot-llm.test.ts` pins it going forward.
- **Only `kind` is measured.** As elsewhere in this doc, nothing here verifies that `summary`
  actually renders in German.

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

- **Not in the hermetic gate.** `bun test ./test` stays hermetic and free; it covers only the harness's
  pure logic.
- **Nightly (#2156).** `eval-stop-classifier.yml` now carries a `schedule:` at 06:00 UTC, plus its
  `workflow_dispatch` inputs for reproducing a specific leg (notably the #1627 A/B). At ~54 Haiku calls
  a run this costs pennies, and it turns the eval from an instrument someone has to remember to use
  into standing drift detection.
- **Per-PR, fingerprint-triggered (#2156).** `eval-prompts.yml` runs the classifier's GATING fixtures on
  any PR whose rendered classifier prompt changes — decided by the committed fingerprint in
  `scripts/eval-fingerprints.json`, not by changed paths. An unrelated edit to
  `src/autopilot-classify-core.ts` costs nothing; a prompt edit cannot dodge the gate without also
  failing `check:eval-fingerprints`. See [`eval-harness.md`](./eval-harness.md).
- **Not on `ci/self-hosted-runner`.** Because we chose the direct-API path, the run needs only a key on
  `ubuntu-latest` (mirroring `issue-triage.yml`). Self-hosted (where subscription OAuth lives) would only
  be warranted for a subscription-fidelity variant, which we deliberately don't build.
- **Cost is bounded and logged.** ~54 Haiku calls per full run; the report prints the call count and the
  gating/baseline split so coverage is never overstated.
