# Prompt eval harness

Live-model evals for Shepherd's four high-leverage prompts — labelled fixtures, multi-trial,
thresholded. Issue **#2156**, generalizing the stop-classifier eval (#1626/#1627) from one prompt to
four and putting a gate on the PRs that change them.

The classifier's own history, baseline and A/B methodology stay in
**[`eval-stop-classifier.md`](./eval-stop-classifier.md)**; this document covers the shared harness
and the three sets added by #2156.

| Eval              | Prompt builder                                       | Model              | Fixtures | Verdict file                 |
| ----------------- | ---------------------------------------------------- | ------------------ | -------- | ---------------------------- |
| `stop-classifier` | `autopilot-classify-core.ts` → `classifierPrompt`    | `claude-haiku-4-5` | 12       | first `Write` wins           |
| `plan-gate`       | `plan-gate.ts` → `planReviewPrompt`                  | `claude-sonnet-5`  | 12       | `.shepherd-plan-review.json` |
| `critic`          | `critic-core.ts` → `reviewPrompt` / `prReviewPrompt` | `claude-sonnet-5`  | 12       | `.shepherd-review.json`      |
| `rundown`         | `rundown-core.ts` → `buildRundownPrompt`             | `claude-sonnet-5`  | 10       | `.shepherd-rundown.json`     |

Each eval pins the model its prompt actually runs on in production: haiku for the classifier
(`classifyStop`'s default), sonnet for the rundown (`HerdDigestService`'s `RoleEnvironment`
default), sonnet standing in for the operator's role model on plan-gate and critic
(`reviewerModel` / `criticModel`, both "default" ⇒ the operator default).

## How to run

```bash
# Paid, live-model runs. Needs a key.
ANTHROPIC_API_KEY=… bun run eval:plan-gate
ANTHROPIC_API_KEY=… bun run eval:critic --json
ANTHROPIC_API_KEY=… bun run eval:rundown --gating-only

# Flags (all four evals): --trials N  --model <id>  --temperature <t>  --threshold <0..1>
#                         --filter <id-substring>  --gating-only  --json
```

Or dispatch **`.github/workflows/eval-prompts.yml`** (`evals`, `trials`, `gating_only` inputs).

The harness's pure logic — the tool loop, the scorers, aggregation, the fixture invariants and the
fingerprints — is unit-tested in `test/eval-core.test.ts` and runs for free in the normal gated
`bun test ./test`: **no network, no key**.

## The shared harness

`scripts/eval-core.ts` runs every eval. Three things generalize out of the original
stop-classifier script:

**Verdicts are labels plus predicates.** The classifier scored an enum. The other three do not have
one, so correctness is a per-fixture PREDICATE SET (`correct` = every predicate holds) and the
`label` exists only for the report's distribution. The classifier's single
`kind === expectedKind` predicate is the degenerate case, so its behaviour is unchanged.

**The loop answers tool calls from a fixture environment.** The critic prompt tells the reviewer the
branch is checked out and orders `git diff <base>...HEAD` plus tree greps; the plan-gate reviewer
MAY inspect the codebase. So the harness declares `Bash`/`Read`/`Grep` next to `Write` and answers
each call from the fixture's own `{ diff, files }` map (`scripts/eval-fixtures/env.ts`). Two
consequences, both deliberate: the production prompt is imported **unchanged** — nothing is
rewritten to inline the diff — and **no model-authored shell is ever executed**, which matters
because fixture content is untrusted by construction. A path the map lacks answers "does not
exist", exactly as a real tree would.

**Termination is per-eval.** `EvalSpec.verdictFile` names the file whose `Write` ends a trial; any
other write is acknowledged with a `tool_result` and the loop continues. This is not a detail: the
critic's contract is **two** writes — `scopeAndOutputTail` orders `.shepherd-review.md` FIRST and
`.shepherd-review.json` LAST, "the JSON file is the completion signal" — so a loop that stopped at
the first `Write` would capture prose and score every critic fixture as a parse failure. The
classifier leaves `verdictFile` unset (first write wins), matching its single-write contract.

Three facts are tracked per trial — `toolUsed`, `parseOk` and the scored label — so a mechanical
failure (no verdict written, unparseable content, turn budget exhausted) never masquerades as a
genuine wrong verdict.

### Pass/fail

