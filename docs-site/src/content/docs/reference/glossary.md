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

### Critic

Shepherd's isolated, read-only review agent that inspects a PR's diff once CI is
green and posts a verdict.

### Merge train

Shepherd's queue that carries a ready PR through rebase and merge automatically,
landing it once CI stays green.

### REWORK

A session sent back to revise its work after the plan gate or PR critic requested
changes, instead of approving it.

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
(critic, planner, recap, doc-agent, distiller, optimizer, merge-suggester, rundown,
namer, autopilot) in the Settings agent matrix;
leave it at **default** to use the CLI's own effort. Shepherd passes it to the
agent CLI as `--effort` (Claude) or `model_reasoning_effort` (Codex).

### Satellite pass

An automated LLM pass Shepherd spawns alongside the main task agent — critic /
PR-review, plan-gate, recap, rundown, or doc-agent. Its token spend is real
overhead attributed back to the task, on top of the agent's own authoring.

### Host capacity

Whether Shepherd's systemd service (or its slice) sets a memory or CPU ceiling —
`MemoryHigh`, `MemoryMax`, or `CPUQuota`. Without one, a burst of concurrent
sessions can consume all the host's RAM or CPU and starve the box; the
Diagnostics check warns until a limit is set. See
[Operating Shepherd](/operating/#host-tuning--resource-guardrails).

### herdr runtime hygiene

Shepherd reconciles herdr's panes and processes against its own session model to
spot leftovers. It counts panes with live leftover processes — not systemd's
"Tasks" figure for the herdr service, which counts threads (each agent process
spawns many), so a Tasks count in the thousands is normal and not by itself a
process leak.

## Industry terms

### PR

Pull request — a proposed set of code changes submitted for review and merging
into a branch. ([Wikipedia](https://en.wikipedia.org/wiki/Distributed_version_control#Pull_requests))

### CI

Continuous integration — automatically building and testing every change so
problems surface early. ([Wikipedia](https://en.wikipedia.org/wiki/Continuous_integration))

### Inode

A filesystem's record for one file or directory. A filesystem has a limited
number of them, set when it is created — so it can run out of inodes while still
having free space, and every new file then fails as though the disk were full.
([Wikipedia](https://en.wikipedia.org/wiki/Inode))

### Telemetry

Automatic collection of anonymous usage and diagnostic data from software, sent
back to its developers to guide improvements. In Shepherd it is off until you opt
in, respects `DO_NOT_TRACK`, and never includes code or personal data — see
[Configuration](/reference/configuration/#anonymous-usage-telemetry).
([Wikipedia](https://en.wikipedia.org/wiki/Telemetry#Software))
