---
title: Running Shepherd alongside Claude Ship
description: Turn on Anthropic's Claude Ship for a repo Shepherd drains without the two pushing over each other or paying for review twice.
---

[Claude Ship](https://code.claude.com/docs/en/claude-ship) is Anthropic's PR loop. It
runs through the Claude GitHub App on Team and Enterprise plans, GitHub only, and has
three parts:

- **Code Review** posts a `Claude Code Review` check run with findings.
- **PR Steward** keeps a PR green. It fixes failing checks and resolves conflicts by
  **merging base into the branch**.
- **Claude Approvals** reads `.claude/approvals.yml` and posts a `Claude Approvals`
  check that can wait on a human.

Shepherd already does the same jobs with the critic, the autopilot steers and the merge
train. This page covers how to run both on one repo.

## Use GitHub App credential mode

The biggest risk is **two agents pushing to one branch**. Steward merges base in, while
Shepherd's conflict steer rebases and force-pushes, which discards Steward's commits.

Whether Steward acts on a Shepherd PR depends on who opened it. Set
`SHEPHERD_AGENT_GH_APP_ID` and `SHEPHERD_AGENT_GH_APP_KEY_FILE` (see
[Configuration](/reference/configuration/)), and task agents open PRs as your GitHub App,
which is a bot. Anthropic's docs say Steward skips bot-opened PRs.

| Agent credential mode                               | PR opened by     | Steward acts on it?   |
| --------------------------------------------------- | ---------------- | --------------------- |
| GitHub App (`SHEPHERD_AGENT_GH_APP_ID`/`_KEY_FILE`) | your App (a bot) | No: no collision      |
| Operator token (default)                            | your own login   | Yes: collision        |
| `SHEPHERD_AGENT_GH_TOKEN_FILE` (machine user)       | the machine user | Probably (unverified) |

**Recommended:** use GitHub App mode on any repo with Claude Ship. If you can't, turn on
[Leave fixes to Claude's PR Steward](#leave-fixes-to-claudes-pr-steward).

## What Shepherd detects

On a GitHub PR, Shepherd treats Claude Ship as active when it sees any of:

- the `claude-pr-steward-watching` label (Steward is watching and may push),
- a check run from the Claude GitHub App named exactly `Claude Code Review` or
  `Claude Approvals`.

A GitHub Actions job with one of those names stays CI. Only the App's own runs count.

### The badge

A **Claude Ship** badge appears on the session card and in the PR rail. It reads
**Awaiting approval** while Claude Approvals holds the PR, and **Steward fixes** while
Shepherd [leaves fixes to Steward](#leave-fixes-to-claudes-pr-steward). Hover it to see
what Steward, Code Review and Approvals are doing, and what Shepherd does about it.

### Claude checks are review gates, not CI

Neither Claude check counts toward the PR's CI state. A failing `Claude Approvals` check
waits on a human, so no commit can fix it: it never turns CI red and never sends the
agent a CI-fix steer.

### The merge train waits on Claude Approvals

Full auto-merge holds a PR with the wait code `approval_pending` ("the Claude Approvals
check waits on a human approval. Approve it on GitHub") while the check is pending or
failing. A successful check clears it, and so does a neutral or skipped result (observe
mode). The train waits even when branch protection doesn't require the check.

## Per-repo settings

Both settings are off by default, live in **Repo settings**, travel in
`.shepherd/config.json` (see [Shared repository rules](/repo-config/)) and only act on PRs
where Shepherd sees the matching Claude Ship signal. A repo without Claude Ship behaves
exactly as before.

### Leave fixes to Claude's PR Steward

**Repo settings › Merge** (`claudeShipStewardDefer`). While a PR carries the
`claude-pr-steward-watching` label, Shepherd sends no rebase, CI-fix or base-moved steer
for it, and the merge train never rebases it. Only Steward pushes.

- A conflict or red CI waits on Steward: wait code `steward_watching`.
- A PR that is only behind its base waits on you: `steward_behind`. Update the branch on
  GitHub or remove the label.
- Removing the label restores Shepherd's steers.

Turn it on when agents don't run in GitHub App mode. In App mode Steward skips Shepherd's
PRs, so the setting has nothing to do.

### Claude Code Review replaces the Critic

**Repo settings › Review** (`claudeReviewSkipsCritic`). When a `Claude Code Review` check
run is on a PR's latest commit, running or finished, Shepherd starts no critic run for
that commit, so the same code isn't reviewed and paid for twice. Full auto-merge, the
drain and autopilot then wait for the check instead of a critic verdict:

- Success or neutral clears the PR.
- Running holds it: wait code `code_review_pending`.
- Failed holds it: `code_review_failed`. A push that addresses the findings re-runs the
  review.

Code Review's findings arrive as PR review comments, which reach the agent through PR
review feedback. Commits without a Code Review check (it can run once per PR, or not be
installed) still get the critic once CI is green.

It needs the critic on. Sign-off by "Critic" alone is unavailable while it's on: switch
draft-mode sign-off to "Human" or "Human or Critic".

Turn it on when you'd rather pay for Claude Code Review than run the critic on the same
commits.

## Start Claude Approvals in observe mode

Begin with `mode: observe` in `.claude/approvals.yml`. In observe mode the check finishes
without a verdict, so the badge tooltip reads "finished without a verdict (observe mode)"
and the merge train never waits on it. Watch what it would have decided on a few
Shepherd PRs, then switch to `mode: enforce`. From then on the train holds each PR as
`approval_pending` until a human approves on GitHub.
