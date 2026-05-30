# Shepherd v2 — HUD UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
> **Svelte note:** Every task that writes `.svelte`/`.svelte.ts` MUST use the `svelte-code-writer` skill (and Context7 for Svelte 5 / Tailwind 4 / xterm APIs). Svelte 5 runes only (`$state`, `$derived`, `$effect`, `$props`); NEVER Svelte 4 stores syntax or `export let`.

**Goal:** A monospace "Shepherd HUD" web UI (SvelteKit 5 + Tailwind 4 + xterm.js) on top of the Plan-1 backend — spawn tasks, watch the herd with live status lights, and open a live, steerable terminal per session.

**Architecture:** A SvelteKit 5 **SPA** in `ui/` (adapter-static, Svelte 5 runes). In dev, Vite proxies `/api`, `/events`, `/pty` to the Bun backend (`:7330`). In prod, the Bun server serves `ui/build` as static files. State of record is the backend; the UI holds a reactive mirror updated by an initial REST fetch + the `/events` WebSocket. The live terminal is xterm.js over the `/pty/:id` WebSocket. Visual language is ported from `mockup/hud.html`.

**Tech Stack:** SvelteKit 5, Svelte 5 (runes), Tailwind CSS 4 (`@tailwindcss/vite`), `@xterm/xterm` + `@xterm/addon-fit`, Bun, Vitest (+ Playwright via `@testing-library` optional), `sv` scaffolder. Backend: existing Bun server (`src/server.ts`).

**Backend contract (already live, Plan 1):**

- `GET /api/sessions` → `Session[]` (active). `POST /api/sessions {repoPath, baseBranch, prompt}` → `Session` (201). `GET /api/sessions/:id` → `Session`. `DELETE /api/sessions/:id` → `{ok:true}`.
- `Session` fields: `id, desig, name, prompt, repoPath, baseBranch, branch, worktreePath, isolated, herdrSession, herdrAgentId, status, lastState, createdAt, updatedAt, archivedAt`. `status ∈ running|idle|blocked|done|archived`.
- WS `/events` → JSON frames `{event, data}`; events: `session:new` (data=Session), `session:status` (`{id,status}`), `session:archived` (`{id}`).
- WS `/pty/:id` → raw terminal bytes both directions; send `"\x00resize:<cols>:<rows>\n"` to resize.
- CSRF: POST/DELETE require `Content-Type: application/json` and (if cross-origin) an allowed `Origin`. Same-origin UI is fine. WS upgrades also enforce Origin.

---

## File structure

```
tank/
  src/server.ts               # MODIFY (Task 8): serve ui/build static + SPA fallback
  ui/                         # NEW SvelteKit SPA
    svelte.config.js          # adapter-static
    vite.config.ts            # tailwind plugin + dev proxy to :7330
    src/
      app.html
      app.css                 # Shepherd HUD tokens (ported from mockup/hud.html) + tailwind
      lib/
        types.ts              # Session, WS event types (mirror backend)
        api.ts                # REST client
        store.svelte.ts       # reactive herd state + /events WS
        pty.ts                # /pty/:id WebSocket helper
        format.ts             # elapsed/clock helpers
        components/
          TopBar.svelte
          StatusPip.svelte
          UnitRow.svelte
          Herd.svelte
          Viewport.svelte
          NewTask.svelte
          ActionBar.svelte
      routes/
        +layout.ts            # export const ssr=false, prerender=true (SPA)
        +page.svelte          # composes the HUD
    test/
      api.test.ts
      store.test.ts
```

---

## Task 1: Scaffold the SvelteKit SPA in `ui/`

**Files:** create `ui/` project.

- [ ] **Step 1: Scaffold**

```bash
cd ~/Work/tank
bunx sv create ui --template minimal --types ts --no-add-ons --no-install
cd ui && bun install
bun add -d @tailwindcss/vite @sveltejs/adapter-static
bun add @xterm/xterm @xterm/addon-fit
```

- [ ] **Step 2: SPA adapter** — `ui/svelte.config.js`:

```js
import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
export default {
  preprocess: vitePreprocess(),
  kit: { adapter: adapter({ fallback: "index.html" }) },
};
```

- [ ] **Step 3: Vite + Tailwind + dev proxy** — `ui/vite.config.ts`:

```ts
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    proxy: {
      "/api": "http://localhost:7330",
      "/events": { target: "ws://localhost:7330", ws: true },
      "/pty": { target: "ws://localhost:7330", ws: true },
    },
  },
});
```

