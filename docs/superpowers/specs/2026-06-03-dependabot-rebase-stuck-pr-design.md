# Opt-in "@dependabot rebase" for stuck backlog PRs

## Problem

Dependabot PRs in the backlog frequently can't be merged: they fall behind the
base branch or conflict, so the host reports `mergeable: false` and Shepherd
disables the merge button (`blocked`). A merge attempt that does fire returns a
502. Either way the user is stuck — the fix (telling Dependabot to rebase) lives
in GitHub's comment UI, outside Shepherd.

Dependabot rebases itself when a maintainer posts `@dependabot rebase` on the PR.
This feature surfaces that as a one-click, opt-in action right on the backlog PR
row, so a stuck dependency bump can be unstuck without leaving the app.

## Detection

A PR is treated as Dependabot's when its author login contains `dependabot`
(case-insensitive). `gh pr list --json author` reports the login as
`app/dependabot`; the substring match also covers `dependabot[bot]`. Detection is
client-side only, in `PrRow`.

```ts
const isDependabot = pr.author.toLowerCase().includes("dependabot");
```

## UI — `ui/src/lib/components/PrRow.svelte`

New per-row state alongside the existing merge state:

- `requesting` — POST in flight
- `requested` — comment posted (sticky for the row's lifetime → no duplicate
  `@dependabot rebase` comments)
- `rebaseFailed` — POST failed

A **"Dependabot rebase"** button renders in `.pr-actions` (left of Review/Merge)
when:

```
isDependabot && (blocked || failed) && !requested
```

- `blocked` is the existing derived flag (`mergeable === false && !isDraft`).
- `failed` is the existing post-merge-failure flag.
- The disabled merge button still renders for blocked non-draft rows; the rebase
  button is the actionable one beside it.

Interaction:

- **One click, no two-click arming.** The merge button arms-then-fires because a
  merge is hard to reverse; posting a rebase request is low-stakes and the click
  itself is the opt-in. The button posts immediately.
- While in flight: disabled, label `prspanel_requesting` ("requesting…").
- On success: `requested = true`; the button is replaced by a muted inline
  `prspanel_rebase_requested` ("rebase requested") and never re-renders for that
  row, so Dependabot is not spammed.
- On failure: `rebaseFailed = true`; inline `prspanel_rebase_failed` ("rebase
  failed") shows and the button stays for a retry.

### i18n keys (EN + DE, `prspanel_` prefix)

| key | EN | DE |
| --- | --- | --- |
| `prspanel_rebase_button` | `Dependabot rebase` | `Dependabot-Rebase` |
| `prspanel_rebase_button_title` | `Ask Dependabot to rebase this PR` | `Dependabot bitten, diesen PR zu rebasen` |
| `prspanel_requesting` | `requesting…` | `wird angefragt…` |
| `prspanel_rebase_requested` | `rebase requested` | `Rebase angefragt` |
| `prspanel_rebase_failed` | `rebase failed` | `Rebase fehlgeschlagen` |

(Final DE wording can be tuned at implementation; keys must exist in both
catalogs to pass `check:i18n`.)

## API client — `ui/src/lib/api.ts`

```ts
export async function requestDependabotRebase(repoPath: string, number: number): Promise<void> {
  const r = await fetch("/api/prs/dependabot-rebase", JSON_POST({ repo: repoPath, number }));
  if (!r.ok) throw new Error(await failed(r));
}
```

Mirrors `mergeBacklogPr` (same `JSON_POST` + error-extraction helpers).

## Server — `src/server.ts`

New handler `handleDependabotRebase`, registered in `ROUTE_HANDLERS`:

- `POST /api/prs/dependabot-rebase`, body `{ repo, number }`.
- Validate `repo` via `safeRepoDir` → 400 on invalid.
- `number` must be a number → 400.
- Resolve forge; `if (!forge?.comment) return 400` ("no comment support").
- `await forge.comment(number, DEPENDABOT_REBASE_COMMAND)`; `{ ok: true }`.
- `catch` → 502 with the error message (same shape as `handlePrMerge`).

The comment body is fixed server-side; the client cannot post arbitrary text.
No server-side re-verification that the author is actually Dependabot: the body
is harmless on any PR, the UI only offers it for Dependabot rows, and Shepherd is
a loopback single-user tool. (Mirrors the trust model of the existing
merge/rerun endpoints.)

## Forge layer

- `src/forge/types.ts`:
  - Add optional `comment?(prNumber: number, body: string): Promise<void>` to
    `GitForge` — same GitHub-only gating convention as `rerunWorkflowRun`.
  - Add `export const DEPENDABOT_REBASE_COMMAND = "@dependabot rebase";`
- `src/forge/github.ts`: implement `comment` →
  `gh pr comment <number> --repo <slug> --body <body>` (via the existing
  `run`/`GhRunner` path; returns void).
- `src/forge/gitea.ts`: omit `comment`. Dependabot is GitHub-only, so the
  endpoint 400s for Gitea and the UI never shows the button (no Gitea author is
  "dependabot").

## Tests

- **Server** (`bun test ./test`): `handleDependabotRebase` —
  - success path posts `@dependabot rebase` and returns `{ ok: true }`;
  - missing/non-number `number` → 400;
  - forge without `comment` → 400;
  - forge `comment` throws → 502.
- **UI** (`cd ui && bun run test`, vitest): `PrRow` —
  - "Dependabot rebase" button shows for a blocked Dependabot row;
  - hidden for a non-Dependabot blocked row;
  - click posts then transitions to the `requested` inline state and the button
    does not re-render (no duplicate post).

## Out of scope

- No server-side author re-verification.
- No automatic posting — always an explicit user click.
- No Gitea support.
- No change to the merge logic itself.
- No proactive offer on Dependabot PRs that are *mergeable* (only `blocked` or a
  failed merge attempt).
