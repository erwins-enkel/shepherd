# Cursor's agent-swarm model economics — what transfers to Shepherd

**Scope:** research synthesis, no product code changes. Reads Cursor's July 2026 blog post
["Agent swarms and the new model economics"](https://cursor.com/blog/agent-swarm-model-economics)
against the Shepherd codebase (mapped by five read-only research agents) and against Shepherd's own
prior analyses ([`../token-usage-analysis.md`](../token-usage-analysis.md),
[`learnings-management-at-scale.md`](./learnings-management-at-scale.md)), and answers: **which of
Cursor's findings could Shepherd act on, and where?**

---

## 1. What Cursor found (condensed)

Cursor ran swarms of hundreds of agents against a hard benchmark — implement SQLite in Rust from the
835-page spec alone, scored by the `sqllogictest` suite — and published architecture + cost findings:

1. **Planner–worker split beats solo frontier models on cost at equal quality.** A frontier model
   (GPT-5.5) working solo cost **$10,565** for a 4-hour run at ~85 % test pass; an Opus 4.8 planner
   driving cheap Composer 2.5 workers hit the same ~85 % for **$1,339**. The worker fleet alone:
   $9,373 (solo) vs $411 (hybrid) — a **23× reduction**. Workers generate 69–90 %+ of all tokens but
   a small fraction of cost, because planner tokens are the expensive ones.
2. **Planner choice dominates the total bill — through the workers, not its own line item.** The
   Fable 5 planner "ran up a slightly smaller bill than the Opus 4.8 planner, despite roughly twice
   the per-token price" — but its "workers went through several times as many tokens, and the run
   as a whole came out substantially more expensive." Cursor offers no causal mechanism for the
   worker-token blowup; the operational lesson is that a planner model must be judged by the total
   cost it induces downstream, not by its own bill — and the priciest planner is not automatically
   the best one.
3. **Context efficiency, not parallelism, is the real win.** The swarm scales because the planner
   never holds implementation detail and each worker holds only its narrow task. Solo agents fail on
   long tasks because they oscillate between overview and detail in one ever-growing context. Cursor
   states this holds at every scale — even a single complex task benefits from decomposition.
4. **Coordination machinery is what keeps swarms from thrashing.** Their old swarm produced 68,000
   commits / 70,000+ merge conflicts in 2 h of "fake productivity"; the new one ~1,000 commits and
   <1,000 conflicts via: design decisions recorded in shared docs with compiler-checked references, a
   neutral **merger agent** arbitrating conflicts, workers flagging **bloated files** (blocking
   further commits until a refactor agent splits them), and licensed "deliberate breaks" so core code
   doesn't crust over.
5. **Diverse review perspectives have outsized ROI.** Multiple review agents with different models
   and prompts have uncorrelated failure modes (their analogy: sensor redundancy in self-driving
   cars) — and reviews are much cheaper than the work they check.
6. **A "field guide" (stigmergy) shortens future trajectories.** An agent-curated folder
   (`index.md`, hard line budget) is injected into every agent; agents themselves decide what is
   surprising enough to write down, so the next agent's trajectory is shorter.

## 2. Where Shepherd stands today (codebase map)

Five read-only research agents mapped the relevant subsystems. Per Cursor finding:

### 2.1 Model economics: per-role models exist — but authoring is monolithic

Shepherd already runs an 11-role model matrix (`src/config.ts:691-862`), each role independently
configurable (CLI/model/effort) via env + settings UI: main session, namer, critic, plan-gate
reviewer, recap, rundown, autopilot stop-classifier, doc-agent, distiller, optimizer, merge-suggest.
Cheap tiers are already used where the role is a constant-cadence classifier: **namer = haiku**,
**autopilot classifier = haiku**, **recap/rundown = sonnet** (`src/config.ts:782-853`). There is even
a usage-aware downgrade (opt-in: at 70 % of the cap, spawns drop to haiku, `src/config.ts:961-966`)
and a usage hold at 80 %.

But the **authoring session — where ~90 % of tokens burn** (69.4M authoring vs 7.9M satellite in
[`../token-usage-analysis.md`](../token-usage-analysis.md)) — is one monolithic agent on one
(typically premium) model doing research, planning, coding, and PR authoring in a single ever-growing
context. And the two rigor roles that default expensive stay expensive: **critic and plan-gate
reviewer inherit the global default model** (`criticCli/criticModel: "inherit"/"default"`,
`src/config.ts:832-843`), differentiated only by effort (critic forced `high`).

### 2.2 Planner→worker split: the seam exists, the split doesn't

There is **no planner→worker handoff anywhere**. The opt-in plan gate (`src/plan-gate.ts`) is a
_phase_ of the same session: the agent writes `.shepherd-plan.md`, a disposable adversarial reviewer
critiques it (up to 5 rounds, `planReviewCyclesCap`), and on approval the **same session with the
same model and the same accumulated context** is steered to "Execute `.shepherd-plan.md` now"
(`releasePlanGate`, `planPhase: "planning" → "executing"`, `src/types.ts:73`). Epic children drained
in parallel likewise spawn on the repo/global default model (`resolvedSpawnModel()`,
`src/drain.ts:384-399`) — the epic author cannot mark a child as "mechanical, cheap model suffices".

### 2.3 Context efficiency: strong discipline, already measured

Shepherd's own data agrees with Cursor's thesis from the other side:
[`../token-usage-analysis.md`](../token-usage-analysis.md) measured **91–99 % of authoring tokens as
`cacheRead`** — the agent re-reading its accumulated context every turn — with cost scaling
super-linearly in session length (57× spread; TASK-288 at 157 msgs / 37.4M tokens vs TASK-295 at 13
msgs / 0.66M). The injection side is already tightly budgeted: house rules 4,000 chars
(`src/house-rules.ts:206-272`), issue comments 50,000, recap transcript digest 4,000, namer input
2,000, and unattended spawns strip the skill catalog entirely (documented −6,349 tokens/turn,
`src/service.ts:395-430`). Auxiliary roles never see the session transcript — each gets a
purpose-built capped prompt. What has **no** mitigation is the main session's own longitudinal
growth: nothing compacts or splits a session that runs long.

### 2.4 Coordination: solid for its scale, two gaps vs Cursor

Shepherd's swarm-hygiene toolkit is real: worktree-per-session isolation (`src/worktree.ts:78-103`),
a branch-hygiene CI gate (no merge commits), a **union merge driver** for the i18n catalog hotfiles
(`scripts/json-union-merge.mjs` — the only custom merge strategy in `.gitattributes`), the
one-file-per-entry split of `feature-announcements/entries/`, mechanical agentless landing-branch
rebase with union-driver self-test (`src/landing-rebase.ts:303-406`), capped rebase steering of the
owning agent (`src/automerge.ts:367-419`), and a lifetime-capped landing-repair spawn
(`LANDING_REPAIR_CAP = 1`, `src/drain.ts:113-117`). Two gaps against Cursor's finding 4:

- **No merger agent.** A _genuine_ landing conflict (not union-driver-covered) pauses the epic and
  pages the operator (`enterLandingConflict()`, `src/drain.ts:1381-1389`). Cursor resolves these with
  a neutral arbiter agent.
- **Megafile handling is reactive, not detected.** The two historic hotfiles got bespoke fixes; but
  `ui/src/lib/glossary.ts` (single append-only array — structurally identical to the pre-split
  feature-announcements tail-collision), `ui/src/lib/api.ts` (2,517 lines, every endpoint PR touches
  it), and `ui/src/app.css` (all tokens) remain unmitigated, and nothing watches for files that
  repeatedly conflict.

### 2.5 Review: one reviewer per artifact, at premium price

Every review artifact gets **exactly one** reviewer per round: `PlanGateService` (plan),
`ReviewService` (session PR), `StandalonePrCriticService` (sessionless PRs) are mutually exclusive,
sequential services. The prompt's "lenses" (scope-creep, latent-defect, smells) are sections of one
prompt for one model call, not perspectives (`src/critic-core.ts:146-232`). And per §2.1 the critic
runs on the inherited premium model at `high` effort — the opposite of Cursor's "many cheap
uncorrelated reviewers". Review burn is already ≥ 0.25× authoring and likely undercounted
([`../token-usage-analysis.md`](../token-usage-analysis.md)). Operational memory adds a bias data
point: a single plan-gate reviewer model that near-never approves produced multi-week rework
treadmills — a single perspective is a single point of failure in _both_ directions.

### 2.6 Field guide: Shepherd is largely ahead

The learnings pipeline is Cursor's field guide with more machinery, not less: failure/correction
signals → daily distiller (LLM, capped 5 adds/run, `src/distiller.ts`) → proposed → auto-**trial** →
active, **scope-aware budgeted injection** (glob-matched against the task's target paths,
greedy-by-composite-score, 4,000-char budget, `src/house-rules.ts:143-272`), per-session recording of
injected rule ids for helpfulness scoring (`src/learnings-lifecycle.ts`), plus promote-to-`CLAUDE.md`
PRs. Much of what [`learnings-management-at-scale.md`](./learnings-management-at-scale.md) proposed
has since landed. The one Cursor mechanism Shepherd lacks: **agents can't write to the guide**.
Learnings are distilled from _failure_ signals (`reply`/`critic`/`block`/`stall`); a session that
discovers something surprising mid-task — Cursor's core stigmergy trigger, "document the unexpected
so the next trajectory is shorter" — has no write path.

## 3. What transfers — ranked recommendations

Ranked by expected leverage ÷ effort. Every item is measurable with the existing usage accounting
(`session_usage`, `reviewer_spawns`, the Overhead lens) — run the experiment, read the delta.

### R1 — Split plan-phase and execute-phase across models (the 23× lever, scaled to Shepherd)

Shepherd already owns the exact seam Cursor's economics need: an adversarially-reviewed,
self-contained plan artifact (`.shepherd-plan.md`) and an explicit `planPhase` flip. Today the flip
steers the same premium session onward. Instead, offer a per-repo/per-task **execute-phase model**:
on plan approval, respawn the session on a cheaper model (sonnet-class) with the approved plan as its
brief. Two compounding wins:

- **Model economics:** the expensive model does what it's uniquely good at (research, design,
  plan-gate rework); the mechanical execution of an approved plan runs on the cheap tier. This is
  precisely Cursor's Opus-plans/Composer-executes configuration.
