# Research: take-aways from mattpocock/skills for our reviewer briefings

**TL;DR — the single highest-value finding is not a prompt technique, it's a
broken wire.** Matt Pocock's `to-spec` → `implement` → `code-review` skills form
one **contract chain**: `to-spec` fixes the seams and an explicit _Out of Scope_,
`implement` honours them, and `code-review`'s Spec axis verifies the diff against
that spec, quoting spec lines. **Shepherd has the same chain and drops the last
link.** Our Plan gate produces an adversarially-reviewed, approved
`.shepherd-plan.md` — and then the Critic never sees it
(`review.ts:651` passes `session.prompt` + `issueBody`, never the plan). The
Critic re-derives intent from the raw issue: precisely the artifact the Plan gate
existed to sharpen. We pay for a spec and review against the pre-spec.

**Recommendation:** take **A** (feed the approved plan to the Critic) and **B**
(a scope-creep bucket + an _Out of Scope_ plan section) — they're one coherent
change and they close the chain. Take **C** (a named quality vocabulary) routed
_non-blocking_, reusing the latent-lens body-section pattern. **Skip E** (the
parallel two-axis split) — the idea is sound but our whole verdict machinery is
built around one verdict file, and a cheap 80% version exists.

Scope note: this is a **read-only research task**. No product code changed — this
report file is the entire diff. Everything below is a proposal, not a decision.

---

## What was compared

| Source                        | File                                                         | Lines |
| ----------------------------- | ------------------------------------------------------------ | ----- |
| Matt's PR reviewer            | `skills/engineering/code-review/SKILL.md`                    | 89    |
| Matt's spec author            | `skills/engineering/to-spec/SKILL.md`                        | 75    |
| Matt's implementer            | `skills/engineering/implement/SKILL.md`                      | 15    |
| Our PR critic (session)       | `src/critic-core.ts` → `reviewPrompt` + `scopeAndOutputTail` | ~90   |
| Our PR critic (standalone)    | `src/critic-core.ts` → `prReviewPrompt`                      | ~25   |
| Our adversarial plan reviewer | `src/plan-gate.ts` → `planReviewPrompt`                      | ~40   |
| Our plan schema               | `src/service.ts` → `planGateDirective{Interactive,Auto}`     | ~40   |

**Where we are already ahead, and should not regress.** Matt's Spec axis asks the
reviewer to "quote the spec line for each finding". Our VERIFY block goes
considerably further: resolve every identifier, cite concrete ground truth as
`path:line`, and an explicit rule that _"a correctness assertion with no citation
is not allowed"_. We also have three mechanisms Matt has no analogue for — the
SCOPE rule with a deterministic server-side backstop, CANNOT-VERIFY vs WRONG, and
the LATENT-DEFECT LENS. None of what follows should be read as trading those away.

---

## A. The approved plan never reaches the Critic — **recommended**

Matt's chain works because one artifact travels through all three skills. Ours
stops at the gate:

- `planReviewPrompt` (`plan-gate.ts:84`) reviews the plan, iterates up to 5
  rounds, and approves it.
- `reviewPrompt` (`critic-core.ts:131`) is then called with
  `(diffBase, session.prompt, priorFindings, authorNotes, issueBody, epic)`.

The approved plan is absent. The Critic judges "does the implementation satisfy
that task" against the **raw task string and issue body** — the un-negotiated
inputs. Every clarification the plan gate bought (resolved assumptions, chosen
approach, rejected alternatives) is invisible at review time.

**Feasibility is good.** `.shepherd-plan.md` is git-excluded (`shepherd-exclude.ts`)
but physically present in the session worktree, and a reader already exists —
`plan-gate.ts:1234` and `recap.ts:150` both read it from `worktreePath`. This is
a plumbing change, not new machinery.

**Two things it must get right:**

1. **The plan is agent-authored, therefore UNTRUSTED.** It has to be fenced with
   `fenceUntrusted(...)` exactly like `issueBody` already is
   (`critic-core.ts:150`) — not spliced in as instructions. The reviewer preset's
   read-only `dontAsk` sandbox contains the blast radius either way.
