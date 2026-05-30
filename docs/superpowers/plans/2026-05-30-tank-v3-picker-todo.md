# Shepherd v3 — Repo Picker + Per-Project TODO

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Svelte files MUST use `svelte-code-writer`.

**Goal:** (1) Replace the free-text repo field with an **autocomplete** of `~/Work` directories. (2) Add a **per-project `TODO.md`** surfaced as a "To-Do" tab in the viewport — render as a checklist, toggle items (writes `- [x]` back), and add new items. Track feature requests in the source folder, not just the DB.

**Architecture:** New read-only `GET /api/repos` + read/write `GET|PUT /api/todo?repo=<path>` on the existing Bun server (path-confined to `repoRoot`, CSRF-guarded on PUT). UI: a `<datalist>` on the New Task repo field fed by `/api/repos`; a `TodoPanel` rendered behind a Terminal|To-Do tab toggle in `Viewport`, keyed by the selected session's `repoPath`. Checklist mutation is client-side (toggle/add edit the raw markdown), persisted by PUTting the whole file.

**Tech:** existing stack. Backend `bun:test`; UI `vitest` + `svelte-check`. Branch: `feat/tank-v2-hud-ui`.

**Decisions:** autocomplete datalist (free text still allowed) · TODO file = `<repoPath>/TODO.md` · view+toggle+add · Terminal|To-Do tab.

---

## Task 1: Backend — repos + todo endpoints (TDD)

**Files:** `src/repos.ts` (new, pure helpers + fs ops), modify `src/server.ts`, modify `src/validate.ts` (export a repo-path guard), tests in `test/repos.test.ts` + `test/server.test.ts`.

### Step 1 — repo-path guard in `src/validate.ts`

Add an exported helper reusing `expandHome`:

```ts
import { existsSync, statSync } from "node:fs"; // (statSync already imported)
/** Resolve a repo path, confined to repoRoot and required to be a directory. null if invalid. */
export function safeRepoDir(repoPathRaw: string, repoRoot: string): string | null {
  if (typeof repoPathRaw !== "string" || repoPathRaw.length === 0) return null;
  const resolved = resolve(expandHome(repoPathRaw));
  const root = resolve(expandHome(repoRoot));
  const inside = resolved === root || resolved.startsWith(root + sep);
  if (!inside) return null;
  try {
    return statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}
```

