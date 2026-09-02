---
title: Concepts & glossary
description: The Shepherd-specific and industry terms used throughout the app and these docs.
---

These are the terms Shepherd uses across the UI and this documentation. The same
definitions drive the inline term tooltips in the app (registry:
`ui/src/lib/glossary.ts`).

If you already know your way around, **Settings → Device → "Hide info tooltips"**
(off by default, per-device) removes those dashed-underline glossary terms along
with the app's ⓘ info icons; the terms stay in the text as plain words. Status
chip and badge tooltips are unaffected. This page remains the full reference
either way.

## Shepherd concepts

### Epic

In Shepherd, a tracking issue whose sub-issues are wired by dependency edges —
Shepherd spawns a session per ready child, collects their PRs on an integration
branch, and lands everything as one final PR. (From Agile, where an epic is a
large body of work split into smaller stories.)

### Plan gate

A checkpoint before execution: the agent first researches the task, asks you what
it needs, and writes an implementation plan that a second agent adversarially
reviews, revising until the plan holds up or a round limit is reached. **Who
releases the approved plan into execution depends on Autopilot** — with Autopilot
off you give the explicit Go; with it on (or for a drain-spawned session) Shepherd
releases it itself. On Codex that automatic release additionally requires an
isolated worktree: a session sharing its working directory waits for your Go even
with Autopilot on. Either way, a gated agent asks you its questions first:
Autopilot stands down for the whole planning phase.

### Autopilot

