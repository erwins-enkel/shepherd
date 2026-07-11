---
name: shepherd-epic-authoring
description: Author a Shepherd-recognized epic in an attended session — decompose work into child issues, create them, and mark the parent body with the structural epic marker (fenced dag / task-list), optionally wiring native sub-issue + blocked_by links via epic import. Use when asked to create an epic with sub-issues, promote an existing issue #N to an epic, split an issue into child issues, or make a body of work drainable as an epic — especially mid-session, where no injected epic guidance exists.
---

# Shepherd Epic Authoring

Turn an **attended** epic ask into structure Shepherd actually recognizes. Two
flows share the same spine:

- **Create** — "create an epic for X with sub-issues Y, Z".
- **Promote** — "promote existing issue #N to an epic".

Shepherd's spawn-time prompts already carry a short epic-shape contract (the
single-PR invariant's promote hatch, plus an epic-authoring notice when the
spawn prompt signals epic intent). But that detection is **spawn-time only**:
an operator who asks for an epic **mid-session (steer-time)** gets no injected
epic-shape guidance at all — the agent falls back on generic GitHub habits and
ships an "epic" Shepherd never sees. This skill is the remedy for exactly that
gap: invoke it whenever an epic ask arises, at spawn or mid-session. It is
attended by default (unattended drains run with skills disabled unless the
operator opts out of context trimming) and
richer than the injected blocks: it drafts the whole tree, gates outward
actions on approval, and wires native links.

This skill is **self-contained**: it ships in the Shepherd repo and runs in
_other_ operators' repos, so everything it needs is below.

## The recognition contract

Shepherd recognizes an epic **ONLY structurally** — the parent issue's body
must reference each child's **REAL issue number**, via **either** marker:

1. A fenced dag block. One `#<n>` line per child; `#<n> <- #<m>` when `#n` is
   blocked by `#m` (multiple blockers comma-separated). The canonical example:

   ````
   ```epic-dag
   #12
   #13 <- #12
   #14 <- #12, #13
   ```
   ````

2. A task-list — one `- [ ] #12`-style line per child issue (members only, no
   dependency edges).

The body marker is **MANDATORY even when the children have no dependencies**.
Only the **first** fenced dag block in a body is parsed — keep exactly one.

**NOT recognized:** an `epic` label, an `[EPIC]` title prefix, a prose
checklist without `#<n>` issue references, front-matter, or HTML markers. None
of these exist in Shepherd's parser — don't reach for them.

## Draft-only mode (Shepherd epic-draft flow)

If the system prompt carries an **`<epic-authoring-directive>`** with an epic-draft endpoint
(`PUT …/api/sessions/<id>/epic-draft`), Shepherd's guided epic-draft flow is driving this session.
In that mode the hard gate and the GitHub writes are **owned by the server**: follow ONLY the
decomposition guidance below (Stage 1), emit the draft by PUTting it to that endpoint, then **STOP**.
Do **not** perform Stages 3–5 (`gh issue create`/`gh issue edit`, the epic-import endpoint) — the
operator approves the draft in the UI and the server materializes it. The directive is authoritative;
this skill only lends it the slicing/authoring guidance.

## Stages

Work the stages in order; track one todo per stage. **Nothing outward (issue
creation, body edits, epic import) happens before the Stage 2 approval gate.**

### 0. Orient

Pin two facts, then confirm them with the operator:

**Flow** — create a new epic, or promote an existing issue `#N`? For
promotion, read the current parent (`gh issue view <N> --json title,body`) so
the draft builds on what's there.

**Tracker** — GitHub-native or local/lightweight:

```bash
git remote -v                      # is there a GitHub remote?
gh auth status 2>/dev/null         # is gh usable?
```

A working GitHub remote + `gh` ⇒ **GitHub-native** (issue creation + epic
import available). Otherwise **local/lightweight**: programmatic creation and
import are unavailable (import asserts a GitHub-native forge) — the deliverable
becomes an importable markdown file instead (see Stage 3).

