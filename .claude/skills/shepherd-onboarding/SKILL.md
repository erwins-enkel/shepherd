---
name: shepherd-onboarding
description: Onboard a repo into Shepherd's work-execution model — turn a PRD or stated goals into a drainable backlog of issues/epics (tracer-bullet vertical slices, epic-dag dependencies) and seed repo-specific agent instructions, then point at the first task to drain. Use when onboarding an existing codebase to Shepherd, bootstrapping a greenfield project from a PRD, or asked to turn intent into Shepherd-shaped issues/epics.
---

# Shepherd Onboarding

Get a repo ready to be **driven by Shepherd** — not its tooling (lint/types/CI:
that's the Readiness analyzer's job), but its **work-execution model**. Shepherd
drains _work_, and work has a shape: intent decomposed into issues/epics, each a
single-PR vertical slice, dependencies expressed as an `epic-dag`, then run through
plan-gate → implement → critic → merge-train. This skill turns a PRD (greenfield)
or stated goals (existing repo) into that shape, seeds the repo-specific agent
instructions Shepherd does **not** already inject, and points at the first thing to
drain.

Two paths share one spine. **Greenfield** = a near-empty repo with a PRD/spec.
**Existing** = a real codebase you want to start driving with Shepherd. They differ
only at intake (Stage 0–1) and at the CLAUDE.md content (Stage 2); Stages 3–6 are
identical.

This skill is **self-contained**: it ships in the Shepherd repo and runs in _other_
operators' repos, so it never references any operator-specific command or external
planning skill. Everything it needs is in this file and its `references/`.

## Stages

Work the stages in order. Create a TodoWrite item per stage. **Nothing outward
(issue creation, body edits) happens before the Stage 4 approval gate.**

| Stage                  | What happens                                                              | Detail                             |
| ---------------------- | ------------------------------------------------------------------------- | ---------------------------------- |
| 0. Orient              | Pin path (greenfield/existing), tracker (GitHub/local), and intent source | `references/intake.md`             |
| 1. Brief               | ~10-line written brief every later decision is judged against             | `references/intake.md`             |
| 2. Agent instructions  | Write/upgrade the repo's `CLAUDE.md` — scope it precisely                 | `references/claude-md-contract.md` |
| 3. Decompose (draft)   | Tracer-bullet vertical slices + `epic-dag` dependencies, as markdown      | `references/intake.md`             |
| 4. Approve (hard gate) | Below — present everything, then **stop**                                 | this file                          |
| 5. Create (ordered)    | Below — children first, then the parent marker, then hand over import     | this file                          |
| 6. Point to first task | Below — name the DAG roots and the first slice                            | this file                          |

**Read `references/claude-md-contract.md` before Stage 2** — it lists what the
CLAUDE.md must _not_ contain, which is where this stage usually goes wrong.

### 4. Approve (hard gate)

Present the full draft — the proposed `CLAUDE.md` (as a diff for an existing repo)
and the entire issue/epic tree — then **stop**. Use `AskUserQuestion` to confirm,
amend, or abort. **Nothing is created or edited before this gate.** If the operator
amends, revise the draft and re-present.

### 5. Create (ordered)

Only after approval. **GitHub-native repos** — order matters, because the parent's
`epic-dag` fence must reference real child numbers, and import is a separate step:

1. **Create child issues first and capture their numbers.** `gh issue create` prints
   the new issue URL; the trailing path segment is the number:

   ```bash
   url=$(gh issue create --title "<title>" --body "<body>")
   num=${url##*/}          # e.g. 142
   ```

   Repeat per slice, recording each `num`.

2. **Create the parent epic issue** with a body containing the `epic-dag` fence that
   references those captured child numbers (and a checklist if you like). Capture its
   number too.
