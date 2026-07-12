# Spike #1074 — herdr built-in worktrees vs Shepherd's `WorktreeMgr`

**Phase-0 go/no-go, re-scoped to a short ADR (triage 2026-06-29).** herdr ships a worktree
integration (`herdr worktree list/create/open/remove`, CLI + socket API). Question: is it worth
replacing (or partially adopting) our own `src/worktree.ts` (`WorktreeMgr`)?

The predicted **NO-GO (keep `WorktreeMgr` ownership)** is now validated **de-facto in the code**:
`doc-agent.ts` and the tab-reaper deliberately parse `git worktree list` directly so they survive a
herdr daemon restart — exactly the daemon-independence this ADR argues is load-bearing. So no
from-scratch empirical probe was needed; the API surface was confirmed against the live pinned herdr
and mapped against the requirements `WorktreeMgr` already satisfies.

## Decision: **NO-GO** ⛔ — keep `WorktreeMgr`, do not cede worktree lifecycle to herdr

Routing worktree create/remove through herdr's socket would couple our **most safety-critical op**
(commits can vanish, sessions can strand) to daemon liveness + protocol version, for the **same**
underlying `git worktree` call — with **no** git-correctness or perf gain, and it would forfeit the
daemon-independence that currently rescues us during orphaning bugs. herdr's `create` API is a thin
7-field wrapper that **cannot express** the git-correctness logic `WorktreeMgr` depends on (detached
checkout at a sha, base divergence resolution, `isolated:false` fallback, fork PR-ref fetch).

There **is** an additive win worth a separate follow-up: herdr's `worktree list` already reflects
worktrees we mint with raw git (verified below), so surfacing them in herdr's sidebar / aligning to
`[worktrees].directory` for operator visibility needs **no** lifecycle ceding. Tracked separately, not
part of this decision.

## Environment

|                    |                                                                                                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| herdr (live)       | `0.7.3` (issue matrix referenced `0.7.1` — API has since moved; re-verified against 0.7.3)                                                                                                                     |
| Pinned min         | `HERDR_MIN_VERSION = "0.7.0"` (`src/config.ts:74`)                                                                                                                                                             |
| herdr worktree CLI | `list` / `create` / `open` / `remove` (introduced v0.6.2; bare-repo since 0.6.9)                                                                                                                               |
| Socket protocol    | `worktree_list` / `worktree_created` / `worktree_opened` / `worktree_removed` + events (`src/generated/herdr-protocol.ts:154-1176`)                                                                            |
| Our impl           | `WorktreeMgr` (`src/worktree.ts:65`)                                                                                                                                                                           |
| Daemon fact        | herdr 0.7.3 does **not** auto-spawn its daemon (`src/remediations.ts:25`); worktree socket ops "defer long-running Git work until the app runtime can drive it" (herdr 0.7.1 notes) — explicit daemon coupling |

## Decisive prior — **CONFIRMED**

> Routing worktree create/remove through herdr's socket couples our most safety-critical op to
> daemon liveness + protocol version, for the **same** underlying `git worktree` call — no
> git-correctness or perf gain, and it forfeits the daemon-independence that currently rescues us.

Confirmed on two axes:

1. **No git-correctness / perf gain.** herdr's `RequestWorktreeCreateParams`
   (`src/generated/herdr-protocol.ts:1815`) is exactly `{ base?, branch?, cwd?, focus?, label?, path?,
workspace_id? }`. Under the hood it runs the _same_ `git worktree add` we already call — there is no
   git operation herdr does that raw git does not. `worktree remove` is keyed to a daemon-tracked
   `workspace_id` (`:1848`), **not** a path, so removal additionally depends on herdr's in-memory
   workspace registry being live and consistent.
2. **Daemon-independence is real and already load-bearing.** Our reapers read git state **directly**,
   with an explicit comment that this is to survive a daemon restart:
   - `src/doc-agent.ts:1181` — _"Works even when the herdr daemon ALSO restarted (it parses `git
worktree list`)."_ Parse site: `src/doc-agent.ts:1444-1446` (`git worktree list --porcelain`).
   - `src/tab-reaper.ts:167+` — stranded-review-worktree disk sweep enumerates `.shepherd-worktrees`
     dirs by **filesystem scan** (`listDir`, `:227`), independent of the daemon; husk-tab reaping uses
     per-pane process liveness as ground truth (`:95`), not a herdr list.
   - `src/branch-pruner.ts:72` and `src/forge/local.ts:174,258` also parse `git worktree list
