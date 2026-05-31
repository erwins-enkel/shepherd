# Blocked-Triage Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the passive `blocked` status light into a prioritized, one-tap-resolvable triage queue surfaced in a persistent "Needs you" drawer.

**Architecture:** A pure server-side heuristic classifier reads each blocked agent's terminal tail and labels it (`menu` / `yes-no` / `awaiting-input`). The poller runs it on a slow cadence and emits `session:block` over the existing `/events` WS. The UI holds block state in the herd store (event-only, never persisted) and renders a drawer; replies POST to a new `/reply` endpoint that types the answer into the real PTY (`herdr.send(agentId, text + "\r")`) — the same human-typing path already used, keeping it ToS-clean.

**Tech Stack:** Bun + TypeScript (server, `bun:test`), SvelteKit 5 / Svelte 5 runes / Tailwind 4 (UI, `vitest` for pure modules), herdr socket API.

---

## File Structure

**Server (root package):**
- Create `src/blocked.ts` — `classifyBlocked(text)` + `BlockShape`/`BlockOption`/`BlockReason` types. Pure, no deps.
- Modify `src/poller.ts` — read+classify blocked sessions on a cadence; new `onBlock` callback.
- Modify `src/service.ts` — `reply(id, text)` method; widen herdr dep to include `send`.
- Modify `src/server.ts` — `POST /api/sessions/:id/reply`.
- Modify `src/index.ts` — wire `onBlock` → `events.emit("session:block", …)`.
- Modify tests: `test/poller.test.ts`, `test/server.test.ts`.
- Create `test/blocked.test.ts`, `test/service.test.ts` additions.

**UI (`ui/` package):**
- Modify `ui/src/lib/types.ts` — mirror block types; extend `WsEvent`.
- Modify `ui/src/lib/api.ts` — `replySession(id, text)`.
- Modify `ui/src/lib/store.svelte.ts` — `blocks` state + `session:block` handling.
- Create `ui/src/lib/triage.ts` — `sortBlocked(...)` pure helper.
- Create `ui/src/lib/triage.test.ts`.
- Create `ui/src/lib/components/TriageDrawer.svelte` — the queue UI.
- Modify `ui/src/lib/components/TopBar.svelte` — "Needs you · N" badge.
- Modify `ui/src/routes/+page.svelte` — drawer open state + mount.

> First step in a fresh worktree: `bun install` (root) and `cd ui && bun install` (UI). See CLAUDE.md.

---

## Task 1: Heuristic classifier (`src/blocked.ts`)

**Files:**
- Create: `src/blocked.ts`
- Test: `test/blocked.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/blocked.test.ts`:

```ts
import { test, expect } from "bun:test";
import { classifyBlocked } from "../src/blocked";

test("classifies a numbered permission menu", () => {
  const tail = [
    "│ Do you want to proceed?",
    "│ ❯ 1. Yes",
    "│   2. Yes, and don't ask again",
    "│   3. No, and tell Claude what to do differently",
  ].join("\n");
  const r = classifyBlocked(tail);
  expect(r.shape).toBe("menu");
  expect(r.options).toEqual([
    { label: "Yes", send: "1" },
    { label: "Yes, and don't ask again", send: "2" },
    { label: "No, and tell Claude what to do differently", send: "3" },
  ]);
  expect(r.tail.at(-1)).toContain("No, and tell Claude");
});

test("classifies a (y/n) prompt", () => {
  const r = classifyBlocked("Overwrite existing file? (y/n)");
  expect(r.shape).toBe("yes-no");
  expect(r.options).toEqual([
    { label: "Yes", send: "y" },
    { label: "No", send: "n" },
  ]);
});

test("falls back to awaiting-input when no shape matches", () => {
  const r = classifyBlocked("What should I name the component?\n>");
  expect(r.shape).toBe("awaiting-input");
  expect(r.options).toEqual([]);
  expect(r.tail.length).toBeGreaterThan(0);
});

test("ignores stray numbered prose, keeps the last 1..n run", () => {
  const tail = [
    "I considered 3 options earlier.",
    "❯ 1. Apply the patch",
    "  2. Skip it",
  ].join("\n");
  const r = classifyBlocked(tail);
  expect(r.shape).toBe("menu");
  expect(r.options.map((o) => o.send)).toEqual(["1", "2"]);
});

test("keeps only the last 15 non-empty lines in tail", () => {
  const tail = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n\n");
  const r = classifyBlocked(tail);
  expect(r.tail.length).toBe(15);
  expect(r.tail[0]).toBe("line 15");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/blocked.test.ts`
