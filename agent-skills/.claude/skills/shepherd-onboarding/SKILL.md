---
name: shepherd-onboarding
description: Onboard a repo into Shepherd's work-execution model — turn a PRD or stated goals into a drainable backlog (tracer-bullet vertical slices, dependency edges) cut against the repo's real scaffold, submitted as an epic draft for operator approval, then point at the first task to drain. Use when onboarding an existing codebase to Shepherd, bootstrapping a greenfield project from a PRD (bootstrap phase P4), or asked to turn intent into Shepherd-shaped issues/epics.
---

# Shepherd Onboarding

Get a repo ready to be **driven by Shepherd** — not its tooling (lint/types/CI, stack
pins, scaffold: that's Readiness and Bootstrap's job), but its **work-execution
model**. Shepherd drains _work_, and work has a shape: intent decomposed into an
epic of single-PR vertical slices with dependency edges, then run through plan-gate
→ implement → critic → merge-train. This skill turns a PRD (greenfield) or stated
goals (existing repo) into that shape **against what the repo actually contains**,
makes sure the repo carries the agent instructions Shepherd does **not** already
inject, and points at the first thing to drain.

Two paths share one spine. **Greenfield** = a new project with a PRD/spec — usually
already through Bootstrap P1–P3, so the scaffold, pinned stack and foundation
decisions exist. **Existing** = a real codebase you want to start driving with
Shepherd. They differ only at intake (Stage 0–1) and at the CLAUDE.md check
(Stage 2); Stages 3–6 are identical.

Work only from this file and its `references/` — this skill runs in **other operators'
repos**, where no operator-specific command or external planning skill exists.

## Stages

Work the stages in order. **You never create or edit issues yourself** — the backlog
reaches GitHub only through the operator-approved epic draft (Stage 5).

| Stage                  | What happens                                                              | Detail                             |
| ---------------------- | ------------------------------------------------------------------------- | ---------------------------------- |
| 0. Orient              | Pin path (greenfield/existing), tracker (GitHub/local), and intent source | `references/intake.md`             |
| 1. Brief               | ~10-line brief grounded in the real scaffold, not guesses                 | `references/intake.md`             |
| 2. Agent instructions  | Check the repo's `CLAUDE.md` against the contract                         | `references/claude-md-contract.md` |
| 3. Decompose (draft)   | Tracer-bullet vertical slices + dependency edges                          | `references/intake.md`             |
| 4. Approve (hard gate) | Below — present the tree, settle open questions                           | this file                          |
| 5. Submit              | Below — `epic_draft`, the operator approves, the server creates issues    | this file                          |
| 6. Point to first task | Below — name the DAG roots and the first slice                            | this file                          |

**Read `references/claude-md-contract.md` before Stage 2.**

## Hard rules for every issue you draft

- **Acceptance criteria never contain version numbers.** Not "SvelteKit 2", not
  `svelte@5`, not "Node 22". Write "on the pinned stack in CLAUDE.md" instead. An
  issue can sit for weeks; a version in it goes stale and the draining agent will
  dutifully stay on it. Shepherd **rejects** an epic draft whose acceptance criteria
  pin a version — rephrase and re-submit.
- **Cut against the scaffold that exists.** Read the manifest (`package.json`,
  `Cargo.toml`), the routes, the app shell, the CI workflows and the CLAUDE.md pins
  before slicing; never invent a structure the repo doesn't have.
- **No "project scaffold" child when the scaffold exists.** If the repo already has a
  manifest that builds and CI on `main` (Bootstrap P2 ran), the first slice is a
  product slice on top of it.
- **No concrete file paths in issue bodies** — point at stable anchors (module,
  exported symbol, route, glob).

### 4. Approve (hard gate)

Present the brief, the CLAUDE.md finding (Stage 2) and the entire epic tree, and
settle anything unresolved with `AskUserQuestion` — one focused question at a time.
If the operator amends, revise and re-present. The draft review in Shepherd's UI
(Stage 5) is the formal approval; this stage makes sure what you submit is already
right.

### 5. Submit (epic draft)

**GitHub-native repos:** submit the tree with the **`epic_draft` tool** (on the
`shepherd` MCP server) — parent title/body/acceptance criteria/non-goals, and each
child with a stable `key`, title, body, acceptance criteria and `blockedBy` keys.
Author bodies **without** an `epic-dag` fence or issue numbers. Then **stop**: the
operator reviews the draft in Shepherd's UI and approves it; the server creates the
child issues, then the parent with the `epic-dag` fence built from real numbers, and
wires native sub-issue + `blocked_by` links. To amend, re-submit the whole draft.

- **One epic per draft.** If the backlog is bigger than one epic, submit the first
  one (the M0 / first milestone) and list the remaining epics for the operator to
  shape in further epic-authoring sessions.
- **No `epic_draft` tool in this session?** It exists only in an **epic-authoring**
  session. Finish Stages 0–4, then tell the operator to start a New Task with **Epic
  authoring** enabled and run this skill there with the drafted tree. Never fall
  back to `gh issue create` or `gh issue edit`.
- **Link import is not yours.** The server runs it on approval; if it reports
  `unresolved` members, the operator retries with **Import structure** on the
  epic panel in the Backlog. You reach the Shepherd server only through its
  restricted, session-scoped loopback ingress — never go hunting for the operator
  password or an API token to get around that.

**Local/lightweight repos** — there is no forge to create issues on, so the epic
draft cannot be materialized. Write the approved tree to an importable markdown file
(e.g. `BACKLOG.md`) and tell the operator it's the manual reference / future-import
source. Say this explicitly rather than failing silently.

### 6. Point to first task

Identify where to start: the **DAG roots** (members with no blockers) and, among
them, the smallest tracer-bullet. Once the operator has approved the draft, tell
them exactly how to start it in Shepherd — open a New Task on the created child
issue. Do **not** spawn the session yourself (Shepherd owns session creation; a skill
in one session can't cleanly spawn another). For local repos, point at the markdown
backlog.

If tooling guardrails are missing (no lint/typecheck/test/CI, no pinned stack), say
so in one line and point at Shepherd's **Readiness** analyzer (or Bootstrap for a new
project) — don't draft tooling slices yourself.

## Gate rules (reference)

- **No GitHub writes from you.** Issues come only from the approved epic draft
  (GitHub) or a markdown backlog (local). No `gh issue create`, no `gh issue edit`.
- **Dependencies** are `blockedBy` keys between children; the server turns them into
  the parent's `epic-dag` fence (`#<dependent> <- #<blocker>`) with real numbers.
- **No versions in acceptance criteria** — the server rejects the draft.
- **CLAUDE.md exclusions:** no restating injected constants, no
  `# House rules for AI agents` heading, no pointers to skills the repo doesn't ship.

## Principles

- Onboard the **work**, not the tooling — Readiness and Bootstrap own guardrails,
  scaffold and stack pins; this skill owns the backlog + the repo work-contract.
- Slices are vertical and single-PR — the first one proves the spine end-to-end on
  the scaffold that exists.
- Draft, then submit — the operator approves the whole tree before anything outward.
- Point, don't kick off — leave the operator one clear first move, started in
  Shepherd's own New Task flow.
- Write for a drain agent that can load this repo's own skills but no others, and
  already carries Shepherd's injected guidance — say only what's repo-specific and new.