### 1. Draft

Decompose the work into **tracer-bullet vertical slices**: each child is a
thin end-to-end cut with an observable result, sized so it lands in a single
PR — **one slice = one PR = one Shepherd session**. A child too big for one PR
is itself an epic; split it further. Each child gets a crisp title and a body
stating the goal, the vertical cut, and a checkable acceptance criterion.

Draft the **entire tree as markdown**: every child's title + body, and the
parent body carrying the dag fence (or the task-list when there are no
dependencies) with placeholder numbers to be filled in at Stage 3. This draft
is both the approval artifact and the local/lightweight fallback.

### 2. Approve (hard gate)

Present the full draft — for promotion, show the parent-body change as
before/after — then **stop**. Use `AskUserQuestion` to confirm, amend, or
abort. If the operator amends, revise and re-present. Nothing is created or
edited before this gate.

### 3. Create (ordered)

Only after approval. **GitHub-native repos** — order matters, because the
parent marker must reference real child numbers:

1. **Create the child issues first and capture their numbers.**
   `gh issue create` prints the new issue URL; the trailing path segment is
   the number:

   ```bash
   url=$(gh issue create --title "<title>" --body "<body>")
   num=${url##*/}          # e.g. 142
   ```

   Repeat per child, recording each `num`.

2. **Mark the parent body** with the captured numbers:
   - **Create flow:** `gh issue create` the parent with the fence-bearing
     body. Capture its number too.
   - **Promote flow:** `gh issue edit <N> --body "<updated body>"` — the
     existing body plus the fence/task-list. Creating the children while
     leaving `#N`'s body unmarked leaves it a plain issue Shepherd never
     recognizes; the parent edit **is** the promotion.

**Local/lightweight repos** — do not attempt programmatic creation or import.
Write the approved tree to an importable markdown file (e.g. `BACKLOG.md`) and
tell the operator it's the manual reference / future-import source — say this
explicitly rather than failing silently.

### 4. Import (GitHub-native only)

The body marker alone already makes the epic recognized and drainable; import
additionally wires **native sub-issue + `blocked_by` links**. It is **not**
automatic — trigger it per parent:

```bash
curl -s -X POST -G "http://127.0.0.1:7330/api/epic/import" \
  --data-urlencode "repo=$(git rev-parse --show-toplevel)" \
  --data-urlencode "parent=<PARENT_NUM>"
```

(`-G --data-urlencode` keeps the POST while URL-encoding the query, so a repo
path containing a space or `&` can't break the request.)

(Use your Shepherd server's host/port; `7330` is the default.) The response
reports `subIssuesAdded` / `dependenciesAdded` / `unresolved`. Re-check any
`unresolved` member numbers — they usually mean a typo'd or foreign issue
reference in the parent body — fix the body and re-import.

### 5. Verify + hand off

Confirm the parent now carries the marker (and, if imported, the native
links). Then stop and point:

- **The epic itself is the deliverable — open NO pull request.** If this
  session was spawned on the issue being promoted, the parent-body marker is
  the finish line.
- **Drain is operator-started.** Shepherd drains each child as its own session
  and its own PR; an agent cannot trigger that itself. Tell the operator the
  epic is ready to drain and name the **DAG roots** (children with no
  blockers) as the first ones to start.

## Gate rules (reference)

- **Outward actions are gated** on the Stage 2 approval — drafting is always
  safe; creating, editing, and importing are not.
- **GitHub-only operations:** `gh issue create` / `gh issue edit` and the epic
  import endpoint require a GitHub-native forge; local/lightweight repos get
  the markdown fallback.
- **Marker grammar:** members are `#<n>` lines inside the fenced dag block; an
  edge is `#<dependent> <- #<blocker>[, #<blocker>…]`; the task-list variant
  lists members only. Real numbers, one fence, marker mandatory.
- **No PR:** when the ask is to author or promote an epic, stop once the
  parent body carries the marker (and import, where available, reports no
  `unresolved`).