- **Context economics:** a fresh execute spawn drops the entire accumulated planning context — and
  per Shepherd's own data, per-turn context re-read _is_ the cost (91–99 % `cacheRead`). The plan
  file becomes the compaction artifact, for free.

Guardrail from Cursor's planner comparison: the plan-side model choice swings the total bill far
more than its own line item (their pricier Fable 5 planner produced a substantially more expensive
run than Opus 4.8), so A/B the planner tier by induced total cost rather than assuming more
expensive is better — and make plan precision an explicit gate criterion by adding "executable by a
fresh agent with no planning context" to the plan-review rubric (`planReviewPrompt`,
`src/plan-gate.ts:173-256`). Ship behind a flag, A/B a handful of tasks, compare `Auth cost*` and
rework rounds against monolithic baselines.

### R2 — Right-size the expensive-by-default satellite roles

Critic, plan reviewer, distiller, optimizer, and merge-suggest all inherit the global premium model
today. Distiller/optimizer/merge-suggest are structured-output batch jobs — seed them
`sonnet`-class explicit defaults like recap/rundown already have. The critic is the deliberate
rigor role; don't blindly cheapen it — restructure it (R3). Keep the plan reviewer strong — plan
quality is the input the downstream execution chain amplifies (Cursor's planner comparison shows the
plan side moving the total bill far more than its own cost). Evidence: reviewer tax ≥ 0.25× of
authoring and undercounted.

