# Saved Steers / Broadcast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator save canned prompts ("steers") and fire one into the focused session with a tap, or broadcast it to a multi-selected set of sessions.

**Architecture:** Steers persist server-side in the existing settings KV as JSON. New endpoints `GET/PUT /api/steers` (list/replace) and `POST /api/broadcast` (`{text, ids}` → fan `service.reply` over ids). UI: a chip row (`SteerBar`) in the Viewport sends a steer to the focused session via the existing reply path; a `📡 Broadcast` chip opens a target-picker dialog; CRUD lives in a `SteersEditor` inside the Settings modal.

**Tech Stack:** Bun + TypeScript (server, `bun test`), SvelteKit + Svelte 5 runes + Tailwind 4 (UI, `vitest run`). Two packages: root and `ui/` — each needs its own `bun install` in a fresh worktree.

**Spec:** `docs/superpowers/specs/2026-05-31-saved-steers-broadcast-design.md`

> **Setup (run once before Task 1):** `bun install` at repo root and `cd ui && bun install`. Root tests: `bun test`. UI tests: `cd ui && bun run test` (the package's `vitest run` script). UI typecheck: `cd ui && bun run check`. Root lint: `bun run lint`.
>
> **UI test runner — important:** UI tests run on **vitest**, not Bun's runner. `bun test` cannot compile `.svelte.ts` rune files (`$state` throws "is not defined"); the steers store (Task 6) is a rune module, so its test only passes under vitest. Use `cd ui && bun run test` for the whole UI suite, or `cd ui && bunx vitest run <file>` for one file. (This corrects the `bun test` entry in the project's CLAUDE.md table, which only happens to work for the pre-existing plain-TS tests.)

---

### Task 1: `Steer` type + steers persistence module

**Files:**
- Modify: `src/types.ts` (add `Steer`)
- Create: `src/steers.ts`
- Test: `test/steers.test.ts`

- [ ] **Step 1: Add the `Steer` type**

In `src/types.ts`, append:

```ts
export interface Steer {
  id: string;
  label: string;
  text: string;
}
```

- [ ] **Step 2: Write the failing test**

Create `test/steers.test.ts`:

```ts
import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { loadSteers, saveSteers, DEFAULT_STEERS } from "../src/steers";

test("loadSteers seeds + persists the defaults on first read", () => {
  const store = new SessionStore(":memory:");
  const got = loadSteers(store);
  expect(got.length).toBe(DEFAULT_STEERS.length);
  expect(got.map((s) => s.label)).toEqual(DEFAULT_STEERS.map((s) => s.label));
  // every seeded steer has a uuid id
  for (const s of got) expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
  // persisted, so a second read is stable (same ids)
  expect(loadSteers(store)).toEqual(got);
});

test("loadSteers returns the stored list verbatim", () => {
  const store = new SessionStore(":memory:");
  const list = [{ id: "a", label: "x", text: "y" }];
  saveSteers(store, list);
  expect(loadSteers(store)).toEqual(list);
});

test("loadSteers returns [] on corrupt JSON", () => {
  const store = new SessionStore(":memory:");
  store.setSetting("steers", "{not json");
  expect(loadSteers(store)).toEqual([]);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/steers.test.ts`
Expected: FAIL — `Cannot find module '../src/steers'`.

- [ ] **Step 4: Write the module**

Create `src/steers.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { SessionStore } from "./store";
import type { Steer } from "./types";

const SETTING_KEY = "steers";

/** Shipped defaults; seeded on first read, then fully owned by the operator. */
export const DEFAULT_STEERS: Omit<Steer, "id">[] = [
  { label: "commit & push", text: "commit & push" },
  { label: "rebase", text: "rebase onto the base branch" },
  { label: "run tests", text: "run the tests" },
];

/** Read saved steers, seeding (and persisting) the defaults on first use. */
export function loadSteers(store: Pick<SessionStore, "getSetting" | "setSetting">): Steer[] {
  const raw = store.getSetting(SETTING_KEY);
  if (raw == null) {
    const seeded = DEFAULT_STEERS.map((s) => ({ id: randomUUID(), ...s }));
    store.setSetting(SETTING_KEY, JSON.stringify(seeded));
    return seeded;
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Steer[]) : [];
  } catch {
    return [];
  }
}

/** Persist the steers list verbatim (caller has already validated it). */
export function saveSteers(store: Pick<SessionStore, "setSetting">, steers: Steer[]): void {
  store.setSetting(SETTING_KEY, JSON.stringify(steers));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/steers.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/steers.ts test/steers.test.ts
git commit -m "feat(steers): server-side steers persistence + defaults"
```

