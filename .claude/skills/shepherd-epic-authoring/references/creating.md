# Stages 2, 3, 5: approve, create, hand off

## 2. Approve (hard gate)

Present the full draft — for promotion, show the parent-body change as
before/after — then **stop**. Use `AskUserQuestion` to confirm, amend, or
abort. If the operator amends, revise and re-present. Nothing is created or
edited before this gate.

## 3. Create (ordered)

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
   - **Create flow:** `gh issue create` the parent with the marker-bearing
     body. Capture its number too.
   - **Promote flow:** `gh issue edit <N> --body "<updated body>"` — the
     existing body plus the fence/task-list. Creating the children while
     leaving `#N`'s body unmarked leaves it a plain issue Shepherd never
     recognizes; the parent edit **is** the promotion.

**Local/lightweight repos** — do not attempt programmatic creation or import.
Write the approved tree to an importable markdown file (e.g. `BACKLOG.md`) and
tell the operator it's the manual reference / future-import source — say this
explicitly rather than failing silently.

## 5. Verify + hand off

Confirm the parent now carries the marker — re-read the body you just wrote
(`gh issue view <PARENT_NUM> --json body`) and check it lists the real
child numbers. Do **not** wait on import: it is the operator's step, so name it
as pending rather than treating it as a precondition. Then stop and point:

- **The epic itself is the deliverable — open NO pull request.** If this
  session was spawned on the issue being promoted, the parent-body marker is
  the finish line.
- **Drain is operator-started.** Shepherd drains each child as its own session
  and its own PR; an agent cannot trigger that itself. Tell the operator the
  epic is ready to drain and name the **DAG roots** (children with no
  blockers) as the first ones to start.
- **Import is the one thing still owed** (GitHub-native repos) — restate it as
  an operator step, with the UI path from Stage 4 in `SKILL.md`, and note that
  it only wires the native links: drain does not wait on it.
