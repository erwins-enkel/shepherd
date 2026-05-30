# Platform-agnostic git host buttons — design

**Date:** 2026-05-30
**Status:** approved
**Feature:** PRD F6/F7 — git action buttons (open PR / merge / redeploy) across GitHub, Gitea, and Forgejo.

## Problem

Shepherd's only git-host integration today is read-only GitHub issue listing
(`src/github.ts`), hardcoded to `github.com` via a slug regex and the `gh` CLI.
The backlog calls for **open PR / merge / redeploy** buttons that work against
self-hosted Gitea/Forgejo as well as GitHub proper. We want one abstraction so
the UI and server don't branch on host type.

## ToS context (the defining constraint)

Shepherd's hard rule: if a feature can't be done by typing into a real terminal,
it doesn't ship — because the _Claude_ work runs on the operator's Claude
subscription (interactive-only, no Agent SDK / `claude -p`).

Forge actions are **orthogonal** to that rule. Opening/merging a PR and triggering
CI use the operator's **git-host credentials** (`gh` auth, or a Gitea token), never
the Claude subscription. The agent's normal interactive work already produced the
commits + push; the buttons just drive the forge. So **direct forge API/CLI calls
are clean** — this resolves PRD open-question #3 in favor of direct calls (not
type-into-claude).

## Decisions (locked)

| #             | Decision                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------- |
| Execution     | Direct forge API/CLI. No typing into the claude pane.                                           |
| Auth          | Per-forge config file `~/.shepherd/forges.json`. GitHub reuses existing `gh` auth.              |
| Redeploy      | Trigger a **named deploy workflow** (`workflow_dispatch` on GitHub; Gitea Actions equivalent).  |
| UI surface    | Contextual git rail in the Viewport header that morphs by PR state.                             |
| CI checks     | Single **worst-of** rollup dot (pending < success, failure dominates). No per-check list in v1. |
| Merge method  | Config default per forge (`mergeMethod`); **no** per-click picker.                              |
| Delete branch | Merge deletes the head branch by default.                                                       |
| Token storage | Plaintext in `~/.shepherd/forges.json` (chmod 600). No env indirection in v1.                   |

## Architecture

### 1. Forge abstraction (`src/forge/`)

```
src/forge/
  types.ts    GitForge interface, PrStatus, ForgeKind, MergeMethod
  index.ts    detectForge(repoDir) → GitForge | null   (URL parse + factory)
  github.ts   GithubForge   (shells `gh`; absorbs current src/github.ts logic)
  gitea.ts    GiteaForge    (fetch → /api/v1; covers gitea AND forgejo — API-compatible)
```

```ts
export type ForgeKind = "github" | "gitea";
export type MergeMethod = "merge" | "squash" | "rebase";

export interface PrStatus {
  state: "none" | "open" | "merged" | "closed";
  number?: number;
  url?: string;
  title?: string;
  mergeable?: boolean | null; // null = host still computing mergeability
  checks: "none" | "pending" | "success" | "failure"; // worst-of rollup
  deployConfigured: boolean; // a deployWorkflow is set for this host
}

export interface GitForge {
  kind: ForgeKind;
  slug: string | null; // "owner/repo"
  listIssues(): Promise<Issue[]>;
  prStatus(headBranch: string): Promise<PrStatus>;
  openPr(o: { head: string; base: string; title: string; body: string }): Promise<PrStatus>;
  merge(n: number, o: { method: MergeMethod; deleteBranch: boolean }): Promise<void>;
  redeploy(o: { workflow: string; ref: string }): Promise<void>;
}
```

**Detection (`detectForge`):**

1. `git -C <repoDir> remote get-url origin` → parse host + `owner/repo` (handle
   both `https://host/owner/repo(.git)` and `git@host:owner/repo(.git)`).
2. Host `github.com` → `GithubForge` (uses `gh`; reads host config only for
   `deployWorkflow`).
3. Else look up host in `forges.json`. Found → `GiteaForge(cfg)`. Not found → `null`.
4. `null` ⇒ git rail hidden, issues empty (current behavior preserved).

**Worst-of checks rollup:** map the forge's combined status/check-runs to a single
value — any failure/error ⇒ `failure`; else any pending/running/queued ⇒ `pending`;
else if ≥1 check ⇒ `success`; else `none`.

**Issue listing migrates onto the abstraction.** `/api/issues` calls
`forge.listIssues()`, so **Gitea/Forgejo issues begin working** (today GitHub-only).
`GiteaForge.listIssues` hits `/api/v1/repos/{slug}/issues?state=open&type=issues`.

### 2. Config (`~/.shepherd/forges.json`)

File (not env) keeps tokens out of the process list and matches the `~/.shepherd/`
db convention.

```json
{
  "git.example.com": {
    "type": "gitea",
    "baseUrl": "https://git.example.com",
    "token": "…",
    "deployWorkflow": "deploy.yaml",
    "mergeMethod": "squash"
  },
  "github.com": {
    "deployWorkflow": "deploy.yml"
  }
}
```

- `github.com` entry **optional**: `gh` provides auth and slug; the entry is only
  needed to enable Redeploy (`deployWorkflow`) and override `mergeMethod`.