(Refactor `validateCreate`'s repoPath block to use `safeRepoDir` to keep it DRY — optional but preferred.)

### Step 2 — `src/repos.ts`

```ts
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { safeRepoDir } from "./validate";

export interface RepoEntry {
  name: string;
  path: string;
}

/** Top-level directories under repoRoot (the "projects"). */
export function listRepos(repoRoot: string): RepoEntry[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(repoRoot);
  } catch {
    return [];
  }
  return entries
    .map((name) => ({ name, path: join(repoRoot, name) }))
    .filter((e) => {
      try {
        return statSync(e.path).isDirectory() && !e.name.startsWith(".");
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const TODO = "TODO.md";

export function readTodo(
  repoPathRaw: string,
  repoRoot: string,
): { ok: boolean; exists: boolean; content: string } {
  const dir = safeRepoDir(repoPathRaw, repoRoot);
  if (!dir) return { ok: false, exists: false, content: "" };
  const file = join(dir, TODO);
  if (!existsSync(file)) return { ok: true, exists: false, content: "" };
  return { ok: true, exists: true, content: readFileSync(file, "utf8") };
}

export function writeTodo(repoPathRaw: string, repoRoot: string, content: string): boolean {
  const dir = safeRepoDir(repoPathRaw, repoRoot);
  if (!dir) return false;
  if (typeof content !== "string" || content.length > 100_000) return false;
  writeFileSync(join(dir, TODO), content, "utf8");
  return true;
}
```

### Step 3 — failing tests `test/repos.test.ts`

Cover (real temp dirs): `listRepos` returns sorted top-level dirs, skips files + dotdirs; `readTodo` returns `{exists:false,content:""}` when no file, reads content when present; `readTodo`/`writeTodo` reject a path outside repoRoot (return ok:false / false); `writeTodo` then `readTodo` round-trips; `writeTodo` rejects >100k content. Use `mkdtempSync` for a fake repoRoot with sub-dirs.

### Step 4 — wire routes into `src/server.ts` (`makeApp`)

Before the static fallback, add (keep `checkAuth` applied to all `/api`; `checkOrigin` already gates non-GET):

```ts
import { listRepos, readTodo, writeTodo } from "./repos";
import { config } from "./config";
// ...
// GET /api/repos
if (req.method === "GET" && parts[0] === "api" && parts[1] === "repos" && !parts[2]) {
  return json(listRepos(config.repoRoot));
}
// GET/PUT /api/todo?repo=<path>
if (parts[0] === "api" && parts[1] === "todo" && !parts[2]) {
  const repo = url.searchParams.get("repo") ?? "";
  if (req.method === "GET") {
    const r = readTodo(repo, config.repoRoot);
    return r.ok ? json(r) : json({ error: "invalid repo" }, 400);
  }
  if (req.method === "PUT") {
    const body = (await req.json().catch(() => null)) as { content?: unknown } | null;
    if (!body || typeof body.content !== "string") return json({ error: "content required" }, 400);
    return writeTodo(repo, config.repoRoot, body.content)
      ? json({ ok: true })
      : json({ error: "invalid repo" }, 400);
  }
}
```

Ensure these sit under the `/api` auth/origin guards (PUT is non-GET → `checkOrigin` enforces allowed Origin; `checkAuth` applies if token set). Confirm `makeApp` already calls `checkAuth`/`checkOrigin` for `/api`; if those guards live only in `serve()`, replicate the same calls at the top of `makeApp.fetch` for `/api/*` (read the file and match existing pattern — do NOT weaken existing behavior).

### Step 5 — server tests `test/server.test.ts`

Add: `GET /api/repos` returns an array (point `config.repoRoot`? it's module-level — instead test `listRepos` in repos.test; for server, just assert 200 + array shape); `GET /api/todo?repo=<bad>` → 400; `PUT /api/todo` with a disallowed Origin → 403 (reuses origin guard). Keep existing tests green.

### Step 6 — verify + commit

`bun run test` (root) green; `bun run lint`; `bunx tsc --noEmit`. Commit: `feat: repos list + per-project TODO.md read/write endpoints`.

---

## Task 2: Frontend — API + autocomplete repo picker

**Files:** modify `ui/src/lib/api.ts`, `ui/src/lib/types.ts`, `ui/src/lib/components/NewTask.svelte`. USE `svelte-code-writer`.

### Step 1 — types + api

`types.ts`: `export interface RepoEntry { name: string; path: string; }` and `export interface TodoDoc { exists: boolean; content: string; }`.
`api.ts` add:

```ts
import type { RepoEntry } from "./types";
export async function listRepos(): Promise<RepoEntry[]> {
  const r = await fetch("/api/repos");
  if (!r.ok) throw new Error(`repos failed: ${r.status}`);
  return r.json();
}
export async function getTodo(repoPath: string): Promise<{ exists: boolean; content: string }> {
  const r = await fetch(`/api/todo?repo=${encodeURIComponent(repoPath)}`);
  if (!r.ok) throw new Error(`todo get failed: ${r.status}`);
  return r.json();
}
export async function putTodo(repoPath: string, content: string): Promise<void> {
  const r = await fetch(`/api/todo?repo=${encodeURIComponent(repoPath)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!r.ok) throw new Error(`todo put failed: ${r.status}`);
}
```

### Step 2 — NewTask autocomplete

In `NewTask.svelte`: on mount (`$effect` or `onMount`), `listRepos()` → `repos = $state<RepoEntry[]>([])`. Bind the repoPath `<input>` to a `<datalist>`:

```svelte
<input id="nt-repo" bind:value={repoPath} list="repo-list" placeholder="~/Work/…" required />
<datalist id="repo-list">
  {#each repos as r (r.path)}<option value={r.path}>{r.name}</option>{/each}
</datalist>
```

Default `repoPath` to the first repo's path once loaded if empty (optional nicety). Free text still allowed (server expands `~`). Keep submit logic unchanged.

### Step 3 — verify + commit

`cd ui && bun run check` 0 errors; `bun run build`. Commit: `feat(ui): autocomplete repo picker (datalist from /api/repos)`.

---

## Task 3: Frontend — TodoPanel + viewport tab

**Files:** new `ui/src/lib/components/TodoPanel.svelte`, modify `ui/src/lib/components/Viewport.svelte`. USE `svelte-code-writer`.

### Step 1 — `TodoPanel.svelte`

Props `{ repoPath: string }`. Behavior:

- `$effect` keyed on `repoPath`: `getTodo(repoPath)` → `content = $state("")`, `exists = $state(false)`.
- Parse `content` into lines; render each line: if it matches `/^(\s*)-\s\[( |x)\]\s(.*)$/` show a checkbox (checked when `x`) + the label; other lines render as muted text (cheap markdown — headers `#` slightly emphasized is a nice touch but optional).
- **Toggle:** clicking a checkbox flips that line's `[ ]`↔`[x]` in the raw `content`, then `putTodo(repoPath, content)` (optimistic; refetch not required).
- **Add:** an input + "Add" that appends `\n- [ ] <text>` to `content` and PUTs.
- Empty/`!exists`: show "No TODO.md — add the first item" with the add input (first add creates the file via PUT).
- Style: HUD panel look (mono, checkboxes tinted with `--color-amber` when done = green check). Keep it tidy and on-theme.
  Keep line-mutation pure and index-based so toggling the right line is reliable (operate on `content.split("\n")`).

### Step 2 — Viewport tab toggle

In `Viewport.svelte`, add a local `$state` `tab: "term" | "todo" = "term"` with two header tabs (`Terminal` | `To-Do`). When `term`, show the xterm element (keep it MOUNTED — do not destroy on tab switch; just hide with CSS `display:none` so the PTY/session survives). When `todo`, render `<TodoPanel repoPath={session.repoPath} />`. The terminal lifecycle `$effect` stays keyed on `session.id` only (tab switching must NOT tear down the terminal). Match the mockup `.vp-head` styling for the tabs.

### Step 3 — verify + commit

`cd ui && bun run check` 0 errors; `bun run build`. Commit: `feat(ui): per-project TODO panel with Terminal|To-Do viewport tab`.

---

## Task 4: E2E visual smoke (agent-browser, no real claude)

Verification only (no commit). Build UI; boot backend on a temp DB/port with `SHEPHERD_REPO_ROOT=/tmp/fake-work` containing a couple of fake repo dirs (one with a `TODO.md`). Seed a bash-backed session pointing at one repo. Drive the browser: open New Task → confirm the datalist lists the fake repos; open a unit → switch to the To-Do tab → confirm the checklist renders, toggle an item (verify the file on disk now has `- [x]`), add an item (verify appended). Screenshot both tabs. Teardown (stop bash agent, rm temp dirs/db). Report PASS/FAIL with screenshots.

---

## Self-review

- Path confinement: `/api/todo` and `/api/repos` both bounded to `repoRoot` via `safeRepoDir`; PUT gated by Origin allowlist; no traversal (resolve+inside check). Content capped at 100k.
- DRY: `safeRepoDir` shared by `validateCreate` + repos. Terminal not torn down on tab switch. Types mirror backend.
- Scope: additive; no change to spawn/PTY/status paths.
