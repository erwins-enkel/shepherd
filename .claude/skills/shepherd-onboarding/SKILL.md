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
planning skill. Everything it needs is below.

## Stages

Work the stages in order. Create a TodoWrite item per stage. **Nothing outward
(issue creation, epic import) happens before the Stage 4 approval gate.**

### 0. Orient

Establish three facts, then confirm them with the operator before proceeding.

**Path** — greenfield vs existing:

```bash
git ls-files | head -50            # tracked source files
git log --oneline -5 2>/dev/null   # history depth
```

A repo with little/no tracked source and no real history is **greenfield**; a real
codebase is **existing**. Auto-detect, then confirm.

**Tracker** — GitHub-native vs local/lightweight:

```bash
git remote -v                      # is there a GitHub remote?
gh auth status 2>/dev/null         # is gh usable?
```

A working GitHub remote + `gh` ⇒ **GitHub-native** (issues + epic import available).
Otherwise treat the repo as **local/lightweight**: programmatic issue creation and
epic import are unavailable (epic import asserts a GitHub-native forge), so the
backlog will be left as importable markdown (Stage 5).

**Intent source:**

- Existing: `README`, any `docs/`, stated goals from the operator, and the current
  issue list (`gh issue list --limit 50` if GitHub-native).
- Greenfield: a PRD/spec doc in the repo (look in the root and `docs/`).

If **greenfield and no PRD/spec exists**, do **not** run a full interview and do
**not** send the operator to another tool. State plainly that a short intent doc is
the required input, then offer a **minimal inline fallback**: ask only enough to
shape a backlog —

1. What are we building, in one paragraph?
2. Who is it for, and what's the single most important thing it must do first?
3. What's the first slice you could ship and see working end-to-end?

Proceed once the answers are enough to decompose, or stop here if the operator would
rather write the doc first.

**Completion criterion:** path, tracker, and intent source are each pinned and
confirmed.

### 1. Brief

Read the intent. For an existing repo, also survey the codebase (entry points, build
manifest, test setup, domain terms). Produce a short brief (~10 lines): what this
project is, its stack, its domain vocabulary, and what "shipped" means here. Every
later decision is judged against this brief, so it is written once and reused.

**Completion criterion:** a written brief the operator agrees describes the project.

### 2. Agent instructions (CLAUDE.md)

Write (greenfield) or upgrade (existing) the repo's `CLAUDE.md`. This is the
"teach the agents how we work here" deliverable. Scope it precisely — most generic
guidance is already in every agent's prompt, so restating it is pure no-op cost.

**What the CLAUDE.md owns** (write these, under their own headings):

- `## Project orientation` — what the project is, its stack, domain vocabulary, and
  how to run/build/verify it.
- `## How work flows here` — the **repo-specific** Shepherd work-contract: that work
  lives as issues/epics; what a tracer-bullet vertical slice looks like _in this
  codebase_ (name a concrete example seam); what "done" means here (e.g. which gate
  must be green).

**What it must NOT contain:**

- **Don't restate what Shepherd injects at spawn.** Every Shepherd-driven agent
  already receives an engineering posture, a research-first notice, a branch-rename
  notice, a preview-hint notice, and the curated `<shepherd-house-rules>` learnings
  block. Do not reproduce generic posture/process prose — it adds tokens and says
  nothing new.
- **Don't write the heading `# House rules for AI agents`** or reproduce a tooling
  posture / "adopt these guardrails" list. That artifact is owned by Shepherd's
  Readiness analyzer (it generates that snippet for the operator to adopt). Stay off
  that heading so the two never collide; add at most a one-line pointer:
  `> Tooling guardrails (lint/types/tests/CI): see Shepherd's Readiness tab.`
- **Don't instruct agents to invoke skills or slash commands.** Unattended drain
  sessions run with skills and slash commands **disabled** and are explicitly told to
  ignore any CLAUDE.md/memory instruction to invoke them. Write for built-in tools
  and plain prose only — never "run `/foo`" or "use the X skill".

**Greenfield vs existing content model** (not just write-vs-merge):

