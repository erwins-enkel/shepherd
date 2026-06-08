# Full-auto merge mode — design spec

**Date:** 2026-06-08
**Status:** Approved (design), pre-implementation
**Owner:** Patrick

## 1. Problem

Shepherd's autonomous pipeline stops one step short of a merge. Autopilot drives a
session to an **open PR** and stands down; the critic reviews it; the drain, when a PR is
green + mergeable + critic-clean, **retires** the session (archives it, leaves the PR open)
and hands the merge to a human (`src/drain.ts`, `readyToRetire` in `src/drain-core.ts`).

We want an **optional full-auto mode**: once a PR is genuinely ready, Shepherd merges it
itself — carrying the task all the way to landed-on-`main`. It must be safe under
**parallelism**: many sessions running at once, branched from the same `main`, can collide
(textual conflicts) or go stale (a sibling lands first, so a branch was never tested against
what's now on `main`).

## 2. Decisions (settled)

| Decision | Choice |
|---|---|
| Staleness policy | **Strict.** Never merge a branch that isn't rebased onto the latest `main` and re-passing CI (+critic). |
| Conflict recovery | **Auto-rebase via the agent.** Wake the still-idle session, steer it to rebase/resolve/force-push; re-run gates; retry. Cap then pause+notify. |
| Toggle scope | **Per-repo `autoMergeEnabled` + per-session override**, independent of `autoDrainEnabled`. Applies to any full-auto session (drain-spawned *or* manually started). |
| Merge engine | **Shepherd-owned serial merge train.** `forge.merge()` driven by Shepherd; not GitHub native auto-merge. |
| Merge method | **Forge default** (`squash`). No per-repo override in v1. |
| Train ordering | **Next-in-line** (max throughput), not strict oldest-first. Re-rebase thrash bounded by the attempt cap. |
| Rebase-attempt cap | **5** (config, env-overridable), then pause the repo + notify. |
| Pane warming | **None.** Rely on existing idle-pane persistence; steering an idle pane is how the critic auto-address loop already works. |

## 3. Architecture

Three orthogonal toggles, each independently switchable:

| Toggle | Scope | Governs | Status |
|---|---|---|---|
| `autopilotEnabled` | per-session override (`Session.autopilotEnabled: boolean \| null`) + repo default (`RepoConfig.autopilotEnabled`) | drive a session to a PR — and, in full-auto, keep unblocking gates **past** the PR (for rebases) | exists |
| `autoDrainEnabled` | per-repo (`RepoConfig`) | spawn auto sessions from labeled backlog issues | exists |
| `autoMergeEnabled` | **new** per-repo (`RepoConfig`) **+ new** per-session override (`Session.autoMergeEnabled: boolean \| null`) | carry a full-auto session's ready PR to a merge, with rebase recovery | **new** |

A session is **full-auto** when its *effective* `autopilotEnabled` AND *effective*
`autoMergeEnabled` are both true (override wins; `null` inherits the repo default — same
resolution as `AutopilotService.enabled()`).

Because `autoMergeEnabled` must work **without** `autoDrainEnabled` (and for manual
sessions the drain never manages), the merge logic lives in a **new dedicated service**, not
inside the drain.

### 3.1 New: `AutoMergeService` (the merge train)

Files: `src/automerge-core.ts` (pure decision) + `src/automerge.ts` (side-effect harness),
mirroring the `drain-core.ts` / `drain.ts` split.

- **Gated on `autoMergeEnabled`.** Per-repo serial pump (its own `pumping` lock) — that lock
  + one-decision-per-iteration **is** the merge train: at most one merge in flight per repo.
- Considers **every** non-archived full-auto session in the repo (auto or manual).
- Driven off the same events the drain/critic already consume: `session:git`,
  `session:review`, `session:status`, plus a periodic `tick()` (~30s).

**Pure core decision** (`computeNext`) returns one of:

- **`merge`** — PR `open` + `checks === "success"` + `mergeable === true` + **up-to-date with
  `main`** + (if critic enabled) clean verdict for the **current head** (reuse the existing
  critic-clean condition from `readyToRetire`: `reviewDecision` not
  `changes_requested`/`error`, and `reviewHeadSha === headSha`).
- **`rebase`** — otherwise mergeable-intent but **stale or conflicting**: open + green +
  critic-clean, but `behind === true` OR `mergeable === false`.
- **`hold`** — nothing to do / waiting (reason surfaced for the UI banner).

Side-effect harness applies the decision:

- `merge` → `forge.merge(prNumber, { method: forge.mergeMethod, deleteBranch: true })`, then
  settle teardown (§3.4). Fail-closed on non-conflict errors (§3.5).
- `rebase` → bump the session's rebase-attempt counter; if over cap → `hold` +
  `merge_error`-style pause + notify; else steer the agent to rebase (§3.3).

### 3.2 Drain change (small)

When `autoMergeEnabled` is on for a repo, the drain must **not** retire ready sessions
(archiving them would remove the worktree/pane and foreclose rebase recovery). Add
`autoMergeEnabled` to `DrainRepoState`; in `computeNext`, **skip the retire branch** when it
is set — the ready session stays in `autoSessions`, still counts toward `maxAuto`, and the
`AutoMergeService` lands it. When the merge service archives on success,
`session:archived` frees the slot and the drain spawns the next backlog item exactly as
today. When `autoMergeEnabled` is off, the drain retires/hands-off unchanged.

Consequence: with full-auto on, a slot is held until **merge**, not until **PR-ready**. This
is intentional (the task isn't done until it lands) and naturally throttles the train via
`maxAuto`.

### 3.3 Rebase recovery loop

On a `rebase` decision the harness steers the (idle, still-alive) agent with an internal
agent instruction — **not** UI chrome, never i18n'd, like `OPEN_PR_STEER` /
`PROCEED_STEER` in `src/autopilot.ts`. Text (Shepherd-owned, English):

> "You're in full-auto. Your PR can't merge as-is — it's behind `main` (or has conflicts).
> Fetch origin, rebase your branch onto `origin/main`, resolve any conflicts, and
> force-push with `--force-with-lease`. Do NOT merge `main` into your branch (it breaks the
> linear-history gate). If something genuinely blocks this, say specifically what you need."

Steering uses the same path as autopilot/critic: `service.reply(id, text)` (resume the pane
first if exited, via `service.resume`). Honor the **bracketed-paste / no-coalesce** rule for
multi-line steers (see the herdr-send memory) — reuse `service.reply`, which already does.

**Autopilot must keep helping past the PR in full-auto.** Today `AutopilotService.eligible()`
stands down the moment a PR exists (`if (this.deps.hasPr(id)) return null`,
`src/autopilot.ts:83`). Change: stand down at PR **only when the session is not full-auto**.
For a full-auto session, autopilot keeps classifying/unblocking procedural gates so the agent
can complete the rebase + force-push. (It still must not redundantly steer "open a PR" — the
existing `finished`→`OPEN_PR_STEER` path is guarded by `hasPr`; keep that guard, only relax
the blanket stand-down.) Autopilot needs to know "is this session full-auto" — add a
`fullAuto(id): boolean` dep resolving effective autopilot ∧ autoMerge.

After the agent force-pushes: new head → CI re-runs → critic re-reviews (its gate already
keys on the current head) → poller emits `session:git` → `AutoMergeService` re-evaluates →
`merge` when clean+current.

**Attempt cap.** Track rebase attempts per session (a new `Session` column, e.g.
`autoMergeRebaseCount: number`, reset on a successful merge-readiness or when the operator
intervenes — mirror the autopilot step-count pattern). On exceeding the cap (default 5),
`hold` with a new pause reason and a push notification; the operator takes over.

### 3.4 The strict "up-to-date" signal (`behind`)

GitHub's `mergeStateStatus=BEHIND` only appears when branch protection requires up-to-date,
so we **cannot** rely on it for the strict gate. Compute `behind` ourselves,
forge-agnostically, in the session's worktree:

```
git fetch origin <baseBranch>           # best-effort
git merge-base --is-ancestor origin/<baseBranch> HEAD
#   exit 0 → main is an ancestor of HEAD → up-to-date  → behind = false
#   exit 1 → main has commits not in HEAD → stale       → behind = true
```

This mirrors `WorktreeMgr.pruneMergedBranch` (already uses `merge-base --is-ancestor`).
Surface it as a new boolean on `GitState`/`PrStatus` (e.g. `behind?: boolean`), computed by
the pr-poller alongside `mergeable`. `mergeable === false` (DIRTY) covers true conflicts;
`behind === true` covers stale-but-clean. Where the worktree is gone/unreadable, treat
`behind` as unknown → **do not merge** (fail-closed: wait).

Note: computing `behind` requires the session's local worktree. Manual full-auto sessions
have one; drain-spawned ones do too. A session whose worktree was already removed is not a
merge-train candidate.

### 3.5 Teardown, claims, fail-closed

**Single-owner teardown.** Factor the drain's current `reapMerged` (close issue / settle the
`shepherd:active` claim / archive / drop pr-cache / emit `session:archived`) into one shared
helper used by **both** the out-of-band-merge path *and* the `AutoMergeService`. Today
`reapMerged` is auto-only (`onGit` returns early for non-auto sessions); the shared helper
must also handle **manual** full-auto sessions (which carry no issue/claim — those steps
no-op). Claim retain/release semantics are unchanged (see the drain-claim memory): merge
closes the issue via `Closes #N`, retiring the claim; a `closeIssue` failure retains it.

**Merge success.** `forge.merge` lands → shared teardown archives the session, drops the
pr-cache, emits `session:archived` (drain pumps, slot frees). The pr-poller's later
"merged" observation is a no-op because the cache was dropped (same guard the retire path
relies on).

**Fail-closed on non-conflict merge errors** (auth, API hiccup, branch-protection block,
merge raced). House rule: never let a failed merge look like success. Keep the PR **open**,
keep the claim, do **not** archive; pump → `hold` with a new `merge_error` reason; push
notification (CI/agent category). A merge that fails specifically because the branch went
behind/conflicting between gate and call is treated as a transient → next pump re-evaluates
→ emits `rebase`, not a hard error.

### 3.6 Status surfacing

`AutoMergeService` emits a per-repo status (new event, e.g. `automerge:status`, or extend
`drain:status` — prefer a **separate** event to keep the drain's payload stable). New
operator-visible states (i18n EN+DE): `merging`, `rebasing`, `merge_error`. UI shows them in
the drain/automerge banner. Push-notification intents added for `merge_error` and (optionally)
a quiet "merged" confirmation, localized at send time (`src/push.ts` pattern).

## 4. Data model & config

**`RepoConfig`** (`src/store.ts`): add `autoMergeEnabled: boolean` (default `false`).
- DDL default in `CREATE TABLE repo_config`, plus a `migrateRepoConfigColumns` entry:
  `add("autoMergeEnabled", "autoMergeEnabled INTEGER NOT NULL DEFAULT 0")`.
- Thread through `getRepoConfig` SELECT/mapping and `setRepoConfig` INSERT/UPSERT.

**`Session`** (`src/types.ts` + `src/store.ts`): add
- `autoMergeEnabled: boolean | null` (override; `null` inherits repo). Migrate column
  `autoMergeEnabled INTEGER` (nullable, like `autopilotEnabled`).
- `autoMergeRebaseCount: number` (default 0). Migrate `autoMergeRebaseCount INTEGER NOT NULL DEFAULT 0`.

**`GitState`/`PrStatus`** (`src/forge/types.ts`): add `behind?: boolean`.

**`config.ts`**: `autoMergeRebaseCap: Number(process.env.SHEPHERD_AUTOMERGE_REBASE_CAP ?? 5)`.

## 5. API & UI

**Server** (`src/server.ts`):
- Repo-config PUT: add `autoMergeEnabled` to the boolean-field allowlist, the validator, the
  patch type, and the `setRepoConfig` merge (lines ~219–330).
- Per-session override: extend the existing `PUT /api/sessions/:id/autopilot` pattern with a
  sibling `PUT /api/sessions/:id/automerge` (body `{ enabled: boolean | null }`), or fold a
  second field into a generalized endpoint. Emit a `session:*` event so the UI updates live.

**UI**:
- Repo settings surface: add an `autoMergeEnabled` toggle next to the existing drain/critic
  toggles (locate via `RepoConfig` usage in `ui/src/lib/store.svelte.ts` / `api.ts` /
  `types.ts`; mirror `autoDrainEnabled`). New label key(s).
- Per-session override control alongside the autopilot toggle.
- Banner/badge for `merging` / `rebasing` / `merge_error`.
- **i18n (REQUIRED):** every new string in **both** `ui/messages/en.json` and `de.json`
  (snake_case, component-prefixed). `cd ui && bun run check:i18n` must pass.
- **Feature discovery (REQUIRED):** one entry in
  `ui/src/lib/feature-announcements.ts` (`id: "auto-merge"`, `sinceVersion: <release>`,
  `titleKey`/`bodyKey`), with EN+DE keys, in the same PR.

## 6. Edge cases

- **`maxAuto = 1`** (default): no sibling parallelism, but a branch can still go behind from
  human/other-repo merges → the rebase loop still applies.
- **Rebase thrash**: under a hot queue a branch may rebase repeatedly as siblings land; the
  attempt cap bounds it; once the queue drains it catches up. Accepted for v1.
- **Critic disabled**: gate drops the verdict requirement → merge on green + current +
  mergeable (matching `readyToRetire` with `criticEnabled === false`).
- **Human merges out-of-band**: existing `onGit` "merged" path (now via the shared teardown
  helper) still reaps it.
- **Manual full-auto session with no PR yet**: not a merge-train candidate until a PR opens
  (the `merge`/`rebase` gates require `state === "open"`).
- **Worktree already removed**: `behind` unknown → never merged (fail-closed).
- **Two services reacting to one `session:git`**: clear ownership — drain never merges; the
  merge service is the only thing calling `forge.merge`. No double-merge.

## 7. Testing

**Root** (`bun test ./test`):
- `automerge-core.test.ts` (new): merge gate (green+current+mergeable+critic-clean), `behind`
  → rebase, `mergeable:false` → rebase, critic-on vs -off, hold reasons, next-in-line pick.
- `automerge.test.ts` (new): merge-success → shared teardown; fail-closed on a thrown
  `forge.merge`; rebase steer fires + bumps count; cap → pause; serial pump lock.
- `drain-core.test.ts`: new case — `autoMergeEnabled` suppresses `retire`.
- Shared-teardown refactor: existing drain `reapMerged` tests still pass; add a manual
  (non-auto) session teardown case.
- pr-poller: `behind` computed/propagated.
- `forge/github.test.ts`: existing `gh pr merge --squash --delete-branch` test covers the call.

**UI** (`cd ui && bun run test`): toggle wiring, banner states, store plumbing.

**Gates**: `bun run lint` + root tests; `cd ui && bun run check` + `check:i18n` + UI tests.
Branch hygiene (linear), feature-catalog, i18n-parity all green.

## 8. Out of scope (v1)

- Per-repo merge-method override (forge default only).
- GitHub native auto-merge / merge queue.
- Mechanical (Shepherd-driven, agentless) clean rebases — possible fast-follow; v1 always
  routes rebases through the agent.
- Strict oldest-first fairness ordering.
- Revert-on-red-`main` after a merge (strict pre-merge re-verify is the safeguard instead).

## 9. Open questions

- Separate `automerge:status` event vs. extend `drain:status`? (Leaning separate — stable
  drain payload.) — *decide in plan*
- Per-session override endpoint: new `/automerge` route vs. generalized toggle route? — *plan*
- Reset point for `autoMergeRebaseCount` (on merge only, or also on operator reply)? — *plan*
