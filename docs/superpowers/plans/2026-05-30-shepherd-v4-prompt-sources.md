# Shepherd v4 — Prompt Sources (TODO + GitHub Issues) + Picker Polish

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Svelte files MUST use `svelte-code-writer`.

**Goal:**

1. **TODO → prompt:** in New Task, after choosing a repo, pick one of its open `TODO.md` items to seed the prompt (replace-then-editable).
2. **GitHub issues:** browse the selected repo's upstream GitHub issues as a viewport tab (`Terminal | To-Do | Issues`), AND pick an issue in New Task to seed the prompt (title + body). "+ Task" on a listed issue opens New Task pre-seeded.
3. **Picker polish:** replace the native `<datalist>` repo field with a custom **opaque** dropdown showing compacted `~/Work/<name>` paths (fixes the full-home-path display + see-through bugs).

**Architecture:** New backend `GET /api/issues?repo=<path>` resolves the repo's `origin` → GitHub `owner/repo` → `gh issue list --json`. `/api/repos` gains a `display` (home → `~`). UI: a custom `RepoSelect` combobox; a `PromptSources` block in New Task with To-Do / Issues tabs that seed the prompt; an `IssuesPanel` viewport tab; issue→task wiring via a callback threaded page→Viewport→IssuesPanel.

**Tech:** existing stack. `gh` CLI (authed). Backend `bun:test`, UI `vitest`+`svelte-check`. Branch `feat/shepherd-v4-prompt-sources`. Decisions: replace-then-editable · issue prompt = title+body · issues as viewport tab · custom opaque combobox.

---

## Task 1: Backend — GitHub issues + repo display

**Files:** `src/github.ts` (new), modify `src/repos.ts` (add `display`), modify `src/server.ts` (`/api/issues`), tests `test/github.test.ts` + `test/server.test.ts`.

### Step 1 — `src/github.ts`

```ts
import { execFileSync } from "node:child_process";
import { safeRepoDir } from "./validate";

export interface Issue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
}

const SLUG_RE = /github\.com[:/]([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/;

/** Resolve a repo dir's origin remote to a GitHub `owner/repo`, or null. */
export function githubSlug(repoDir: string): string | null {
  try {
    const url = execFileSync("git", ["-C", repoDir, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m = url.match(SLUG_RE);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

/** Parse `gh issue list --json` stdout into typed issues. Pure — injectable for tests. */
export function parseIssues(stdout: string): Issue[] {
  const raw = JSON.parse(stdout) as Array<{
    number: number;
    title: string;
    body?: string;
    url: string;
    labels?: Array<{ name: string }>;
  }>;
  return raw.map((i) => ({
    number: i.number,
    title: i.title,
    body: i.body ?? "",
    url: i.url,
    labels: (i.labels ?? []).map((l) => l.name),
  }));
}

/** List open issues for the repo's GitHub upstream. repo path must be validated by caller. */
export function listIssues(
  repoDir: string,
  run: (slug: string) => string = (slug) =>
    execFileSync(
      "gh",
      [
        "issue",
        "list",
        "--repo",
        slug,
        "--state",
        "open",
        "--json",
        "number,title,body,url,labels",
        "--limit",
        "50",
      ],
      { encoding: "utf8" },
    ),
): { slug: string | null; issues: Issue[] } {
  const slug = githubSlug(repoDir);
  if (!slug) return { slug: null, issues: [] };
  try {
    return { slug, issues: parseIssues(run(slug)) };
  } catch {
    return { slug, issues: [] };
  }
}
```

### Step 2 — `src/repos.ts`: add `display`

Add `display: string` to `RepoEntry`; in `listRepos`, compute `display = path.startsWith(home) ? "~" + path.slice(home.length) : path` where `home = process.env.HOME ?? ""`. (Import nothing new; use `process.env.HOME`.)

### Step 3 — tests `test/github.test.ts`

Pure tests (no real git/gh): `parseIssues` maps fields incl. labels[].name → string[] and missing body → "". `githubSlug` via a tiny temp git repo (`git init`, `git remote add origin https://github.com/o/r.git`) → "o/r"; also test the `git@github.com:o/r.git` form (set-url) → "o/r"; non-github remote → null; no remote → null. `listIssues` with an injected `run` returning a fixture → issues; with a repo whose slug is null → `{slug:null,issues:[]}`; with `run` throwing → `{slug, issues:[]}`.

### Step 4 — `src/server.ts`: `/api/issues`