- **Greenfield** — the repo has no real stack/run/verify facts yet. Record the
  **intended** stack and conventions, and explicitly **defer** concrete
  run/build/verify commands to the first bootstrapping slice (note in CLAUDE.md that
  they'll be filled in then).
- **Existing** — record the **actual** surveyed stack and the real run/build/verify
  commands. If a `CLAUDE.md` already exists, merge **surgically**: add the missing
  `## How work flows here` section and fill gaps; never clobber existing content.

**Completion criterion:** `CLAUDE.md` carries project orientation + the
repo-specific work-contract, with none of the forbidden content above.

### 3. Decompose (draft)

Break the intent into a backlog of **tracer-bullet vertical slices**. The method:

- A slice is a thin, end-to-end cut that delivers something observable, not a
  horizontal layer. Prefer "user can create and see one note" over "build the
  database schema". The first slice is the thinnest thing that proves the spine
  works end-to-end.
- **One slice = one PR = one Shepherd session.** Size every slice so it lands in a
  single PR (the single-PR invariant). If a unit is too big for one PR, it is an
  **epic** — split it into child slices.
- Each issue gets a crisp title and a body stating the goal, the vertical cut, and a
  checkable acceptance criterion.
- **Don't bake concrete file paths into an issue body.** An issue can sit in the
  backlog for weeks before it drains, and paths named in it may have moved or been
  renamed by then — the draining agent then follows a stale map. Point at stable
  anchors (a module/feature name, an exported symbol, a glob) and let the agent
  locate the current files when it picks the issue up.

Express dependencies with an `epic-dag` fence (the format Shepherd's importer reads —
`#<dependent> <- #<blocker>, #<blocker>`; a bare `#<n>` line is a member with no
deps). For an epic whose children are issues `#101…#103`:

````
```epic-dag
#101
#102 <- #101
#103 <- #101, #102
```
````

**Draft the entire tree as markdown** — parent epic(s) with their `epic-dag` fence,
and each child issue's title + body. This markdown is both the approval artifact and
the format the importer consumes, so it doubles as the local/lightweight fallback.

**Completion criterion:** a complete markdown draft of every epic + issue with
dependencies, sized one-PR-each.

### 4. Approve (hard gate)

Present the full draft — the proposed `CLAUDE.md` (as a diff for an existing repo)
and the entire issue/epic tree — then **stop**. Use `AskUserQuestion` to confirm,
amend, or abort. **Nothing is created or imported before this gate.** If the operator
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
3. **Trigger import per parent** so the links are actually wired — imports are **not**
   automatic on creation, and the endpoint requires a **GitHub-native forge**:

   ```bash
   curl -s -X POST -G "http://127.0.0.1:7330/api/epic/import" \
     --data-urlencode "repo=$(git rev-parse --show-toplevel)" \
     --data-urlencode "parent=<PARENT_NUM>"
   ```

   (`-G --data-urlencode` keeps the POST while URL-encoding the query, so a
   repo path containing a space or `&` can't break the request.)

   (Use your Shepherd server's host/port; `7330` is the default.) The response
   reports `subIssuesAdded` / `dependenciesAdded` / `unresolved`. Re-check any
   `unresolved` member numbers.

**Local/lightweight repos** — `forge.createIssue` and epic import are unavailable, so
do **not** attempt programmatic creation or import. Write the approved tree to an
importable markdown file (e.g. `BACKLOG.md`) and tell the operator it's the manual
reference / future-import source. Say this explicitly rather than failing silently.

**Completion criterion:** every approved issue exists (GitHub) with epic links wired
and `unresolved` empty, or the markdown backlog is written (local).

### 6. Point to first task

Identify where to start: the **DAG roots** (members with no blockers) and, among
them, the smallest tracer-bullet. Tell the operator exactly how to start it in
Shepherd — open a New Task on issue `#<n>`. Do **not** spawn the session yourself
(Shepherd owns session creation; a skill in one session can't cleanly spawn another).

For GitHub repos, first confirm the per-parent import actually wired the links
(sub-issues + blocked-by present) before pointing. For local repos, point at the
markdown backlog.

If obvious tooling guardrails are missing (no lint/typecheck/test/CI), add a one-line
nudge: run Shepherd's **Readiness** analyzer to score and install them.

**Completion criterion:** the operator knows the exact first issue to drain and how
to start it.

## Gate rules (reference)

- **Outward actions are gated.** Issue creation and epic import are outward and
  happen only after the Stage 4 approval. Drafting is always safe; creating is not.
- **GitHub-only operations:** `gh issue create` and `POST /api/epic/import` require a
  GitHub-native forge. Local/lightweight repos get the markdown backlog instead.
- **epic-dag grammar:** members are `#<n>` lines inside a fenced ` ```epic-dag `
  block; an edge is `#<dependent> <- #<blocker>[, #<blocker>…]`. (A `- [ ] #<n>`
  checklist is also accepted as a member list with no edges.)
- **CLAUDE.md exclusions:** no restating injected constants, no
  `# House rules for AI agents` heading, no instructions to invoke skills/commands.

## Principles

- Onboard the **work**, not the tooling — Readiness owns guardrails; this skill owns
  the issue/epic backlog + the repo work-contract.
- Slices are vertical and single-PR — the first one proves the spine end-to-end.
- Draft, then create — the operator approves the whole tree before anything outward.
- Point, don't kick off — leave the operator one clear first move, started in
  Shepherd's own New Task flow.
- Write the CLAUDE.md for a drain agent that has skills disabled and already carries
  Shepherd's injected guidance — say only what's repo-specific and new.