Expected: FAIL — `Cannot find module "../src/blocked"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/blocked.ts`:

```ts
export type BlockShape = "menu" | "yes-no" | "awaiting-input";

export interface BlockOption {
  label: string;
  /** Literal text typed into the PTY. The server appends the Enter (`\r`). */
  send: string;
}

export interface BlockReason {
  shape: BlockShape;
  options: BlockOption[];
  /** Last non-empty terminal lines for context; most recent last. */
  tail: string[];
}

const TAIL_LINES = 15;
// Matches "1. Yes", "❯ 2. No", "│  3) Foo" — captures the digit and the label.
const OPTION_RE = /^[\s│|]*[❯>*]?\s*(\d+)[.)]\s+(.*\S)\s*$/;
const YES_NO_RE = /\(\s*y\s*\/\s*n\s*\)|\[\s*y\s*\/\s*n\s*\]/i;

/** Classify a blocked agent's terminal tail into an actionable shape. Never throws. */
export function classifyBlocked(text: string): BlockReason {
  const tail = text
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "")
    .slice(-TAIL_LINES);

  // Capture the last contiguous 1..n run of numbered options.
  let run: BlockOption[] = [];
  for (const line of tail) {
    const m = OPTION_RE.exec(line);
    if (!m) continue;
    const n = Number(m[1]);
    if (n === run.length + 1) run.push({ label: m[2]!, send: m[1]! });
    else if (n === 1) run = [{ label: m[2]!, send: m[1]! }];
  }
  if (run.length >= 2) return { shape: "menu", options: run, tail };

  if (tail.some((l) => YES_NO_RE.test(l))) {
    return {
      shape: "yes-no",
      options: [
        { label: "Yes", send: "y" },
        { label: "No", send: "n" },
      ],
      tail,
    };
  }

  return { shape: "awaiting-input", options: [], tail };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/blocked.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/blocked.ts test/blocked.test.ts
git commit -m "feat: heuristic classifier for blocked-agent terminal tails"
```

---

## Task 2: Poller reads + classifies blocked sessions

**Files:**
- Modify: `src/poller.ts`
- Test: `test/poller.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/poller.test.ts` (keep the existing test; add the import + new test):

```ts
import { classifyBlocked } from "../src/blocked"; // add near the top imports

test("emits onBlock with a classified reason for blocked sessions, clears on resume", () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const blocks: { id: string; block: unknown }[] = [];

  let agentStatus: "working" | "blocked" = "blocked";
  const herdr = {
    list: (): HerdrAgent[] => [
      {
        agent: "claude",
        agentStatus,
        cwd: "/wt",
        paneId: "p",
        tabId: "t",
        terminalId: "term_a",
        workspaceId: "w",
      },
    ],
    read: () => "❯ 1. Yes\n  2. No",
  };

  let clock = 100_000;
  const poller = new StatusPoller(
    store,
    herdr as any,
    () => {},
    (id, block) => blocks.push({ id, block }),
    1000,
    3000,
    classifyBlocked,
    () => clock,
  );

  poller.tick();
  expect(blocks).toHaveLength(1);
  expect((blocks[0]!.block as any).shape).toBe("menu");

  // within the reclassify window + same content → no new emit
  clock += 1000;
  poller.tick();
  expect(blocks).toHaveLength(1);

  // agent resumes → exactly one clear emit (block === null)
  agentStatus = "working";
  clock += 5000;
  poller.tick();
  expect(blocks).toHaveLength(2);
  expect(blocks[1]).toEqual({ id: s.id, block: null });
});
```

Also update the **existing** test's constructor call to pass the new `onBlock` arg and a `read` on the mock. Change:

```ts
const poller = new StatusPoller(store, { list: () => agents } as any, (id, status) =>
  emitted.push({ id, status }),
);
```

to:

```ts
const poller = new StatusPoller(
  store,
  { list: () => agents, read: () => "" } as any,
  (id, status) => emitted.push({ id, status }),
  () => {},
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/poller.test.ts`
Expected: FAIL — `onBlock`/extra args not accepted; new test throws.

- [ ] **Step 3: Write the implementation**

Replace the entire contents of `src/poller.ts`:

```ts
import type { SessionStore } from "./store";
import { mapState, type HerdrDriver } from "./herdr";
import { classifyBlocked, type BlockReason } from "./blocked";

export class StatusPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastReadAt = new Map<string, number>();
  private lastSig = new Map<string, string>();

  constructor(
    private store: SessionStore,
    private herdr: Pick<HerdrDriver, "list" | "read">,
    private onChange: (id: string, status: string) => void,
    private onBlock: (id: string, block: BlockReason | null) => void,
    private intervalMs = 1000,
    private reclassifyMs = 3000,
    private classify: (text: string) => BlockReason = classifyBlocked,
    private now: () => number = Date.now,
  ) {}

  tick(): void {
    const byTerm = new Map(this.herdr.list().map((a) => [a.terminalId, a]));
    for (const s of this.store.list({ activeOnly: true })) {
      const agent = byTerm.get(s.herdrAgentId);
      if (!agent) continue;
      const status = mapState(agent.agentStatus);
      if (status !== s.status || agent.agentStatus !== s.lastState) {
        this.store.update(s.id, { status, lastState: agent.agentStatus });
        this.onChange(s.id, status);
      }
      if (status === "blocked") this.classifyBlocked(s.id, s.herdrAgentId);
      else this.clearBlock(s.id);
    }
  }

  /** Read + classify a blocked agent at most every `reclassifyMs`; emit only on change. */
  private classifyBlocked(id: string, term: string): void {
    const t = this.now();
    if (t - (this.lastReadAt.get(id) ?? 0) < this.reclassifyMs) return;
    this.lastReadAt.set(id, t);
    let reason: BlockReason;
    try {
      reason = this.classify(this.herdr.read(term, "visible"));
    } catch {
      return; // best-effort; retry next cadence
    }
    const sig = JSON.stringify(reason);
    if (sig === this.lastSig.get(id)) return;
    this.lastSig.set(id, sig);
    this.onBlock(id, reason);
  }

  private clearBlock(id: string): void {
    if (!this.lastSig.has(id)) return;
    this.lastSig.delete(id);
    this.lastReadAt.delete(id);
    this.onBlock(id, null);
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
```

