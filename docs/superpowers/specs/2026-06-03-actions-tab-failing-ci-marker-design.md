# Actions tab: failing-CI marker on the tab label

**Issue:** [#235](https://github.com/erwins-enkel/shepherd/issues/235)
**Date:** 2026-06-03

## Problem & reframing

Issue #235 asks to "show a count of repos with failing default-branch CI on the
Actions tab label (like the open Issues/PRs counts)."

The wording ("count of repos") reads like a cross-repo aggregate, but the
existing Issues/PRs tab badges are **per-selected-repo** — a deliberate choice
(see the comment in `BacklogView.svelte`: an all-repos `totals` made "PRs · 5"
sit over a repo with no open PRs). To stay consistent, the Actions badge is
also **per-selected-repo**: it reflects the CI health of the repo currently
shown in the detail pane, not an aggregate across the backlog.

So the delivered feature is: **a failing/healthy CI marker on the Actions tab
label for the selected repo's default branch.** Not a number — a state marker
(`Actions · failing` in red when the default branch's check rollup is failing;
otherwise the existing label).

## Constraint

The hard requirement from the issue: a **cheap aggregate that does not fan out
N+1 `gh` calls on every backlog poll.** The `ActionsPanel` run-listing path
(`gh run list` + per-run `gh run view`) is explicitly off-limits for the badge.

## Approach

Fold the default branch's CI rollup state into the **existing** per-repo GitHub
GraphQL counts query in `CountsService.fetchGitHub`. That query already runs
once per repo, warmed by `BacklogPoller` (45s), capped at 6 concurrent, and
60s-cached. Adding one field to the selection set costs **zero extra calls** and
no N+1.

GitHub GraphQL exposes the rollup directly:

```graphql
query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    issues(states:OPEN){totalCount}
    pullRequests(states:OPEN){totalCount}
    defaultBranchRef{ target{ ... on Commit{ statusCheckRollup{ state } } } }
  }
}
```

`statusCheckRollup.state` is GitHub's `StatusState` enum:
`SUCCESS | FAILURE | ERROR | PENDING | EXPECTED`. It is the rollup of the
default branch HEAD commit's checks — i.e. "is current CI healthy?" — which is
exactly the at-a-glance signal wanted, and far cheaper than listing runs.

## Changes

### Server — `src/backlog.ts`

- `RepoCounts` gains `ciStatus: "success" | "failure" | "pending" | null`.
  `null` = no CI configured / no default branch / unknown / non-GitHub forge.
- `fetchGitHub`:
  - Extend the GraphQL query with `defaultBranchRef{ target{ ... on Commit{ statusCheckRollup{ state } } } }`.
  - Map `StatusState` → `ciStatus`:
    - `SUCCESS` → `"success"`
    - `FAILURE`, `ERROR` → `"failure"` (errored CI is not healthy)
    - `PENDING`, `EXPECTED` → `"pending"`
    - rollup absent / `defaultBranchRef` null / unrecognized → `null`
- `fetchGitea` returns `ciStatus: null` (no cheap single-call equivalent; matches
  how `workflows` is GitHub-only). `NULL_COUNTS` gains `ciStatus: null`.

### Server — `src/server.ts`

- `BacklogProject` interface gains `ciStatus: "success" | "failure" | "pending" | null`.
- `buildBacklogPayload` passes `counts.ciStatus` through onto each project.
- **Not** added to `BacklogPayload.totals` — per-repo only.

### UI — `ui/src/lib/types.ts`

- Mirror `ciStatus` on the `BacklogProject` type so server and UI agree on the
  payload shape (no hardcoded UI mirror of the server union — the value is
  surfaced through the payload).

### UI — `ui/src/lib/components/backlog-view.ts`

- `actionsTabLabel(sel)`: if `sel?.ciStatus === "failure"` → `"Actions · failing"`;
  otherwise the existing defined-workflows-count / bare-label logic. Pure helper,
  unit-testable; the component mirrors it through Paraglide messages.

### UI — `ui/src/lib/components/BacklogView.svelte`

- Actions tab button (both the desktop `.tab-bar` and the mobile
  `.overlay-tabs`): when `selected?.ciStatus === "failure"`, render
  `m.backlog_tab_actions_failing()` and apply `class:failing`. Otherwise the
  existing `workflows`-count / bare-label expression is unchanged.
- A decorative `✕` glyph (`aria-hidden="true"`) precedes the failing label; the
  **word** "failing" carries the meaning so the marker is not color-only
  (a11y). `.tab-btn.failing` is styled with `var(--color-red)`.

### i18n — `ui/messages/{en,de}.json`

- New key `backlog_tab_actions_failing`:
  - EN: `"Actions · failing"`
  - DE: `"Actions · fehlerhaft"`
- Added to **both** catalogs (parity gate `check:i18n`).

## Testing

- `src/backlog.ts` (server test): GraphQL mock returning each rollup `state`
  asserts the `ciStatus` mapping (success / failure from FAILURE / failure from
  ERROR / pending / null when rollup absent); Gitea path asserts `ciStatus: null`.
- `ui/src/lib/components/backlog-view.test.ts`: `actionsTabLabel` returns the
  failing label when `ciStatus === "failure"`, and the unchanged label
  otherwise; `makeProject` fixture gains `ciStatus`.

## Out of scope (YAGNI)

- No failing **count** number (state marker only).
- No cross-repo aggregate / global badge.
- No `ProjectRow` (per-repo list) CI indicator.
- No Gitea CI fetch.
- No change to the `ActionsPanel` run-listing path.