---

### Task 2: `validateSteers` + `validateBroadcast`

**Files:**
- Modify: `src/validate.ts`
- Test: `test/validate.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `test/validate.test.ts`:

```ts
import { validateSteers, validateBroadcast } from "../src/validate";

test("validateSteers normalizes valid entries and assigns missing ids", () => {
  const out = validateSteers([
    { label: "  run tests ", text: "  run the tests " },
    { id: "keep", label: "rebase", text: "rebase onto main" },
  ]);
  expect(out).not.toBeNull();
  expect(out![0].label).toBe("run tests");
  expect(out![0].text).toBe("run the tests");
  expect(out![0].id).toMatch(/^[0-9a-f-]{36}$/);
  expect(out![1].id).toBe("keep");
});

test("validateSteers rejects bad shapes", () => {
  expect(validateSteers({})).toBeNull(); // not an array
  expect(validateSteers([{ label: "x" }])).toBeNull(); // missing text
  expect(validateSteers([{ label: "", text: "y" }])).toBeNull(); // empty label
  expect(validateSteers([{ label: "x", text: "  " }])).toBeNull(); // blank text
  expect(validateSteers([{ label: "a".repeat(61), text: "y" }])).toBeNull(); // label too long
  expect(validateSteers(Array(41).fill({ label: "x", text: "y" }))).toBeNull(); // too many
});

test("validateBroadcast accepts text + ids and trims", () => {
  expect(validateBroadcast({ text: "  go ", ids: ["a", "b"] })).toEqual({ text: "go", ids: ["a", "b"] });
});

