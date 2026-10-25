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

A working GitHub remote + `gh` ⇒ **GitHub-native**: the backlog goes to Shepherd as
an epic draft and the server creates the issues on approval (Stage 5). Otherwise treat
the repo as **local/lightweight**: there is no forge to create issues on, so the
backlog will be left as importable markdown (Stage 5).

**Intent source:**

- Existing: `README`, any `docs/`, stated goals from the operator, and the current
  issue list (`gh issue list --limit 50` if GitHub-native).
- Greenfield: a PRD/spec doc in the repo (look in the root and `docs/`), plus the
  foundation decisions Bootstrap P3 recorded (in the PRD and `CLAUDE.md`) —
  including its list of **M0 candidates** (app shell, shared components).

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

Read the intent, then survey the **scaffold that actually exists** — never guess it:

```bash
cat package.json 2>/dev/null; cat Cargo.toml 2>/dev/null   # manifest, scripts, deps
ls .github/workflows 2>/dev/null                           # CI present?
git ls-files | grep -Ei 'routes?/|pages?/|app\.' | head -40 # routes + app shell
```

Note the routes, app shell, shared components, test setup, domain terms, and the
stack pins in `CLAUDE.md`. If a manifest that builds and CI on `main` already exist,
Bootstrap P2 ran: record that — the decomposition must not re-scaffold. Produce a short brief (~10 lines): what this
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
- **Acceptance criteria never contain version numbers** — write "on the pinned stack
  in CLAUDE.md". Shepherd rejects a draft that pins one.
- **Cut against the real scaffold** from the brief: extend the routes, shell and
  components that exist; name them as anchors.
- **No "project scaffold" slice** when Bootstrap P2 ran (manifest + CI on `main`).
  Only an unscaffolded existing repo might need one — and then point at Readiness /
  Bootstrap instead of drafting tooling yourself.
- **Start from P3's M0 candidates** when present (app shell, shared components): they
  become the first slices / the first milestone, ahead of feature slices that use them.
- **Don't bake concrete file paths into an issue body.** An issue can sit in the
  backlog for weeks before it drains, and paths named in it may have moved or been
  renamed by then — the draining agent then follows a stale map. Point at stable
  anchors (a module/feature name, an exported symbol, a glob) and let the agent
  locate the current files when it picks the issue up.

Express dependencies as edges between children: give each child a short stable
`key` (e.g. `c1`) and list the keys it is `blockedBy`. Don't write issue numbers or an
`epic-dag` fence — the server builds the fence from real numbers when it creates the
issues.

Siblings with no edge between them run in parallel. If two of them will edit the same
files (a shared message catalog, a registry, a schema), the second to merge conflicts.
List each child's likely-touched stable anchors (a module, a glob, a catalog) in its
`touches` field — review-only, never written into the issue — and give siblings that
share an anchor a `blockedBy` edge.

**Draft the entire tree as markdown** — parent epic with goal, acceptance criteria
and non-goals, and each child's key, title, body, acceptance criteria and blockers.
It is the approval artifact (Stage 4), maps 1:1 onto the `epic_draft` submission, and
doubles as the local/lightweight `BACKLOG.md` fallback.

**Completion criterion:** a complete markdown draft of the epic + every child with
dependencies, sized one-PR-each, no versions in any acceptance criterion.
