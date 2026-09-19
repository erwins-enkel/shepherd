# What can Shepherd do with JEV?

**Verdict: two targets are worth it, in order — `classifyStop` first, `blocked.ts` second — and
everything else can wait.** JEV is a _decision_ model, not a generator: it answers typed
multiple-choice / score / yes-no questions against a shared text blob in 70–500 ms with a calibrated
confidence number, and it cannot emit a value outside the enum you gave it. That makes it a poor fit
for most of what Shepherd spawns Claude for (naming, recaps, distillation, critic findings — all
generative) and an unusually good fit for exactly two places: the autopilot stop classifier, which is
a four-option choice currently paying for a whole `claude` process, and the `blocked.ts` regex
family, which decides whether a PTY pane is showing a real dialog using patterns pinned to one
Claude Code release.

> Research task, **2026-09-18**, against TypeSafe AI's published docs for **`jev-1.13.0`** and the
> Shepherd tree at `d40b7338`. A capability map and a recommendation, not a committed plan.
>
> **Updated 2026-09-19: a key now exists and §9 step 2 has been run — the go/no-go is GO.** Read §9
> first; it carries the measured numbers and three findings that supersede design choices argued for
> below (notably §3b's abstain mechanism and §5's question shape). Everything from the original
> 2026-09-18 pass is otherwise unedited, including the parts the measurement contradicts — the
> reasoning is worth keeping next to the result.

---

## 1. What JEV actually is

|                  |                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------- |
| **Endpoint**     | `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`         |
| **Model**        | `jev-1.13.0` (aliases `jev-latest`, `jev-preview`) — the only model                |
| **Request**      | one `state` string + a **map** of named `questions`, all answered in parallel      |
| **Latency**      | 70–500 ms end-to-end                                                               |
| **Price**        | **$0.042 / MTok input; output free.** Rate limits 250k tok/s, 1,200 req/min        |
| **Context**      | 64k total, of which 32k for `state` + the longest question                         |
| **Input**        | text only (strings, JSON, arrays). No images/audio/video                           |
| **Language**     | English primary; other languages _including German_ documented as reduced accuracy |
| **Availability** | Closed API, early-access waitlist, **no self-host, no open weights**               |

Three question primitives, and nothing else:

| Type     | Ask                                     | Returns                                                   |
| -------- | --------------------------------------- | --------------------------------------------------------- |
| `noul`   | a yes/no judgement                      | `P(yes)`, 0–1                                             |
| `choice` | pick one of ≤255 named options          | `choice`, full `probabilities` distribution, `confidence` |
| `score`  | rate against ordered descriptive levels | `score`, `probabilities`, `confidence`                    |

Two properties do the real work:

1. **It cannot produce a type error.** The output is constrained to the schema you supplied, so the
   whole class of "model returned something we couldn't parse" disappears — not mitigated, removed.
2. **Confidence is separate from the answer.** The distribution's peakedness is reported as a number,
   so _"which option"_ and _"should we act on it"_ become two decisions instead of one.

And one property bounds everything below: **JEV cannot generate text.** Every generative call in
Shepherd — `namer-llm.ts`, `recap.ts`, `distiller.ts`, `doc-agent.ts`, the critic's findings and
prose — is out of scope by construction, permanently. Only the judgement half is in play.

## 2. The doctrine question, and what it costs

Shepherd's standing rule is that in-app LLM calls go through a transient **subscription** `claude`
spawn — never `claude -p`, never a metered API. JEV is a metered API, so this needs stating plainly
rather than glossing:

**This is not a cost saving in dollars. It is a cost _addition_.** `classifyStop` today runs on a
subscription spawn whose marginal token cost is zero. Routing it to JEV adds a real, billed line item
where there was none.

What it buys, and what makes the addition defensible:

- **Per-call cost is negligible.** `classifyStop`'s prompt (3,000-char tail + 1,500-char task +
  amendments + instructions) is roughly 1.5k–2.5k tokens → **$0.00006–$0.0001 per call**. A
  `blocked.ts` pane snapshot is 15 lines, roughly 300 tokens → **about $0.00001 per call**. Both sit an order of
  magnitude under the sub-$0.001 bar.
- **It frees subscription quota.** Classifier spawns consume the same account quota as real agent
  work — the quota `usage-halt.ts` exists to detect running out of. Moving the hottest non-productive
  LLM call off the subscription is a saving denominated in quota rather than dollars.