2. **A plan is not a warrant.** Injected naively, a Critic could rubber-stamp a
   diff that faithfully implements a _bad_ plan. Matt's answer is the axis split:
   his Standards axis never sees the spec, so it cannot be captured by it. Our
   equivalent already exists inside one prompt — the judge clause asks for bugs,
   security and quality **independently** of task satisfaction. Wording must keep
   that independence explicit: the plan is context for _intent_, never a defence
   for a defect. Our `prReviewPrompt` already models this register ("treat as
   CONTEXT … NOT as a spec to verify against").

**Open question for the operator:** should the plan _replace_ `session.prompt` as
the intent source, or be _added_ alongside it? Adding is safer (the plan can be
stale or wrong; the task is ground truth) but grows an already-long prompt.

## B. No scope-creep check, and nothing to check it against — **recommended**

Matt's Spec brief has three explicit buckets. Ours has rough analogues of two:

| Matt's Spec bucket                                                | Our equivalent                      |
| ----------------------------------------------------------------- | ----------------------------------- |
| (a) requirements missing or partial                               | judge clause: "satisfies that task" |
| (b) **behaviour in the diff that wasn't asked for (scope creep)** | **nothing**                         |
| (c) requirements implemented but wrong                            | judge clause: bugs / quality        |

Bucket (b) is a genuine hole, and it's an **asymmetry in our own rules**: the
`<engineering-posture>` block holds every _author_ to "Simplicity first",
"Surgical changes", "no features beyond what was asked, no abstractions for
single-use code, no unrequested flexibility" — and then no reviewer is ever asked
to check any of it. Gold-plating is a well-known autonomous-agent failure mode
and currently nothing in the pipeline looks for it.

The other half is the artifact. Matt's spec template has a mandatory **Out of
Scope** section; our plan schema (`goal, approach, files, steps, risks, success
criteria`) has no such section — so even a Critic told to hunt scope creep has no
boundary to measure against. The two changes are one mechanism: add _Out of
Scope_ to the plan schema, then let the Critic check the diff against it. It also
gives the adversarial plan reviewer something sharper to attack at gate time.

_Not in conflict with the latent lens._ Its rule that "descoped" or "handled in
another ticket" doesn't excuse an in-diff **defect** is about defects; bucket (b)
is about unrequested **additions**. Different objects.

## C. "Clear quality problems" is one undefined phrase — **recommended, non-blocking**

Our entire quality axis rests on that phrase in the judge clause
(`critic-core.ts:175`). Matt pastes a **12-smell Fowler baseline** (_Refactoring_
ch.3) into the Standards sub-agent, each as _what it is_ → _how to fix_:
Mysterious Name, Duplicated Code, Feature Envy, Data Clumps, Primitive Obsession,
Repeated Switches, Shotgun Surgery, Divergent Change, Speculative Generality,
Message Chains, Middle Man, Refused Bequest. Two rules bind it: **the repo
overrides** (a documented standard always wins) and **always a judgement call**
("possible Feature Envy", never a hard violation).

This is the best value-per-token idea in the three skills. It converts vibes into
a matchable checklist, and several smells map straight onto rules we already
hold authors to — **Speculative Generality** is literally our "no abstractions for
single-use code"; **Duplicated Code** and **Shotgun Surgery** are what our house
rules keep re-learning by hand.

**The cost is real and points one way.** ~800 extra tokens on every review round,
and a checklist invites hunting: more findings → more auto-address rounds → more
spend. The mitigation is already in our codebase — the LATENT-DEFECT LENS routes
its items to a body section (`Latent / future-reachable (non-blocking):`),
one line per item, never `request-changes`. Smells should land the same way:
a `Possible smells (judgement calls, non-blocking):` section. That takes Matt's
own hedge (always a judgement call) and enforces it structurally rather than
trusting the model to hedge. Worth trialling behind a flag and measuring round
counts before defaulting on.

## D. "Skip anything tooling already enforces" — **a divergence, not a gap**

Matt tells both axes to skip what tooling enforces. We **deliberately do the
opposite** in one place: VERIFY explicitly asks the Critic to confirm locale
parity (`critic-core.ts:413`) even though `check:i18n` gates it in CI and in the
pre-push hook. That's defensible — the Critic catching it pre-CI saves the
operator a red run — and I'd keep it.

But it's worth noticing how much the Critic can now redundantly re-derive: we
gate branch hygiene, locale parity, feature-catalog presence, announcement
versions, glossary integrity, and a fallow dead-code/complexity audit. A single
line naming the repo's gates and telling the Critic not to spend _findings_ on
what they already fail would sharpen focus. **Low confidence** — this trades a
real pre-CI benefit for prompt economy, and I'd want evidence that the Critic
actually wastes findings here before changing anything.

## E. The parallel two-axis split — **interesting, skip**

Matt's structural move: Standards and Spec run as **parallel sub-agents** so they
can't pollute each other's context, reported side by side under two headings,
explicitly **never merged or reranked** — "don't pick a single winner across
axes, that's the reranking the separation exists to prevent". The rationale is
sharp: code can follow every standard while implementing the wrong thing, or do
exactly what the issue asked while breaking conventions; one axis masks the other.

The argument plausibly applies to us — we run one Critic doing both jobs. But the
cost is not just 2× the agents per round. Our verdict machinery is built around a
**single verdict file**: `buildVerdict`, the deterministic scope backstop
(`attributeFinding`/`scopeFindings`), the streak counter, `runAutoAddress`, the
patch-id skip, and the author-note re-raise loop all key off one
`.shepherd-review.json` with one `decision` and one flat `findings` array. Two
verdicts means a merge policy (whose `decision` wins? do findings dedup?) —
i.e. exactly the reranking Matt says destroys the value.

**Cheap 80%:** keep one agent, require two labelled body sections, and state that
one axis passing never excuses the other. Captures most of the anti-masking
benefit for ~5 lines and no architectural change. If we ever _do_ want the real
split, it belongs in `standalone-critic.ts` first, where there's no session, no
streak counter and no auto-address loop to satisfy.

## F. No length budget on the review body — **cheap, low risk**

Matt caps each axis at "Under 400 words". We cap `summary` at ≤100 chars and
leave `body` and `findings[]` unbounded — and `body` is what the operator
actually reads. A word budget is a one-line change. Unknown whether our bodies
actually ramble; worth a look at recent verdicts before bothering.

## G. From `implement`: self-review before the gate — **cheap, worth trying**

`implement` is 15 lines and its last instruction is the interesting one: _"Once
done, use /code-review to review the work"_ — the author critiques its own diff
**before** committing. Our `<autopilot-directive>` requires lint/check/test before
a PR but never asks the agent to review its own diff. Since every Critic round
costs a full transient agent plus an auto-address turn, a self-review pass that
kills even one round per PR likely pays for itself. Easy to A/B on round counts.

## H. From `to-spec`: seams and testing decisions — **plan-schema idea**

`to-spec` step 2 makes the author sketch the **testing seams** before writing the
spec: prefer existing seams, use the **highest** seam possible, minimise seam
count ("the ideal number is one"), and **confirm the seams with the user** before
proceeding. The template then carries a **Testing Decisions** section (what makes
a good test, which modules, prior art in the codebase).

Our plan schema has **no testing section at all** — so the adversarial plan
reviewer, whose whole brief is to refute the plan, has no surface on which to
attack testability. "Success criteria" is adjacent but answers _what does done
look like_, not _where will this be tested and at what seam_. Adding seams +
testing decisions to the plan schema is the cheapest way to give the plan
reviewer real purchase, and it pairs with `implement`'s "use /tdd at pre-agreed
seams" — seams agreed at the gate, honoured during execution, checked at review.

**One deliberate divergence to keep.** `to-spec` forbids file paths in the spec
("they may end up being outdated very quickly"); our plan schema explicitly asks
for `files`. Keep ours — a `.shepherd-plan.md` is consumed in the same session it
was written, so staleness barely has time to bite. But the warning **does** apply
to `shepherd-epic-authoring` and `shepherd-onboarding`, which write issue bodies
that can sit in a backlog for weeks before drain. Paths baked into those rot.

---

## Ranked summary

| #   | Take-away                                               | Target                           | Value       | Cost                           |
| --- | ------------------------------------------------------- | -------------------------------- | ----------- | ------------------------------ |
| A   | Feed the approved plan to the Critic (fenced UNTRUSTED) | `critic-core.ts`, `review.ts`    | High        | Low                            |
| B   | Scope-creep bucket + _Out of Scope_ plan section        | `critic-core.ts`, `service.ts`   | High        | Low                            |
| C   | Fowler smell baseline, routed non-blocking              | `critic-core.ts`                 | Medium-High | Medium (~800 tok/round)        |
| H   | Seams + Testing Decisions in the plan schema            | `service.ts`                     | Medium      | Low                            |
| G   | Author self-reviews its diff before the PR              | `service.ts` autopilot directive | Medium      | Low                            |
| F   | Word budget on the review body                          | `critic-core.ts`                 | Low-Medium  | Trivial                        |
| E   | Two-axis split (cheap version: two body sections)       | `critic-core.ts`                 | Low-Medium  | Trivial (full split: high)     |
| D   | "Skip what tooling enforces"                            | —                                | Unclear     | — (divergence; needs evidence) |

## Open questions

- A: plan **replaces** or **augments** `session.prompt` as intent source?
- C: ship behind a flag and measure auto-address rounds first, or just default it on?
- E: is the cheap two-section version enough, or is a real split wanted in `standalone-critic.ts`?
- B/H: growing the plan schema costs plan-gate rounds — acceptable?
