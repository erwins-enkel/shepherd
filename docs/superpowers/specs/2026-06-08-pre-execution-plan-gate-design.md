# Pre-execution plan gate (grill + adversarial plan review) — design

Issue: #348. Date: 2026-06-08.

## Problem

Shepherd's value is unattended execution, so **misalignment is the most expensive failure
mode**: a confident-but-wrong plan burns a whole autonomous run before anyone sees it. Today
the only adversarial review is at PR stage (`src/review.ts`, read-only critic on a finished
diff) — by then the work is done. Spawn goes rough-prompt → autonomous with no alignment
phase. There is no sanctioned moment to align *before* execution.

## Goal

A **pre-execution gate**, opt-in per task and per-repo (for drain/overnight), that pays the
alignment cost up front:

1. **Grill/plan phase** — the session spawns in a planning mode that researches the codebase,
   asks the human sharp clarifying questions (interactive), and writes a written plan to
   `.shepherd-plan.md`. No implementation yet.
2. **Adversarial plan review** — a second, read-only Claude (reusing the critic spawn
   hardening) tries to refute the plan over bounded rounds; findings steer back to the
   planning agent, which revises until the reviewer signs off.
3. **Go gate** — plan + verdict surface in the UI. Only after reviewer approval can the task
   enter autonomous execution (manual "Go" for interactive; auto-release for drain).

Claude-only / subscription-spawn throughout (no Codex/cross-model). Additive — the PR-stage
critic remains the *after* gate.

## Scope decisions (made autonomously; rationale recorded)

- **Shepherd-native prompts**, not a bundled MIT skill. Consistent with critic/classifier/
  namer; clean-context spawns already strip skills (`disableAllHooks` + `--disable-slash-
  commands`); avoids an external dependency. (Open question in issue → resolved: native.)
- **Opt-in per task + repo default.** Mirrors `autopilotEnabled` exactly: a nullable
  per-session override inheriting a per-repo default. Off by default. Drain/auto sessions
  inherit the repo default → "selectable for drain". (Acceptance: opt-in per task AND
  selectable for drain.)
- **Plan lives in `.shepherd-plan.md`** in the session worktree (committed by the executing
  agent, so it naturally rides into the PR), and the reviewer verdict surfaces in the UI via a
  `plan_gates` store record. (Open question → resolved: worktree file + UI record.)
- **Reviewer runs in a disposable detached worktree at the base branch** (exactly like the
  critic), with the plan *text* passed inline in its prompt. It never touches the live session
  worktree → no race with the planning agent, full sandbox.
- **Bounded rounds reuse `config.reviewCyclesCap`** (the existing critic round cap) rather than
  adding a second knob. Documented; a separate knob can be split out later if needed.
- **Interactive vs drain grill (issue open question):** interactive sessions grill the human
  and require a manual Go; drain/auto sessions have no human, so the planning agent writes the
  plan without human Q&A and the gate **auto-releases on reviewer approval**. If the reviewer
  can't approve within the cap, the session surfaces as paused (drain holds on it like any
  blocked auto session) instead of running unaligned.

## Architecture

Reuses existing session/terminal/steer/critic-spawn/store/events patterns. New pieces are a
session **phase** flag, a **PlanGate** store record + table, a **PlanGateService** (focused
sibling of `ReviewService`), spawn-prompt branching in `SessionService.create`, autopilot
suppression during planning, poller wiring, server routes, and a thin UI surface.

### State model (src/types.ts, src/store.ts)

`Session` gains:
- `planGateEnabled: boolean | null` — per-task override; null inherits repo default (mirrors
  `autopilotEnabled`).
- `planPhase: "planning" | "executing" | null` — null = gate off (normal session). Starts at
  `"planning"` when the gate is on; flips to `"executing"` on Go/auto-release.

`RepoConfig` gains `planGateEnabled: boolean` (default `false`).