Add `import { listIssues } from "./github";`. Add a route (under the existing `/api` guards, alongside `/api/todo`):

```ts
if (req.method === "GET" && parts[0] === "api" && parts[1] === "issues" && !parts[2]) {
  const repoRaw = url.searchParams.get("repo") ?? "";
  const dir = safeRepoDir(repoRaw, config.repoRoot); // import safeRepoDir from ./validate
  if (!dir) return json({ error: "invalid repo" }, 400);
  return json(listIssues(dir));
}
```

(Import `safeRepoDir` from `./validate`.) Keep existing routes/guards intact.

### Step 5 — server test

`GET /api/issues?repo=<validRepo>` → 200 with `{slug, issues}` shape (slug may be null for the test temp dir — assert the shape, `Array.isArray(body.issues)`). `GET /api/issues?repo=/etc` → 400.

### Step 6 — verify + commit

`bun run test` green; `bun run lint`; `bunx tsc --noEmit`. Commit: `feat: github issues endpoint + repo display path`.

---

## Task 2: Frontend — API/types + custom opaque RepoSelect

**Files:** `ui/src/lib/types.ts`, `ui/src/lib/api.ts`, new `ui/src/lib/components/RepoSelect.svelte`, modify `NewTask.svelte`. USE `svelte-code-writer`.

### Step 1 — types + api

`types.ts`: add `display: string` to `RepoEntry`; add `export interface Issue { number: number; title: string; body: string; url: string; labels: string[]; }`.
`api.ts`: add

```ts
export async function listIssues(
  repoPath: string,
): Promise<{ slug: string | null; issues: import("./types").Issue[] }> {
  const r = await fetch(`/api/issues?repo=${encodeURIComponent(repoPath)}`);
  if (!r.ok) throw new Error(`issues failed: ${r.status}`);
  return r.json();
}
```

### Step 2 — `RepoSelect.svelte` (custom opaque combobox)

Props `{ repos: RepoEntry[]; value: string; onchange: (path: string) => void }`. Behavior + style:

- A button/input showing the currently-selected repo's `name` (bold) + `display` (dimmed). Clicking toggles an **opaque** dropdown panel (`background: var(--color-panel)`; `border: 1px solid var(--color-line-bright)`; `z-index` above the New Task card; **NOT transparent** — this fixes the see-through bug). Position it absolutely under the field.
- Type-to-filter: an input filters repos by `name`/`display` (case-insensitive). Each row shows `name` + dimmed `display` (the `~/Work/<name>` form). Selecting a row calls `onchange(repo.path)` and closes.
- Keyboard: Esc closes; Enter selects the highlighted; ArrowUp/Down move (nice-to-have — at minimum click works).
- Click-outside closes (a window listener or an overlay). Ensure the panel renders ABOVE other content and is fully opaque (the reported bug = transparent dropdown).
  This REPLACES the native `<input list>`/`<datalist>` entirely.

### Step 3 — wire into `NewTask.svelte`

Replace the repoPath input+datalist with `<RepoSelect repos={repos} value={repoPath} onchange={(p) => (repoPath = p)} />`. Keep `repoPath` `$state` + the default-to-first behavior. Submit unchanged.

### Step 4 — verify + commit

`cd ui && bun run check` 0/0; `bun run build`. Commit: `feat(ui): custom opaque repo dropdown (~/Work compaction), issues api`.

---

## Task 3: Frontend — New Task prompt sources (TODO + Issues)

**Files:** new `ui/src/lib/components/PromptSources.svelte`, modify `NewTask.svelte`. USE `svelte-code-writer`.

### Step 1 — `PromptSources.svelte`

Props `{ repoPath: string; onpick: (prompt: string) => void }`. Behavior:

- Local `$state` `tab: "todo" | "issues" = "todo"`. Two small tabs.
- **To-Do tab:** `$effect` on `repoPath` → `getTodo(repoPath)`; parse OPEN items (`/^\s*-\s\[ \]\s+(.*)$/` → capture text); list them as clickable rows; click → `onpick(text)`. (Skip done items.) Empty → muted "no open TODO items".
- **Issues tab:** `$effect` on `repoPath` → `listIssues(repoPath)`; if `slug === null` show muted "no GitHub upstream"; else list issues (`#<number> <title>`, labels as tiny chips); click → `onpick(`${title}\n\n${body}`.trim())`. Loading state while fetching.
- Compact, scrollable (max-height ~180px), HUD-styled. This sits inside the New Task card under the prompt field.