Best-effort automation that drives a task through its routine stops to an open
pull request. It never merges — landing a PR is the [merge train](#merge-train),
which requires Autopilot **and** full-auto merge. Switched off, every step stays
with you, and no automatic merge is possible at all. On Codex it applies only
when Shepherd owns an isolated worktree, and stands down entirely without one —
its resume path would otherwise target a sibling session in the shared directory.

### Critic

Shepherd's isolated, read-only review agent that inspects a PR's diff once CI is
green and posts a verdict. Its built-in lenses are the floor; a repository can
add passes and known exclusions with a committed `REVIEW.md`, and the repo's
house rules are shown to the critic alongside them — see
[Review policy](/reference/review-policy/).

### Merge train

Shepherd's queue that carries a ready PR through rebase and merge automatically,
landing it once CI stays green.

### REWORK

A session sent back to revise its work after the plan gate or PR critic requested
changes, instead of approving it.

### First-pass rate

The share of merged tasks that passed review in a single clean round — no rework
requested. Tasks that were never reviewed are left out of the calculation
entirely rather than counted as passes.

### First-push CI green

The share of merged tasks whose first observed CI result was green — the change
passed CI outright, with no red round before it. It measures what Shepherd saw: a
push made before the PR opened is not counted. Tasks in repos without CI, and
tasks whose CI was never observed finishing, are left out rather than counted as
failures.

### Plan drift

How far a merged change departed from the plan approved before it was written, as
reported by the PR critic: none, minor or major. It never affects the review's
verdict — departing from a plan is legitimate. It is measured because a repo that
drifts constantly is usually writing vague plans, not writing bad code.

### Maintain loop

A daily check of Shepherd's own health signals against declared thresholds. A
mild breach is logged; a sustained one spawns a read-only agent that drafts a
backlog issue for you to triage. For one pre-approved class of mechanical fix it
skips the issue and opens a pull request instead. It watches Shepherd itself —
never a production system.

### Band

One health signal plus the thresholds that decide what happens when it is
crossed: tier 1 logs a reading, tier 2 spawns a diagnosis. A band whose
remediation is mechanical enough to be pre-approved is promoted to tier 3
instead, which opens a pull request. A band below its minimum sample size reports
nothing rather than a misleading number.

### Inferred

Derived by the recap model from the code — not verified against the real diff.
Treat it as a hint, not ground truth.

### Lightweight repo

A repo Shepherd drives with local git only — no Forge, no GitHub, no PRs, no
remote. When a task finishes, the agent's branch is squash-merged into the base
branch locally; the operator pushes to a remote when they choose.

### Trial

A proposed house rule auto-promoted to active on strong, multi-source evidence,
injected at lowest priority while it proves itself. It is auto-removed if it
underperforms (Wilson auto-retire) or stays inert, and can be reverted to the
queue by hand.

### Weighted units

A model-weighted measure of token spend that counts what actually draws down your
subscription limits — output tokens cost far more than cached reads, so weighted
units, not raw token counts, reflect true usage.

### Reasoning effort

A cost/quality dial (`low`, `medium`, `high`, `xhigh`, `max`) that sets how much
the model reasons before answering — higher effort spends more tokens for deeper
reasoning, lower is faster and cheaper. Selectable per session in the New Task
picker — and when spawning a variant, comparison, or replacement — with a per-repo
or global default in Settings, plus a per-role override for each satellite pass
(critic, planner, recap, doc-agent, distiller, optimizer, merge-suggester, namer,
autopilot) in the Settings agent matrix;
leave it at **default** to use the CLI's own effort. Shepherd passes it to the
agent CLI as `--effort` (Claude) or `model_reasoning_effort` (Codex).

### Satellite pass

An automated LLM pass Shepherd spawns alongside the main task agent — critic /
PR-review, plan-gate, recap, or doc-agent. Its token spend is real
overhead attributed back to the task, on top of the agent's own authoring.

### Host capacity

Whether Shepherd's systemd service — or the slice it runs in — sets a memory or
CPU ceiling (`MemoryHigh`, `MemoryMax`, `CPUQuota`). Without one, a burst of
concurrent sessions can consume all the host's RAM or CPU and starve the box; the
**Host capacity** row in Settings → Diagnose warns until a limit is set. See
[Operating Shepherd](/operating/).

### herdr runtime hygiene

Shepherd reconciling herdr's panes and processes against its own session model to
spot leftovers. It counts the panes that still hold a live process — deliberately
not systemd's **Tasks** figure for the herdr service, which counts threads. Each
agent process spawns many, so a Tasks count in the thousands is normal and not by
itself a process leak.

### Sandbox membrane

The confined view of the filesystem Shepherd builds around an agent it starts,
using bubblewrap. The agent sees the one worktree it is working in plus the
programs it needs to run; everything else is hidden or read-only — so a prompt
from an issue, a pull request or a plan cannot reach the rest of the machine. The
residuals it deliberately does not close are listed on the
[Security](/reference/security/) page.

### Spawn prompt

The standing instructions Shepherd assembles and hands an agent the moment it
starts — house rules, safety notices and the directive for this kind of task. It
rides every turn of the session, so its size is paid for again and again.

### Access token

A named credential a machine client sends in the `Authorization` header as a
bearer, instead of logging in with the operator password. Shepherd shows the
value once when you mint it and stores only a hash of it, so a single token can
be revoked on its own — unlike the shared `SHEPHERD_TOKEN` environment variable,
which every client presents identically. How far it reaches is its
[token scope](#token-scope).

### Token scope

How far a minted [access token](#access-token) reaches, chosen when you create it
and fixed for its lifetime; the app labels it simply **scope**. **Read** can list
sessions, holds and git status and follow live updates. **Submit** adds handing
work in — starting a session, queueing or releasing a held task, attaching a
file, filing an issue. **Full** is the access you have yourself, including typing
into a running agent's terminal. Anything a scope doesn't cover is refused, so a
client can only do what you granted it. `SHEPHERD_TOKEN` has no scope; it always
has full reach.

## Industry terms

### PR

Pull request — a proposed set of code changes submitted for review and merging
into a branch. ([Wikipedia](https://en.wikipedia.org/wiki/Distributed_version_control#Pull_requests))

### CI

Continuous integration — automatically building and testing every change so
problems surface early. ([Wikipedia](https://en.wikipedia.org/wiki/Continuous_integration))

### Telemetry

Automatic collection of anonymous usage and diagnostic data from software, sent
back to its developers to guide improvements. In Shepherd it is off until you opt
in, respects `DO_NOT_TRACK`, and never includes code or personal data — see
[Configuration](/reference/configuration/#anonymous-usage-telemetry).
([Wikipedia](https://en.wikipedia.org/wiki/Telemetry#Software))

### Lead time

How long a task took end to end: from the moment the session was created to the
moment its pull request merged. Borrowed from lean manufacturing, where it
measures the delay between a request and its delivery.
([Wikipedia](https://en.wikipedia.org/wiki/Lead_time))

### Inode

A filesystem's record for one file or directory. A filesystem has a limited
number of them, set when it is created — so it can run out of inodes while still
having free space, and every new file then fails as though the disk were full.
([Wikipedia](https://en.wikipedia.org/wiki/Inode))