3. **Hand the per-parent import to the operator.** The fence in the parent body is
   what Shepherd recognizes, so the epic is drainable the moment step 2 lands;
   import only additionally wires the **native sub-issue + `blocked_by` links**, is
   **not** automatic on creation, and requires a **GitHub-native forge**.

   **You cannot trigger it.** You reach the Shepherd server only through its
   restricted loopback ingress, whose allowlist is session-scoped (hooks, build
   queue, epic draft); the repo-scoped import route is not on it, and the main port
   answers `{"error":"unauthorized"}` (401). That boundary is deliberate — import
   performs GitHub writes, which stay on the operator's side of the gate. **Never
   go hunting for the operator password or an API token to get around it.**

   Give the operator both paths instead:
   - **In the UI:** open the Backlog, expand the parent issue's row, and press
     **Import structure** on the epic panel (also offered as a remediation inside
     that panel's **Diagnose** modal).
   - **From their own shell.** OPERATOR-RUN — needs their credentials, so print it
     for them, don't run it:

     ```bash
     curl -s -X POST -G "http://127.0.0.1:7330/api/epic/import" \
       -H "Authorization: Bearer $SHEPHERD_TOKEN" \
       --data-urlencode "repo=$(git rev-parse --show-toplevel)" \
       --data-urlencode "parent=<PARENT_NUM>"
     ```

     (Use your Shepherd server's host/port; `7330` is the default. The bearer
     header only works if `SHEPHERD_TOKEN` is configured there — it's optional and
     unset by default; without it, use the UI. `-G --data-urlencode` keeps the POST
     while URL-encoding the query, so a repo path containing a space or `&` can't
     break the request.)

   The response reports `subIssuesAdded` / `dependenciesAdded` / `unresolved`; tell
   the operator that any `unresolved` member numbers are worth reporting back, since
   they usually mean a typo'd or foreign issue reference in the parent body.

**Local/lightweight repos** — `forge.createIssue` and epic import are unavailable, so
do **not** attempt programmatic creation or import. Write the approved tree to an
importable markdown file (e.g. `BACKLOG.md`) and tell the operator it's the manual
reference / future-import source. Say this explicitly rather than failing silently.

### 6. Point to first task

Identify where to start: the **DAG roots** (members with no blockers) and, among
them, the smallest tracer-bullet. Tell the operator exactly how to start it in
Shepherd — open a New Task on issue `#<n>`. Do **not** spawn the session yourself
(Shepherd owns session creation; a skill in one session can't cleanly spawn another).

For GitHub repos, first confirm the parent body actually carries the `epic-dag`
fence with the real child numbers (`gh issue view <PARENT_NUM> --json body`) — that,
not the import, is what makes it drainable. Restate the import as the one step still
owed by the operator; don't wait on it. For local repos, point at the markdown
backlog.

If obvious tooling guardrails are missing (no lint/typecheck/test/CI), add a one-line
nudge: run Shepherd's **Readiness** analyzer to score and install them.

## Gate rules (reference)

- **Outward actions are gated.** Issue creation is outward and happens only after
  the Stage 4 approval. Drafting is always safe; creating is not.
- **GitHub-only operations:** `gh issue create` and the epic link import require a
  GitHub-native forge. Local/lightweight repos get the markdown backlog instead.
- **Import is the operator's, never yours:** it is off the agent ingress allowlist
  and 401s for you (Stage 5). Hand it over — never hunt for credentials to force it
  through.
- **epic-dag grammar:** members are `#<n>` lines inside a fenced ` ```epic-dag `
  block; an edge is `#<dependent> <- #<blocker>[, #<blocker>…]`. (A `- [ ] #<n>`
  checklist is also accepted as a member list with no edges.)
- **CLAUDE.md exclusions:** no restating injected constants, no
  `# House rules for AI agents` heading, no pointers to skills the repo doesn't ship.

## Principles

- Onboard the **work**, not the tooling — Readiness owns guardrails; this skill owns
  the issue/epic backlog + the repo work-contract.
- Slices are vertical and single-PR — the first one proves the spine end-to-end.
- Draft, then create — the operator approves the whole tree before anything outward.
- Point, don't kick off — leave the operator one clear first move, started in
  Shepherd's own New Task flow.
- Write the CLAUDE.md for a drain agent that can load this repo's own skills but no
  others, and already carries Shepherd's injected guidance — say only what's
  repo-specific and new.
