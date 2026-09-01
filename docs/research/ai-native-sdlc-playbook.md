# The AI-native SDLC playbook — what transfers to Shepherd

**Scope:** research synthesis, no product code changes. Reads Anthropic's
["The AI-Native SDLC Playbook"](https://claude.com/blog/the-ai-native-sdlc-playbook) against the
Shepherd codebase (mapped by a read-only research agent) and answers: **which of the playbook's
plays does Shepherd already run, which are worth adopting, and which don't fit a single-operator
tool?**

---

## 1. What the playbook says (condensed)

Premise: code generation is no longer the bottleneck, so the SDLC's constraint moves to the phases
that still run at human speed — planning, review, testing, deployment. The playbook restructures
the lifecycle into six stages, each committing an artifact the next stage reads, with the commit
chain as the audit trail:

1. **Plan — capture intent.** Ideas become version-controlled `intent.md` files (problem, proposed
   outcome, affected users/systems, constraints, open questions) produced in a clarifying-question
   session with Claude and approved by a product owner.
2. **Design — requirements + spec in one session.** Claude turns `intent.md` into `spec.md` with
   organizational skills (brand, security, compliance, UX) applied; policy conflicts are flagged
   for human resolution rather than silently resolved.
3. **Build — plan mode before code.** An implementation plan (files that change, order of work,
   risks, proof) is interrogated and approved _before_ generation, commits as `plan.md`, and is
   updated in the same commit when the implementation departs from it. CLAUDE.md, skills, hooks,
   parallel worktree sessions, and subagents support the stage; "the practical ceiling is how many
   streams one person can review properly."
4. **Test — sessions verify their own work.** Quantifiable targets, verification commands in
   CLAUDE.md, hooks protecting test files during fixes — plus **continuous evals in CI**: a suite
   of 20–50 real tasks that runs on any change to CLAUDE.md, skills, or hooks and gates
   configuration changes on pass rate. Each production incident becomes a permanent eval.
5. **Deploy — gated review.** Every PR gets an identical AI policy review driven by a
   version-controlled **REVIEW.md**: named passes (bugs, security, compliance), Important-vs-Nit
   severity, a cap on nits per review, explicit exclusions. Claude addresses review comments on its
   own PRs; hooks act as deterministic approval gates; managed settings lock down what agents can
   do in regulated environments.
6. **Maintain — closing the loop.** Deterministic **control-band monitoring** (rolling baseline +
   Western Electric rules) watches production metrics with three tiers in version-controlled
   config: 1σ → log, 2σ → Claude diagnoses read-only, 3σ → Claude proposes a fix (PR or runbook).
   Findings are written in the Stage-1 `intent.md` format and re-enter the pipeline; on-call
   triages (fix / schedule / dismiss — dismissals tune the bands). Scheduled security scanning and
   chat-ops integration feed the same loop.

The playbook closes with a **measurement framework**: leading indicators (time to first intent
commit, first-pass CI success rate for agent output, time to first PR review, eval pass rate on
config changes) and lagging ones (rework cycles per change, PR review time, how often the merged
diff matches the committed plan, defect escape rate, DORA metrics, repeat incidents of same class).

---

## 2. Where Shepherd stands today (codebase map)

### 2.1 Stages 1–3: Shepherd already runs most of the plays — some beyond the playbook

The build stage is Shepherd's home turf and in places ahead of the playbook. The plan gate
(`src/plan-gate.ts`, `PlanGateService`) doesn't just require an approved plan — it runs an
**adversarial plan review** ("try to REFUTE the plan") before the operator ever sees it, which the
playbook doesn't ask for. The approved plan is durably persisted (`plan_gates.plan` TEXT column,
`src/store.ts:1304`, with `planHash`, rounds, answered questions) and later injected into the PR
critic's prompt as an `APPROVED PLAN` block (`src/critic-core.ts:195-215`). Parallel worktree
sessions, per-repo CLAUDE.md, house rules (`src/house-rules.ts`), and the learnings flywheel cover
the CLAUDE.md/skills machinery. Guided intent capture exists at the **epic** level: the epic
shaping flow (#1507, shipped) is exactly the playbook's Stage-1 interview — gather context, ask
focused questions, draft, hard approval gate, only then create issues.

Two gaps against Stages 1–3:

- **Per-task intent is unstructured.** New Task is a single freeform textarea
  (`ui/src/lib/components/NewTask.svelte`); backlog drain passes the raw issue title/body
  (`src/issue-spawn-prompt.ts`). No problem/outcome/constraints/open-questions shape anywhere, and
  **all clarifying-question machinery lives inside the plan gate** — if the plan gate is off,
  nothing ever asks. The `shepherd-onboarding` skill's structured intake runs once at
  repo-onboarding time, not per task.
- **Plan fidelity is deliberately unmeasured.** The critic prompt explicitly says the plan "is
  CONTEXT for intent, never a warrant… Judge correctness, security, and quality independently of
  whether the diff matches the plan"; the plan's only operational use is feeding the scope-creep
  lens an out-of-scope boundary (`src/critic-core.ts:640-660`). The playbook's lagging metric —
  how often the merged diff matches the committed plan — cannot be computed today.

### 2.2 Stage 4: verification loops yes, config evals no

Self-verification is well covered (verify directives, critic, checks gate, stall detection). The
**continuous-evals play is the biggest miss**: Shepherd ships instruction changes with no
regression testing at all. The Promoter (`src/promote.ts`) writes repo CLAUDE.md edits and opens a
PR with zero quality gate beyond operator approval; house rules and learnings are guarded only
_post-hoc_ — `attributeLearningReward()` (`src/service.ts:5686-5705`) counts injected/helpful per
real session and a Wilson lower bound below the repo base rate soft-retires a rule after ≥8 pulls
(`src/learnings-lifecycle.ts:318`). That is harm detection on live traffic, not a pre-ship eval.
The repo contains exactly **one** real eval suite — the stop-classifier harness
(`scripts/eval-stop-classifier.ts`: labelled fixtures, multi-trial, thresholded), built precisely
because #1627 wanted a before/after baseline for a prompt edit — and its scheduled CI run is
deliberately commented out. The pattern was never generalized to the plan-gate prompt, critic
prompt, house rules, or promoted learnings.

### 2.3 Stage 5: the review loop exists; the review _policy_ is hardcoded and binary

The critic-on-PR loop matches the playbook's shape: auto-review on CI-green, findings steered back
to the task agent, merge train, autopilot. But where the playbook version-controls the review
policy as REVIEW.md with named passes and severity levels, Shepherd's reviewer prompt is built
entirely in code (`src/critic-core.ts`), per-repo configurability is three booleans
(`repo_config.criticEnabled/criticAllPrs/criticSmellLensEnabled`), and findings are **binary**:
`findings[]` is blocking-only with everything else routed into prose sections (Nits, Scope creep,
Possible smells, Latent). No bugs/security/compliance taxonomy, no machine-readable severity, no
nit cap. Notably, **house rules are injected into task agents but never into the reviewer**
(`src/service.ts:2844` vs the bare reviewer preset in `src/transient-agent-argv.ts:170`) — the
critic enforces a repo's standards only to the extent the repo's own CLAUDE.md happens to state
them. Governance/managed-settings plays are covered at single-operator scale (egress allowlist,
dontAsk + scoped allowedTools, membrane, plan/build-queue human gates).

### 2.4 Stage 6: Shepherd notifies; it never remediates

Every autonomous loop in the codebase is **housekeeping or notification, never remediation**:
`backup_stale` and the daily Herd Rundown emit a signal/digest and stop; stall/blocked/critic-stuck
detection reaps or escalates to the operator; the only genuine metric-threshold trigger is the
tmpfs inode guard (`src/tmp-sweep.ts`), and the only automatic issue creation is the post-merge
manual-steps tracker and epic materialization — both event-driven, neither diagnostic. No metric
threshold anywhere spawns a diagnosis session or files a backlog issue. There is no scheduled
scanning of managed repos (CodeQL runs weekly on Shepherd itself only) and no production-signal
ingress (no Sentry/metrics/log source feeding the loop; #1108 evaluated Sentry and recommended
defer).

### 2.5 Measurement: tokens thoroughly, delivery outcomes not at all

Shepherd has a rich token/cost stack (`session_usage`, `reviewer_spawns`, ~15 `usage-*` modules,
Usage lenses in the UI, `scripts/usage-report.ts`) — and **zero delivery metrics**. Grepping for
first-pass/merge-rate/lead-time/DORA hits only prose in `docs/research/`. The raw material already
exists and is never aggregated: `reviews.addressRound`/`errorRound` (rework rounds),
`plan_gates.round` (plan rework), `local_prs.createdAt/mergedAt`, `signals` (60-day retention).
Nothing computes first-pass merge rate, rework cycles per task, time-to-first-review, or
time-to-merge, and no UI shows them.

---

## 3. What transfers — ranked recommendations

### R1 — Delivery-metrics lens: compute the playbook's indicators from data Shepherd already has

The highest-leverage, lowest-risk adoption. Nearly every leading/lagging indicator the playbook
names is derivable from existing tables — no new instrumentation needed:

| Playbook indicator             | Shepherd source                                              |
| ------------------------------ | ------------------------------------------------------------ |
| First-pass success rate        | `reviews.addressRound == 0` at merge; CI green on first push |
| Rework cycles per change       | `reviews.addressRound`, `streakReviews`, `errorRound`        |
| Plan rework                    | `plan_gates.round`                                           |
| Time to first review           | review row createdAt − PR opened                             |
| Lead time (task → merge)       | session createdAt → `local_prs.mergedAt` / GitHub mergedAt   |
| Repeat incidents of same class | `signals` grouped by tone/key                                |

Ship it as a Usage-style lens (per repo, trend over time) plus a `scripts/` report. Beyond parity
with the playbook, this is the missing substrate for several other recommendations (R3's plan-match
rate, R5's control bands) and for judging whether flywheel/config changes actually help — today
Shepherd can tell you what a task _cost_ but not whether the process is _getting better_.

### R2 — Version-controlled review policy: a per-repo REVIEW.md + severity taxonomy for the critic

Three moves, separable:

1. **Per-repo review policy file.** Let the critic read a `REVIEW.md` (or `.shepherd/review.md`)
   from the target repo — extra passes to run, known exclusions, repo-specific severity rules —
   appended to the built-in prompt the way house rules are appended to task prompts. The built-in
   lenses stay the floor; the file adds repo policy. This replaces "three booleans" with the
   playbook's version-controlled, diffable review policy.
2. **Inject house rules into the reviewer.** Today the critic can't flag violations of the very
   rules Shepherd injects into the author (`src/service.ts:2844` never reaches the reviewer spawn).
   Symmetry is cheap and closes a real enforcement gap — a rule the author ignored is exactly what
   review should catch.
3. **Machine-readable severity on findings.** Move from blocking-vs-prose to the playbook's
   Important/Nit distinction with named passes (bug/security/compliance/scope) in the verdict JSON,
   and cap nits per review. This unlocks severity-aware steering (only Important findings block the
   merge train), better UI, and R1's defect-class metrics. Keep the current sections as the
   presentation layer.

### R3 — Plan-drift report: measure plan fidelity without weaponizing the plan

The critic's "plan is context, never a warrant" stance is correct — don't turn the plan into a
straitjacket. But the playbook's insight stands: _systematic_ divergence between approved plans and
merged diffs is a process signal (plans too vague, gate answering the wrong questions). Cheap
adaptation: ask the critic for one non-blocking `planDrift: none|minor|major` field plus a
one-line note when the diff departs materially from the `APPROVED PLAN` block it already receives.
Persist it on `reviews`, surface it in R1's lens. No change to review judgment; pure measurement.

### R4 — Generalize the eval harness; gate instruction changes; incidents become fixtures

The stop-classifier harness is the template — labelled fixtures, multi-trial, thresholded — and it
exists because one prompt edit needed a baseline. Three steps up the playbook's ladder:

1. **Re-enable the scheduled run** of the existing eval (its cron is commented out) and trigger it
   on PRs touching the classifier prompt.
2. **Extend the pattern to the other high-leverage prompts** — plan-gate reviewer, critic, rundown
   — with small fixture sets (10–20 transcripts/diffs with expected verdicts), run on any PR that
   touches those prompt builders. This is the playbook's "evals gate configuration changes"
   applied to Shepherd's own config surface.
3. **Incident → fixture.** When a critic miss ships a bug, or a learning proves harmful
   (Wilson-retired), capture the case as an eval fixture the way the playbook turns incidents into
   permanent evals. This complements — not replaces — the observational lifecycle: lifecycle
   catches harm post-hoc on live traffic; fixtures prevent the _same class_ from re-shipping.
   Full pre-ship evals for promoted learnings are likely overkill at current scale (see §4), but
   the fixture library is the cheap 80%.

### R5 — A maintain loop: tiered thresholds that open work, not just notifications

Shepherd's Stage-6 machinery stops at "tell the operator." Adopt the playbook's tier structure on
signals Shepherd already computes, with Shepherd's own vocabulary (backlog issue = `intent.md`):

- **Tier 1 (log):** today's behavior — signal row, rundown mention.
- **Tier 2 (diagnose):** a sustained threshold breach — review error rate over N days, repeated
  stall/critic-stuck of the same class, first-pass rate collapse on one repo (from R1) — spawns a
  **read-only transient diagnosis agent** (existing reviewer-preset argv is exactly the right
  sandbox) whose deliverable is a drafted backlog issue: anomaly, evidence, affected subsystem,
  open questions.
- **Tier 3 (propose):** for a pre-approved narrow class (e.g. doc drift — already exists as the
  doc agent), open the PR directly.

The operator triages the drafted issues in the backlog exactly as the playbook's on-call triages
the intent queue; dismissals tune thresholds. Start with two or three bands on Shepherd-internal
health metrics — not external production ingress (see §4). This converts the rundown's
"what needs a human now" into "here is the issue, approve or dismiss."

### R6 — Optional structured intake for New Task

Lightest-touch item. Per-task freeform is fine for a solo operator who knows what they want, and
the plan gate catches ambiguity later — but only when it's on, and by then a session is already
burning tokens on a possibly misshapen ask. Two cheap moves: (a) an optional "shape this" toggle
on New Task that runs a short clarifying round (the epic shaping flow's little sibling, reusing
its interview machinery) and writes a structured task brief — problem, outcome, constraints, open
questions — as the spawn prompt; (b) teach the readiness analyzer to prescribe intent-shaped issue
templates for managed repos, so drained backlog issues arrive pre-structured. Both preserve the
freeform fast path.

---

## 4. What does not transfer

- **`intent.md`/`spec.md` as committed repo files.** Shepherd is issue-centric: GitHub issues are
  the intent artifact, the DB-persisted plan + PR + review + recap are the audit chain. Committing
  intent/spec markdown into managed repos would duplicate the backlog and fight the drain model.
  The _structure_ transfers (R6); the storage doesn't. Same for `plan.md` in-repo — Shepherd
  deliberately git-excludes `.shepherd-plan.md` and persists to `plan_gates`; that's the better
  design for one-PR-per-session work.
- **A separate Design/spec stage.** The playbook's Stage 2 exists to serialize product-owner and
  engineer roles. Solo-operator Shepherd correctly collapses spec into the plan gate; adding a
  stage adds latency, not safety.
- **Enterprise governance machinery.** MDM-deployed managed settings, product-owner sign-off
  chains, Bedrock/Vertex routing, managed code review — single-operator Shepherd's equivalents
  (egress allowlist, scoped allowedTools, membrane, human gates) already fit its threat model.
- **Full pre-ship evals for every learning/house-rule change.** With learnings volume and a solo
  approver, a mandatory eval gate on each promotion would cost more than it saves; the
  observational Wilson-bound lifecycle is the right primary control. R4 takes only the cheap parts
  (fixture library, prompt-builder gates).
- **Production control bands with Western Electric rules.** Shepherd manages development, not
  production; it has no metrics ingress and #1108 already deferred Sentry. R5 applies the tiering
  to Shepherd's _own_ health signals instead — external production monitoring stays out of scope.

---

## 5. Sources

- [The AI-Native SDLC Playbook](https://claude.com/blog/the-ai-native-sdlc-playbook) — Anthropic
- Codebase survey (read-only research agent, this branch): `src/plan-gate.ts`, `src/store.ts`,
  `src/review.ts`, `src/critic-core.ts`, `src/house-rules.ts`, `src/promote.ts`,
  `src/learnings-lifecycle.ts`, `src/service.ts`, `src/index.ts` sweep loops,
  `scripts/eval-stop-classifier.ts`, `ui/src/lib/components/NewTask.svelte`
- Prior art in this repo: [`cursor-agent-swarm-model-economics.md`](./cursor-agent-swarm-model-economics.md)
  (R3 critic-panel overlaps with R2's severity work), issues #1507 (epic shaping, shipped),
  #1627 (stop-classifier eval origin), #1108 (Sentry deferral), #925 (learnings auto-trial)