--porcelain` directly.
     Ceding creation to herdr would make these consumers' worldview diverge from the authority that
     created the worktrees the moment the daemon restarts or the protocol drifts.

## Requirements matrix

| Requirement                                                                                                      | `WorktreeMgr` today                                                                                                                                                                                                                                                                                                                                                                                       | herdr worktree API (0.7.3)                                                                                       | Verdict                       |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **Detached checkout at a specific sha** (reviewer/critic read-only trees)                                        | `createDetached()` (`src/worktree.ts:609`) — `worktree add --detach <sha>`                                                                                                                                                                                                                                                                                                                                | **Not expressible.** `create` params have no `detach`; `base`/`branch` create a _branch_, not a detached HEAD.   | ❌ herdr can't                |
| **Fork / PR-ref + missing-object fetch** before detach                                                           | `createDetached` fetches `origin -- <branch>`, and the PR `pullRef` for fork heads (`src/worktree.ts:634-646`), so the head sha lands before `add --detach`                                                                                                                                                                                                                                               | No fetch/ref control in the API; `base` must already resolve locally                                             | ❌ herdr can't                |
| **Base fast-forward / divergence resolution** (`ResolvedBase`)                                                   | `ensureBaseRef()` → `ResolvedBase` (`src/worktree.ts:20,299`): upstream freshening, `FAIL_CLOSED`, `localFf`, dirty / checked-out-elsewhere / diverged states                                                                                                                                                                                                                                             | No resolution primitives; `base` is a plain ref passed to git as-is                                              | ❌ herdr can't                |
| **`behindBase` strict auto-merge gate**                                                                          | `behindBase()` (`src/worktree.ts:433`) fetches `origin -- <base>`, prefers the fetched ref                                                                                                                                                                                                                                                                                                                | No equivalent read; not a worktree-lifecycle concern in herdr's model                                            | ❌ herdr can't                |
| **`isolated:false` signal** (non-git checkout → run live, no branch; consumers set `sessions.branch`/`isolated`) | Returns `{ worktreePath: repoPath, branch: null, isolated: false }` for a non-git repo (`src/worktree.ts:82`); a genuine `add` failure instead retries (`retryWorktreeAdd`, `:151`) then throws — never silently degrades. `isolated`/`branch` threaded through `service.ts:2892-2906`; consumers gate on `!wt.isolated \|\| !wt.branch` (`doc-agent.ts:647`, `gitignore-adopt.ts:111`, `promote.ts:118`) | Socket `create` returns a worktree or an error — no "not isolated, run in the live checkout" signal to branch on | ❌ herdr can't                |
| **Survives herdr daemon restart**                                                                                | Pure git; reapers parse `git worktree list` / scan fs directly (`doc-agent.ts:1181`, `tab-reaper.ts:167`, `branch-pruner.ts:72`)                                                                                                                                                                                                                                                                          | Socket ops **require** the daemon; 0.7.1 explicitly defers git work "until the app runtime can drive it"         | ✅ ours / ❌ herdr couples it |
| **Deterministic test fakes** (`Pick<WorktreeMgr, …>` injected)                                                   | Narrow structural interfaces injected across `automerge.ts:69`, `landing-rebase.ts:40`, `gitignore-adopt.ts:19`, `doc-agent.ts:227`, `plan-gate.ts:155`, `standalone-critic.ts:80`, `review.ts:121`, `promote.ts:23`                                                                                                                                                                                      | A socket dependency forces integration-level fakes (daemon/protocol), not a 1-method `Pick<>`                    | ❌ regression if ceded        |
| **Orphaned-branch reuse**                                                                                        | Reuses an orphaned branch at `baseBranch` (`src/worktree.ts:179`)                                                                                                                                                                                                                                                                                                                                         | No orphan-reuse semantics exposed                                                                                | ❌ herdr can't                |
| **shepherd-exclude + scratch cleanup, orphan-process reap**                                                      | `ensureShepherdExclude` (`src/worktree.ts:7`); orphan-process sweep + claude scratch reclaim on teardown (`src/worktree.ts:537,581`)                                                                                                                                                                                                                                                                      | Out of scope for herdr's API                                                                                     | ❌ herdr can't                |

**No requirement is better served by routing through herdr; several are unrepresentable in its API.**

## Empirical findings (against live herdr 0.7.3)

1. **herdr's `create` is a thin git wrapper — 7 fields, no correctness control.**
   `RequestWorktreeCreateParams = { base?, branch?, cwd?, focus?, label?, path?, workspace_id? }`. No
   detached-HEAD-at-sha, no fetch/ref control, no divergence resolution, no isolated-fallback signal.
   `remove` takes a `workspace_id`, not a path — coupling removal to daemon-held state.

2. **`herdr worktree list` already reflects worktrees created by raw git.** Running it in the Shepherd
   repo returned this session's own worktree (`shepherd/keep-worktreemgr`, minted by git, never by
   herdr), the `.claude/worktrees/agent-*` trees, and the detached `/tmp/fallow-audit-base-cache-*`
   trees — all with correct `is_detached` / `is_linked_worktree` flags. herdr's list is a faithful
   `git worktree list` reflector, so **operator visibility is already available without ceding
   lifecycle** (this is the additive win, below).

3. **Shepherd routes zero worktree lifecycle through herdr today.** Every `worktree.create()` /
   `worktree.remove()` call in the codebase resolves to the injected `WorktreeMgr` (`this.deps.worktree`,
   e.g. `doc-agent.ts:642,648`), never herdr's API. `src/herdr.ts` only ever consumes `worktreePath` as
   an immutable agent cwd (`:105,109`). The de-facto no-go is the current architecture, not a proposal.

## Additive win (separate optional follow-up — NOT this decision)

Because herdr's `worktree list` already sees our git-created trees (finding 2), we could **surface**
Shepherd's worktrees in herdr's sidebar groups and/or align our `.shepherd-worktrees/` layout to
herdr's `[worktrees].directory` for operator visibility — **without** ceding create/remove. This is
purely additive read-side integration and does not touch the safety-critical lifecycle. File as its
own issue if desired; it is explicitly out of scope here.

## Rationale

The migration would trade a self-contained, synchronously-testable, daemon-independent git primitive
for a socket round-trip to a daemon that runs _the same git command_, while **losing** the four
correctness capabilities `WorktreeMgr` layers on top (`createDetached` at a sha, `ResolvedBase`
divergence resolution, `isolated:false` fallback, fork PR-ref fetch) and the `Pick<WorktreeMgr, …>`
testability that eight modules depend on. The one thing herdr offers that git-alone doesn't —
operator-facing sidebar visibility — is reachable additively without giving up ownership.

**Keep `WorktreeMgr`. Do not route worktree lifecycle through herdr's socket API.** No product-code
changes from this spike.