- [ ] **Step 4: SPA layout** — `ui/src/routes/+layout.ts`:

```ts
export const ssr = false;
export const prerender = true;
```

- [ ] **Step 5: Minimal app.css + verify dev boots**

`ui/src/app.css`:

```css
@import "tailwindcss";
```

Import it in `ui/src/routes/+layout.svelte` (create if missing):

```svelte
<script lang="ts">
  import "../app.css";
  let { children } = $props();
</script>
{@render children()}
```

Verify: `cd ui && bun run dev` boots without error (Ctrl-C after confirming). Run `bun run build` — it produces `ui/build/`.

- [ ] **Step 6: Commit**

```bash
cd ~/Work/tank
echo "ui/build/" >> .gitignore
git add -A && git commit -m "chore(ui): scaffold sveltekit5 spa (tailwind4, xterm, adapter-static)"
```

---

## Task 2: Shepherd HUD design tokens

**Files:** Modify `ui/src/app.css`. Reference: `mockup/hud.html` (the `:root` token block + component CSS already prototyped there).

- [ ] **Step 1: Port the token sheet** into `ui/src/app.css` (after `@import "tailwindcss";`). Use Tailwind v4 `@theme` for the palette + a `:root` block for raw vars, mirroring `mockup/hud.html`:

```css
@import "tailwindcss";

@theme {
  --color-bg: #0a0d0c;
  --color-panel: #0f1413;
  --color-inset: #070a09;
  --color-line: #1b2422;
  --color-line-bright: #2c3835;
  --color-ink: #aab8b2;
  --color-ink-bright: #e9f1ec;
  --color-muted: #5d6c67;
  --color-amber: #e8a13a;
  --color-green: #5ad19a;
  --color-red: #e5484d;
  --color-slate: #566460;
  --font-mono: "Berkeley Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}

:root {
  --status-working: var(--color-amber);
  --status-done: var(--color-green);
  --status-blocked: var(--color-red);
  --status-idle: var(--color-slate);
}

html,
body {
  background: var(--color-bg);
  color: var(--color-ink);
  font-family: var(--font-mono);
}

/* motion (guarded) */
@keyframes pip-pulse {
  0% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--status-working) 70%, transparent);
  }
  70% {
    box-shadow: 0 0 0 7px transparent;
  }
  100% {
    box-shadow: 0 0 0 0 transparent;
  }
}
@keyframes blink {
  50% {
    opacity: 0;
  }
}
@keyframes scan {
  0% {
    top: -70px;
  }
  100% {
    top: 100%;
  }
}
@media (prefers-reduced-motion: reduce) {
  * {
    animation: none !important;
  }
}
```

Load JetBrains Mono webfont via `ui/src/app.html` `<head>` (the `<link>` tags from the mockup). Keep "Berkeley Mono" first in the stack (falls back if unlicensed).

- [ ] **Step 2: status helper** — add a small mapping used by components, in `ui/src/lib/format.ts` (created fully in Task 3); for now just confirm the CSS vars exist.

- [ ] **Step 3: Commit**

```bash
git add ui/src/app.css ui/src/app.html && git commit -m "feat(ui): tank hud design tokens + motion"
```

---

## Task 3: Types, REST client, format helpers (TDD where pure)

**Files:** `ui/src/lib/types.ts`, `ui/src/lib/api.ts`, `ui/src/lib/format.ts`; Test `ui/test/api.test.ts`.

- [ ] **Step 1: Types** — `ui/src/lib/types.ts` (mirror backend):

```ts
export type SessionStatus = "running" | "idle" | "blocked" | "done" | "archived";
export interface Session {
  id: string;
  desig: string;
  name: string;
  prompt: string;
  repoPath: string;
  baseBranch: string;
  branch: string | null;
  worktreePath: string;
  isolated: boolean;
  herdrSession: string;
  herdrAgentId: string;
  status: SessionStatus;
  lastState: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}
export type WsEvent =
  | { event: "session:new"; data: Session }
  | { event: "session:status"; data: { id: string; status: SessionStatus } }
  | { event: "session:archived"; data: { id: string } };
export interface CreateInput {
  repoPath: string;
  baseBranch: string;
  prompt: string;
}
```

- [ ] **Step 2: format helpers** — `ui/src/lib/format.ts`:

```ts
import type { SessionStatus } from "./types";

export function elapsed(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export const STATUS_COLOR: Record<SessionStatus, string> = {
  running: "var(--status-working)",
  idle: "var(--status-idle)",
  blocked: "var(--status-blocked)",
  done: "var(--status-done)",
  archived: "var(--status-idle)",
};

export function statusLabel(s: SessionStatus): string {
  return s === "running" ? "WORKING" : s.toUpperCase();
}
```