test("validateBroadcast rejects bad shapes", () => {
  expect(validateBroadcast({ text: "", ids: ["a"] })).toBeNull();
  expect(validateBroadcast({ text: "go", ids: "a" })).toBeNull();
  expect(validateBroadcast({ text: "go", ids: [1] })).toBeNull();
  expect(validateBroadcast({ ids: ["a"] })).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/validate.test.ts`
Expected: FAIL — `validateSteers` / `validateBroadcast` not exported.

- [ ] **Step 3: Implement the validators**

In `src/validate.ts`, change the `node:crypto` import to add `randomUUID`:

```ts
import { timingSafeEqual, randomUUID } from "node:crypto";
```

Change the `./types` import to add `Steer`:

```ts
import { MODELS, type CreateSessionInput, type Steer } from "./types";
```

Append at the end of the file:

```ts
const STEER_LABEL_MAX = 60;
const STEER_TEXT_MAX = 4000;
const STEER_MAX = 40;

/** Validate + normalize a PUT /api/steers payload. Returns null on any violation. */
export function validateSteers(body: unknown): Steer[] | null {
  if (!Array.isArray(body) || body.length > STEER_MAX) return null;
  const out: Steer[] = [];
  for (const it of body) {
    if (it === null || typeof it !== "object" || Array.isArray(it)) return null;
    const o = it as Record<string, unknown>;
    if (typeof o.label !== "string" || typeof o.text !== "string") return null;
    const label = o.label.trim();
    const text = o.text.trim();
    if (label.length === 0 || label.length > STEER_LABEL_MAX) return null;
    if (text.length === 0 || text.length > STEER_TEXT_MAX) return null;
    const id = typeof o.id === "string" && o.id.length > 0 ? o.id : randomUUID();
    out.push({ id, label, text });
  }
  return out;
}

/** Validate a POST /api/broadcast payload. Returns null on any violation. */
export function validateBroadcast(body: unknown): { text: string; ids: string[] } | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  if (typeof o.text !== "string") return null;
  const text = o.text.trim();
  if (text.length === 0 || text.length > STEER_TEXT_MAX) return null;
  if (!Array.isArray(o.ids)) return null;
  const ids: string[] = [];
  for (const id of o.ids) {
    if (typeof id !== "string" || id.length === 0) return null;
    ids.push(id);
  }
  return { text, ids };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/validate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/validate.ts test/validate.test.ts
git commit -m "feat(steers): validate steers + broadcast payloads"
```

---

### Task 3: `SessionService.broadcast`

**Files:**
- Modify: `src/service.ts`
- Test: `test/service.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `test/service.test.ts`:

```ts
test("broadcast fans the text out to known sessions, skips unknown ids", () => {
  const sent: { target: string; text: string }[] = [];
  const store = new SessionStore(":memory:");
  const mk = (name: string, agent: string) =>
    store.create({
      name,
      prompt: "x",
      repoPath: "/r",
      baseBranch: "main",
      branch: `shepherd/${name}`,
      worktreePath: `/wt/${name}`,
      isolated: true,
      herdrSession: "default",
      herdrAgentId: agent,
    });
  const a = mk("a", "term_a");
  const b = mk("b", "term_b");
  const svc = new SessionService({
    store,
    namer: async () => "x",
    worktree: { create: () => ({}) as any, remove: () => {} },
    herdr: {
      start: () => ({}) as any,
      list: () => [],
      stop: () => {},
      send: (target: string, text: string) => sent.push({ target, text }),
    } as any,
  });

  const res = svc.broadcast([a.id, "ghost", b.id], "run tests");
  expect(res).toEqual({ sent: 2, total: 3 });
  expect(sent).toEqual([
    { target: "term_a", text: "run tests\r" },
    { target: "term_b", text: "run tests\r" },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/service.test.ts`
Expected: FAIL — `svc.broadcast is not a function`.

- [ ] **Step 3: Implement `broadcast`**

In `src/service.ts`, add this method to `SessionService` (right after `reply`):

```ts
  /** Fan a steer out to many sessions (human-style). Skips unknown ids. */
  broadcast(ids: string[], text: string): { sent: number; total: number } {
    let sent = 0;
    for (const id of ids) if (this.reply(id, text)) sent++;
    return { sent, total: ids.length };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/service.ts test/service.test.ts
git commit -m "feat(steers): SessionService.broadcast fans reply over ids"
```

---

### Task 4: Server routes — `/api/steers` + `/api/broadcast`

**Files:**
- Modify: `src/server.ts`
- Test: `test/server-steers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/server-steers.test.ts`:

```ts
import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { makeApp, type AppDeps } from "../src/server";

function harness(broadcast?: (ids: string[], text: string) => { sent: number; total: number }) {
  const store = new SessionStore(":memory:");
  const deps: AppDeps = {
    store,
    events: new EventHub(),
    service: { broadcast } as any,
    usageLimits: { limits: () => ({}) } as any,
  };
  return { app: makeApp(deps), store };
}

const jsonReq = (path: string, method: string, body: unknown) =>
  new Request(`http://x${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("GET /api/steers seeds + returns the defaults", async () => {
  const { app } = harness();
  const res = await app.fetch(new Request("http://x/api/steers"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.map((s: { label: string }) => s.label)).toEqual(["commit & push", "rebase", "run tests"]);
});

test("PUT /api/steers validates, persists, and returns the normalized list", async () => {
  const { app, store } = harness();
  const res = await app.fetch(jsonReq("/api/steers", "PUT", [{ label: " a ", text: " b " }]));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body[0]).toMatchObject({ label: "a", text: "b" });
  expect(body[0].id).toMatch(/^[0-9a-f-]{36}$/);
  expect(JSON.parse(store.getSetting("steers")!)[0].label).toBe("a");
});

test("PUT /api/steers rejects a bad payload with 400", async () => {
  const { app } = harness();
  const res = await app.fetch(jsonReq("/api/steers", "PUT", [{ label: "" }]));
  expect(res.status).toBe(400);
});

test("PUT /api/steers requires application/json", async () => {
  const { app } = harness();
  const res = await app.fetch(
    new Request("http://x/api/steers", { method: "PUT", body: "[]" }),
  );
  expect(res.status).toBe(415);
});

test("POST /api/broadcast returns the service counts", async () => {
  const calls: { ids: string[]; text: string }[] = [];
  const { app } = harness((ids, text) => {
    calls.push({ ids, text });
    return { sent: ids.length, total: ids.length };
  });
  const res = await app.fetch(jsonReq("/api/broadcast", "POST", { text: "go", ids: ["a", "b"] }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ sent: 2, total: 2 });
  expect(calls).toEqual([{ ids: ["a", "b"], text: "go" }]);
});

