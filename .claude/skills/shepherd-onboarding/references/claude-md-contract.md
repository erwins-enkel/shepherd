# Stage 2: agent instructions (CLAUDE.md)

Write (greenfield) or upgrade (existing) the repo's `CLAUDE.md`. This is the
"teach the agents how we work here" deliverable. Scope it precisely — most generic
guidance is already in every agent's prompt, so restating it is pure no-op cost.

## What the CLAUDE.md owns

Write these, under their own headings:

- `## Project orientation` — what the project is, its stack, domain vocabulary, and
  how to run/build/verify it.
- `## How work flows here` — the **repo-specific** Shepherd work-contract: that work
  lives as issues/epics; what a tracer-bullet vertical slice looks like _in this
  codebase_ (name a concrete example seam); what "done" means here (e.g. which gate
  must be green).

## What it must NOT contain

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
- **Only reference skills the repo itself ships.** Unattended drain sessions keep the
  Skill tool and the repo's own `.claude/skills/`, but run with Claude Code's built-in
  skills, the operator's personal ones, and every plugin **disabled**. So "use the X
  skill" is fine when `X` lives in `.claude/skills/` of this repo, and wrong for
  anything else — a personal or plugin skill won't be there. Slash commands are not
  typed by an unattended agent either way: point at the skill by name, not as `/foo`.

## Long, conditional guidance belongs in path-scoped rules

If a convention only matters for part of the codebase (UI components, a migrations
directory, one service), it does not belong in `CLAUDE.md` — that file is resident in
every turn of every session. Put it in `.claude/rules/<topic>.md` with `paths:`
frontmatter listing the globs it governs. Those rules load automatically when the
agent touches a matching file — unlike a skill, which loads only if the model decides
to invoke it — so the convention reaches the turn that needs it either way.

## Greenfield vs existing content model

Not just write-vs-merge:

- **Greenfield** — the repo has no real stack/run/verify facts yet. Record the
  **intended** stack and conventions, and explicitly **defer** concrete
  run/build/verify commands to the first bootstrapping slice (note in CLAUDE.md that
  they'll be filled in then).
- **Existing** — record the **actual** surveyed stack and the real run/build/verify
  commands. If a `CLAUDE.md` already exists, merge **surgically**: add the missing
  `## How work flows here` section and fill gaps; never clobber existing content.

**Completion criterion:** `CLAUDE.md` carries project orientation + the
repo-specific work-contract, with none of the forbidden content above.