- [ ] **Step 3: failing test** — `ui/test/api.test.ts`:

```ts
import { test, expect } from "vitest";
import { elapsed, statusLabel } from "../src/lib/format";

test("elapsed formats mm:ss", () => {
  expect(elapsed(0, 194_000)).toBe("03:14");
  expect(elapsed(0, 0)).toBe("00:00");
});
test("statusLabel maps running→WORKING", () => {
  expect(statusLabel("running")).toBe("WORKING");
  expect(statusLabel("blocked")).toBe("BLOCKED");
});
```

Add Vitest: `cd ui && bun add -d vitest`. Add `"test": "vitest run"` to `ui/package.json` scripts. Run `bun run test` → expect these PASS (format.ts already implemented). (If `sv` already added a test setup, integrate; otherwise a bare `vitest` config is fine.)

- [ ] **Step 4: REST client** — `ui/src/lib/api.ts`:

```ts
import type { Session, CreateInput } from "./types";

const JSON_HEADERS = { "content-type": "application/json" };

export async function listSessions(): Promise<Session[]> {
  const r = await fetch("/api/sessions");
  if (!r.ok) throw new Error(`list failed: ${r.status}`);
  return r.json();
}
export async function createSession(input: CreateInput): Promise<Session> {
  const r = await fetch("/api/sessions", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(`create failed: ${r.status}`);
  return r.json();
}
export async function archiveSession(id: string): Promise<void> {
  const r = await fetch(`/api/sessions/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`archive failed: ${r.status}`);
}
```

- [ ] **Step 5:** Run `bun run test` (PASS) + `bun run check` (svelte-check, if present) clean.

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib ui/test ui/package.json && git commit -m "feat(ui): types, rest client, format helpers"
```

---

## Task 4: Reactive herd store + `/events` WebSocket

**Files:** `ui/src/lib/store.svelte.ts`; Test `ui/test/store.test.ts`. USE `svelte-code-writer` skill (runes in a `.svelte.ts` module).

- [ ] **Step 1: failing test** — `ui/test/store.test.ts`:

```ts
import { test, expect } from "vitest";
import { HerdStore } from "../src/lib/store.svelte";
import type { Session } from "../src/lib/types";

const s = (id: string, status: any = "running"): Session => ({
  id,
  desig: "UNIT-01",
  name: "x",
  prompt: "x",
  repoPath: "/r",
  baseBranch: "main",
  branch: "tank/x",
  worktreePath: "/wt",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "term_" + id,
  status,
  lastState: "working",
  createdAt: 0,
  updatedAt: 0,
  archivedAt: null,
});

test("applies snapshot, new, status, archived", () => {
  const store = new HerdStore();
  store.setAll([s("a"), s("b")]);
  expect(store.sessions.length).toBe(2);

  store.apply({ event: "session:new", data: s("c") });
  expect(store.sessions.length).toBe(3);

  store.apply({ event: "session:status", data: { id: "a", status: "blocked" } });
  expect(store.byId("a")?.status).toBe("blocked");

  store.apply({ event: "session:archived", data: { id: "b" } });
  expect(store.sessions.find((x) => x.id === "b")).toBeUndefined();
});
```

- [ ] **Step 2:** Run `bun run test` — expect FAIL (module missing).

- [ ] **Step 3: Implement** `ui/src/lib/store.svelte.ts`:

```ts
import type { Session, SessionStatus, WsEvent } from "./types";

export class HerdStore {
  sessions = $state<Session[]>([]);
  connected = $state(false);

  setAll(list: Session[]) {
    this.sessions = list;
  }
  byId(id: string) {
    return this.sessions.find((s) => s.id === id);
  }

  apply(ev: WsEvent) {
    if (ev.event === "session:new") {
      if (!this.byId(ev.data.id)) this.sessions = [...this.sessions, ev.data];
    } else if (ev.event === "session:status") {
      this.sessions = this.sessions.map((s) =>
        s.id === ev.data.id ? { ...s, status: ev.data.status } : s,
      );
    } else if (ev.event === "session:archived") {
      this.sessions = this.sessions.filter((s) => s.id !== ev.data.id);
    }
  }

  /** Connect the /events WS with auto-reconnect. Returns a disposer. */
  connect(makeWs: () => WebSocket = () => new WebSocket(wsUrl("/events"))): () => void {
    let ws: WebSocket | null = null;
    let stopped = false;
    const open = () => {
      ws = makeWs();
      ws.onopen = () => (this.connected = true);
      ws.onmessage = (e) => {
        try {
          this.apply(JSON.parse(e.data));
        } catch {}
      };
      ws.onclose = () => {
        this.connected = false;
        if (!stopped) setTimeout(open, 1000);
      };
      ws.onerror = () => ws?.close();
    };
    open();
    return () => {
      stopped = true;
      ws?.close();
    };
  }
}

export function wsUrl(path: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${path}`;
}
```

Note: `$state` in a `.svelte.ts` class is valid Svelte 5. Verify the test runs `$state` outside a component — vitest needs the Svelte plugin. Add to `ui/vite.config.ts` test config OR create `ui/vitest-setup`: ensure `vitest` uses the svelte plugin so runes compile. If `$state` in plain `.ts` test proves troublesome, wrap the reducer logic (`apply`, `setAll`, `byId`) as pure functions over a plain array and have the class delegate — keep the test on the pure functions. Prefer the pure-function split if runes-in-vitest is friction. (Implementer: choose the working path, keep behavior identical.)

- [ ] **Step 4:** Run `bun run test` — PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/store.svelte.ts ui/test/store.test.ts && git commit -m "feat(ui): reactive herd store + events websocket"
```

---

## Task 5: Presentational HUD components

**Files:** `TopBar.svelte`, `StatusPip.svelte`, `UnitRow.svelte`, `Herd.svelte`, `NewTask.svelte`, `ActionBar.svelte` under `ui/src/lib/components/`. USE `svelte-code-writer` skill. Port visuals from `mockup/hud.html` (box-drawing frames, amber/green/red pips, ticking elapsed). Use Tailwind classes + the tokens from Task 2.

- [ ] **Step 1: StatusPip.svelte** — a colored dot; pulses when `running`.

```svelte
<script lang="ts">
  import type { SessionStatus } from "$lib/types";
  import { STATUS_COLOR } from "$lib/format";
  let { status }: { status: SessionStatus } = $props();
</script>
<span class="pip" class:pulse={status === "running"} style="--c:{STATUS_COLOR[status]}"></span>
<style>
  .pip { width: 9px; height: 9px; border-radius: 50%; background: var(--c); display: inline-block; }
  .pulse { animation: pip-pulse 1.5s ease-out infinite; }
</style>
```

- [ ] **Step 2: UnitRow.svelte** — one session row: pip, `desig` (muted), `name`, last-line/`prompt`, status badge, live elapsed (ticks via a `nowMs` prop passed from parent), model hint. Emits `select` and exposes the session. Left rule + glow when selected (port mockup `.unit`). Props: `{ session, selected, nowMs }`, callback prop `onselect: (id)=>void`.

- [ ] **Step 3: Herd.svelte** — the list panel: header (`THE HERD`), maps `sessions` → `UnitRow`. Props `{ sessions, selectedId, nowMs, onselect }`.

- [ ] **Step 4: TopBar.svelte** — HUD bar: `SHEPHERD` callsign, herd count, working/idle/blocked tallies (derived from sessions), live clock. Props `{ sessions, nowMs }`; compute tallies with `$derived`.

- [ ] **Step 5: NewTask.svelte** — a form: prompt textarea, repoPath input (default `~/Work/...`), baseBranch input (default `main`); on submit calls `onsubmit({repoPath, baseBranch, prompt})`. Disable while submitting. Props: `{ onsubmit }`.

- [ ] **Step 6: ActionBar.svelte** — buttons `+ NEW TASK` (primary), `All ▦`, `Focus ⌖`; the honest status line. Props: callback `onnew`.

Each component: keep `<style>` scoped, reuse the mockup's exact look (1px borders, corner brackets, uppercase micro-labels). No business logic — pure props in, callbacks out.

- [ ] **Step 7:** `cd ui && bun run check` (svelte-check) clean; `bun run build` succeeds.

- [ ] **Step 8: Commit**

```bash
git add ui/src/lib/components && git commit -m "feat(ui): hud components (topbar, herd, unitrow, pip, newtask, actionbar)"
```

---

## Task 6: Live terminal Viewport (xterm + `/pty/:id`)

**Files:** `ui/src/lib/pty.ts`, `ui/src/lib/components/Viewport.svelte`. USE `svelte-code-writer` + Context7 for `@xterm/xterm` API.

- [ ] **Step 1: pty helper** — `ui/src/lib/pty.ts`:

```ts
import { wsUrl } from "./store.svelte";

export interface PtyConn {
  send(data: string): void;
  resize(c: number, r: number): void;
  close(): void;
}

export function connectPty(
  id: string,
  onData: (bytes: string) => void,
  onClose: () => void,
): PtyConn {
  const ws = new WebSocket(wsUrl(`/pty/${id}`));
  ws.binaryType = "arraybuffer";
  ws.onmessage = (e) =>
    onData(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data));
  ws.onclose = onClose;
  return {
    send: (d) => ws.readyState === ws.OPEN && ws.send(d),
    resize: (c, r) => ws.readyState === ws.OPEN && ws.send(`\x00resize:${c}:${r}\n`),
    close: () => ws.close(),
  };
}
```

- [ ] **Step 2: Viewport.svelte** — frame (header: `desig` · branch · model · elapsed) + an xterm mounted in an element. On mount: `new Terminal({ fontFamily, theme: { background: "#070a09", foreground: "#b9c7c1" }, cursorBlink: true })`, `FitAddon`, `term.open(el)`, `fit()`; `connectPty(id, (d)=>term.write(d), onClose)`; `term.onData((d)=>conn.send(d))`; on resize (ResizeObserver) `fit()` + `conn.resize(term.cols, term.rows)`. Clean up term + conn in `$effect` teardown / `onDestroy`. Props: `{ session }`. Re-create the connection when `session.id` changes (`$effect` keyed on id). Include the drifting `.scan` overlay from the mockup.

- [ ] **Step 3:** `bun run check` clean; `bun run build` succeeds.

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/pty.ts ui/src/lib/components/Viewport.svelte && git commit -m "feat(ui): live xterm viewport over /pty websocket"
```

---

## Task 7: Compose the HUD (`+page.svelte`)

**Files:** `ui/src/routes/+page.svelte`. USE `svelte-code-writer`.

- [ ] **Step 1: Compose** — wire everything:

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { HerdStore } from "$lib/store.svelte";
  import { listSessions, createSession, archiveSession } from "$lib/api";
  import TopBar from "$lib/components/TopBar.svelte";
  import Herd from "$lib/components/Herd.svelte";
  import Viewport from "$lib/components/Viewport.svelte";
  import NewTask from "$lib/components/NewTask.svelte";
  import ActionBar from "$lib/components/ActionBar.svelte";

  const store = new HerdStore();
  let selectedId = $state<string | null>(null);
  let showNew = $state(false);
  let nowMs = $state(Date.now());

  const selected = $derived(store.sessions.find((s) => s.id === selectedId) ?? null);

  onMount(() => {
    listSessions().then((list) => {
      store.setAll(list);
      if (!selectedId && list[0]) selectedId = list[0].id;
    });
    const dispose = store.connect();
    const t = setInterval(() => (nowMs = Date.now()), 1000);
    return () => { dispose(); clearInterval(t); };
  });

  async function onsubmit(input: { repoPath: string; baseBranch: string; prompt: string }) {
    const s = await createSession(input);
    selectedId = s.id; showNew = false;
  }
  async function onarchive(id: string) { await archiveSession(id); if (selectedId === id) selectedId = null; }
</script>

<div class="hud-shell">
  <TopBar sessions={store.sessions} {nowMs} />
  <div class="grid">
    <Herd sessions={store.sessions} {selectedId} {nowMs} onselect={(id) => (selectedId = id)} />
    {#if selected}
      <Viewport session={selected} />
    {:else}
      <div class="empty">NO UNIT SELECTED</div>
    {/if}
  </div>
  <ActionBar onnew={() => (showNew = true)} />
  {#if showNew}<NewTask {onsubmit} />{/if}
</div>
```

(Layout/grid styles port from the mockup `.wrap`/`.grid`. The connection-pip / `store.connected` can drive a small indicator in TopBar.)

- [ ] **Step 2:** `bun run check` clean; `bun run build` succeeds.

- [ ] **Step 3: Commit**

```bash
git add ui/src/routes/+page.svelte && git commit -m "feat(ui): compose tank hud page"
```

---

## Task 8: Backend serves the built UI

**Files:** Modify `src/server.ts` (`makeApp` fallback + `serve`).

- [ ] **Step 1:** In `src/server.ts`, when no `/api` route matches and the method is GET, serve static files from `ui/build` with SPA fallback to `index.html`. Add a helper:

```ts
import { join, normalize } from "node:path";

const UI_DIR = join(import.meta.dir, "..", "ui", "build");

async function serveStatic(pathname: string): Promise<Response> {
  const rel = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
  const file = Bun.file(join(UI_DIR, rel === "/" ? "index.html" : rel));
  if (await file.exists()) return new Response(file);
  return new Response(Bun.file(join(UI_DIR, "index.html"))); // SPA fallback
}
```

In `makeApp`'s `fetch`, replace the final `return json({ error: "not found" }, 404);` with: if `req.method === "GET"` and the path isn't under `/api`, `return serveStatic(url.pathname);` else keep the 404. (Keep `/api/*` returning JSON 404.) Guard the path-traversal as shown (the `normalize` + strip leading `..`).

- [ ] **Step 2: Test** — add to `test/server.test.ts`: a GET to `/` returns 200 with HTML when `ui/build/index.html` exists; skip gracefully if not built (`test.skipIf(!existsSync(...))`). And a GET to `/api/nope` still returns JSON 404. Keep existing tests green.

- [ ] **Step 3:** `bun test` (root) green; `bun run lint`; `bunx tsc --noEmit` clean.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts test/server.test.ts && git commit -m "feat: backend serves built ui/ (spa fallback, traversal-safe)"
```

---

## Task 9: End-to-end visual smoke (agent-browser, no real claude)

**Files:** none committed (verification only). USE the `agent-browser` skill.

- [ ] **Step 1: Build UI + boot backend on a temp DB/port**

```bash
cd ~/Work/tank/ui && bun run build
cd ~/Work/tank && SHEPHERD_DB=/tmp/tank-e2e.db SHEPHERD_PORT=7346 SHEPHERD_REPO_ROOT=/tmp bun run src/index.ts &
sleep 1.5
```

- [ ] **Step 2: Seed a fake, claude-free session** so the herd + a streaming terminal are visible:
- `herdr agent start tank-e2e-probe --cwd /tmp --no-focus -- bash` ; get its `terminal_id` from `herdr agent list`.
- Insert a session row pointing at it: write a throwaway `e2e-seed.ts` that opens the same SQLite (`new Database("/tmp/tank-e2e.db")`) and inserts a row via `SessionStore`, OR POST to `/api/sessions` with `repoPath=/tmp` (it will spawn a real `claude` — DON'T; prefer the direct insert with the bash terminal_id). Run it with `bun run e2e-seed.ts`, then delete it.

- [ ] **Step 3: Drive the browser** (agent-browser): open `http://localhost:7346`, snapshot, **screenshot** the HUD. Click the unit row → confirm the Viewport opens and streams bash (type `echo hud-live` via the terminal, screenshot showing it). Open `+ NEW TASK`, screenshot the form. Save screenshots to `/tmp/tank-hud-*.png`.

- [ ] **Step 4: Verify** the screenshots show: the amber/green/red HUD styling, the herd list with the seeded unit, a live terminal pane. Report PASS/FAIL with the screenshots.

- [ ] **Step 5: Teardown** — kill the backend, stop the bash probe (`herdr pane close`), `rm -f /tmp/tank-e2e.db e2e-seed.ts`. Confirm `herdr agent list` clean.

- [ ] **Step 6:** No commit (verification only). If any wiring bug surfaced, fix it in the relevant module + re-run, and note it.

---

## Self-review (run after writing the plan)

**Spec coverage (UI-SPEC §9 / PRD F-items in scope):** spawn task (Task 5 NewTask + Task 7) ✓; live terminal (Task 6) ✓; status lights (Tasks 5 StatusPip + 4 store) ✓; All/Herd view (Task 5 Herd) ✓; HUD visual language (Task 2 + components) ✓; persistence/reconnect surfaced via store.connect + initial REST (Task 4/7) ✓; backend serves UI (Task 8) ✓; e2e proof (Task 9) ✓. Out of scope (later milestones): git PR/merge buttons, research chat, usage gauge wiring, second-viewer takeover UX (frame only) — consistent with v1 thin-core scope.

**Placeholder scan:** component Tasks 5/6 give structure + key snippets + the mockup as the exact visual reference rather than full line-by-line markup — acceptable because `mockup/hud.html` is committed and is the literal source of truth, and the `svelte-code-writer` skill is mandated. api/store/server/pty/format are fully specified with code.

**Type consistency:** `Session`/`SessionStatus`/`WsEvent` mirror the backend exactly; `wsUrl` shared from store; `connectPty` signature matches Viewport usage; `STATUS_COLOR` keyed by `SessionStatus`.