test("POST /api/broadcast rejects a bad body with 400", async () => {
  const { app } = harness(() => ({ sent: 0, total: 0 }));
  const res = await app.fetch(jsonReq("/api/broadcast", "POST", { text: "", ids: [] }));
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/server-steers.test.ts`
Expected: FAIL — routes return the SPA fallback / 404, not the JSON above.

- [ ] **Step 3: Wire imports**

In `src/server.ts`, extend the `./validate` import to add the two validators:

```ts
import {
  validateCreate,
  isAuthorized,
  originAllowed,
  safeRepoDir,
  parseTermDims,
  validateSteers,
  validateBroadcast,
} from "./validate";
```

Add a new import line below the `./dirs` import:

```ts
import { loadSteers, saveSteers } from "./steers";
```

- [ ] **Step 4: Add the routes**

In `src/server.ts`, immediately **after** the settings block (the `if (parts[0] === "api" && parts[1] === "settings" && !parts[2]) { … }` closing brace, around line 223) insert:

```ts
      // ── saved steers (canned prompts): list / replace ──
      if (parts[0] === "api" && parts[1] === "steers" && !parts[2]) {
        if (req.method === "GET") return json(loadSteers(deps.store));
        if (req.method === "PUT") {
          if (req.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
            return json({ error: "Content-Type must be application/json" }, 415);
          }
          const body = await req.json().catch(() => null);
          const steers = validateSteers(body);
          if (!steers) return json({ error: "invalid steers payload" }, 400);
          saveSteers(deps.store, steers);
          return json(steers);
        }
      }

      // ── broadcast a steer to many sessions ──
      if (parts[0] === "api" && parts[1] === "broadcast" && !parts[2]) {
        if (req.method === "POST") {
          if (req.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
            return json({ error: "Content-Type must be application/json" }, 415);
          }
          const body = await req.json().catch(() => null);
          const parsed = validateBroadcast(body);
          if (!parsed) return json({ error: "body must be {text: string, ids: string[]}" }, 400);
          return json(deps.service.broadcast(parsed.ids, parsed.text));
        }
      }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/server-steers.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Lint + full root tests**

Run: `bun run lint && bun test`
Expected: clean lint, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts test/server-steers.test.ts
git commit -m "feat(steers): GET/PUT /api/steers + POST /api/broadcast"
```

---

### Task 5: UI types + API client

**Files:**
- Modify: `ui/src/lib/types.ts` (add `Steer`)
- Modify: `ui/src/lib/api.ts`

- [ ] **Step 1: Add the UI `Steer` type**

In `ui/src/lib/types.ts`, append:

```ts
export interface Steer {
  id: string;
  label: string;
  text: string;
}
```

- [ ] **Step 2: Add the API functions**

In `ui/src/lib/api.ts`, add `Steer` to the type import block (the `import type { … } from "./types";` at the top):

```ts
  Steer,
```

Append these functions at the end of the file:

```ts
export async function getSteers(): Promise<Steer[]> {
  const r = await fetch("/api/steers");
  if (!r.ok) throw new Error(`steers failed: ${r.status}`);
  return r.json();
}

export async function putSteers(steers: Steer[]): Promise<Steer[]> {
  const r = await fetch("/api/steers", {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(steers),
  });
  if (!r.ok) {
    const msg = await r.json().catch(() => ({ error: `${r.status}` }));
    throw new Error((msg as { error?: string }).error ?? `error ${r.status}`);
  }
  return r.json();
}

export async function broadcast(
  text: string,
  ids: string[],
): Promise<{ sent: number; total: number }> {
  const r = await fetch("/api/broadcast", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ text, ids }),
  });
  if (!r.ok) throw new Error(`broadcast failed: ${r.status}`);
  return r.json();
}
```

- [ ] **Step 3: Typecheck**

Run: `cd ui && bun run check`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/types.ts ui/src/lib/api.ts
git commit -m "feat(steers): UI Steer type + steers/broadcast API client"
```

---

### Task 6: UI steers store

**Files:**
- Create: `ui/src/lib/steers.svelte.ts`
- Test: `ui/src/lib/steers.svelte.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/lib/steers.svelte.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { steers } from "./steers.svelte";

beforeEach(() => {
  steers.list = [];
  steers.error = null;
  steers.loaded = false;
});

describe("steers store", () => {
  it("load() populates the list from GET /api/steers", async () => {
    const data = [{ id: "a", label: "x", text: "y" }];
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify(data), { status: 200 }),
    ) as unknown as typeof fetch;
    await steers.load();
    expect(steers.list).toEqual(data);
    expect(steers.loaded).toBe(true);
  });

  it("save() PUTs the list and adopts the normalized result", async () => {
    const normalized = [{ id: "srv", label: "a", text: "b" }];
    const calls: { method?: string }[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: { method?: string }) => {
      calls.push({ method: init?.method });
      return new Response(JSON.stringify(normalized), { status: 200 });
    }) as unknown as typeof fetch;
    await steers.save([{ id: "tmp", label: "a", text: "b" }]);
    expect(calls[0].method).toBe("PUT");
    expect(steers.list).toEqual(normalized);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && bunx vitest run src/lib/steers.svelte.test.ts`
