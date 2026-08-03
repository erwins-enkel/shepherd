# Stages 0–1: orient and draft

## Draft-only mode (Shepherd epic-draft flow) — check this first

If the system prompt carries an **`<epic-authoring-directive>`** with an epic-draft endpoint
(`PUT …/api/sessions/<id>/epic-draft`), Shepherd's guided epic-draft flow is driving this session.
In that mode the hard gate and the GitHub writes are **owned by the server**: follow ONLY the
decomposition guidance below (Stage 1), emit the draft by PUTting it to that endpoint, then **STOP**.
Do **not** perform Stages 3–5 (`gh issue create`/`gh issue edit`, the import handoff) — the
operator approves the draft in the UI and the server materializes it. The directive is
authoritative; this skill only lends it the slicing/authoring guidance.

## 0. Orient

Pin two facts, then confirm them with the operator:

**Flow** — create a new epic, or promote an existing issue `#N`? For
promotion, read the current parent (`gh issue view <N> --json title,body`) so
the draft builds on what's there.

**Tracker** — GitHub-native or local/lightweight:

```bash
git remote -v                      # is there a GitHub remote?
gh auth status 2>/dev/null         # is gh usable?
```

A working GitHub remote + `gh` ⇒ **GitHub-native**: you can create issues, and
the operator can run the link import (Stage 4). Otherwise **local/lightweight**:
programmatic creation is unavailable and import has no forge to write to — the
deliverable becomes an importable markdown file instead (see Stage 3).

## 1. Draft

Decompose the work into **tracer-bullet vertical slices**: each child is a
thin end-to-end cut with an observable result, sized so it lands in a single
PR — **one slice = one PR = one Shepherd session**. A child too big for one PR
is itself an epic; split it further. Each child gets a crisp title and a body
stating the goal, the vertical cut, and a checkable acceptance criterion.

Draft the **entire tree as markdown**: every child's title + body, and the
parent body carrying the dag fence (or the task-list when there are no
dependencies) with placeholder numbers to be filled in at Stage 3. This draft
is both the approval artifact and the local/lightweight fallback.

**Don't bake concrete file paths into a child body.** A child issue can sit in
the backlog for weeks before it drains, and by then the paths named in it may
have moved or been renamed — the draining agent then follows a stale map. State
the goal, the behaviour, and the acceptance criterion; point at stable anchors
(a module/feature name, an exported symbol, a glob) rather than exact paths, and
let the agent locate the current files when it picks the issue up.

The exact marker grammar the parent body must carry is in `SKILL.md` under
**The recognition contract** — use it verbatim.
