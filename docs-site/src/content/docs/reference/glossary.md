---
title: Concepts & glossary
description: The Shepherd-specific and industry terms used throughout the app and these docs.
---

These are the terms Shepherd uses across the UI and this documentation. The same
definitions drive the inline term tooltips in the app (registry:
`ui/src/lib/glossary.ts`).

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

## Industry terms

### PR

Pull request — a proposed set of code changes submitted for review and merging
into a branch. ([Wikipedia](https://en.wikipedia.org/wiki/Distributed_version_control#Pull_requests))

### CI

Continuous integration — automatically building and testing every change so
problems surface early. ([Wikipedia](https://en.wikipedia.org/wiki/Continuous_integration))