### R3 — Critic panel: N cheap diverse reviewers instead of one premium reviewer

Convert the existing single-prompt "lenses" into **2–3 parallel critics on cheaper models with
disjoint prompts** (correctness/spec-fit; security/latent-defect; scope/simplicity), then a
deterministic, severity-aware merge. A correctness or security finding **blocks even when a single
reviewer raises it** — with disjoint foci each lens is the sole owner of its domain, so real
defects will usually be singletons, and requiring cross-reviewer agreement there would neuter the
panel. Agreement gating applies only to judgment-call categories (scope, simplification, style): a
singleton routes to the non-blocking suggestions section (the findings-routing machinery in
`src/critic-core.ts` already separates these tiers), duplicates raised by several reviewers merge
into one finding. At Sonnet-vs-premium pricing (3/15 vs 5/25 or 10/50 $/Mtok, `src/pricing.ts`), a
2–3-critic Sonnet panel costs about the same as today's single premium critic — and buys Cursor's
uncorrelated failure modes in _both_ directions: fewer missed defects **and** fewer
single-reviewer-bias treadmills. The never-approving-reviewer loop documented operationally is
broken on the _verdict_ side — a majority-of-panel approve decision — without ever diluting any
single reviewer's blocking defect findings. Same shape applies to the plan gate, where the
treadmill risk is highest.

### R4 — Proactive megafile management

Borrow Cursor's "workers flag bloated files" loop at Shepherd scale:

