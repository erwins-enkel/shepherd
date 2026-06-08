# Merge-train shortcut in the "Ready to merge" section

## Goal

Add a shortcut link to the **"Ready to merge"** section header in the session
list that kicks off a **merge train** in a new session, working through the PRs
of every session flagged ready-to-merge and suggesting a merge order.

## Context

- The session list lives in `ui/src/lib/components/Herd.svelte`. Sessions are
  grouped by `partitionSessions` (`herd-partition.ts`); the operator-parked
  **"Ready to merge"** group is `partition.ready` (sessions where
  `readyToMerge === true`), rendered under the `.ready-head` header.
- Precedent for a section-header shortcut link: the **"Clear all"** link in the
  `.merged-head` header (`onclearmerged` prop), rendered only when the handler
  is provided.
- Per-session PR info comes from `git[session.id]` (`GitState extends PrStatus`:
  `state`, `number`, `url`, `title`, `checks`).
- New sessions are created via `createSession({ repoPath, baseBranch, prompt,
  model })`, mirrored on `onquickissue` in `+page.svelte`.
- The `/merge-train` skill is **project-scoped to the Shepherd repo only**
  (`.claude/skills/merge-train`). A merge-train session created against any
  other repo would not have it — so the kickoff prompt must be **self-contained**
  and only use `/merge-train` opportunistically.

## Design

### UI — `Herd.svelte`

- New optional prop `onmergetrain?: () => void`.
- `$derived` count `readyPrCount` = ready sessions with an open PR:
  `partition.ready.filter((s) => git[s.id]?.state === "open" && git[s.id]?.number)`.
- In `.ready-head`, render a right-aligned green-tinted link button (same
  structure/style as `.clear-merged`) **only when** `onmergetrain` is provided
  **and** `readyPrCount > 0`. Label `m.herd_merge_train_action()`, tooltip
  `m.herd_merge_train_title()`. Fail-closed: no PRs → no link (no dead action).

### Handler — `+page.svelte` `onmergetrain()`

1. Collect ready PRs from `store.sessions`: those with `readyToMerge` and
   `store.git[id]?.state === "open"` and a `number` →
   `{ number, title, url, repoPath }`.
2. Guard: empty → `toasts.info(m.toast_merge_train_no_prs())` and return
   (defensive; the link is already hidden when empty).
3. **Repo scope (multi-repo):** group PRs by `repoPath`; pick the repo with the
   most ready PRs as the target. If ready PRs span more than one repo, surface a
   fail-loud toast (`m.toast_merge_train_other_repos({ count })`) noting the PRs
   in other repos were left for a separate run — never silently dropped.
4. Resolve `baseBranch` via `listBranches(repoPath)` (current ?? first ??
   "main"), as `onquickissue` does.
5. Build the PR list string (`- #<n> <title> — <url>` per line) and the prompt
   `m.herd_merge_train_prompt({ prs })`.
6. `createSession({ repoPath, baseBranch, prompt, model: null })` →
   `selectedId = s.id`; close backlog / set mobile detail screen. Wrap in
   try/catch with `toasts.info(m.toast_merge_train_failed())` on failure
   (mirrors `onquickissue`).
7. Wire `{onmergetrain}` into **both** `<Herd>` instances (mobile + desktop).

### Prompt (`herd_merge_train_prompt`, self-contained)

Lists the ready PRs (`{prs}`, passed-through verbatim — not translated), then:
"If this repo provides a `/merge-train` command, use it. Otherwise:" inline the
condensed merge-train procedure — gather each PR's status with `gh`
(CI/mergeability/behind-main/file overlap), exclude red/conflicting/unwanted into
a hold list, order smallest-and-independent first with release-please last and
overlapping PRs sequenced so the riskier rebases onto the other, **present the
numbered order and stop for approval**, then on approval merge `--squash`,
rebasing onto latest main first and re-checking the remainder after each merge.

### i18n (en.json + de.json)

- `herd_merge_train_action` — link text ("Merge train" / "Merge-Train").
- `herd_merge_train_title` — tooltip.
- `herd_merge_train_prompt` — the canned prompt with `{prs}` (translated to DE,
  matching the existing `newtask_pr_review_template` convention).
- `toast_merge_train_no_prs`, `toast_merge_train_other_repos` (`{count}`),
  `toast_merge_train_failed` — operator toasts.
- `feat_merge_train_title` / `feat_merge_train_body` — What's-New entry.

### Feature discovery — `feature-announcements.ts`

Append one entry: `id: "merge-train-shortcut"`, `sinceVersion: "1.17.0"`,
`titleKey: "feat_merge_train_title"`, `bodyKey: "feat_merge_train_body"`.

## Testing

- `herd-partition.test.ts` already covers `ready` grouping.
- New `Herd.svelte` component test: link renders when a ready session has an open
  PR; hidden when no ready PRs; hidden when `onmergetrain` not provided; click
  fires the handler.
- Pure helper `formatReadyPrs(prs)` extracted for a unit test of the list format.

## Decisions (resolved)

1. Multi-repo → scope to repo with most ready PRs; fail-loud toast for the rest.
2. Link label → "Merge train".
3. Prompt language → translated DE, matching `newtask_pr_review_template`.

## Out of scope

- No server changes; reuses `POST /api/sessions`.
- No new merge-train execution logic; the new session's agent runs it.