### Step 2 — wire into `NewTask.svelte`

- Below the prompt textarea, render `<PromptSources repoPath={repoPath} onpick={(p) => (prompt = p)} />` (replace-then-editable: clicking sets `prompt`). Only render when `repoPath` is set.
- Accept optional props `initialPrompt?: string` and `initialRepoPath?: string`; if provided, initialize `prompt`/`repoPath` from them (used by the issue→task flow in Task 4).

### Step 3 — verify + commit

`cd ui && bun run check` 0/0; `bun run build`. Commit: `feat(ui): new-task prompt sources (todo + issues seed the prompt)`.

---

## Task 4: Frontend — Issues viewport tab + issue→task

**Files:** new `ui/src/lib/components/IssuesPanel.svelte`, modify `Viewport.svelte`, modify `+page.svelte`. USE `svelte-code-writer`.

### Step 1 — `IssuesPanel.svelte`

Props `{ repoPath: string; onnewtask: (prompt: string) => void }`. `$effect` on `repoPath` → `listIssues(repoPath)`. Render: if `slug===null` → muted "no GitHub upstream for this repo"; else a header (`ISSUES · <slug>`) + scrollable list of issues — each row: `#<number>`, title, label chips, an external link (`url`, opens new tab), and a `+ Task` button → `onnewtask(`${title}\n\n${body}`.trim())`. Loading + empty states. HUD-styled.

### Step 2 — `Viewport.svelte`: add Issues tab

Extend the tab toggle to `term | todo | issues` (header tabs `Terminal | To-Do | Issues`). Keep the terminal element MOUNTED across all tabs (display toggle, effect keyed only on `session.id`). When `issues`, render `<IssuesPanel repoPath={session.repoPath} onnewtask={onnewtask} />`. Add a prop `{ onnewtask: (prompt: string) => void }` to Viewport (passed from the page) carrying the session's repoPath context — actually the page needs BOTH repoPath and prompt; since Viewport knows `session.repoPath`, have IssuesPanel call `onnewtask(prompt)` and Viewport forward `onnewtask(prompt)` while the PAGE uses the currently-selected session's repoPath. Simpler: Viewport prop `onnewtask: (repoPath: string, prompt: string) => void`; IssuesPanel calls `onnewtask(prompt)`, Viewport wraps to `onnewtask(session.repoPath, prompt)`.

### Step 3 — `+page.svelte`: wire issue→New Task

- Add `$state` `composeRepoPath: string | null` and `composePrompt: string`. Pass `onnewtask={(repoPath, prompt) => { composeRepoPath = repoPath; composePrompt = prompt; showNew = true; }}` to `Viewport`.
- Pass `initialRepoPath={composeRepoPath ?? undefined}` and `initialPrompt={composePrompt}` to `<NewTask>`. Reset them when New Task closes.

### Step 4 — verify + commit

`cd ui && bun run check` 0/0; `bun run build`. Commit: `feat(ui): issues viewport tab + new-task-from-issue`.

---

## Task 5: E2E visual smoke (agent-browser)

Verification only. Build UI; boot backend on temp DB/port with `SHEPHERD_REPO_ROOT=/tmp/fake-work`. Create `/tmp/fake-work/proj` as a git repo with `origin` = a real public GitHub repo that HAS open issues (e.g. `git remote add origin https://github.com/cli/cli.git`) + a `TODO.md` with open items. Seed a bash-backed session for `proj`. Drive browser:

- New Task → confirm the custom dropdown is **opaque** + shows `~`-compacted paths (screenshot); confirm To-Do tab lists open items, clicking one fills the prompt; confirm Issues tab lists real GitHub issues, clicking one fills the prompt with title+body.
- Open the unit → Issues viewport tab → confirm issues render; click `+ Task` → New Task opens pre-seeded.
  Screenshot each. Teardown (stop agent, rm temp). Report PASS/FAIL with screenshots. (Uses a real public repo's issues — read-only `gh issue list`, safe.)

---

## Self-review

- `gh`/`git` calls use `execFileSync` arg arrays (no shell); slug regex-bounded; repo confined via `safeRepoDir`. Issues endpoint GET-only (no origin needed; read-only).
- Terminal stays mounted across all 3 viewport tabs. Prompt infusion = replace (editable). Custom dropdown opaque + `~`-compacted (fixes both cosmetic bugs).
- Scope: additive; spawn/PTY/status untouched. `gh` failures degrade to empty issue lists, never 500.
