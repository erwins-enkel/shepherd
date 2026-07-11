---
title: Authoring an epic
description: Step-by-step guide to structuring a GitHub epic that Shepherd recognizes and can drain — native sub-issues, the epic-dag fence, and the checklist fallback.
---

An **epic** is a tracking issue whose children are wired by dependency edges: Shepherd spawns a
session per ready child, collects their PRs on a shared integration branch, and lands everything as
one final PR. See [Concepts & glossary](/reference/glossary/) for the model, and
[Hands-off epics](/hands-off-epics/) for running one once it exists.

This page is the other half — how to **author** an epic Shepherd will recognize. Recognition is
**purely structural**: Shepherd reads the parent issue's structure, never a label or a title. Get
the structure right and the epic shows up in Shepherd, ready to drain; get it wrong and the parent
stays a plain issue Shepherd never sees.

## What "recognized" means

Shepherd treats a parent issue as an epic when **either** is true:

- The parent has **native GitHub sub-issues**, or
- The parent **body references child issue numbers** — an `epic-dag` fence or a `- [ ] #123`
  checklist.

Everything hinges on **real child issue numbers**. That drives the ordering of the whole process:
create the children first, capture their numbers, then mark the parent with those numbers. A marker
written before the children exist has nothing valid to point at.

:::caution[What Shepherd does NOT recognize]
None of these make an issue an epic — each is silently ignored, leaving a plain issue:

- An **`epic` label**.
- An **`[EPIC]` title prefix**.
- A **prose checklist** with no `#<number>` references (e.g. `- [ ] Build the API`).
- **Placeholder lines** like `#<n>` or `#child` — the parser needs literal digits.
- **YAML front matter** or **HTML markers/comments**.

There is no label, title, or front-matter convention anywhere in Shepherd. If your epic isn't
showing up, it's almost always one of these.
:::

## Step 1 — New epic, or promote an existing issue?

Two starting points, same finish line (a parent whose body/links reference real children):

- **New epic** — you have an idea and no issue yet. You'll create the children and a fresh parent.
- **Promote an existing issue `#N`** — you already have an issue that's really several PRs of work.
  You keep `#N` as the parent and **edit its body** (or attach sub-issues) to add the marker.
  Creating children while leaving `#N`'s body unmarked leaves `#N` unrecognized — the parent edit
  **is** the promotion.

## Step 2 — Split the work into child issues

Break the work into children where **one child = one PR = one Shepherd session**. Each child should
be a thin, end-to-end slice with an observable result, small enough to land in a single PR. A child
too big for one PR is itself an epic — split it further.

Give each child a crisp title and a body stating the goal and a checkable acceptance criterion. The
child's body is forwarded verbatim as the spawn brief, so write it for the agent that will pick it
up.

## Step 3 — Create the children first and capture their numbers

Create the child issues **before** marking the parent, and record each issue number — the marker
must reference the real numbers.

```bash
url=$(gh issue create --title "Add the widget API endpoint" --body "Goal: ... Acceptance: ...")
num=${url##*/}          # gh prints the new issue URL; the trailing segment is the number, e.g. 142
echo "$num"
```

Repeat per child, keeping the numbers. (In the GitHub web UI, the number is the `#142` shown on the
created issue.)

## Step 4 — Mark the parent (choose one shape)

Pick **one** of the three recognized shapes. Native sub-issues are preferred; the two markdown
shapes are fallbacks.

### Native sub-issues (preferred)

Attach each child to the parent as a GitHub **sub-issue** (on the parent issue, use **Create
sub-issue → Add existing issue** and reference each child number). Ordering and dependencies come
from issue **`blocked_by`** relationships (GitHub's issue *dependencies*).

This is the safest shape for gating: Shepherd reads each child's open/closed state and its
dependency edges directly from GitHub, with no reliance on scanning the repo's issue list. Prefer it
— especially in large repos (see [Why native links matter](#step-6--import-a-markdown-epic-into-native-links)).

### `epic-dag` fence (markdown)

Add exactly **one** fenced block to the parent body. One `#<number>` line per child; add
`<- #<blocker>` to declare a dependency (multiple blockers comma-separated):

````markdown
```epic-dag
#12
#13 <- #12
#14 <- #12, #13
```
````

That reads: `#12` is a root; `#13` is blocked by `#12`; `#14` is blocked by both `#12` and `#13`.
Lines must use **literal digits** — a `#<n>` placeholder is unparseable. Only the **first**
`epic-dag` fence in the body is read, so keep exactly one.

### Checklist (markdown, no dependencies)

When the children have **no** ordering between them, a task-list works. One `- [ ] #<number>` line
per child:

```markdown
- [ ] #12
- [ ] #13
- [ ] #14
```

A checklist carries **members only, no dependency edges** — every child is a root and they all drain
in parallel. The checkbox state (`[ ]` vs `[x]`) is ignored for recognition; done-ness comes from
the issue being closed or merged, not the box.

:::note[Which shape wins if you mix them]
Precedence is deterministic: **native sub-issues win over the markdown body**; within the body an
**`epic-dag` fence wins over a checklist**; and only the **first** fence is read. Don't rely on
mixing — pick one shape and keep the parent tidy.
:::

## Step 5 — Add dependency edges

If some children must land before others, express the ordering:

- **Native:** add a **`blocked_by`** relationship on the dependent child (issue dependencies).
- **`epic-dag`:** add `<- #<blocker>` on the child's line — `#13 <- #12` means "#13 is blocked by
  #12"; comma-separate multiple blockers.
- **Checklist:** no edges are possible — every child drains in parallel. If you need ordering, use
  the fence or native links instead.

Children with no blockers are the **DAG roots** — Shepherd starts those first, then drains the rest
as their blockers complete.

## Step 6 — Import a markdown epic into native links

If you authored the epic in markdown (fence or checklist), Shepherd's Epic panel shows an **Import
structure** button (it appears only for markdown-source epics). Clicking it wires each member as a
native GitHub sub-issue and each dependency as a `blocked_by` relationship — converting your markdown
epic into the native shape. Once imported, the epic resolves natively and the button disappears.

**Why import (or author native from the start):** the markdown path resolves each child against the
repo's open-issue list, which Shepherd reads **capped at 200 issues**. In a large repo, a child
beyond that cap can be misread as closed and spawned prematurely. Native sub-issue links carry each
child's state and edges directly, so gating stays exact regardless of repo size. In small repos
markdown is fine; in large ones, prefer native — import is the one-click path to get there.

## Step 7 — Verify in Shepherd before draining

Before you start the drain, open the parent issue's **Epic panel** in Shepherd and confirm:

- Every child you expect is listed, with the right **state** chips.
- Dependency edges look right — blocked children show what they're **blocked on**.
- Any **warnings** on the panel are understood and clear (for example, the markdown 200-cap warning
  is a prompt to import into native links).

When the tree looks right, follow [Hands-off epics → Starting the epic](/hands-off-epics/#starting-the-epic)
to drain it. Shepherd spawns the first ready child, then drains the rest as their dependencies
complete, landing one aggregate PR at the end.
