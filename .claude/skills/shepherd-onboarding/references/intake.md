# Stages 0, 1, 3: orient, brief, decompose

## 0. Orient

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

A working GitHub remote + `gh` ⇒ **GitHub-native**: you can create issues, and the
operator can run the epic link import (Stage 5). Otherwise treat the repo as
**local/lightweight**: programmatic issue creation is unavailable and epic import has
no forge to write to, so the backlog will be left as importable markdown (Stage 5).

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

## 1. Brief

Read the intent. For an existing repo, also survey the codebase (entry points, build
manifest, test setup, domain terms). Produce a short brief (~10 lines): what this
project is, its stack, its domain vocabulary, and what "shipped" means here. Every
later decision is judged against this brief, so it is written once and reused.

**Completion criterion:** a written brief the operator agrees describes the project.

## 3. Decompose (draft)

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

Express dependencies with an `epic-dag` fence — the exact grammar is in `SKILL.md`
under **Gate rules**: members are `#<n>` lines inside the fenced block, and an edge is
`#<dependent> <- #<blocker>[, #<blocker>…]`.

**Draft the entire tree as markdown** — parent epic(s) with their dependency fence,
and each child issue's title + body. This markdown is both the approval artifact and
the format the importer consumes, so it doubles as the local/lightweight fallback.

**Completion criterion:** a complete markdown draft of every epic + issue with
dependencies, sized one-PR-each.
