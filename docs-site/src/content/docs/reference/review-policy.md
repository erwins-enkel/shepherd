---
title: Review policy (REVIEW.md)
description: How a repository steers Shepherd's PR critic with a version-controlled REVIEW.md, why the file is read from the base commit rather than the pull request, and how the repo's own house rules now reach the reviewer.
---

Shepherd's PR critic runs a fixed set of built-in review lenses. A repository can **add** to them
with a version-controlled policy file, and the house rules Shepherd already injects into the agent
that *writes* the code are now also shown to the agent that *reviews* it.

Neither is a setting. There is nothing to switch on: commit the file, and the next review reads it.

## `REVIEW.md`

Put the policy at **`REVIEW.md`** in the repository root, or at **`.shepherd/review.md`** if you
would rather not spend a root-level file. If both exist, `REVIEW.md` wins.

It is ordinary Markdown — extra passes you want run, areas you do not want reviewed, severity
guidance specific to this codebase:

```markdown
# Review policy

## Extra passes

- **Migrations.** Any change under `db/migrations/` gets a rollback pass: does the down-migration
  actually reverse the up-migration, and is it safe to run against a populated table?
- **Public API.** A change to `src/api/**` is a compatibility surface — call out anything a
  published client would notice.

## Known exclusions

- `src/generated/**` is code-generated. Do not review its style or structure; review the generator.
- We test the CLI by hand. A missing test for `bin/**` is not a finding here.
```

Both critics read it: the session critic that reviews a Shepherd task's own PR, and the standalone
critic that reviews every open PR in a repository with **Review all PRs** on. The policy belongs to
the *repository*, not to who opened the pull request.

## It is read from the base commit

The critic reads the policy from the **base commit of the pull request** — the merge target — not
from the branch it is reviewing.

That is deliberate, and it is the reason the policy can steer a review at all. Everything the critic
reads out of a pull request (the diff, the description, the plan, review comments) is fenced as
untrusted data that it is instructed never to obey; otherwise a pull request could talk its way past
its own review. `REVIEW.md` is the exception: it is handed over as genuine instruction. What makes
that safe is that the text can only come from work the repository has **already reviewed and
merged** — a branch cannot rewrite the rules it is about to be judged by, which matters most for a
pull request from a fork.

The consequence to know about: **the pull request that adds or edits `REVIEW.md` is not reviewed
under it.** The new policy takes effect once it lands on the base branch.

## The built-in lenses stay the floor

The policy may only add. Shepherd's own contract — the scope rules, the verification discipline,
findings routing, and the verdict format — is not negotiable by a file in the repository.

Concretely:

- The policy **may** add review passes, add emphasis, and state repo-specific severity guidance.
- It **may** declare known exclusions that narrow which areas or which classes of issue the critic
  spends attention on.
- An exclusion **may never** suppress a correctness or security defect the critic actually verified
  in the diff.
- Anything raised under the policy is routed like any other point: it becomes a finding, carrying
  the severity and pass the critic declares for it. The policy adds passes, not a new kind of
  output.

The file is capped at about 8 KB. A longer one is truncated with a visible marker rather than
silently cut — but a review policy that runs past a page is probably documentation in the wrong
place.

## Severity: Important and Nit

Every point the critic raises is declared with a **severity** and a **pass**.

- **Important** is work the author must do: a correctness bug, a security issue, a broken contract,
  a missing catalog counterpart, or a change that does not do what the task asked. Only important
  findings are sent back to the agent, count toward the rework budget, and hold up the merge train.
  A verdict that raises nothing important is a comment, never a request for changes.
- **Nit** is everything non-blocking — a naming preference, a stylistic choice, a refactor you would
  like but the task did not require. Nits are recorded and posted in the review's
  `Nits (non-blocking):` section, and they are never sent back as work. At most five survive per
  review; the rest are discarded, so the critic is asked to pick the five worth reading.

The **pass** names where the point came from — `bug`, `security`, `compliance` (a repo policy, house
rule, or catalog requirement) or `scope`. It is classification only: nothing gates on it.

A repository's policy can state which classes of issue matter more here, but it cannot change what
the two severities mean, and an exclusion still may never suppress a verified correctness or
security defect.

## House rules reach the reviewer

Shepherd injects a repository's curated **house rules** into the system prompt of every agent that
works in it. The critic is now shown that same body of rules as the repository's standard, so it can
judge a pull request against the conventions the repo actually holds itself to. They are scoped to
the files the pull request touches, and they follow the repository's existing **Learnings**
setting — with learnings off, no rules are injected anywhere.

The set the critic sees is **planned fresh for that review**, from the rules active at the time and
the files the diff touches. It is not a replay of what any particular agent was given, and it is not
limited to pull requests Shepherd wrote: a third-party or fork pull request is reviewed against the
same repository standard. Where Shepherd's own session critic reviews a PR one of its agents wrote,
the critic is additionally told so — a rule the author was handed and ignored is worth catching —
but the rules apply either way.

House rules are distilled from past sessions, so they are treated as guidance rather than law: a
**clear, unambiguous** violation is a blocking finding; anything softer is reported as a
non-blocking note. A rule that has gone stale can slow a review down; it cannot deadlock one.

Reviewer-side injection does not count toward a rule's usage statistics — the helpfulness record
that retires an underperforming rule is still kept by the sessions that *write* code.