Expected: FAIL — cannot resolve `./steers.svelte`.

- [ ] **Step 3: Write the store**

Create `ui/src/lib/steers.svelte.ts`:

```ts
import type { Steer } from "./types";
import { getSteers, putSteers } from "./api";

// Client cache of the saved canned steers. Loaded once on app start; every
// mutation persists to the server and adopts the normalized result.
class SteersStore {
  list = $state<Steer[]>([]);
  loaded = $state(false);
  error = $state<string | null>(null);

  async load() {
    try {
      this.list = await getSteers();
    } catch (e) {
      this.error = e instanceof Error ? e.message : "failed to load steers";
    } finally {
      this.loaded = true;
    }
  }

  /** Replace the whole list (Settings editor). Persists + adopts the normalized list. */
  async save(next: Steer[]) {
    this.error = null;
    try {
      this.list = await putSteers(next);
    } catch (e) {
      this.error = e instanceof Error ? e.message : "failed to save steers";
      throw e;
    }
  }
}

export const steers = new SteersStore();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && bunx vitest run src/lib/steers.svelte.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/steers.svelte.ts ui/src/lib/steers.svelte.test.ts
git commit -m "feat(steers): UI steers store (load/save)"
```

---

### Task 7: `SteerBar` component

**Files:**
- Create: `ui/src/lib/components/SteerBar.svelte`

- [ ] **Step 1: Write the component**

Create `ui/src/lib/components/SteerBar.svelte`:

```svelte
<script lang="ts">
  import { steers } from "$lib/steers.svelte";
  import { replySession } from "$lib/api";

  let { focusedId, onbroadcast }: { focusedId: string; onbroadcast: () => void } = $props();

  let flash = $state<string | null>(null);

  // pointerdown + preventDefault: fire instantly and never blur the terminal
  // (which would dismiss the mobile soft keyboard), matching ControlBar.
  function send(e: PointerEvent, text: string) {
    e.preventDefault();
    replySession(focusedId, text).catch(() => {
      flash = "send failed";
      setTimeout(() => (flash = null), 1500);
    });
  }
  function broadcast(e: PointerEvent) {
    e.preventDefault();
    onbroadcast();
  }
</script>

<div class="steer-bar" role="toolbar" aria-label="Saved steers">
  <button
    type="button"
    class="chip bc"
    onpointerdown={broadcast}
    aria-label="Broadcast a steer to multiple sessions">📡 Broadcast</button
  >
  {#each steers.list as s (s.id)}
    <button
      type="button"
      class="chip"
      title={s.text}
      aria-label={`Send steer: ${s.label}`}
      onpointerdown={(e) => send(e, s.text)}>{s.label}</button
    >
  {/each}
  {#if flash}<span class="flash">{flash}</span>{/if}
</div>

<style>
  .steer-bar {
    display: flex;
    gap: 4px;
    padding: 6px 10px;
    background: var(--color-head);
    border-top: 1px solid var(--color-line);
    overflow-x: auto;
    white-space: nowrap;
    min-width: 0;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .steer-bar::-webkit-scrollbar {
    display: none;
  }
  .chip {
    flex: 0 0 auto;
    height: 32px;
    padding: 0 12px;
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    color: var(--color-ink);
    font-family: var(--font-mono);
    font-size: 12.5px;
    cursor: pointer;
    touch-action: manipulation;
    user-select: none;
    transition:
      background 0.08s,
      border-color 0.08s;
  }
  .chip:active {
    background: var(--color-line-bright);
    border-color: var(--color-ink);
  }
  .chip.bc {
    color: var(--color-amber);
    border-color: var(--color-amber);
  }
  .flash {
    align-self: center;
    color: var(--color-red);
    font-size: 11px;
    padding-left: 6px;
  }
</style>
```

- [ ] **Step 2: Typecheck**