New `PlanGate` record (one per session, table `plan_gates`), shaped after `ReviewVerdict`:
```
{ sessionId, planHash, decision: "approved" | "changes_requested" | "error",
  summary, body, findings: string[], round, cap, approved: boolean,
  plan: string /* the reviewed plan text snapshot */, updatedAt }
```
- `planHash` dedupes re-reviews of an unchanged plan (sha256 of the plan text — the plan-stage
  analogue of the critic's `patchId`).
- `approved` is the load-bearing gate flag; `decision`/`findings`/`round` drive the badge +
  steer-back, mirroring the critic.

Store: `migrateSessionColumns` adds `planGateEnabled INTEGER` (nullable) + `planPhase TEXT`
(nullable). `migrateRepoConfigColumns` adds `planGateEnabled INTEGER NOT NULL DEFAULT 0`. New
`plan_gates` table + `getPlanGate/putPlanGate/dropPlanGate/snapshotPlanGates/bumpPlanGate`;
cascade-drop on session archive (like `reviews`).

### Spawn (src/service.ts `composeSystemPrompt`, `create`)

When the gate is effectively on for a new session:
- persist `planPhase: "planning"`.
- compose the system prompt with a `<plan-gate-directive>` **instead of** the autopilot
  directive (we *want* the agent to stop and grill; autopilot would push it to execute).
  - **Interactive variant:** research the codebase first; ask the human sharp clarifying
    questions until genuinely aligned; then write the plan to `.shepherd-plan.md` at the repo
    root and tell the user it's ready for review; do NOT implement until the plan is approved.
  - **Auto/drain variant** (`input.auto === true`): research + write `.shepherd-plan.md`
    directly (no human Q&A available); do NOT implement until approved.

`composeSystemPrompt(houseRules, autopilotActive, planGateActive)` — when `planGateActive`, the
plan-gate directive replaces the autopilot directive block (they're mutually exclusive at spawn
time; autopilot resumes governing only after Go).

### Plan review engine (src/plan-gate.ts — new, `PlanGateService`)

A focused sibling of `ReviewService`. Deps mirror it: `store` (plan-gate CRUD + getRepoConfig +
addSignal), `herdr` (start/stop), `worktree` (createDetached/remove), `reply` (steer findings
to the live planning agent), `cap` thunk (reuse `reviewCyclesCap`), `model`, clock, injectable
verdict reader.

- `consider(session)` — called when a planning session settles (poller "done"/idle) or via an
  explicit operator "review plan" action. Reads `.shepherd-plan.md` from the live worktree. No
  file / empty → no-op (agent is mid-grill). Already `approved` → no-op. Plan hash unchanged
  vs the stored gate → no-op (dedupe). Otherwise spawn the reviewer (claims an in-flight slot
  like `ReviewService.starting`/`inflight`).
- `begin` — `createDetached(repoPath, baseBranch, baseSha)` (disposable, read-only inspect of
  the codebase). Spawn the reviewer with `reviewerArgv` = the **critic argv hardening verbatim**
  (`disableAllHooks`, `--disable-slash-commands`, allowlist Read/Grep/Glob/`Bash(git diff*)`/
  `Bash(git log*)`/`Bash(git show*)`/`Bash(git status)`/bare `Write`, `--permission-mode
  dontAsk` LAST, no `--bare`). Prompt = `planReviewPrompt(task, planText, priorFindings)`:
  read the plan + task; adversarially refute it (is it the best path? does it match the task?
  hidden risks? simpler approach? missing steps?); write verdict JSON to
  `.shepherd-plan-review.json` as `{"decision":"approve"|"request-changes","summary","body",
  "findings":[...]}`.
- `tick()` — finalize: read verdict from the disposable worktree; on timeout produce an `error`
  verdict (separate round, bias to surface). Reap worktree + terminal always.
- finalize:
  - `request-changes` → store gate (decision=changes_requested, findings, round+1), steer
    findings back to the live planning agent via `reply` (a bracketed-paste steer, exactly like
    the critic auto-address) so it revises the plan; if round ≥ cap, stop steering and surface
    (signal `stall`). The planning agent revises `.shepherd-plan.md`, settles, `consider`
    re-fires on the new hash.
  - `approve` → store gate (decision=approved, approved=true). For an **auto** session,
    immediately release the gate (→ executing). For an **interactive** session, leave it for
    the human's Go; emit so the badge shows "READY ✓".
  - `error` → store gate (decision=error), bias to surface (signal).
- emits `session:plangate {id, gate}` and `session:plangate-reviewing {id, reviewing}`.

### Go / release (src/service.ts)

`releasePlanGate(id)`:
- guard: session exists, `planPhase === "planning"`, and its `PlanGate.approved === true`
  (strict — "must approve before execution"). Returns false otherwise.
- set `planPhase: "executing"`; steer the planning agent: *"Plan approved. Execute
  `.shepherd-plan.md` now, autonomously — commit, push, open a PR. Don't re-litigate the
  plan."* From here autopilot (if enabled for the repo) governs normally.
- emit `session:plangate`.

Interactive: triggered by `POST /api/sessions/:id/go`. Drain/auto: `PlanGateService` calls
`releasePlanGate` itself on approval (the auto branch above).

### Autopilot suppression (src/autopilot.ts)

`AutopilotService.eligible` returns null when `s.planPhase === "planning"` — autopilot must not
drive a planning agent to a PR, and must not classify its grill questions. Once `planPhase`
is `"executing"` (or null), autopilot behaves exactly as today.

### Drain (src/drain-core.ts, src/drain.ts)

Auto sessions inherit `planGateEnabled` from the repo default (no drain-core change — the gate
is applied at spawn by `SessionService.create`). `AutoSessionView` gains awareness that a
session still in `planning` is **not** ready to retire (it has no PR yet — already covered by
the `git.state==="open"` retire guard, so no new logic). A planning auto-session whose reviewer
escalated surfaces as paused → drain holds on it via the existing `blocked`/pause path.

### Server wiring (src/index.ts, src/server.ts)

- construct `PlanGateService` next to `ReviewService`, same dep style; wire `onChange`/
  `onReviewing` to emit events; pass `reply` = `service.reply`, `cap` = `() => store cap`.
- poll loop: on `session:status` settle for a `planning` session, call `planGate.consider`;
  add `planGate.tick()` to the same cadence as `reviewService.tick()`.
- routes: `POST /api/sessions/:id/go` → `service.releasePlanGate`; `POST /api/sessions/:id/
  review-plan` → `planGate.consider` (manual trigger); include `planGateEnabled` in the
  create-session body + repo-config PATCH validator; include plan-gate snapshot in the
  bootstrap payload.

### UI (ui/src/lib/…)

- **NewTask.svelte**: a "Plan gate" checkbox (grill + adversarial review before running),
  defaulting from the repo config, overridable per task. Passes `planGateEnabled` to create.
- **AutomationPanel.svelte**: a "Plan gate" repo-default toggle (same pattern as the critic
  toggle), via a `RepoConfigStore.togglePlanGate`.
- **PlanGateBadge.svelte** (new): on the session card, derived from `planPhase` + the plan-gate
  store record + in-flight set — `PLANNING` / `REVIEWING` (pulsing) / `CHANGES · round N/­cap` /
  `READY ✓`. Clicking opens the plan panel.
- **Plan panel** (new, reuse an existing drawer/modal): renders the plan markdown + the
  reviewer verdict (summary/body/findings) + a **Go** button enabled only when approved.
- store: a `planGates` map + `planGateReviewing` set fed by `session:plangate*` events
  (mirrors the reviews store); `releasePlanGate(id)` / `reviewPlan(id)` API calls.
- **i18n**: all new chrome (checkbox label, toggle label, badge states, panel headings, Go
  button, empty/error states) added to **both** `en.json` and `de.json`.
- **feature-announcements.ts**: one entry (`id: "plan-gate"`, `sinceVersion`, title/body keys,
  `targetId` on the NewTask checkbox for a coachmark).

## Data flow (interactive, happy path)

1. Operator creates a task with Plan gate on → session spawns `planPhase="planning"` with the
   grill directive; autopilot suppressed.
2. Agent researches, asks questions in its pane; operator answers via the normal steer box.
3. Aligned, the agent writes `.shepherd-plan.md` and stops. Poller sees settle → `planGate.
   consider` finds the plan → spawns the adversarial reviewer (disposable base worktree).
4. Reviewer writes `request-changes` with findings → steered back into the agent's pane; agent
   revises the plan, stops; re-review fires on the new hash. Loop until `approve` or cap.
5. `approve` → badge shows READY ✓. Operator reviews the plan + verdict, clicks **Go** →
   `planPhase="executing"`, agent steered to implement; autopilot governs to a PR.

Drain path: same minus steps 1–2 and 5 — the agent writes the plan directly, the reviewer
loops, and on approval the gate auto-releases into execution; on cap-exhaustion it surfaces.

## Testing

Server (bun, `./test`): `PlanGateService` with injected herdr/worktree/clock/verdict-reader —
approve path, request-changes→steer→re-review, hash-dedupe skip, cap escalation→signal+surface,
auto vs interactive release, error/timeout verdict, archive cleanup. `composeSystemPrompt`
plan-gate branch (replaces autopilot block). `SessionService.create` sets planPhase + omits
autopilot directive when gated. `releasePlanGate` guards (not approved → false; wrong phase →
false; approved → steers + flips). `AutopilotService.eligible` null during planning. Store:
migrations idempotent, plan-gate CRUD + cascade. UI (vitest): badge state derivation, panel Go
enablement, store event reducers, i18n parity (`check:i18n`).

## Out of scope (this PR / follow-ups)

- Mandatory (non-overridable) plan gate for drain — left as a per-repo opt-in.
- Persisting the plan into the PR body automatically (the agent commits the file; a structured
  PR-body insert is a follow-up).
- A separate plan-review round cap distinct from the critic's.
- Cross-model (Codex) review — explicitly out per the issue.

## Unresolved questions

- Reviewer worktree at base vs. plan text inline only (no codebase read)? — default: base
  worktree + inline plan (richer review).
- Auto-release for drain on approval vs. always-hold-for-human? — default: auto-release for
  `auto` sessions, hold for interactive.
- Reuse `reviewCyclesCap` vs. dedicated knob? — default: reuse.