- Missing file ⇒ GitHub PR/merge still work (via `gh`); self-hosted hosts have no
  rail.
- `mergeMethod` defaults to `"squash"` if omitted.
- Loaded once at startup into `config`; absent/malformed file logs a warning and
  yields an empty forge map (no crash). chmod 600 expected; documented in README.

### 3. Server endpoints (`src/server.ts`)

Addressed by **session id** — the session already carries `repoPath`, `branch`,
`baseBranch`, so no repo query-param to validate.

| Method | Path                             | Body                         | Returns                 |
| ------ | -------------------------------- | ---------------------------- | ----------------------- |
| GET    | `/api/sessions/:id/git`          | —                            | `{ kind, ...PrStatus }` |
| POST   | `/api/sessions/:id/git/pr`       | `{ title?, body? }`          | `PrStatus`              |
| POST   | `/api/sessions/:id/git/merge`    | `{ method?, deleteBranch? }` | `PrStatus`              |
| POST   | `/api/sessions/:id/git/redeploy` | —                            | `{ ok: true }`          |

- All reuse existing `checkAuth` + `checkOrigin` (POSTs already origin-guarded).
- Forge resolved per-request via `detectForge(session.repoPath)` using the loaded
  config; `null` ⇒ `404 { error: "no forge for this repo" }`.
- `pr` defaults: `title` = session name (fallback first commit subject); `body` =
  session prompt; `head` = `session.branch`; `base` = `session.baseBranch`.
- `merge` defaults: `method` = host `mergeMethod`; `deleteBranch` = `true`.
- `redeploy`: `workflow` = host `deployWorkflow` (400 if unset); `ref` =
  `session.baseBranch` (deploy runs against the merged target).
- Forge construction injected via `AppDeps` (a `resolveForge(repoDir)` function)
  so routes are unit-testable with a fake forge.

### 4. UI: contextual git rail (`ui/src/lib/components/GitRail.svelte`)

Placed in `vp-head`, immediately before the `decommission` button. Hidden on the
compact/mobile header to avoid clipping (consistent with how secondary fields drop).

Fetches `/api/sessions/:id/git` on session change, after each action, and
light-polls (~15s) **only** while `state === "open"` or a redeploy is in flight.

State machine (morphs in place):

- **none** → `[ ↟ Open PR ]`
  - Click → inline popover prefilled with title + body (editable) → submit →
    optimistic to `open`.
- **open** → `PR #N ↗ · ●CI · [ Merge ]`
  - CI dot color: amber `pending`, blue `success`, red `failure`, dim `none`.
  - `Merge` enabled only when `mergeable !== false && checks !== "failure"`.
- **merged** → `merged ✓ · [ ⟳ Redeploy ]`
  - Redeploy hidden when `deployConfigured === false`.
- **closed** → `closed` (terminal; no actions).

**Destructive actions (Merge, Redeploy)** reuse the header's existing arm/confirm
pattern (first click arms → label changes to "confirm…" → fires within 3s,
disarms on timeout or unit change) — same UX as decommission, no modal.

**Error handling:** inline red flash on the rail; state unchanged; concise message
(e.g. "push your branch first", "merge conflict", "deploy workflow not found").

Styling matches the mono/amber theme and existing `task-btn`/tab classes.

### 5. Types, client, tests

- `ui/src/lib/types.ts`: add `PrStatus`, `ForgeKind`, `MergeMethod`.
- `ui/src/lib/api.ts`: `gitStatus(id)`, `openPr(id, body)`, `mergePr(id, body)`,
  `redeploy(id)`.
- Tests:
  - URL → `{kind, slug}` parse: https + ssh forms, github + gitea hosts, `.git`
    suffix, unknown host → null.
  - `GithubForge` via injected `run` (keeps existing `test/github.test.ts` green;
    relocate/rename as needed).
  - `GiteaForge` via injected `fetch`: listIssues, prStatus mapping, openPr, merge,
    redeploy request shapes.
  - Worst-of checks rollup table.
  - Server routes with a fake forge: status, pr, merge, redeploy, and `null`→404.

## Out of scope (YAGNI)

- GitLab / Bitbucket (the `GitForge` interface makes them a later drop-in).
- GitHub Enterprise host config (`gh` multi-host later).
- Auto-redeploy via merge webhook → act-runner (button is explicit for v1).
- Rich PR templates (default + edit-on-forge is enough).
- Per-repo `deployWorkflow` override (host-level for v1; trivial extension later).
- Per-click merge-method picker.
- Env-var token indirection.

## Files touched

**New:** `src/forge/{types,index,github,gitea}.ts`,
`ui/src/lib/components/GitRail.svelte`, `test/forge/*.test.ts`.
**Modified:** `src/server.ts` (routes + `AppDeps`), `src/config.ts` (load
`forges.json`), `src/github.ts` (absorbed into `src/forge/github.ts`, old file
removed), `ui/src/lib/{types,api}.ts`, `ui/src/lib/components/Viewport.svelte`
(mount `GitRail`), `README.md` (forges.json docs), `TODO.md` (check off item).