Run: `cd ui && bun run check`
Expected: no errors (component compiles; unused until wired in Task 10).

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/components/SteerBar.svelte
git commit -m "feat(steers): SteerBar chip row component"
```

---

### Task 8: `BroadcastDialog` component

**Files:**
- Create: `ui/src/lib/components/BroadcastDialog.svelte`

- [ ] **Step 1: Write the component**

Create `ui/src/lib/components/BroadcastDialog.svelte`:

```svelte
<script lang="ts">
  import type { Session } from "$lib/types";
  import { steers } from "$lib/steers.svelte";
  import { broadcast as apiBroadcast } from "$lib/api";

  let { sessions, onclose }: { sessions: Session[]; onclose: () => void } = $props();

  let selected = $state<Set<string>>(new Set());
  let text = $state("");
  let sending = $state(false);
  let result = $state<string | null>(null);

  const allSelected = $derived(sessions.length > 0 && selected.size === sessions.length);
  const canSend = $derived(text.trim().length > 0 && selected.size > 0 && !sending);

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selected = next;
  }
  function toggleAll() {
    selected = allSelected ? new Set() : new Set(sessions.map((s) => s.id));
  }

  async function send() {
    if (!canSend) return;
    sending = true;
    result = null;
    try {
      const r = await apiBroadcast(text.trim(), [...selected]);
      result = `sent ${r.sent}/${r.total}`;
      setTimeout(onclose, 800);
    } catch {
      result = "broadcast failed";
      sending = false;
    }
  }
</script>

