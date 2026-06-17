# In-app LLM touchpoint audit — deterministic-first tiered routing (cost guard)

**Issue:** [#692](https://github.com/erwins-enkel/shepherd/issues/692) ·
**Inspiration:** the "deterministic-first tier ladder" (`regex → Haiku classifier → strong executor`) from an external Claude Code OS demo. We borrow the **philosophy**, not the mechanism — the demo routes via headless `claude -p`; Shepherd deliberately rejects `-p` and uses transient **interactive** subscription spawns (the critic pattern) everywhere.

## TL;DR

Shepherd has **already adopted this philosophy independently.** Every in-app LLM call is a transient interactive subscription spawn via `herdr.start()` — none use `claude -p`. The two genuine _classification_ touchpoints already run on **Haiku**, the readiness analyzer is already **fully deterministic** (zero LLM), and a deterministic "regex tier" (`classifyBlocked`) already shapes a stopped agent and surfaces menus/stalls **without any model**. There is **no expensive-model-doing-classification offender** to fix; the strong-model touchpoints are all genuine _generation_.

The two concrete changes shipped with this audit are therefore marginal refinements of the already-tiered classifiers, not a structural fix:

- **A** — a deterministic empty-tail short-circuit in front of the autopilot stop-classifier (a conservative override on a rare edge case; **not** a saving on the high-volume bulk).
- **B** — skip the background Haiku name-refine when the heuristic name is already strong (a small, **bounded** quality trade for cost — not "without quality loss").

## The 11 touchpoints

Spawn mechanism is `herdr.start(...)` (transient interactive subscription `claude`) for every row that calls a model. "Model" is the model the spawn pins or inherits: `deps.model ?? null` means it inherits the operator default (often unset → no `--model` flag); a named model means it is pinned in the spawn argv.

| #   | Touchpoint                | File / entry                             | Model                                               | Class                               | Job                                                                                          | Volume                                                |
| --- | ------------------------- | ---------------------------------------- | --------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1   | PR critic                 | `src/review.ts` `ReviewService`          | `deps.model ?? null`                                | **Generation**                      | Read-only review of a PR diff vs the task spec; request-changes / comment verdict + findings | Per push while CI-green + PR open (≤2×cap per streak) |
| 2   | Plan reviewer             | `src/plan-gate.ts` `PlanGateService`     | `deps.model ?? null`                                | **Generation**                      | Adversarial critique of an untrusted plan; approve / request-changes                         | Per planning phase (≤cap rounds)                      |
| 3   | Standalone critic         | `src/standalone-critic.ts`               | `deps.model ?? null`                                | **Generation**                      | Review of third-party repo PRs (comment-only)                                                | Per open PR per repo on push                          |
| 4   | Session recap             | `src/recap.ts` `RecapService`            | `?? "sonnet"`                                       | **Generation**                      | Synthesize a durable recap (headline/body/open-items) from a session's activity              | Once per settled-idle episode + on archive            |
| 5   | Herd rundown              | `src/herd-digest.ts` `HerdDigestService` | `?? "sonnet"`                                       | **Generation**                      | Cross-session "what needs a human now?" triage digest                                        | Once per calendar day                                 |
| 6   | Learnings distiller       | `src/distiller.ts` `DistillerService`    | `deps.model ?? null`                                | **Generation**                      | Mine recent signals for recurring mistakes; propose house rules                              | When ≥5 signals collected                             |
| 7   | Autopilot stop classifier | `src/autopilot-llm.ts` `classifyStop`    | **`haiku`** (`SHEPHERD_AUTOPILOT_MODEL ?? "haiku"`) | **Routing**                         | Classify why an autopilot agent stopped → gate / question / finished / complete / unknown    | Per autopilot stop                                    |
| 8   | Session namer (LLM)       | `src/namer-llm.ts` `llmName`             | **`haiku`** (`namerModel`)                          | **Routing**                         | Comprehend a task prompt into a 2–4 word slug                                                | Once per session (background refine)                  |
| 9   | Readiness analyzer        | `src/readiness.ts` `analyzeReadiness`    | **none**                                            | **Routing** (already deterministic) | Scan a repo's guardrails + prescribe tooling/house-rules                                     | On-demand                                             |
| 10  | Usage probe               | `src/usage-probe.ts` `HerdrUsageProbe`   | **none** (scrapes `/usage`)                         | **Probe**                           | Render `/usage` to read subscription token usage                                             | Hourly while calibrating (subscription mode)          |
| 11  | API-key verifier          | `src/verify-key.ts` `verifyApiKey`       | **`haiku`** (pinned)                                | **Probe**                           | End-to-end auth check of a configured API key via the real spawn wiring                      | Only on operator-triggered key verification           |

### Reading the table

- **Generation (rows 1–6): leave alone.** Each produces a judgment-bearing artifact — a review, a critique, a recap, a triage digest, a house-rule proposal. These are exactly the "actually doing the work" tier the demo reserves the strong model for. Recap and rundown sensibly pin `sonnet`; the critics/distiller inherit the operator default. Downgrading any of these to a cheap classifier tier would degrade the artifact. **No change.**
- **Routing (rows 7–9): already tiered.** The two that call a model already pin **Haiku** — the demo's "cheap classifier" tier, reached via the subscription-safe interactive spawn (not `-p`). The readiness analyzer is already the ideal end state: **fully deterministic, no model at all.** **No change warranted beyond the marginal trims A/B below.**
- **Probe (rows 10–11): already cheapest possible.** The usage probe makes **no model call** (it scrapes a slash-command panel). The API-key verifier pins **Haiku** and fires only on an operator-triggered verification, never in a hot path. **No change.**

### The "regex tier" already exists

`src/blocked.ts::classifyBlocked()` deterministically shapes a stopped agent's terminal tail into `menu` / `yes-no` / `awaiting-input` / `stall` / `quota` using pure regex. Crucially, **`menu` and `stall` surface to the operator with no LLM at all**; only `awaiting-input` / `yes-no` (and the `onDone` idle path) escalate to the Haiku classifier (row 7). So Shepherd's autopilot ladder today is already:

```
regex (classifyBlocked)  →  Haiku (classifyStop)  →  deterministic steer
```

— the demo's exact principle, minus the `-p`.

## Concrete proposals

### A — deterministic empty-tail short-circuit for `classifyStop`

**Change:** a pure `preClassify(tail)` runs inside `classifyStop`, **after** the api-key fail-closed guard and before the Haiku spawn. When the tail is empty / whitespace-only it returns `{kind:"unknown"}` (surface); otherwise `null` → the existing Haiku spawn runs unchanged.

**Honest costing — an edge-case trim, NOT a saving on the high-volume bulk.** `classifyStop` is the highest-_frequency_ in-app LLM call, but A's branch fires only on the **rare** path where the classifier has no tail to read: `onDone` when `readTail` throws or returns nothing (`src/autopilot.ts:264-268`). The bulk of classifier invocations come from the `onBlock` path, which is gated by `STEERABLE_SHAPES` (`awaiting-input` / `yes-no`) and therefore **always carries a non-empty tail** — A never fires there. So A removes a spawn in a known no-tail edge case; it does **not** trim the high-volume classifier traffic. Do not read "highest-volume call" as "A trims the bulk."

**Honest behavior framing — a conservative override, not an identical-verdict optimization.** Today's empty-tail path still hands Haiku the real task prompt, so Haiku could (rarely) return `complete` / `finished` off the task alone rather than `unknown`. A instead **always surfaces** (`unknown`, never an auto-proceed) when there is no tail. It only ever swaps a possible auto-action for an operator surface — **strictly safe** — but it is a small behavior change, not literally today's verdict.

**Rejected — a deterministic gate-phrase branch.** Matching procedural "shall I proceed?" phrasings to return `{kind:"gate"}` (auto-proceed via `PROCEED_STEER`) was considered and **deliberately dropped**: it would contradict the classifier's explicit "never guess gate" instruction (the `"unknown"` rule in `classifierPrompt`, `autopilot-llm.ts:76`) and the documented surface-on-doubt bias (the `SURFACE` comment, `autopilot-llm.ts:18`), and it adds the only real regression surface (a false gate auto-decides a real product fork) for the smallest slice of savings — those phrases are exactly what Haiku already classifies cheaply and correctly. Recorded here rather than shipped.

### B — skip the Haiku name-refine when the heuristic name is already strong

**Change:** the namer is already heuristic-first — `generateName` (pure, in `src/namer.ts`) sets the displayed name at create, and the Haiku `llmName` spawn runs in the background only to _maybe improve_ it. B skips that background spawn when `isHeuristicNameStrong(prompt)` — i.e. the heuristic already selected ≥2 _specific_ (non-COMMON, non-stopword) words, so it latched a distinctive multi-word subject. To prevent drift, both `normalize` and `isHeuristicNameStrong` derive from one shared `selectWords` helper, pinned by a load-bearing test.

**Honest framing against the issue's "without quality loss" constraint.** "≥2 specific words" means _distinctive_, not provably _optimal_ — the skipped Haiku pass might still have produced a marginally nicer phrasing. So B is a **small, bounded naming-quality trade for cost**, not literally zero quality loss: we forgo a possible minor polish on names that are already good, and never touch the weaker cases (which still refine). The bound is "a strong-but-improvable name keeps its already-good heuristic form" — one `git branch -m` / display rename avoided per self-naming session.

## Acceptance check

- ✅ A written audit of every touchpoint, tagged routing / generation / probe — above.
- ✅ At least one concrete, costed proposal — two (A and B), each costed honestly, plus the explicit rationale for why the six generation touchpoints and the probe touchpoints warrant **no** change.
