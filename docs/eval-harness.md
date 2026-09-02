# Prompt eval harness

Live-model evals for Shepherd's high-leverage prompts — labelled fixtures, multi-trial,
thresholded. Issue **#2156**, generalizing the stop-classifier eval (#1626/#1627) from one prompt to
three and putting a gate on the PRs that change them.

> #2156 also named the **rundown**. That feature was removed from main by **#2174** (`feat(herd)!:
remove the Herd Rundown`), so its prompt no longer exists to measure; its eval, its ten fixtures
> and its captured baseline were deleted with it. The harness is unchanged by that — the rundown was
> one `EvalSpec` among several, which is the point of having a shared one.

The classifier's own history, baseline and A/B methodology stay in
**[`eval-stop-classifier.md`](./eval-stop-classifier.md)**; this document covers the shared harness
and the two sets added by #2156.

| Eval              | Prompt builder                                       | Model              | Fixtures | Verdict file                 |
| ----------------- | ---------------------------------------------------- | ------------------ | -------- | ---------------------------- |
| `stop-classifier` | `autopilot-classify-core.ts` → `classifierPrompt`    | `claude-haiku-4-5` | 12       | first `Write` wins           |
| `plan-gate`       | `plan-gate.ts` → `planReviewPrompt`                  | `claude-sonnet-5`  | 12       | `.shepherd-plan-review.json` |
| `critic`          | `critic-core.ts` → `reviewPrompt` / `prReviewPrompt` | `claude-sonnet-5`  | 12       | `.shepherd-review.json`      |

Each eval pins the model its prompt actually runs on in production: haiku for the classifier
(`classifyStop`'s default), sonnet standing in for the operator's role model on plan-gate and critic
(`reviewerModel` / `criticModel`, both "default" ⇒ the operator default).

## How to run

```bash
# Paid, live-model runs. Needs a key.
ANTHROPIC_API_KEY=… bun run eval:plan-gate
ANTHROPIC_API_KEY=… bun run eval:critic --json

# Flags (all three evals): --trials N  --model <id>  --temperature <t>  --threshold <0..1>
#                         --filter <id-substring>  --gating-only  --concurrency N
#                         --max-spend <usd>  --json

# The cheap probe: ONE fixture, ONE trial — a few cents, and enough to prove the harness
# obtains a verdict at all before committing to a full run.
ANTHROPIC_API_KEY=… bun run eval:critic --filter bug-off-by-one --trials 1 --json
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

**The inspection-tool evals carry an agent system prompt.** Production runs these prompts inside
the interactive `claude` CLI, whose own system prompt establishes that the model acts through
tools. A bare Messages call has none of that, and the first live run showed the cost: asked to
review a PR, the model answered the way a chat model does — in prose — and never called `Write`.
`no-tool` on **55/55** critic and **50/55** plan-gate trials, with zero transport errors. So
`AGENT_SYSTEM_PROMPT` frames the model as an agent acting through the provided tools.

It does two things, and the second is a real (small) divergence from production, recorded as
caveat F below: it establishes tool-driven operation, and it **discloses that turns are finite**.
Production has no turn cap; the harness does, so the model is told about the harness's own
constraint rather than left to exhaust it silently. An earlier draft went further and told the
model to inspect only what it needed and to stop as soon as it could decide — that is an
inspection-budget instruction, i.e. guidance about _how_ to review, and it was removed for exactly
that reason. What remains says nothing about findings, severity, or what any verdict should be.

The classifier does NOT carry it: it obtained verdicts on every trial without one, and adding it
would invalidate a measurement already paid for.

**A broken harness fails in seconds, not in a full run.** The preflight trial runs alone and guards
two things: a dead key, and a harness that cannot obtain a verdict at all. Two consecutive
verdict-less preflights abort with the fixture, turn count, `stop_reason` and the prose the model
returned instead. Discovering the mode failure above cost ~$10 and an hour once; it now costs a few
cents and reports its own diagnosis.

**Every run meters and caps its own spend.** These are paid runs, and the first attempt burned
~$10 before anyone could see a number. So the harness counts its own tokens, prices them through
`dollars()` in `src/pricing.ts` (the same formula the usage lens prices real sessions with), prints
`spend: calls=… in=… out=… ≈ $…`on every run, and puts it in the`--json`block. A run **stops** at`--max-spend` (default **$5**) and discards its partial results, because an incomplete run is not a
measurement. Raise the ceiling deliberately when a bigger run is actually intended.

Probe before you commit: `--filter <one-fixture> --trials 1` costs a few cents and answers the
question that has failed twice — does the harness obtain a verdict at all?

**A trial that cannot execute is never a data point.** Each trial gets three attempts with backoff;
a failure that survives them invalidates the whole run (`CANNOT_RUN`) rather than being scored as a
miss. This is not defensiveness — a sustained `529 overloaded_error` once made ~30 of 52 classifier
trials fail, each recorded as a mechanical miss, and the run reported **42.3%** for a prompt that had
measured **91.8%** an hour earlier. A permanent condition (exhausted usage limit, dead key) skips the
retries entirely, since it cannot recover.

**Trials run concurrently** (`--concurrency`, default 4). They are independent, and a critic trial
is a multi-turn conversation, so running them one at a time takes hours — too slow to gate a PR.
The very first trial runs alone as a preflight: a dead key or broken transport aborts before the
rest of the spend. After that, a transport failure is **retried once** before it is allowed to
become a data point — a 429 is not a verdict, and recording it as a mechanical miss would corrupt
the measurement the eval exists to produce.

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

## Baselines