<div
  class="overlay"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div class="card">
    <div class="chead">
      <span class="micro">Broadcast steer</span>
      <button type="button" class="x" onclick={onclose} aria-label="close">✕</button>
    </div>

    <div class="row-head">
      <span class="micro">Targets</span>
      <button type="button" class="link" onclick={toggleAll}>
        {allSelected ? "clear all" : "select all"}
      </button>
    </div>
    <div class="targets">
      {#if sessions.length === 0}
        <div class="placeholder">no active sessions</div>
      {:else}
        {#each sessions as s (s.id)}
          <label class="target">
            <input type="checkbox" checked={selected.has(s.id)} onchange={() => toggle(s.id)} />
            <span class="nm">{s.name}</span>
          </label>
        {/each}
      {/if}
    </div>

    <span class="micro">Steer</span>
    <div class="picks">
      {#each steers.list as s (s.id)}
        <button type="button" class="pick" class:on={text === s.text} onclick={() => (text = s.text)}>
          {s.label}
        </button>
      {/each}
    </div>
    <textarea bind:value={text} rows="2" placeholder="…or type a one-off steer"></textarea>

    {#if result}<div class="result">{result}</div>{/if}

    <button class="run" type="button" disabled={!canSend} onclick={send}>
      {sending ? "Sending…" : `Send to ${selected.size}`}
    </button>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(3, 6, 5, 0.66);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 20;
  }
  .card {
    width: min(460px, 92vw);
    border: 1px solid var(--color-line-bright);
    background: var(--color-panel);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .chead {
    display: flex;
    align-items: center;
  }
  .x {
    margin-left: auto;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
    font: inherit;
  }
  .micro {
    font-size: 10.5px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .row-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .link {
    background: transparent;
    border: 0;
    color: var(--color-amber);
    cursor: pointer;
    font: inherit;
    font-size: 11px;
  }
  .targets {
    border: 1px solid var(--color-line);
    background: var(--color-inset);
    border-radius: 2px;
    max-height: 200px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  .target {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--color-line);
    color: var(--color-ink-bright);
    font-size: 13px;
    cursor: pointer;
  }
  .target:last-child {
    border-bottom: 0;
  }
  .placeholder {
    padding: 14px 12px;
    color: var(--color-faint);
    font-size: 11.5px;
  }
  .picks {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .pick {
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 3px;
    color: var(--color-ink);
    font: inherit;
    font-size: 12px;
    padding: 5px 10px;
    cursor: pointer;
  }
  .pick.on {
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  textarea {
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink-bright);
    font: inherit;
    font-size: 13px;
    padding: 8px;
    resize: vertical;
  }
  .result {
    color: var(--color-amber);
    font-size: 11.5px;
  }
  .run {
    margin-top: 4px;
    border: 1px solid var(--color-amber);
    color: var(--color-amber);
    background: transparent;
    padding: 9px 14px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .run:disabled {
    opacity: 0.5;
    cursor: default;
  }
  @media (max-width: 768px) {
    .overlay {
      align-items: stretch;
      justify-content: stretch;
    }
    .card {
      width: 100%;
      height: 100dvh;
      border: 0;
      overflow-y: auto;
    }
  }
</style>
```

- [ ] **Step 2: Typecheck**

Run: `cd ui && bun run check`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/components/BroadcastDialog.svelte
git commit -m "feat(steers): BroadcastDialog target picker"
```

---

### Task 9: `SteersEditor` + wire into Settings

**Files:**
- Create: `ui/src/lib/components/SteersEditor.svelte`
- Modify: `ui/src/lib/components/Settings.svelte`

- [ ] **Step 1: Write the editor component**

Create `ui/src/lib/components/SteersEditor.svelte`:

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { steers } from "$lib/steers.svelte";
  import type { Steer } from "$lib/types";

  let draft = $state<Steer[]>([]);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let saved = $state(false);

  function syncFromStore() {
    draft = steers.list.map((s) => ({ ...s }));
  }

  onMount(async () => {
    if (!steers.loaded) await steers.load();
    syncFromStore();
  });

  function add() {
    draft = [...draft, { id: crypto.randomUUID(), label: "", text: "" }];
    saved = false;
  }
  function remove(id: string) {
    draft = draft.filter((s) => s.id !== id);
    saved = false;
  }

  const valid = $derived(
    draft.length <= 40 && draft.every((s) => s.label.trim() !== "" && s.text.trim() !== ""),
  );

  async function save() {
    if (!valid || saving) return;
    saving = true;
    error = null;
    try {
      await steers.save(draft.map((s) => ({ ...s, label: s.label.trim(), text: s.text.trim() })));
      syncFromStore();
      saved = true;
    } catch (e) {
      error = e instanceof Error ? e.message : "failed to save";
    } finally {
      saving = false;
    }
  }
</script>

<div class="editor">
  <span class="micro">Saved&nbsp;Steers</span>
  <div class="rows">
    {#each draft as s (s.id)}
      <div class="srow">
        <input class="label" bind:value={s.label} placeholder="label" oninput={() => (saved = false)} />
        <input class="text" bind:value={s.text} placeholder="prompt text" oninput={() => (saved = false)} />
        <button type="button" class="del" aria-label="delete steer" onclick={() => remove(s.id)}>✕</button>
      </div>
    {/each}
    {#if draft.length === 0}
      <div class="placeholder">no steers yet</div>
    {/if}
  </div>

  {#if error}<div class="err">{error}</div>{/if}

  <div class="actions">
    <button type="button" class="add" onclick={add} disabled={draft.length >= 40}>+ Add</button>
    <button type="button" class="save" disabled={!valid || saving} onclick={save}>
      {saving ? "Saving…" : saved ? "Saved ✓" : "Save steers"}
    </button>
  </div>
</div>

<style>
  .editor {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 8px;
    border-top: 1px solid var(--color-line);
    padding-top: 10px;
  }
  .micro {
    font-size: 10.5px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .srow {
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .srow input {
    background: var(--color-inset);
    border: 1px solid var(--color-line-bright);
    border-radius: 2px;
    color: var(--color-ink-bright);
    font: inherit;
    font-size: 12.5px;
    padding: 6px 8px;
  }
  .srow .label {
    flex: 0 0 34%;
    min-width: 0;
  }
  .srow .text {
    flex: 1;
    min-width: 0;
  }
  .del {
    flex: 0 0 auto;
    background: transparent;
    border: 1px solid var(--color-line);
    border-radius: 2px;
    color: var(--color-muted);
    cursor: pointer;
    font: inherit;
    padding: 6px 8px;
  }
  .placeholder {
    color: var(--color-faint);
    font-size: 11.5px;
    padding: 6px 2px;
  }
  .err {
    color: var(--color-red);
    font-size: 11.5px;
  }
  .actions {
    display: flex;
    gap: 6px;
    margin-top: 4px;
  }
  .add,
  .save {
    border: 1px solid var(--color-line-bright);
    background: transparent;
    color: var(--color-ink);
    font: inherit;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 8px 12px;
    cursor: pointer;
  }
  .save {
    margin-left: auto;
    border-color: var(--color-amber);
    color: var(--color-amber);
  }
  .save:disabled,
  .add:disabled {
    opacity: 0.5;
    cursor: default;
  }
  @media (max-width: 768px) {
    .add,
    .save,
    .del {
      min-height: 40px;
    }
  }
</style>
```

- [ ] **Step 2: Render it inside Settings**

In `ui/src/lib/components/Settings.svelte`, add the import after the existing imports:

```ts
  import SteersEditor from "$lib/components/SteersEditor.svelte";
```

Then place `<SteersEditor />` inside the `.card`, immediately **before** the closing `</div>` of `.card` (after the `Use this folder` button):

```svelte
    <SteersEditor />
  </div>
```

- [ ] **Step 3: Typecheck**

Run: `cd ui && bun run check`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/components/SteersEditor.svelte ui/src/lib/components/Settings.svelte
git commit -m "feat(steers): Settings steers editor (CRUD)"
```

---

### Task 10: Wire `SteerBar` into Viewport + `BroadcastDialog` into the page

**Files:**
- Modify: `ui/src/lib/components/Viewport.svelte`
- Modify: `ui/src/routes/+page.svelte`

- [ ] **Step 1: Add `SteerBar` to the Viewport**

In `ui/src/lib/components/Viewport.svelte`, add the import next to the other component imports:

```ts
  import SteerBar from "$lib/components/SteerBar.svelte";
```

Add `onbroadcast` to the props type and destructure. Change the props block to include it:

```ts
  let {
    session,
    nowMs = Date.now(),
    onnewtask,
    onarchive,
    onback,
    onbroadcast,
    mobile = false,
    touch = false,
  }: {
    session: Session;
    nowMs?: number;
    onnewtask?: (repoPath: string, prompt: string) => void;
    onarchive?: (id: string) => void;
    onback?: () => void;
    onbroadcast?: () => void;
    mobile?: boolean;
    touch?: boolean;
  } = $props();
```

Then, in the markup, insert the steer bar just **before** the `<!-- control-key bar` comment block (so it renders above the mobile ctrl-row and above the footer, on all devices):

```svelte
  {#if tab === "term"}
    <SteerBar focusedId={session.id} onbroadcast={() => onbroadcast?.()} />
  {/if}

```

- [ ] **Step 2: Wire the page**

In `ui/src/routes/+page.svelte`:

Add the import after the `Settings` import:

```ts
  import BroadcastDialog from "$lib/components/BroadcastDialog.svelte";
```

Add the steers store import to the `$lib/...` imports and a state flag. After `import { sortBlocked } from "$lib/triage";` add:

```ts
  import { steers } from "$lib/steers.svelte";
```

Next to the other `let show… = $state(false)` lines add:

```ts
  let showBroadcast = $state(false);
```

In the existing `onMount(...)` callback, load steers once (add this line inside the onMount body):

```ts
    steers.load();
```

Pass `onbroadcast` to **both** `<Viewport ... />` instances (mobile detail view and desktop focus view) by adding this prop to each:

```svelte
          onbroadcast={() => (showBroadcast = true)}
```

Finally, add the dialog near the other modal blocks at the end of the markup (after the `{#if showSettings}` block):

```svelte
{#if showBroadcast}
  <BroadcastDialog sessions={store.sessions} onclose={() => (showBroadcast = false)} />
{/if}
```

- [ ] **Step 3: Typecheck + UI tests**

Run: `cd ui && bun run check && bun run test`
Expected: no type errors; all UI tests pass.

- [ ] **Step 4: Manual smoke (optional but recommended)**

Start the app, open a session: confirm the chip row shows the seeded steers, tapping `run tests` injects `run the tests` + Enter into the focused PTY, and `📡 Broadcast` opens the dialog, lets you select sessions + a steer, and reports `sent X/Y`. Edit/add/delete in the Settings gear and confirm chips update after Save.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/components/Viewport.svelte ui/src/routes/+page.svelte
git commit -m "feat(steers): wire SteerBar into Viewport + BroadcastDialog into page"
```

---

## Final verification

- [ ] Root: `bun run lint && bun test` — clean.
- [ ] UI: `cd ui && bun run check && bun run test` — clean.
- [ ] Open a PR into `main` (never merge locally).

## Notes for the executor

- Two packages, two `bun install`s in a fresh worktree (see header).
- The single-chip send path is `replySession` (server reply → herdr injects into the PTY, which the attached terminal renders) — identical to the Triage drawer's reply. Do **not** route single sends through `conn.send`; broadcast targets have no browser PTY open, so all sends go through the server for consistency.
- `crypto.randomUUID()` is used client-side for new editor rows; the server preserves provided ids and only assigns one when missing.