- **Now (proven pattern):** split `ui/src/lib/glossary.ts` into `glossary/entries/*.ts` fragments,
  exactly like `feature-announcements/entries/` — it is the same append-only-array collision class.
- **Detection:** record a `conflict` signal (file path, branch) whenever a session rebase or landing
  rebase hits a genuine conflict; the existing distiller can then surface "this file keeps
  conflicting — consider a split/driver" as a proposed learning. That closes the loop without new
  services: signals table + distiller already exist.
- `api.ts` / `app.css` are harder (typed single surfaces); a conflict-frequency signal will show
  whether they actually hurt before anyone invests in restructuring.

### R5 — A capped merger agent before paging the human

Genuine (non-union) landing conflicts currently hard-pause the epic for the operator. Mirror the
landing-repair pattern (`landingRepair: true`, lifetime cap 1): one neutral, capped **merger spawn**
that sees both branches' intents (their PRs/plans) and attempts the reconciliation; only on failure
does the epic pause. Cursor's merger-as-arbiter, sized to Shepherd's actual conflict volume — the
cap keeps the cost bounded and the human remains the fallback, not the first responder.

### R6 — Make decomposition the default economics, and say so

Cursor's finding 3 plus Shepherd's own super-linear session-cost curve point the same way: **several
short sessions are structurally cheaper than one long one**, because `cacheRead` compounds per turn
over a growing context. Shepherd already has the machinery (epics, `blocked_by` gating, parallel
drain up to `maxAuto`). Two cheap nudges:

- An autopilot/coach signal when a session crosses a turn/token threshold (e.g. 80 msgs): "split
  remaining work into issues" — the data says the knee is real (157-msg session ≈ 57× a 13-msg one).
- Document the many-small-tasks cost argument in the epic-authoring skill so attended epic authors
  bias toward tracer-bullet-sized children.

### R7 — Give agents a write path into the field guide

Close the one stigmergy gap: let a session flag a mid-task discovery as a learning candidate — e.g.
a `shepherd-note` marker the server captures as a new signal kind (`agent_note`) feeding the existing
distiller → proposal → trial pipeline. Curation, dedup, budget, and operator control all already
exist; only the positive-surprise capture edge is missing. (This also generalizes the current
critic/reply-only signal diet, which learns exclusively from failure.)

## 4. What does not transfer

- **The 1,000-commits/second VCS and hundred-agent swarms.** Shepherd's parallelism is per-repo
  `maxAuto` (default 1, ceiling 20) with worktree isolation and linear-history gates — at that scale
  git plus the union driver is the right tool. Cursor's VCS solves a problem Shepherd should avoid
  having, not import.
- **Licensed "deliberate breaks"** (agents intentionally breaking core code with compiler-propagated
  errors) presumes a swarm dense enough that other agents immediately absorb the break. In
  Shepherd's one-PR-per-session model, CI + the critic already police cross-cutting changes.
- **Wholesale worker fleets per task.** Cursor fans one task out to many workers; Shepherd's unit of
  parallelism is the task/epic-child. R1 deliberately keeps that shape (one executor per task) and
  imports only the model-tier split — fan-out within a task would require Cursor-grade coordination
  machinery for little gain at Shepherd's task sizes.

## 5. Sources

- Cursor blog — https://cursor.com/blog/agent-swarm-model-economics (fetched 2026-07-26)
- Cursor's published solo run — https://github.com/cursor/minisqlite
- Shepherd prior analyses — [`../token-usage-analysis.md`](../token-usage-analysis.md),
  [`learnings-management-at-scale.md`](./learnings-management-at-scale.md),
  [`learnings-pane-ux.md`](./learnings-pane-ux.md)
- Codebase mapping (2026-07-26, five read-only research agents): role/model matrix
  (`src/config.ts`, `src/default-model.ts`, `src/index.ts:651-668`), prompt assembly
  (`src/service.ts:1385-1488`, `src/house-rules.ts`, `src/critic-core.ts`, `src/recap-core.ts`,
  `src/namer-llm.ts`), review pipeline (`src/plan-gate.ts`, `src/review.ts`,
  `src/standalone-critic.ts`), usage accounting (`src/usage.ts`, `src/pricing.ts`,
  `src/usage-breakdown.ts`, `src/usage-limits.ts`), decomposition & coordination
  (`src/epic-model.ts`, `src/epic-core.ts`, `src/drain.ts`, `src/worktree.ts`,
  `src/landing-rebase.ts`, `src/automerge.ts`, `scripts/json-union-merge.mjs`)