> **PENDING CAPTURE for plan-gate and critic — and until then they DO NOT GATE.** They are now the
> only two new evals in the set, so nothing measured ships from #2156 beyond the classifier's
> confirmation. No run has yet
> scored either prompt: the first hit the prose-instead-of-tools mode failure, the second exhausted
> the turn budget, and the third could not run at all (workspace API usage limit, resets
> 2026-10-01). Their floors below are therefore unobserved guesses, and blocking a PR on a number
> nobody has measured would be theatre. Both ship with `observational: true` — they run, score and
> report on every trigger, and their report says `OBSERVATIONAL … does NOT gate` in its header and
> `(observational — not gating)` on its RESULT line, so a green result can never be mistaken for a
> passed gate. The guarantee is unconditional: an observational eval cannot return a failing code
> for ANY eval outcome — a scoring miss or a verdict-less harness alike — because the state it is in
> is precisely "this eval does not work yet", and blocking every PR in the repo on that would be the
> same mistake as gating on an unpinned floor. CLI misuse (a `--filter` matching nothing) still
> fails, since that is not an outcome of running the eval.
>
> To close this: capture with `bun run eval:<name> --json` (or a `workflow_dispatch` of
> `eval-prompts.yml`), transcribe the per-fixture distributions here, pin each floor via the
> adjustment rule, and flip `OBSERVATIONAL` to `false` **in the same commit**.

| Eval        | Model             | Trials | Gating accuracy  | Floor                         |
| ----------- | ----------------- | ------ | ---------------- | ----------------------------- |
| `plan-gate` | `claude-sonnet-5` | 5      | _never measured_ | `0.75` — unpinned, not gating |
| `critic`    | `claude-sonnet-5` | 5      | _never measured_ | `0.75` — unpinned, not gating |

### stop-classifier — confirmed on the shared harness

The classifier ran twice on 2026-09-02 (`--gating-only`), confirming the refactor preserved its
behaviour: **95.1% (58/61)** then **91.8% (56/61)** against its pinned floor of `0.80`, with
`ambiguous-unknown` at 9/9 both times. The second run demoted one fixture — see
[`eval-stop-classifier.md`](./eval-stop-classifier.md#known-current-classifier-gaps-contingency-rule).

## The PR gate — rendered-prompt fingerprints

`.github/workflows/eval-prompts.yml` runs on **every** PR and decides for itself whether there is
anything to do. It is deliberately not `paths:`-filtered: a path-filtered job reports **no status at
all** on PRs that don't touch those paths, and a required check that never reports blocks the PR
forever (the same reasoning as `ci.yml`'s `site` job — #1859).

Filtering on paths would also not bound the spend. `src/plan-gate.ts` and `src/critic-core.ts`
took 45 and 20 commits in a recent three-month window — roughly 20 PRs a
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
to it moves all three fingerprints on its own.

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
- **Per-PR: a SMOKE gate, not the measurement.** `--gating-only --smoke --trials 1 --max-spend 1`.
  It gates on **well-formedness only** — every trial must obtain a parseable verdict — and reports
  accuracy without gating on it. That split is forced by the arithmetic: the per-fixture rule is
  majority-correct, which needs an odd `T > 1` to mean anything, and `gate-commit-now`'s own
  recorded baseline is `gate:4 finished:1`, so a correctness gate at one sample would red about one
  run in five on model noise. Well-formedness is noise-free, and is what broke in every harness
  failure this project has had. `--smoke` also makes `--trials` CAP per-fixture overrides, so a
  `T=9` abstain fixture really does run once here; outside smoke mode the override still wins and
  those buckets keep their depth. The weekly run does the statistics at full depth. Sized after a PR run cost **$10.08**: the sets are large, the
  critic is multi-turn, and until `eval-fingerprints.json` exists on the default branch EVERY push
  selects all three evals. One trial per fixture with a $1 ceiling each bounds a full three-eval push
  to a few dollars worst case, and usually far less. A prompt change is a handful of PRs a year, not
  25 a month.
- **Nightly** for the classifier (`eval-stop-classifier.yml`, haiku, ~54 calls ≈ pennies).
  **Weekly** for the two sonnet evals over the full fixture sets (`eval-prompts.yml`, Mondays
  06:00 UTC), ~$1–2 each.
- **A gate that cannot run does not fail.** The eval exits `0` pass, `1` ran-and-missed, `2`
  could-not-run, `3` harness-broken (`EXIT` in `scripts/eval-core.ts`), and the workflow branches on
  those. Code `2` — no key (fork/Dependabot PRs), an exhausted API usage limit, a dead key, or rate
  limiting that survived its retry — warns loudly and leaves the job green, because **nothing was
  measured**: it says nothing about the prompt, and failing on it would block every unrelated PR
  until the account can make calls again. Codes `1` and `3` fail the job.

  The corollary is a rule this gate cannot enforce for itself: **a prompt change must not merge on a
  skipped result.** When the warning appears, dispatch `eval-prompts.yml` once calls are possible
  again and read the numbers before merging.

## Incidents become fixtures

Every fixture carries `origin`: `synthetic` for an authored case, or `incident:#NNNN` naming the
GitHub issue of a real misfire it was distilled from. The lifecycle catches harm post-hoc on live
traffic; a fixture prevents the same **class** from re-shipping.

When a prompt misfires in production — a critic miss that ships a bug, a plan gate that blocks a
sound plan, a classifier that stops abstaining on an ambiguous tail:

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
- **F — the harness discloses a turn limit production does not have.** `AGENT_SYSTEM_PROMPT` tells
  the model its turns are finite and announces its final turn, because the harness caps turns and
  production does not. This is disclosure of a harness constraint, not review guidance — but it is
  a divergence, and a reviewer that would have inspected further in production may write its verdict
  sooner here.
- **E — bounded coverage.** `T` trials over a curated set. This is a stable measuring stick for
  prompt edits, not a coverage guarantee over real-world inputs.
