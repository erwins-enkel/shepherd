---
name: shepherd-pull-requests
description: How a Shepherd session opens a pull request - exactly one PR per session, what to do when the work is too large for one (promote to an epic, or ship a slice plus a follow-up issue), and how to declare manual operator steps so they survive merge. Load before running `gh pr create`, or as soon as a task looks like it needs more than one PR.
---

# Opening a pull request from a Shepherd session

A Shepherd session tracks **one** pull request. This is the mechanism talking, not a style
preference: PR detection, the critic, the merge train and the Owed lens are all keyed to a single
PR per session.

## Exactly one PR

When you open a pull request, open exactly one — never a second, and never label work "PR 1 of N."
This holds even when the task or its issue describes multiple parts, phases, or "Part A / Part B."

If the work is genuinely too large for one cohesive PR, pick ONE of:

- **(a) Promote to an epic.** Convert the issue into an epic — create one child issue per intended
  PR and mark the parent body so Shepherd recognizes it (shape below) — open NO pull request
  yourself, then STOP and tell the operator the epic is ready to drain. Shepherd drains each
  sub-issue as its own session and its own PR, but that drain is operator-started: you cannot
  trigger it yourself.
- **(b) Ship one PR + file a follow-up.** Complete and open a single cohesive PR for the slice you
  can finish, then `gh issue create` a follow-up issue capturing the remainder for a later agent,
  and reference it from the PR body. This is the always-safe default.

Never split the work across two PRs from this one session.

## The epic shape (option (a))

Shepherd recognizes an epic ONLY structurally — the parent issue's body must reference each child's
REAL issue number. Create the child issues first (`gh issue create`), capture their numbers, then
edit the parent body to add EITHER a fenced dag block, e.g.:

```epic-dag
#12
#13 <- #12
```

(one `#<n>` line per child; `#<n> <- #<m>` when #n is blocked by #m), OR a task-list with one
`- [ ] #12`-style line per child issue. This body marker is MANDATORY even when the children have
no dependencies. NOT recognized as an epic: an `epic` label, an `[EPIC]` title prefix, or a prose
checklist without `#<n>` issue references.

## Manual operator steps

Before you open the pull request, declare any MANUAL OPERATOR STEPS the change implies — work a
human must do around merge/deploy that the diff itself cannot perform (flip a feature flag, set an
env var, run a one-off backfill/migration, restart a worker, DNS cutover, seed a record). Shepherd
parses these from the PR body and surfaces them on the Owed lens so they survive merge and teardown.

Declare them in the PR body with EITHER carrier:

- A fenced block — each `- [ ]` line is one step:

```shepherd:manual-steps
- [ ] Set the FEATURE_X env var in production
- [ ] POST-MERGE: Run the data backfill once the PR is live
```

- Or column-0 `Manual-Step:` trailer lines (flush-left, outside any fence), e.g. a line reading
  exactly `Manual-Step: Rotate the signing key`.

Prefix a step with `POST-MERGE:` when it must happen AFTER the PR merges.

**DEFAULT TO DECLARING NOTHING.** Most PRs need NO manual steps. Add a step ONLY for a real
out-of-band action a human must take; if merging fully completes the change, OMIT the carrier
entirely. NEVER invent steps to fill the block — a spurious step is worse than none. When in doubt,
declare nothing.

If you have already opened the PR when you realize a step is owed, add it with
`gh pr edit --body` rather than opening a second PR.