> Note: the private method is named `classifyBlocked` and the injected fn is `this.classify` — no collision.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/poller.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/poller.ts test/poller.test.ts
git commit -m "feat: poller reads+classifies blocked agents, emits onBlock"
```

---

## Task 3: Reply endpoint (`service.reply` + `POST /reply`)

**Files:**
- Modify: `src/service.ts`, `src/server.ts`
- Test: `test/service.test.ts`, `test/server.test.ts`

- [ ] **Step 1: Write the failing service test**

Append to `test/service.test.ts`:

```ts
test("reply types the text plus Enter into the agent's PTY", () => {
  const sent: { target: string; text: string }[] = [];
  const store = new SessionStore(":memory:");
  const s = store.create({
    name: "x",
    prompt: "x",
    repoPath: "/r",
    baseBranch: "main",
    branch: "shepherd/x",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_z",
  });
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

  expect(svc.reply(s.id, "1")).toBe(true);
  expect(sent).toEqual([{ target: "term_z", text: "1\r" }]);
  expect(svc.reply("nope", "1")).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/service.test.ts`
Expected: FAIL — `svc.reply is not a function`.

- [ ] **Step 3: Implement `service.reply` + widen herdr dep**

In `src/service.ts`, change the `herdr` field of `ServiceDeps` to include `send`:

```ts
  herdr: Pick<HerdrDriver, "start" | "list" | "stop" | "send">;
```

Add this method to the `SessionService` class (after `archive`):

```ts
  /** Type a reply into a session's live PTY (human-style steer). Returns false if unknown. */
  reply(id: string, text: string): boolean {
    const s = this.deps.store.get(id);
    if (!s) return false;
    this.deps.herdr.send(s.herdrAgentId, text + "\r");
    return true;
  }
```

- [ ] **Step 4: Run service test to verify it passes**

Run: `bun test test/service.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing server test**

First, in `test/server.test.ts`, add `send` to the herdr mock inside `makeDeps()` (the `herdr: { … } as any` block) so reply has a spy. Change the mock to capture sends:

```ts
  const sent: { target: string; text: string }[] = [];
  // ... inside makeDeps, herdr mock:
    herdr: {
      start: () => ({
        terminalId: "term_x",
        cwd: "/wt",
        agent: "claude",
        agentStatus: "working",
        paneId: "p",
        tabId: "t",
        workspaceId: "w",
      }),
      list: () => [],
      stop: () => {},
      send: (target: string, text: string) => sent.push({ target, text }),
    } as any,
```

Return `sent` from `makeDeps` so the test can assert on it (change the return to `return { store, service, events, usageLimits, sent } as AppDeps & { sent: typeof sent };` and have `harness()` thread it through, OR keep it simpler by asserting reply succeeds). Use the simpler assertion test:

```ts
test("POST /api/sessions/:id/reply types into the agent and 404s unknown ids", async () => {
  const app = harness();
  const created = await (
    await postSessions(app, { repoPath: validRepo, baseBranch: "main", prompt: "go" })
  ).json();

  const ok = await app.fetch(
    new Request(`http://x/api/sessions/${created.id}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify({ text: "1" }),
    }),
  );
  expect(ok.status).toBe(200);

  const missing = await app.fetch(
    new Request(`http://x/api/sessions/does-not-exist/reply`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify({ text: "1" }),
    }),
  );
  expect(missing.status).toBe(404);

  const bad = await app.fetch(
    new Request(`http://x/api/sessions/${created.id}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify({ nope: true }),
    }),
  );
  expect(bad.status).toBe(400);
});
```

> Check `postSessions` (already defined lower in the file) and whether the existing tests pass an `Origin` header — if `config.allowedOriginHosts` is empty in tests origin checks pass; mirror what the existing POST tests do for headers. If existing POST tests omit `Origin`, omit it here too.

- [ ] **Step 6: Run server test to verify it fails**

Run: `bun test test/server.test.ts`
Expected: FAIL — reply route returns 404 (not yet implemented) for the valid id.

- [ ] **Step 7: Implement the route**

In `src/server.ts`, inside the `if (parts[0] === "api" && parts[1] === "sessions") { … }` block, add (next to the other `parts[2]` handlers, e.g. after the DELETE handler):

```ts
        if (req.method === "POST" && parts[2] && parts[3] === "reply") {
          if (req.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
            return json({ error: "Content-Type must be application/json" }, 415);
          }
          const body = await req.json().catch(() => null);
          if (!body || typeof (body as { text?: unknown }).text !== "string") {
            return json({ error: "body must be {text: string}" }, 400);
          }
          const ok = deps.service.reply(parts[2], (body as { text: string }).text);
          return ok ? json({ ok: true }) : json({ error: "not found" }, 404);
        }
```

- [ ] **Step 8: Run server tests to verify they pass**

Run: `bun test test/server.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/service.ts src/server.ts test/service.test.ts test/server.test.ts
git commit -m "feat: POST /api/sessions/:id/reply types steer into agent PTY"
```

---

## Task 4: Wire `onBlock` into the event hub (`src/index.ts`)

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update the poller construction**

In `src/index.ts`, replace:

```ts
const poller = new StatusPoller(store, herdr, (id, status) =>
  events.emit("session:status", { id, status }),
);
```

with:

```ts
const poller = new StatusPoller(
  store,
  herdr,
  (id, status) => events.emit("session:status", { id, status }),
  (id, block) => events.emit("session:block", { id, block }),
);
```

- [ ] **Step 2: Verify the server still builds + lints**

Run: `bun run lint`
Expected: no errors. (`herdr` is the full `HerdrDriver`, so it satisfies `Pick<…,"list"|"read">`.)

- [ ] **Step 3: Run the full server test suite**

Run: `bun test`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: emit session:block over /events"
```

---

## Task 5: UI types + reply API

**Files:**
- Modify: `ui/src/lib/types.ts`, `ui/src/lib/api.ts`

- [ ] **Step 1: Add block types + extend the event union**

In `ui/src/lib/types.ts`, add (anywhere sensible, e.g. after `Session`):

```ts
export type BlockShape = "menu" | "yes-no" | "awaiting-input";
export interface BlockOption {
  label: string;
  send: string;
}
export interface BlockReason {
  shape: BlockShape;
  options: BlockOption[];
  tail: string[];
}
```

Extend the `WsEvent` union with a new member:

```ts
  | { event: "session:block"; data: { id: string; block: BlockReason | null } }
```

- [ ] **Step 2: Add the reply API call**

In `ui/src/lib/api.ts`, add:

```ts
export async function replySession(id: string, text: string): Promise<void> {
  const r = await fetch(`/api/sessions/${id}/reply`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error(`reply failed: ${r.status}`);
}
```

- [ ] **Step 3: Verify types**

Run: `cd ui && bun run check`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/types.ts ui/src/lib/api.ts
git commit -m "feat(ui): block types + replySession api"
```

---

## Task 6: Store block state + `sortBlocked` helper

**Files:**
- Create: `ui/src/lib/triage.ts`, `ui/src/lib/triage.test.ts`
- Modify: `ui/src/lib/store.svelte.ts`

- [ ] **Step 1: Write the failing triage test**

Create `ui/src/lib/triage.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sortBlocked } from "./triage";
import type { Session, BlockReason } from "./types";

const sess = (id: string): Session =>
  ({ id, desig: id, name: id, status: "blocked" }) as Session;
const reason: BlockReason = { shape: "yes-no", options: [], tail: ["?"] };

describe("sortBlocked", () => {
  it("keeps only blocked-with-reason sessions, oldest-blocked first", () => {
    const sessions = [sess("a"), sess("b"), sess("c")];
    const blocks = {
      a: { reason, since: 300 },
      c: { reason, since: 100 },
    };
    const out = sortBlocked(sessions, blocks);
    expect(out.map((e) => e.session.id)).toEqual(["c", "a"]);
    expect(out[0]!.reason).toBe(reason);
  });

  it("returns empty when nothing is blocked", () => {
    expect(sortBlocked([sess("a")], {})).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ui && bun run test triage`
Expected: FAIL — `Cannot find module "./triage"`.

- [ ] **Step 3: Implement the helper**

Create `ui/src/lib/triage.ts`:

```ts
import type { Session, BlockReason } from "./types";

export interface BlockState {
  reason: BlockReason;
  since: number;
}

export interface BlockedEntry {
  session: Session;
  reason: BlockReason;
  since: number;
}

/** Blocked sessions that have a classified reason, oldest-blocked first. */
export function sortBlocked(
  sessions: Session[],
  blocks: Record<string, BlockState>,
): BlockedEntry[] {
  return sessions
    .filter((s) => blocks[s.id])
    .map((s) => ({ session: s, reason: blocks[s.id]!.reason, since: blocks[s.id]!.since }))
    .sort((a, b) => a.since - b.since);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd ui && bun run test triage`
Expected: PASS (2 tests).

- [ ] **Step 5: Add block state to the store**

In `ui/src/lib/store.svelte.ts`:

Add the import at the top:

```ts
import type { Session, WsEvent, UsageLimits } from "./types";
import type { BlockState } from "./triage";
```

Add the state field (next to `sessions`):

```ts
  blocks = $state<Record<string, BlockState>>({});
```

In `apply(ev)`, add a branch (and clear blocks on archive). Replace the `session:archived` branch and add a `session:block` branch:

```ts
    } else if (ev.event === "session:archived") {
      this.sessions = this.sessions.filter((s) => s.id !== ev.data.id);
      const { [ev.data.id]: _drop, ...rest } = this.blocks;
      this.blocks = rest;
    } else if (ev.event === "session:block") {
      if (ev.data.block) {
        const prev = this.blocks[ev.data.id];
        this.blocks = {
          ...this.blocks,
          [ev.data.id]: { reason: ev.data.block, since: prev?.since ?? Date.now() },
        };
      } else {
        const { [ev.data.id]: _drop, ...rest } = this.blocks;
        this.blocks = rest;
      }
    } else if (ev.event === "usage:limits") {
```

> The `usage:limits` branch already exists — merge by inserting the `session:block` branch before it, not duplicating it.

- [ ] **Step 6: Verify types**

Run: `cd ui && bun run check`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add ui/src/lib/triage.ts ui/src/lib/triage.test.ts ui/src/lib/store.svelte.ts
git commit -m "feat(ui): herd store tracks blocked-agent reasons"
```

---

## Task 7: Triage drawer + TopBar badge + page mount

**Files:**
- Create: `ui/src/lib/components/TriageDrawer.svelte`
- Modify: `ui/src/lib/components/TopBar.svelte`, `ui/src/routes/+page.svelte`

- [ ] **Step 1: Create the drawer component**

Create `ui/src/lib/components/TriageDrawer.svelte`:

```svelte
<script lang="ts">
  import type { BlockedEntry } from "$lib/triage";

  let {
    entries,
    nowMs,
    onreply,
    onclose,
  }: {
    entries: BlockedEntry[];
    nowMs: number;
    onreply: (id: string, text: string) => void;
    onclose: () => void;
  } = $props();

  let selected = $state<Record<string, boolean>>({});
  let drafts = $state<Record<string, string>>({});
  let batchText = $state("");

  const selectedIds = $derived(entries.filter((e) => selected[e.session.id]).map((e) => e.session.id));

  function waited(since: number): string {
    const s = Math.max(0, Math.round((nowMs - since) / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  }

  function sendBatch() {
    const t = batchText;
    if (!t) return;
    for (const id of selectedIds) onreply(id, t);
    batchText = "";
    selected = {};
  }
</script>

<aside class="drawer">
  <header>
    <span class="title">NEEDS YOU · {entries.length}</span>
    <button class="x" onclick={onclose} aria-label="Close">✕</button>
  </header>

  {#if entries.length === 0}
    <p class="empty">No agents are waiting on you.</p>
  {/if}

  {#each entries as e (e.session.id)}
    <section class="row">
      <div class="head">
        <input type="checkbox" bind:checked={selected[e.session.id]} aria-label="Select {e.session.desig}" />
        <span class="desig">{e.session.desig}</span>
        <span class="name">{e.session.name}</span>
        <span class="waited">{waited(e.since)}</span>
      </div>

      <pre class="tail">{e.reason.tail.join("\n")}</pre>

      {#if e.reason.shape === "awaiting-input"}
        <form
          class="reply"
          onsubmit={(ev) => {
            ev.preventDefault();
            const t = drafts[e.session.id] ?? "";
            if (t) onreply(e.session.id, t);
            drafts[e.session.id] = "";
          }}
        >
          <input placeholder="Type a reply…" bind:value={drafts[e.session.id]} />
          <button type="submit">Send</button>
        </form>
      {:else}
        <div class="opts">
          {#each e.reason.options as o (o.send)}
            <button onclick={() => onreply(e.session.id, o.send)}>{o.label}</button>
          {/each}
        </div>
      {/if}
    </section>
  {/each}

  {#if selectedIds.length > 1}
    <footer class="batch">
      <span>Reply to {selectedIds.length} selected:</span>
      <input placeholder="same text to all…" bind:value={batchText} />
      <button onclick={sendBatch}>Send to {selectedIds.length}</button>
    </footer>
  {/if}
</aside>

<style>
  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    width: min(440px, 100vw);
    height: 100vh;
    background: var(--color-panel);
    border-left: 1px solid var(--color-line-bright);
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
    overflow-y: auto;
    z-index: 50;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .title {
    color: var(--color-red);
    letter-spacing: 0.18em;
    font-size: 12px;
  }
  .x {
    background: none;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
  }
  .empty {
    color: var(--color-muted);
    font-size: 13px;
  }
  .row {
    border: 1px solid var(--color-line);
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .desig {
    color: var(--color-ink-bright);
    font-weight: 600;
  }
  .name {
    color: var(--color-muted);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .waited {
    color: var(--color-amber);
    font-variant-numeric: tabular-nums;
    font-size: 12px;
  }
  .tail {
    margin: 0;
    padding: 8px;
    background: #0c100f;
    border: 1px solid var(--color-line);
    font-size: 11.5px;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 160px;
    overflow-y: auto;
  }
  .opts,
  .reply,
  .batch {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }
  button {
    background: var(--color-line);
    border: 1px solid var(--color-line-bright);
    color: var(--color-ink-bright);
    padding: 6px 12px;
    cursor: pointer;
  }
  input {
    flex: 1;
    min-width: 120px;
    background: #0c100f;
    border: 1px solid var(--color-line-bright);
    color: var(--color-ink-bright);
    padding: 6px 8px;
  }
  .batch {
    border-top: 1px solid var(--color-line);
    padding-top: 10px;
    font-size: 12px;
    color: var(--color-muted);
  }
</style>
```

- [ ] **Step 2: Add the "Needs you" badge to TopBar**

In `ui/src/lib/components/TopBar.svelte`, add `ontriage` to the props block:

```ts
    ontriage,
  }: {
    sessions: Session[];
    nowMs: number;
    connected?: boolean;
    mobile?: boolean;
    limits?: UsageLimits | null;
    ontriage?: () => void;
  } = $props();
```

Then add a clickable badge immediately after the closing `{/if}` of the tallies block (before the `{#if gauges.length}` block):

```svelte
  {#if blocked > 0}
    <button class="needsyou" onclick={() => ontriage?.()}>NEEDS YOU · {blocked}</button>
  {/if}
```

Add to the `<style>`:

```css
  .needsyou {
    background: color-mix(in srgb, var(--color-red) 18%, transparent);
    border: 1px solid var(--color-red);
    color: var(--color-red);
    letter-spacing: 0.14em;
    font-size: 11px;
    padding: 5px 10px;
    cursor: pointer;
  }
```

- [ ] **Step 3: Mount the drawer + wire the trigger in the page**

In `ui/src/routes/+page.svelte`:

Add the imports:

```ts
  import TriageDrawer from "$lib/components/TriageDrawer.svelte";
  import { sortBlocked } from "$lib/triage";
  import { replySession } from "$lib/api";
```

Add state + derived (near the other `$state` declarations):

```ts
  let showTriage = $state(false);
  const blockedEntries = $derived(sortBlocked(store.sessions, store.blocks));
```

Pass `ontriage` to **both** `<TopBar … />` usages (mobile + desktop share one in this file — there is a single `<TopBar>` at the top of the shell). Add the prop:

```svelte
  <TopBar
    sessions={store.sessions}
    {nowMs}
    connected={store.connected}
    mobile={mobile.current}
    limits={store.usageLimits}
    ontriage={() => (showTriage = true)}
  />
```

At the end of the `.shell` block (just before its closing `</div>`), mount the drawer:

```svelte
  {#if showTriage}
    <TriageDrawer
      entries={blockedEntries}
      {nowMs}
      onreply={(id, text) => replySession(id, text).catch(() => {})}
      onclose={() => (showTriage = false)}
    />
  {/if}
```

- [ ] **Step 4: Verify types + lint**

Run: `cd ui && bun run check`
Expected: no errors.

- [ ] **Step 5: Run the UI test suite**

Run: `cd ui && bun test`
Expected: all PASS (incl. `triage.test.ts`).

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/components/TriageDrawer.svelte ui/src/lib/components/TopBar.svelte ui/src/routes/+page.svelte
git commit -m "feat(ui): blocked-triage drawer + Needs-you badge"
```

---

## Task 8: Full verification + backlog tick

**Files:**
- Modify: `TODO.md`

- [ ] **Step 1: Run both halves clean**

Run (root): `bun install && bun run lint && bun test`
Run (UI): `cd ui && bun install && bun run check && bun test`
Expected: all green.

- [ ] **Step 2: Mark the backlog item done**

In `TODO.md`, move the `Blocked-triage queue` line from the "Attention-routing" backlog section to a checked state (or strike its `**NEXT.**`). Minimal edit: change `- [ ] Blocked-triage queue —` to `- [x] Blocked-triage queue —` and drop the `**NEXT.**` marker; promote the next item (Push notifications) to NEXT.

- [ ] **Step 3: Commit**

```bash
git add TODO.md
git commit -m "docs: mark blocked-triage queue shipped"
```

---

## Self-Review Notes (verify during execution)

- **Spec coverage:** classifier (Task 1) ✓ · poll cadence + emit (Task 2) ✓ · reply endpoint typing `\r` into PTY (Task 3) ✓ · `session:block` over `/events` (Task 4) ✓ · oldest-first ordering (Task 6 `sortBlocked`) ✓ · persistent drawer + badge, desktop+mobile (Task 7) ✓ · batch = same-text-to-selected, explicit select (Task 7 drawer) ✓ · blocked-only, no schema persistence (event-only block state) ✓.
- **Type consistency:** `BlockReason`/`BlockOption`/`BlockShape` identical in `src/blocked.ts` and `ui/src/lib/types.ts`; `BlockState`/`BlockedEntry` defined once in `ui/src/lib/triage.ts` and imported by the store + drawer; poller callback `onBlock(id, BlockReason | null)` matches the `session:block` event `{ id, block: BlockReason | null }`.
- **Known integration check (do during Task 3):** confirm whether existing POST tests in `test/server.test.ts` set an `Origin` header; match them exactly so origin-guard behaviour is consistent.
- **Manual smoke (optional, post-merge):** spawn an agent that hits a permission prompt, confirm the badge increments, the drawer shows the menu options, and clicking one resumes the agent.