- **The latency win is structural, not marginal.** `classifyStop` is not slow because the model is
  slow; it is slow because answering costs a `claude` process spawn, a PTY pane, a prompt round-trip
  and a 1 s disk poll under a 120 s timeout. JEV replaces all of that with one HTTP request.

**Ruling taken for this document:** the rule is about magnitude, not mechanism. A metered API is
admissible where per-call cost is sub-$0.001 **and** the call is a bounded decision rather than
generation, behind a server-enforced spend ceiling (§5).

---

## 3. Target 1 — `classifyStop`

**`src/autopilot-llm.ts:230`**, prompt at `src/autopilot-classify-core.ts:99`, normalize at `:147`.

### What it does today

On **every** agent stop, autopilot must decide why. It spawns a `writer-only` Haiku agent into a
disposable pane with the last 20 terminal lines (clipped to 3,000 chars), the task prompt (1,500) and
up to five amendments, waits up to 120 s polling for `.shepherd-autopilot.json`, and reads
`{kind, summary}` where `kind ∈ {gate, question, finished, complete, unknown}`.

The inventory of Shepherd's judgement sites calls this **the hottest LLM call in the product**. Its
only pre-filter (`preClassify`, `autopilot-classify-core.ts:38`) catches empty tails.

### Why it is the cleanest JEV fit in the tree

It is, structurally, a single `choice` question over five options against ~2k tokens of state. That
is the primitive, exactly.

|                    | Today                                              | With JEV         |
| ------------------ | -------------------------------------------------- | ---------------- |
| Mechanism          | `claude` spawn + PTY pane + disk poll              | one HTTP request |
| Budget             | 120 s timeout, 1 s poll                            | 70–500 ms        |
| Failure modes      | no-tool, parse-fail, husk pane, `agent_name_taken` | HTTP error       |
| Out-of-enum `kind` | silently collapses to `unknown`                    | **impossible**   |
| Marginal cost      | subscription quota                                 | ~$0.00008        |

That fourth row is a logged bug, not a hypothetical. `normalize()` (`:147`) collapses any
out-of-enum `kind` to `unknown`, and `#1627` had to add a prompt directive
(`CLASSIFIER_OUTPUT_LANGUAGE_DE`) whose entire job is begging the model not to translate the enum
token when writing a German summary — because a translated `kind` silently becomes `unknown`. With a
`choice` question the enum is enforced by the decoder and that directive becomes unnecessary.

### The two honest complications

**(a) `summary` is generative, and JEV cannot produce it.** The verdict is `{kind, summary}`, and the
summary is operator-facing prose (rendered in German when `operatorLanguage === "de"`).

This degrades cleanly, because every use site already has a constant fallback:

```
src/autopilot.ts:374  this.markComplete(s, v.summary || COMPLETE_MESSAGE);
src/autopilot.ts:398  this.pause(s, v.summary || SURFACE_MESSAGE);
```

So a JEV verdict supplies `kind` and leaves `summary` empty; control flow is byte-identical and the
operator sees the existing static message instead of a one-line gloss. **That is a real, if small,
product regression** — the gloss is how an operator learns _why_ a session paused without opening the
pane. Options, in preference order: accept it for the paused/`unknown` path only; or keep the Claude
spawn asynchronously for the summary while JEV unblocks the autopilot decision immediately; or add a
`choice` over a fixed set of canned i18n'd reasons, which is a JEV-shaped question in its own right.