Per fixture: **majority-correct** (`> T/2` trials correct). Overall: every **gating** fixture
majority-correct **AND** gating trial-accuracy `≥` the eval's pinned floor. Non-gating (baseline)
fixtures are run and reported but never gate.

Each floor is a **pinned literal** in its eval script — deliberately not "observed − margin computed
at runtime", which would make the gate vacuous. Adjustment rule, shared with the classifier:
**`FLOOR = round_down(observed − 0.15)` to the nearest 0.05**, changed only by a deliberate,
commit-noted edit. The floor is a coarse catastrophe-catcher; the real regression signal is
per-fixture majority-correctness against the recorded distributions below.

**Contingency rule** (unchanged from the classifier): (1) revise a fixture only if it is genuinely
under-specified or mislabelled; (2) otherwise demote it to non-gating baseline and record it as a
known gap; (3) never silently lower a floor to paper over a gap.

## Fixture sets

### plan-gate (`scripts/eval-fixtures/plan-gate.ts`)

What this set measures is **FINDINGS ROUTING** (#1948) and **LOCATION REFERENCES** — the blocks that
exist because the reviewer used to manufacture blocking findings out of wording preferences, scope
demands and stale line numbers, burning whole rework budgets. Half the set is plans that must be
**approved**; the other half are genuine defects it must still block. Every fixture also carries the
prompt's own hard contract: `approve` requires an empty `findings`, `request-changes` at least one.

| id                              | expects         | gating | intent                                              |
| ------------------------------- | --------------- | ------ | --------------------------------------------------- |
| `approve-sound-plan`            | approve         | ✔      | plain sound plan — the baseline approve             |
| `approve-narrower-than-ideal`   | approve         | ✔      | SCOPE DEMANDS: narrower than ideal, still satisfies |
| `approve-terse-decision`        | approve         | ✔      | PROSE: decision stated, not argued at length        |
| `approve-cites-line-numbers`    | approve         | ✔      | line numbers carry no authority                     |
| `approve-proposes-new-symbols`  | approve         | ✔      | symbols the plan will CREATE are never findings     |
| `approve-de-idiomatic`          | approve         | ✔      | German prose, `decision` stays the English enum     |
| `rc-missing-out-of-scope`       | request-changes | ✔      | genuinely absent boundary + seams                   |
| `rc-false-assumption`           | request-changes | ✔      | assumption false against the tree (checkable)       |
| `rc-does-not-satisfy-task`      | request-changes | ✔      | solves a neighbouring problem                       |
| `rc-unmitigated-data-loss`      | request-changes | ✔      | destructive migration, no mitigation                |
| `rc-no-testing-seams`           | request-changes | ✔      | "add tests" with nothing named                      |
| `rc-re-review-drops-suggestion` | request-changes | —      | re-raise the blocker, drop the prior nit (compound) |

### critic (`scripts/eval-fixtures/critic.ts`)

Balanced on purpose: half carry a planted defect the critic must catch and cite by file (a miss
ships a bug); half are clean or merely nitty, where the failure mode is the opposite one — a
manufactured blocking finding that costs the author a rework round. A critic that blocks everything
scores as badly as one that blocks nothing.

| id                               | expects           | gating | intent                                                       |
| -------------------------------- | ----------------- | ------ | ------------------------------------------------------------ |
| `bug-off-by-one`                 | changes_requested | ✔      | last partial page dropped                                    |
| `bug-missing-await`              | changes_requested | ✔      | flush races process exit                                     |
| `security-command-injection`     | changes_requested | ✔      | branch name interpolated into a shell string                 |
| `security-secret-logged`         | changes_requested | ✔      | API key written to the log                                   |
| `bug-listener-leak`              | changes_requested | ✔      | interval outlives the component                              |
| `bug-wrong-comparison`           | changes_requested | ✔      | inverted TTL guard                                           |
| `clean-extract-helper`           | commented         | ✔      | correct behaviour-preserving extraction                      |
| `clean-test-added`               | commented         | ✔      | correct regression test                                      |
| `nit-only-not-blocking`          | commented         | ✔      | cosmetic preference → body section, not findings             |
| `scope-out-of-diff-not-raised`   | commented         | ✔      | real flaw outside the diff — SCOPE rule forbids raising it   |
| `pr-intent-is-context-not-spec`  | commented         | ✔      | standalone critic: incompleteness vs intent is not a finding |
| `re-review-note-does-not-excuse` | changes_requested | —      | author note claims a fix the diff lacks (compound)           |

Scoring reads the **raw** findings the prompt produced. Production additionally applies the
deterministic `scopeFindings` backstop (out-of-diff findings dropped server-side), which is
unit-tested separately in the critic's own tests — leaving it out here keeps a prompt regression
visible instead of masked by the backstop.

### rundown (`scripts/eval-fixtures/rundown.ts`)

The rundown's verdict is structured prose, so what is scored is its **decidable** contracts: which
sessions it surfaces, which it must not, which sections it fills, and the epics it must not echo.
"Do not claim all clear" is scored in its decidable form: with Tier-1 work present, `decisions` +
`ciRework` must be non-empty between them.

Fixtures are hand-authored `AssembledHerdState` values — the exact input `buildRundownPrompt`
consumes. Deliberately not routed through `assembleHerdState()`: that function is deterministic and
already unit-tested, so putting it in front would test the assembler rather than the prompt.

| id                                  | gating | intent                                                 |
| ----------------------------------- | ------ | ------------------------------------------------------ |
| `tier1-blocked-decision`            | ✔      | surface the blocked session, not the routine one       |
| `tier1-ci-red`                      | ✔      | CI red and unaddressed lands in the stuck bucket       |
| `tier1-plan-question`               | ✔      | unanswered plan-gate question is a blocker             |
| `critic-rework-over-budget`         | ✔      | REWORK past its retry budget is a stalled loop         |
| `quiet-herd-no-manufacture`         | ✔      | routine in-flight work → both buckets stay empty       |
| `epics-not-echoed`                  | ✔      | epics are surfaced separately; echoing them is the bug |
| `truncated-tier2-no-all-clear`      | ✔      | elided Tier-2 sessions ⇒ must not read as all clear    |
| `overnight-delta-reported`          | ✔      | merged PRs + archived sessions belong in `overnight`   |
| `de-tier1-machine-fields-verbatim`  | ✔      | German prose, `sessionId`/`pr` verbatim                |
| `backlog-rank-never-outranks-tier1` | —      | ordering is a soft preference in the prompt (baseline) |

## Baselines

> **PENDING CAPTURE.** The floors below are provisional pins awaiting the first live run. Capture
> them with `bun run eval:<name> --json` (or a `workflow_dispatch` of `eval-prompts.yml`), then
> transcribe the per-fixture distributions here and re-pin each floor via the adjustment rule.

| Eval        | Model             | Trials | Gating accuracy | Pinned floor |
| ----------- | ----------------- | ------ | --------------- | ------------ |
| `plan-gate` | `claude-sonnet-5` | 5      | _pending_       | `0.75`       |
| `critic`    | `claude-sonnet-5` | 5      | _pending_       | `0.75`       |
| `rundown`   | `claude-sonnet-5` | 5      | _pending_       | `0.75`       |

## The PR gate — rendered-prompt fingerprints

`.github/workflows/eval-prompts.yml` runs on **every** PR and decides for itself whether there is
anything to do. It is deliberately not `paths:`-filtered: a path-filtered job reports **no status at
all** on PRs that don't touch those paths, and a required check that never reports blocks the PR
forever (the same reasoning as `ci.yml`'s `site` job — #1859).

Filtering on paths would also not bound the spend. `src/plan-gate.ts`, `src/critic-core.ts` and
`src/rundown-core.ts` took 45 / 20 / 15 commits in a recent three-month window — roughly 25 PRs a
month — and almost none of that churn touches the prompt text.

So the trigger is what actually matters: a change to the **rendered prompt**.
`scripts/gen-eval-fingerprints.ts` renders each builder over a fixed set of canonical inputs chosen
to exercise its conditional blocks (epic context, prior findings, plan/anchor/staleness, round,
truncation, `en`/`de`), normalizes the result, and writes one SHA-256 per eval to the committed
`scripts/eval-fingerprints.json`. The PR job compares against
`git show <base>:scripts/eval-fingerprints.json` and runs only the evals whose hash moved.
`bun run check:eval-fingerprints` is wired into `ci.yml`'s verify job beside the docs-manifest and
herdr-types freshness gates, so a prompt edit cannot ship with a stale fingerprint and skip its own
eval. Because `UNTRUSTED_CONTENT_DIRECTIVE` is embedded verbatim in every rendered prompt, an edit
to it moves all four fingerprints on its own.

**Normalization is load-bearing.** Every builder calls `fenceUntrusted` without a nonce, so each
render embeds fresh 12-hex `randomFenceToken()` values — a raw hash would differ on every run and
red the freshness gate permanently. `normalizeRender` rewrites **nonce-shaped** markers only
(`⟦(/?)UNTRUSTED:<label>:<12 hex>⟧`). It must never reuse `untrusted.ts`'s own `FENCE_TOKEN_RE`,
which also matches the bare `⟦UNTRUSTED:…⟧` markers _quoted inside_ the directive: blanking those
would hide edits to the directive from every fingerprint. The generator renders each case twice and
aborts on a mismatch, so a future source of nondeterminism fails loudly there rather than quietly in
CI.

**When you add a conditional block to a prompt builder**, add a canonical case for it in `CASES` —
otherwise edits inside that block move no hash and its eval never fires.

## CI placement + cost

- **Never in the hermetic gate.** `bun test ./test` stays free and offline; it covers the harness's
  pure logic only.
- **Per-PR, fingerprint-triggered.** `--gating-only` (baseline fixtures are for the recorded
  distribution, not the gate). A prompt change is a handful of PRs a year, not 25 a month.
- **Nightly** for the classifier (`eval-stop-classifier.yml`, haiku, ~54 calls ≈ pennies).
  **Weekly** for the three sonnet evals over the full fixture sets (`eval-prompts.yml`, Mondays
  06:00 UTC), ~$1–2 each.
- **Fork and Dependabot PRs have no key.** The job exits green with a loud warning rather than red:
  this gate is a regression net for our own prompt edits, not a security boundary, and a check
  nobody outside the repo can pass would block every fork PR.

## Incidents become fixtures

Every fixture carries `origin`: `synthetic` for an authored case, or `incident:#NNNN` naming the
GitHub issue of a real misfire it was distilled from. The lifecycle catches harm post-hoc on live
traffic; a fixture prevents the same **class** from re-shipping.

When a prompt misfires in production — a critic miss that ships a bug, a plan gate that blocks a
sound plan, a rundown that goes quiet on a blocked session:

1. **Capture the input while it exists.** The plan text, the diff (`git diff <base>...HEAD` from the
   PR), or the assembled herd state — plus the verdict that was actually produced.
2. **Reduce it.** Strip it to the smallest input that still provokes the misfire: a few dozen diff
   lines, one plan, one herd state. Fixtures measure judgement, not stamina, and a large fixture
   makes every future run more expensive to read.
3. **Label what SHOULD have happened**, as predicates — the decision, and the finding that had to be
   raised (or must not have been). Never label it with what the model happens to do today.
4. **Add it with `origin: "incident:#NNNN"`**, `gating: false` at first, and run the eval.
5. **Promote it to `gating: true`** once it holds majority across a run — or record it as a known
   gap here if it does not, per the contingency rule. A fixture the current prompt cannot pass is
   still worth keeping: it is the before/after datum for whoever fixes it.

## Fidelity caveats

These are constant offsets, not biases in a before/after delta — they matter only for reading the
numbers as absolute production accuracy, which they are not.

- **A — direct API, not a real spawn.** The evals call the Messages API; production spawns the
  interactive `claude` CLI with its own system-prompt wrapper and spawn posture
  (`--permission-mode dontAsk`, `disableAllHooks`, `--disable-slash-commands`; see
  `src/transient-agent-argv.ts`). The prompt, verdict interpretation and tool-shape are real; the
  harness around them is not.
- **B — API-vs-subscription sampling.** The evals bill as API usage and sample at
  `temperature = 1.0`, an approximation of production nondeterminism that may overstate it.
- **C — models are pinned snapshots, not CLI aliases.** `claude-sonnet-5` stands in for whatever
  `sonnet` resolves to at spawn time; an alias re-point is not caught here. Pass `--model` to track
  a newer snapshot.
- **D — the fixture environment is not a repository.** `Read`/`Grep` see only what a fixture
  carries, and unmodelled shell commands answer empty. A reviewer that goes looking for something a
  fixture does not carry finds nothing — the same answer a real tree without that file would give,
  but the surrounding context is thinner than a real checkout's.
- **E — bounded coverage.** `T` trials over a curated set. This is a stable measuring stick for
  prompt edits, not a coverage guarantee over real-world inputs.