**(b) Abstention changes mechanism.** Today `unknown` is a _chosen_ enum value — the model decides to
abstain, and the prompt works hard to make it do so (`#1627`'s no-ask rule). A `choice` question
always returns a top option; JEV abstains by _spreading probability_, reported as low confidence.

These are not the same thing, and the existing fixture set tests exactly this distinction
(`ambiguous-unknown`, currently **9/9 `unknown`** — §6). The design must map low confidence onto
`unknown` explicitly rather than assume JEV will pick the `unknown` option. Whether JEV's calibration
reproduces that 9/9 is **the single most important unknown in this document**, and it is cheaply
measurable the moment a key exists.

---

## 4. Target 2 — `blocked.ts`

**`src/blocked.ts`**: `classifyBlocked:206`, `hasActiveSpinner:123`, `hasQueuedInput:148`, consumed by
`poller.ts:1821 suppressAwaitingInput` and `critic-stuck.ts:41`.

### What it does today

Decides, from the last 15 non-blank ANSI-stripped lines of a PTY buffer, whether a pane is showing a
real dialog (`menu` / `yes-no` / `awaiting-input` / `stall` / `quota`), whether the agent is actually
working despite herdr saying `blocked`, and whether the input box holds unconsumed operator input.

It is regex, and it is _good_ regex — measured against a live corpus (4,226 captured block tails at
`blocked.ts:37`; 3,911 unique tails / 27,087 unique lines for the spinner work at `:76`), with a
dialog-chrome gate (`CARET_OPTION_RE`, `DIALOG_FOOTER_RE`) added in **#2281** specifically because a
numbered run alone is not evidence of a dialog — an agent writing a recap as "1. … 2. …" produces the
same shape.

### Why it still wants a model

The comments document the problem better than any argument could:

- `QUEUED_INPUT_RE` is anchored on wordings from **Claude Code 2.1.266**, which "ships three
  wordings". Every CLI release can silently invalidate it.
- `SPINNER_UNTIMED_RE` is "deliberately the tightest shape that covers it", with a documented
  accepted miss "roughly a second wide".
- Of 15 chrome-less rows in the corpus, 13 are prose forgeries and 2 are real dialogs caught
  mid-paint — a genuinely irreducible ambiguity for a pattern matcher.

The two failure modes are the expensive ones: a **forged menu** gets autopilot to type `1` into a
live PTY, or a **real "needs you" is silently missed** and a session sits idle until a human notices.

A batched JEV call — one `choice` over pane shape plus `noul`s for "is a turn actively running" and
"does the input box hold queued input" — is ~300 tokens, answers all of it in one request, and is
**robust to CLI wording changes by construction**. More importantly it returns confidence, so the
dangerous branch can require a peaked distribution and otherwise fall back to surfacing to the human.
A boolean regex has no way to say "I'm not sure".

### Cadence, and why dedupe is load-bearing

The regex runs every 3 s per blocked session, synchronously and free. JEV is a network call, so
firing on every tick is wrong on both cost and latency.

**Call only when the visible buffer changed since the last classify** (byte-identity, exactly as
`critic-stuck.ts:41` already does) **and at decision points** — when autopilot is about to act, or
when the regex is ambiguous.

This is not a marginal optimisation. A _blocked_ pane is by definition mostly static: a rendered menu
does not repaint while it waits. Dedupe therefore collapses the common case from ~20 calls/minute to
roughly **one call per block episode**. The worst case is worth stating anyway, because it is the
case the spend cap exists for: 10 sessions all repainting every 3 s = 200 calls/min = ~288k
calls/day ≈ **$2.88/day**, which would breach a $1/day ceiling. Well inside the 1,200 req/min rate
limit, but a reminder that the cap must degrade gracefully rather than wedge anything.

---

## 5. Architecture — the `Judge` seam

**Shape the interface around the primitives, not around JEV's HTTP API.** `noul` / `choice` / `score`
are a general concept; an interface expressed in those terms is vendor-neutral at no extra cost, and
survives JEV being rate-limited, repriced, acquired or shut down — a live risk for a closed
early-access vendor with one model and no self-host option.

```
judge.ask(state, { name: { type, instructions, criteria } }) → { name: { value, confidence } }
```

with per-decision typed wrappers colocated at their call sites.

| Decision       | Choice                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| Default        | **Off.** Key in `~/.shepherd/env`, setting off by default (the `SHEPHERD_DOC_AGENT` pattern)                      |
| Low confidence | **Fall back to the path that exists today** — Claude spawn for `classifyStop`, regex for `blocked.ts`             |
| Spend cap      | One global daily USD ceiling in Settings, low default (~$1/day)                                                   |
| On breach      | Degrade to the fallback path silently, plus one operator notification                                             |
| Event loop     | Async + `timedAsync` throughout; never a sync call on the single Bun loop                                         |
| Egress         | **No firewall change.** `src/egress.ts:289` constrains _agents_ in the autonomous netns; the server is outside it |

The low-confidence rule is what makes the whole proposal low-risk: there is **no capability loss
path**. When JEV is unsure, Shepherd does what it does today, using code that is already correct and
already tested. The upside is taken when JEV is confident; the downside is bounded at "current
behaviour plus one HTTP round-trip".

The cost of that safety, stated plainly: **the regexes are kept forever.** They will keep rotting
against CLI-version drift whether or not JEV carries the load, and they will keep needing maintenance
for the low-confidence path. This proposal does not retire `blocked.ts`; it puts a better judge in
front of it.

### Untrusted input

The `state` blob is untrusted PTY text and PR prose, so injection deserves a note — and it is good
news. JEV has **no tools, no file access, and an output space constrained to an enum**. The worst a
successful injection achieves is flipping one classification, which the confidence gate and the
fallback path already have to tolerate. Compared to today's classifier — a real Claude agent in a
sandbox, contained by `--allowedTools Write` and `dontAsk` — this is a **reduction** in attack
surface, not a new exposure.

---

## 6. Validation — mostly already built

The gate on all of this is: _does JEV actually beat what we have?_ That question is unusually cheap to
answer here, because **the harness already exists**.

`scripts/eval-core.ts` (#2156) runs three prompt evals on a shared harness, one of them the stop
classifier, documented in `docs/eval-stop-classifier.md`:

- **12 labelled fixtures**, `(taskPrompt, terminal-tail) → expectedKind`, run `T` times each (~54
  calls/run).
- **German fixtures gate**, at `T=9` — `de-gate-commit`, `de-question-approach`,
  `de-ambiguous-unknown`. This matters enormously given JEV's documented non-English accuracy drop:
  we would not be guessing about German, we would be measuring it against a pinned baseline.
- **A pinned floor.** `GATING_ACCURACY_FLOOR = 0.80`, deliberately a literal rather than
  observed-minus-margin.
- **A recorded baseline to beat:** gating accuracy **33/34 = 97.1%**, with `ambiguous-unknown` at
  **9/9 `unknown`**.
- A nightly `ubuntu-latest` workflow and free, network-less unit tests over the harness's pure logic.

So the validation plan is not new infrastructure — it is **a second backend in an existing harness**,
scored against the same fixtures and the same floor:

1. **Corpus replay.** Add a JEV backend to `eval-core.ts`; run the existing fixture set. The bar is
   explicit: match or beat 97.1% gating accuracy, and hold `ambiguous-unknown` — i.e. demonstrate
   that low-confidence-as-abstain reproduces chosen-`unknown` (§3b). The German buckets are
   load-bearing, not informational.
2. **Shadow mode.** Run JEV alongside the live path, acting on nothing, logging disagreements — for
   `blocked.ts` especially, whose 4,226-tail corpus is real captured production input and whose
   fixtures are not curated the way the classifier's are.

Only after both does the setting get turned on anywhere.

---

## 7. Risks

| Risk                                                                         | Severity       | Mitigation                                                                                  |
| ---------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------- |
| **Vendor**: early access, one model, no self-host, no weights                | High           | Primitive-shaped seam; heuristic fallback retained permanently; off by default              |
| **German accuracy** — docs concede reduced non-English quality; we are EN+DE | High           | Existing German gating fixtures measure it before anything ships; low confidence → fallback |
| **Abstain mechanism differs** (§3b)                                          | High           | `ambiguous-unknown` is the explicit gate; if it does not reproduce, target 1 is a no-go     |
| Loss of `summary` prose                                                      | Medium         | Constant fallbacks already at every use site; see §3a for three recoveries                  |
| Calibration drift on a `-latest` alias                                       | Medium         | Pin `jev-1.13.0`, not `jev-latest`; nightly eval already catches drift                      |
| Spend runaway on the 3 s poll path                                           | Medium         | Buffer-change dedupe; global daily cap degrading to fallback                                |
| Network latency added to a hot path                                          | Low            | 70–500 ms vs. a 120 s-budget process spawn; async throughout                                |
| Two code paths to maintain forever                                           | Low, permanent | Accepted cost of the fallback design                                                        |

---

## 8. Appendix — ranked remaining candidates

From the full inventory (15 spawned-agent judgement sites, ~50 heuristic ones). Nothing here is
recommended now; this is the shortlist to revisit once the two targets are measured.

| Rank | Site                                                                                                                            | Primitive                           | Verdict                                                                                                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `critic-core.ts:1385 attributeFinding`                                                                                          | `choice` over the changed-file list | **Strong.** Replaces a `/\.[a-zA-Z]\w{0,7}$/` path-shape regex with documented misses (`Makefile:`, `.7z`, `v2.0`, basename collisions on `index.ts`). ≤255 options fits a normal diff                |
| 2    | `usage-halt.ts:8 USAGE_LIMIT_PATTERNS`                                                                                          | `noul`                              | **Strong.** The file header admits the 5 regexes were authored with _no real captured usage-limit output available_. A calibrated yes/no beats a guessed pattern outright                             |
| 3    | Verdict _extraction_ from critic prose                                                                                          | `choice` over decision enum         | **Strong.** Kills the `no-verdict-unparseable` / `jsonrepair` class (`json-tolerant.ts:37`) at its root. Note: the critic **itself** stays on Claude permanently — 32k state cap, generative findings |
| 4    | `untrusted.ts:71 scanForInjection`                                                                                              | `noul`                              | **Good.** 8 advisory regexes vs. a documented JEV use case (guardrails/jailbreak detection). Advisory today, so a wrong answer is cheap                                                               |
| 5    | `doc-agent.ts:1652 isDocRelevantMerge`                                                                                          | `noul`                              | **Good, low stakes.** Currently judges doc relevance from the PR _title alone_                                                                                                                        |
| 6    | `namer.ts:417 selectWords`                                                                                                      | `score`                             | **Marginal.** Would improve the _gate_ on the LLM namer (currently German-specific regex + stopword lists); naming itself is generative and stays on Claude                                           |
| 7    | `readiness.ts:683`, `up-next-core.ts:144`                                                                                       | `score`                             | **Speculative.** Purely heuristic operator-facing judgements today; plausible fit, no evidenced pain                                                                                                  |
| 8    | `attention-core.ts:143 ATTENTION_RULES`                                                                                         | `score`                             | **Not recommended.** 14 ordered deterministic rules whose ordering is load-bearing and auditable. A model here trades explainability for little. At most an additional tie-breaking signal            |
| —    | `recap.ts`, `distiller.ts`, `optimizer.ts`, `merge-suggest.ts`, `maintain.ts`, `task-shape.ts`, `namer-llm.ts`, critic findings | —                                   | **Out of scope permanently** — generative                                                                                                                                                             |

---

## 9. What happens next

1. ~~Join the waitlist; nothing below is actionable without a key.~~ **Done** — key obtained
   2026-09-19.
2. ~~On key: add a JEV backend to `scripts/eval-core.ts` and run the existing stop-classifier fixture
   set.~~ **DONE 2026-09-19 — the go/no-go is GO.** `--backend jev` on the verbatim framing cleared
   every clause of the bar: gating accuracy **above** the Haiku baseline's 33/34 = 97.1%, a perfect
   score on `ambiguous-unknown` and `de-ambiguous-unknown`, and both German gating buckets passing.
   It also closes the recorded known gap — `gate-spec-first`, the prompt's own `gate` exemplar that
   Haiku splits toward `question`, comes back unanimously `gate`. Run cost was three orders of
   magnitude below the Haiku leg's. The framing comparison and the threshold sweep:
   `docs/eval-stop-classifier.md` → "JEV backend — the go/no-go".

   **Absolute JEV figures are deliberately not published here or there** — TypeSafe's
   [MCA §2.3(f)](https://typesafe.ai/legal/mca) forbids publishing "benchmarks or performance
   information about the Services" and this repo is public. The harness, fixtures and bar are all
   in-tree, so re-running `--backend jev --json` reproduces them locally.

   Three findings that change the design below:

   - **§3b is answered.** Low-confidence-as-abstain works, but is **not needed**: JEV chooses
     `unknown` on its own. The confidence ordering runs opposite to the intuition — the abstains come
     back _more_ confident than the **correct** `gate` calls, so any threshold above 0.6 converts
     correct gates into surfaced sessions rather than buying caution. Recommendation for step 3:
     **no threshold**, or ≤0.6 if one is wanted for other reasons.
   - **Feed the production prompt as `state`.** A purpose-authored structured state with distilled
     per-kind `criteria` — the shape §5 implies — measured below the Haiku baseline and failed
     `ambiguous-unknown` in the dangerous direction (a majority of trials calling it `gate`). Passing `classifierPrompt()` through verbatim wins and
     keeps drift-prevented-by-import for free.
   - **Wire notes from the live probe.** `state` accepts an object as well as a string. A bad key is
     `401` carrying `authentication_error` (which the harness's `isPermanent` already matches); a
     malformed request is **`400 api_usage_error`**, not the documented `422`. `noul` answers carry a
     probability but **no `confidence` field** — relevant to target 2 below, whose design assumes one.

3. If it clears: build the `Judge` seam and route `classifyStop`, off by default, low-confidence
   falling back to the existing spawn.
4. Then `blocked.ts` with buffer-change dedupe and confidence gating, shadow-mode first against the
   captured tail corpus.
5. Deferred, deliberately: the agent-side plugin (`claude plugin install typesafe@typesafe-ai`). It
   would need `api.typesafe.ai` in the autonomous egress allowlist and would put spend outside the
   server's ceiling — a separate decision, worth revisiting only once metering is proven.
