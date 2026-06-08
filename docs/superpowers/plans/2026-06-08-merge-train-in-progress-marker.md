# Merge-train "Merging" in-progress marker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the "Merge train" shortcut launches a train session, mark that repo's ready PRs as **Merging** — their own amber-pulsing badge + list group — and clear the mark per-PR as each lands.

**Architecture:** The train runs client-side as an agent session, so the client tells the server which PR-sessions it scoped in (`POST /api/merge-train/start`). The server stamps each session with a transient `mergingSince` timestamp + `mergingTrainId`, persists it (SQLite), and broadcasts `session:merging`. Clearing is server-owned: per-PR when the poller sees the PR merge/close, whole-set when the train session is archived, and a 30-min TTL backstop. The UI mirrors the fields, renders a "Merging" partition group above "Ready to merge", and shows an amber MERGING badge.

**Tech Stack:** Bun + TypeScript server (`src/`), SvelteKit 5 + Paraglide i18n UI (`ui/`), `bun test` (server) / vitest (`cd ui && bun run test`).

**Design doc:** `docs/superpowers/specs/2026-06-08-merge-train-in-progress-marker-design.md`

**Reference: a sibling unmerged branch ships an `AutoMergeService` (#362, server-side full-auto merge). It is NOT in this tree and is a different mechanism — do not couple to it.** This feature is solely about the agent-session shortcut (#359).

**Constants:** TTL = `30 * 60_000` ms (30 min), defined once per package: `MERGE_STALE_MS` in `src/service.ts` (server) and again in `ui/src/lib/components/merge-train.ts` (UI). They live in separate packages and cannot share an import; keep both values identical.

---

## Task 1: Server — `mergingSince`/`mergingTrainId` on Session + store persistence

**Files:**
- Modify: `src/types.ts:36` (Session interface)
- Modify: `src/store.ts` (NewSession omit `64-87`, COLS `89-93`, create `296-348`, update `363-385`, migrate `621-633`, hydrate `870-886`)
- Test: `test/store.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/store.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";

function newInput() {
  return {
    name: "n",
    prompt: "p",
    repoPath: "/r",
    baseBranch: "main",
    branch: "shepherd/x",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "a",
  };
}

test("merging fields default null and round-trip through update", () => {
  const store = new SessionStore(":memory:");
  const s = store.create(newInput());
  expect(s.mergingSince).toBeNull();
  expect(s.mergingTrainId).toBeNull();

  store.update(s.id, { mergingSince: 1234, mergingTrainId: "train-1" });
  const got = store.get(s.id)!;
  expect(got.mergingSince).toBe(1234);
  expect(got.mergingTrainId).toBe("train-1");

  // a later unrelated update preserves them (mirrors readyToMerge survival)
  store.update(s.id, { status: "idle" });
  const after = store.get(s.id)!;
  expect(after.mergingSince).toBe(1234);
  expect(after.mergingTrainId).toBe("train-1");

  store.update(s.id, { mergingSince: null, mergingTrainId: null });
  const cleared = store.get(s.id)!;
  expect(cleared.mergingSince).toBeNull();
  expect(cleared.mergingTrainId).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/store.test.ts`
Expected: FAIL — `mergingSince` is `undefined` / property not persisted.

- [ ] **Step 3: Add the fields to the Session type**

In `src/types.ts`, inside `interface Session`, immediately after the `readyToMerge` line (`19`):

```typescript
  readyToMerge: boolean; // manually-toggled "parked / done" flag; orthogonal to status
  /** Epoch ms when a launched merge train marked this PR-session as in-flight;
   *  null when not in a train. Transient: cleared on merge/close, train archive,
   *  or the TTL sweep. */
  mergingSince: number | null;
  /** Id of the merge-train session that owns this mark (clears the whole set when
   *  that session is archived). Null when not merging. */
  mergingTrainId: string | null;
```

- [ ] **Step 4: Persist in the store**

In `src/store.ts`:

(a) `NewSession` omit list (`64-87`) — add both fields to the `Omit<...>` union so callers can't pass them:

```typescript
  | "readyToMerge"
  | "mergingSince"
  | "mergingTrainId"
```

(b) `COLS` (`89-93`) — append the two columns at the very end:

```typescript
const COLS = `id, desig, name, prompt, repoPath, baseBranch, branch, worktreePath,
  isolated, herdrSession, herdrAgentId, claudeSessionId, model, readyToMerge, status, lastState,
  autopilotEnabled, autopilotStepCount, autopilotPaused, autopilotQuestion,
  auto, issueNumber,
  createdAt, updatedAt, archivedAt, mergingSince, mergingTrainId`;
```

(c) `create()` — set defaults on the object (after `archivedAt: null,` at `316`):

```typescript
      archivedAt: null,
      mergingSince: null,
      mergingTrainId: null,
```

Bump the placeholder count from 25 to 27 `?` in the INSERT (`319`):

```typescript
      `INSERT INTO sessions (${COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
```

and append the two values after `s.archivedAt,` (`345`):

```typescript
        s.archivedAt,
        s.mergingSince,
        s.mergingTrainId,
```

(d) `update()` (`363-385`) — widen the patch `Pick<>` and the UPDATE statement:

```typescript
  update(
    id: string,
    patch: Partial<
      Pick<
        Session,
        | "name"
        | "status"
        | "lastState"
        | "branch"
        | "herdrAgentId"
        | "readyToMerge"
        | "mergingSince"
        | "mergingTrainId"
      >
    >,
  ) {
    const cur = this.get(id);
    if (!cur) return;
    const next = { ...cur, ...patch, updatedAt: Date.now() };
    this.db.run(
      `UPDATE sessions SET name=?, status=?, lastState=?, branch=?, herdrAgentId=?, readyToMerge=?, mergingSince=?, mergingTrainId=?, updatedAt=? WHERE id=?`,
      [
        next.name,
        next.status,
        next.lastState,
        next.branch,
        next.herdrAgentId,
        next.readyToMerge ? 1 : 0,
        next.mergingSince,
        next.mergingTrainId,
        next.updatedAt,
        id,
      ],
    );
  }
```

(e) `migrateSessionColumns()` (after the `autopilotQuestion` add at `633`):

```typescript
    add("autopilotQuestion", `autopilotQuestion TEXT`);
    add("mergingSince", `mergingSince INTEGER`);
    add("mergingTrainId", `mergingTrainId TEXT`);
```

(f) `hydrate()` (`870-886`) — add explicit normalization before the closing `} as Session;`:

```typescript
      auto: !!r.auto,
      issueNumber: r.issueNumber ?? null,
      mergingSince: r.mergingSince ?? null,
      mergingTrainId: r.mergingTrainId ?? null,
    } as Session;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test ./test/store.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/store.ts test/store.test.ts
git commit -m "feat(store): persist transient mergingSince/mergingTrainId on Session"
```

---

## Task 2: Server — service set/clear/sweep methods + `session:merging` emit

**Files:**
- Modify: `src/service.ts` (add `MERGE_STALE_MS` export near top of file; add methods after `setReadyToMerge` at `465`)
- Test: `test/service.test.ts`

The service already exposes `this.deps.store` (with `update`/`get`/`list`) and `this.deps.events?.emit`.

- [ ] **Step 1: Write the failing test**

Append to `test/service.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { SessionService, MERGE_STALE_MS } from "../src/service";

function svc() {
  const store = new SessionStore(":memory:");
  const emitted: { event: string; data: any }[] = [];
  const service = new SessionService({
    store,
    namer: async () => "n",
    worktree: { create: () => ({ worktreePath: "/wt", branch: "b", isolated: true }), remove: () => {} } as any,
    herdr: { start: () => ({ terminalId: "t", cwd: "/", agent: "claude", agentStatus: "idle", paneId: "p", tabId: "x", workspaceId: "w" }), list: () => [], stop: () => {} } as any,
    events: { emit: (event: string, data: unknown) => emitted.push({ event, data }) } as any,
  });
  return { store, service, emitted };
}

async function mk(store: SessionStore, service: SessionService) {
  return service.create({ repoPath: "/r", baseBranch: "main", prompt: "p", model: null, images: [] });
}

test("setMerging stamps each id and emits session:merging; skips unknown ids", async () => {
  const { store, service, emitted } = svc();
  const a = await mk(store, service);
  service.setMerging([a.id, "ghost"], "train-9");
  expect(store.get(a.id)!.mergingSince).toBeGreaterThan(0);
  expect(store.get(a.id)!.mergingTrainId).toBe("train-9");
  const ev = emitted.filter((e) => e.event === "session:merging");
  expect(ev).toHaveLength(1); // ghost skipped
  expect(ev[0].data).toMatchObject({ id: a.id });
  expect(typeof ev[0].data.since).toBe("number");
});

test("clearMerging nulls the fields and emits since:null; no-op when not merging", async () => {
  const { store, service, emitted } = svc();
  const a = await mk(store, service);
  service.clearMerging(a.id); // not merging → no event
  expect(emitted.filter((e) => e.event === "session:merging")).toHaveLength(0);
  service.setMerging([a.id], "t1");
  service.clearMerging(a.id);
  expect(store.get(a.id)!.mergingSince).toBeNull();
  expect(store.get(a.id)!.mergingTrainId).toBeNull();
  const last = emitted.filter((e) => e.event === "session:merging").at(-1)!;
  expect(last.data).toEqual({ id: a.id, since: null });
});

test("clearMergingForTrain clears every member of one train, leaves others", async () => {
  const { store, service } = svc();
  const a = await mk(store, service);
  const b = await mk(store, service);
  service.setMerging([a.id], "train-A");
  service.setMerging([b.id], "train-B");
  service.clearMergingForTrain("train-A");
  expect(store.get(a.id)!.mergingSince).toBeNull();
  expect(store.get(b.id)!.mergingSince).toBeGreaterThan(0);
});

test("sweepStaleMerging clears marks older than the TTL, keeps fresh ones", async () => {
  const { store, service } = svc();
  const a = await mk(store, service);
  service.setMerging([a.id], "t");
  const now = Date.now();
  // not stale yet
  service.sweepStaleMerging(now);
  expect(store.get(a.id)!.mergingSince).toBeGreaterThan(0);
  // far in the future → stale
  service.sweepStaleMerging(now + MERGE_STALE_MS + 1);
  expect(store.get(a.id)!.mergingSince).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/service.test.ts`
Expected: FAIL — `MERGE_STALE_MS` / `setMerging` not exported.

- [ ] **Step 3: Implement the service methods**

In `src/service.ts`, add the constant near the top of the file (after the imports, before the class):

```typescript
/** A merge-train mark older than this is treated as stale and swept, so a
 *  rejected/held-back PR (never merged, train never archived) can't stay
 *  "Merging" forever. Mirrored in ui/src/lib/components/merge-train.ts. */
export const MERGE_STALE_MS = 30 * 60_000;
```

Then add these methods right after `setReadyToMerge` (`465`):

```typescript
  /**
   * Mark each session as part of a launched merge train (the client passes the
   * scoped ready-PR ids). Stamps `mergingSince`/`mergingTrainId`, persists, and
   * pushes `session:merging` so every client patches the row live. Unknown ids
   * are skipped (best-effort: the set is cosmetic, never load-bearing).
   */
  setMerging(ids: string[], trainId: string): void {
    const since = Date.now();
    for (const id of ids) {
      if (!this.deps.store.get(id)) continue;
      this.deps.store.update(id, { mergingSince: since, mergingTrainId: trainId });
      this.deps.events?.emit("session:merging", { id, since });
    }
  }

  /** Clear one session's merge-train mark. No-op (no event) when not marked. */
  clearMerging(id: string): void {
    const s = this.deps.store.get(id);
    if (!s || s.mergingSince === null) return;
    this.deps.store.update(id, { mergingSince: null, mergingTrainId: null });
    this.deps.events?.emit("session:merging", { id, since: null });
  }

  /** Clear every session marked by a given train (its session was archived). */
  clearMergingForTrain(trainId: string): void {
    for (const s of this.deps.store.list({ activeOnly: true })) {
      if (s.mergingTrainId === trainId) this.clearMerging(s.id);
    }
  }

  /** Backstop: clear marks older than MERGE_STALE_MS. `now` injectable for tests. */
  sweepStaleMerging(now: number = Date.now()): void {
    for (const s of this.deps.store.list({ activeOnly: true })) {
      if (s.mergingSince !== null && now - s.mergingSince > MERGE_STALE_MS) {
        this.clearMerging(s.id);
      }
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/service.ts test/service.test.ts
git commit -m "feat(service): merge-train set/clear/sweep + session:merging event"
```

---

## Task 3: Server — `POST /api/merge-train/start` endpoint

**Files:**
- Modify: `src/server.ts` (add `handleMergeTrain` near `handleHalt` at `1209`; register in the handler array at `1648-1677`)
- Test: `test/server.test.ts`

- [ ] **Step 1: Write the failing test**

Look at an existing handler test in `test/server.test.ts` for the harness (how it builds `deps` + dispatches a `Request`). Add a test mirroring that harness; the assertion logic is:

```typescript
import { test, expect } from "bun:test";
// ...reuse this file's existing makeDeps()/handle() helpers...

test("POST /api/merge-train/start marks the given sessions", async () => {
  const { deps, handle } = makeServer(); // existing helper in this file
  const a = deps.store.create({
    name: "n", prompt: "p", repoPath: "/r", baseBranch: "main",
    branch: "b", worktreePath: "/wt", isolated: true,
    herdrSession: "default", herdrAgentId: "h",
  });
  const res = await handle(
    new Request("http://x/api/merge-train/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [a.id], trainId: "train-7" }),
    }),
  );
  expect(res.status).toBe(200);
  expect(deps.store.get(a.id)!.mergingTrainId).toBe("train-7");
});

test("POST /api/merge-train/start rejects a bad body", async () => {
  const { handle } = makeServer();
  const res = await handle(
    new Request("http://x/api/merge-train/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: "nope" }),
    }),
  );
  expect(res.status).toBe(400);
});
```

> If `test/server.test.ts` exposes its deps/dispatch helper under a different name, use that name — the behavior asserted (200 + mark set, 400 on bad body) is what matters. Match the harness used by the existing `handleSessionReady` / autopilot tests in this file or `test/server-autopilot.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/server.test.ts`
Expected: FAIL — route returns 404 (handler not registered).

- [ ] **Step 3: Implement the handler**

In `src/server.ts`, add after `handleHalt` (`1218`):

```typescript
// POST /api/merge-train/start — mark a launched train's ready PRs as "merging".
// The train itself runs client-side as an agent session; this only flags the
// scoped PR-sessions so the list shows them in-flight. Body: {ids, trainId}.
async function handleMergeTrain({ req, parts, deps }: Ctx): Promise<Response | null> {
  if (!(parts[0] === "api" && parts[1] === "merge-train" && parts[2] === "start" && !parts[3]))
    return null;
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const ctErr = requireJsonContentType(req);
  if (ctErr) return ctErr;
  const body = (await req.json().catch(() => null)) as
    | { ids?: unknown; trainId?: unknown }
    | null;
  if (
    !body ||
    !Array.isArray(body.ids) ||
    !body.ids.every((x) => typeof x === "string") ||
    typeof body.trainId !== "string"
  ) {
    return json({ error: "body must be {ids: string[], trainId: string}" }, 400);
  }
  deps.service.setMerging(body.ids as string[], body.trainId);
  return json({ ok: true });
}
```

Register it in the handler array (`1648-1677`), next to `handleHalt`:

```typescript
  handleBroadcast,
  handleHalt,
  handleMergeTrain,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/server.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat(server): POST /api/merge-train/start marks scoped PRs merging"
```

---

## Task 4: Server — wire clearing (poll merge, train archive, TTL sweep)

**Files:**
- Modify: `src/index.ts` (add two `events.subscribe` blocks + one interval, near the existing `session:status` subscriber at `163-167`)

This is integration glue; the logic it calls is unit-tested in Task 2. No new unit test — verified by `bun run lint` + the existing suite staying green, then manual smoke in Task 15.

- [ ] **Step 1: Add the subscribers + sweep**

In `src/index.ts`, after the existing `session:status` subscriber block (ends `167`):

```typescript
// A PR in a merge train just landed (or was closed) → drop its "Merging" mark
// so the row resolves out of the Merging group one-by-one as the train works.
// session:git fires on any git change; clearMerging no-ops when not marked.
events.subscribe((event, data) => {
  if (event !== "session:git") return;
  const { id, git } = data as { id: string; git: GitState };
  if (git.state === "merged" || git.state === "closed") service.clearMerging(id);
});

// The train session itself was archived → clear any of its PRs still marked
// (e.g. ones it held back / rejected and never merged). Keyed on archive (a
// terminal state), NOT done/idle — a Claude pane reports done at the train's
// approval gate, where clearing would wipe the marks mid-train.
events.subscribe((event, data) => {
  if (event !== "session:archived") return;
  service.clearMergingForTrain((data as { id: string }).id);
});

// Backstop sweep: drop marks older than the TTL so a stuck/rejected PR can't
// stay "Merging" forever when neither of the above fires.
setInterval(() => service.sweepStaleMerging(), 60_000);
```

Ensure `GitState` is imported in `src/index.ts` (it may already be). If not, add it to the forge types import:

```typescript
import type { GitState } from "./forge/types";
```

- [ ] **Step 2: Verify it compiles + suite stays green**

Run: `bunx tsc --noEmit && bun test ./test`
Expected: PASS (no type errors; existing tests unaffected).

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(server): clear merging mark on merge/close, train archive, TTL"
```

---

## Task 5: UI — mirror fields on Session + `session:merging` WsEvent

**Files:**
- Modify: `ui/src/lib/types.ts` (Session `197-226`, WsEvent `313-334`)
- Modify test factories: `ui/src/lib/components/herd-partition.test.ts:5-33`, `ui/src/lib/components/merge-train.test.ts`, `ui/src/lib/store.svelte.test.ts`

- [ ] **Step 1: Add the fields + event**

In `ui/src/lib/types.ts`, after `readyToMerge` in `interface Session` (`213`):

```typescript
  readyToMerge: boolean;
  /** Epoch ms when a merge train marked this PR-session in-flight; null when not.
   *  Transient — cleared server-side on merge/close, train archive, or TTL. */
  mergingSince: number | null;
  /** Id of the owning merge-train session; null when not merging. */
  mergingTrainId: string | null;
```

In the `WsEvent` union, after the `session:ready` line (`316`):

```typescript
  | { event: "session:ready"; data: { id: string; ready: boolean } }
  | { event: "session:merging"; data: { id: string; since: number | null } }
```

- [ ] **Step 2: Update the test session factories**

In each of the three test files, add the two fields to the `Session` literal returned by the local `session(...)` helper (so it still satisfies the type). e.g. in `herd-partition.test.ts` after `readyToMerge,` (`21`):

```typescript
    readyToMerge,
    mergingSince: null,
    mergingTrainId: null,
```

Apply the same two lines to the session factory in `merge-train.test.ts` and `ui/src/lib/store.svelte.test.ts` (wherever each builds a full `Session`).

- [ ] **Step 3: Verify type-check passes**

Run: `cd ui && bun run check`
Expected: PASS (no missing-property errors).

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/types.ts ui/src/lib/components/herd-partition.test.ts ui/src/lib/components/merge-train.test.ts ui/src/lib/store.svelte.test.ts
git commit -m "feat(ui): mirror mergingSince/mergingTrainId + session:merging event"
```

---

## Task 6: UI — store applies `session:merging`; `api.startMergeTrain`

**Files:**
- Modify: `ui/src/lib/store.svelte.ts` (apply switch, after `session:ready` at `134`)
- Modify: `ui/src/lib/api.ts` (after `setReadyToMerge` at `295`)
- Test: `ui/src/lib/store.svelte.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `ui/src/lib/store.svelte.test.ts` (match the file's existing store-construction + `apply` style):

```typescript
test("session:merging sets and clears the mark", () => {
  const store = makeStore([session("a")]); // existing helper in this file
  store.apply({ event: "session:merging", data: { id: "a", since: 111 } });
  expect(store.byId("a")!.mergingSince).toBe(111);
  store.apply({ event: "session:merging", data: { id: "a", since: null } });
  expect(store.byId("a")!.mergingSince).toBeNull();
  expect(store.byId("a")!.mergingTrainId).toBeNull();
});
```

> Use whatever store factory + accessor this test file already uses (`makeStore`, `byId`, etc.). The assertion is: a `since` number sets `mergingSince`; `since: null` clears both `mergingSince` and `mergingTrainId`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && bun run test -- store.svelte`
Expected: FAIL — `session:merging` falls through to the global handler, no patch applied.

- [ ] **Step 3: Implement the apply case**

In `ui/src/lib/store.svelte.ts`, after the `session:ready` case (`130-134`):

```typescript
      case "session:merging":
        this.sessions = this.sessions.map((s) =>
          s.id === ev.data.id
            ? {
                ...s,
                mergingSince: ev.data.since,
                mergingTrainId: ev.data.since === null ? null : s.mergingTrainId,
              }
            : s,
        );
        break;
```

- [ ] **Step 4: Add the api client function**

In `ui/src/lib/api.ts`, after `setReadyToMerge` (`295`):

```typescript
/** Flag a launched merge train's scoped ready PRs as "merging". Fire-and-forget
 *  shape like setReadyToMerge — live state returns via the session:merging WS
 *  event; marking is cosmetic, so a failure must not abort the train launch. */
export async function startMergeTrain(ids: string[], trainId: string): Promise<void> {
  const r = await fetch("/api/merge-train/start", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ ids, trainId }),
  });
  if (!r.ok) throw await failed(r, "merge-train");
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ui && bun run test -- store.svelte`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/store.svelte.ts ui/src/lib/api.ts ui/src/lib/store.svelte.test.ts
git commit -m "feat(ui): apply session:merging + startMergeTrain client"
```

---

## Task 7: UI — `isMerging` helper + `MERGE_STALE_MS`

**Files:**
- Modify: `ui/src/lib/components/merge-train.ts` (top of file)
- Test: `ui/src/lib/components/merge-train.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `ui/src/lib/components/merge-train.test.ts`:

```typescript
import { isMerging, MERGE_STALE_MS } from "./merge-train";

function mergingSession(mergingSince: number | null): Session {
  return { ...session("m"), mergingSince, mergingTrainId: mergingSince ? "t" : null };
}

test("isMerging: true when marked and within TTL, false when null or stale", () => {
  const now = 1_000_000_000;
  expect(isMerging(mergingSession(null), now)).toBe(false);
  expect(isMerging(mergingSession(now - 1000), now)).toBe(true);
  expect(isMerging(mergingSession(now - MERGE_STALE_MS - 1), now)).toBe(false);
});
```

> Reuse the existing `session(...)` factory in this test file (the one updated in Task 5). If it isn't exported/shared, add a minimal local factory with the full `Session` shape.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && bun run test -- merge-train`
Expected: FAIL — `isMerging` not exported.

- [ ] **Step 3: Implement**

At the top of `ui/src/lib/components/merge-train.ts`, after the import line (`1`):

```typescript
import type { Session, GitState } from "$lib/types";

/** Merge-train marks older than this read as stale (the row falls back to its
 *  prior state) so a stuck PR never sticks visually even if the server's TTL
 *  sweep is briefly behind. Mirrors MERGE_STALE_MS in src/service.ts. */
export const MERGE_STALE_MS = 30 * 60_000;

/** True when a session is in a currently-running merge train: marked and the
 *  mark is still within the TTL. `now` injectable for tests. */
export function isMerging(s: Session, now: number = Date.now()): boolean {
  return s.mergingSince !== null && now - s.mergingSince < MERGE_STALE_MS;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && bun run test -- merge-train`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/components/merge-train.ts ui/src/lib/components/merge-train.test.ts
git commit -m "feat(ui): isMerging helper + MERGE_STALE_MS"
```

---

## Task 8: UI — partition `merging` bucket above `ready`

**Files:**
- Modify: `ui/src/lib/components/herd-partition.ts` (`26-63` + doc comment `1-25`)
- Test: `ui/src/lib/components/herd-partition.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `ui/src/lib/components/herd-partition.test.ts`:

```typescript
test("merging sessions land in merging, pulled out of ready; merged still wins", () => {
  const now = 1_000_000_000;
  const m1 = { ...session("m1", true), mergingSince: now - 1000, mergingTrainId: "t" };
  const m2 = { ...session("m2", true), mergingSince: now - 1000, mergingTrainId: "t" };
  const list = [session("r1", true), m1, m2];
  const { ready, merging } = partitionSessions(list, { m2: git("merged") }, () => false, now);
  expect(merging.map((s) => s.id)).toEqual(["m1"]); // m2 merged → merged group
  expect(ready.map((s) => s.id)).toEqual(["r1"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && bun run test -- herd-partition`
Expected: FAIL — `merging` not in the returned shape / extra arg ignored.

- [ ] **Step 3: Implement**

In `ui/src/lib/components/herd-partition.ts`, import `isMerging`:

```typescript
import type { Session, GitState } from "$lib/types";
import { isMerging } from "./merge-train";
```

Add a `now` param (so the TTL is testable), the `merging` array to the return type and locals, and the branch above `ready`:

```typescript
export function partitionSessions(
  sessions: Session[],
  git: Record<string, GitState>,
  isReviewing: (id: string) => boolean = () => false,
  now: number = Date.now(),
): {
  active: Session[];
  ciRunning: Session[];
  ciFailed: Session[];
  reviewerRunning: Session[];
  awaitingMerge: Session[];
  merging: Session[];
  ready: Session[];
  merged: Session[];
} {
  const active: Session[] = [];
  const ciRunning: Session[] = [];
  const ciFailed: Session[] = [];
  const reviewerRunning: Session[] = [];
  const awaitingMerge: Session[] = [];
  const merging: Session[] = [];
  const ready: Session[] = [];
  const merged: Session[] = [];
  for (const s of sessions) {
    const g = git[s.id];
    if (g?.state === "merged") merged.push(s);
    else if (isMerging(s, now)) merging.push(s);
    else if (s.readyToMerge) ready.push(s);
    else if (isReviewing(s.id)) reviewerRunning.push(s);
    else if (g?.state === "open" && g.checks === "pending") ciRunning.push(s);
    else if (g?.state === "open" && g.checks === "failure") ciFailed.push(s);
    else if (
      g?.state === "open" &&
      g.checks === "success" &&
      s.status !== "running" &&
      s.status !== "blocked"
    )
      awaitingMerge.push(s);
    else active.push(s);
  }
  return { active, ciRunning, ciFailed, reviewerRunning, awaitingMerge, merging, ready, merged };
}
```

Update the doc comment (`1-25`): add `merging` to the group list and the precedence line so it reads `merged > merging > ready > reviewerRunning > ciRunning > ciFailed > awaitingMerge > active`, and the render-order line to `… awaitingMerge → merging → ready → merged`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && bun run test -- herd-partition`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/components/herd-partition.ts ui/src/lib/components/herd-partition.test.ts
git commit -m "feat(ui): partition merging group above ready-to-merge"
```

---

## Task 9: UI — MERGING badge + amber pip + `status_merging` key

**Files:**
- Modify: `ui/src/lib/components/UnitRow.svelte` (badge `160-168`, import `9`, pip `131-132`, badge CSS `489-495`)
- Modify: `ui/src/lib/components/StatusPip.svelte` (props + render + style)
- Modify: `ui/messages/en.json` + `ui/messages/de.json`
- Test: `ui/src/lib/components/UnitRow.browser.test.ts` (create if absent, else extend)

- [ ] **Step 1: Add the i18n key (both locales)**

In `ui/messages/en.json`, next to `status_ready_to_merge` (`42`):

```json
  "status_ready_to_merge": "READY",
  "status_merging": "MERGING",
```

In `ui/messages/de.json`, add the same key alongside its `status_ready_to_merge`:

```json
  "status_merging": "MERGE LÄUFT",
```

- [ ] **Step 2: Write the failing test**

Add a browser test asserting the MERGING badge renders for a merging session. Mirror the harness in `ui/src/lib/components/Herd.browser.test.ts` (render a `UnitRow` with a session whose `mergingSince` is recent), then:

```typescript
import { render } from "vitest-browser-svelte";
import UnitRow from "./UnitRow.svelte";

it("shows MERGING for a merging session, not READY", async () => {
  const s = { ...baseSession(), readyToMerge: true, mergingSince: Date.now(), mergingTrainId: "t" };
  const screen = render(UnitRow, { session: s, selected: false, nowMs: Date.now(), onselect: () => {} });
  await expect.element(screen.getByText("MERGING")).toBeInTheDocument();
  expect(screen.container.textContent).not.toContain("READY");
});
```

> Use the same render harness / `baseSession()` shape the existing browser tests use. The assertion: a recently-marked merging session shows MERGING and not READY.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ui && bun run test -- UnitRow`
Expected: FAIL — still renders READY.

- [ ] **Step 4: Implement the badge branch**

In `ui/src/lib/components/UnitRow.svelte`, import `isMerging` (`9` area):

```typescript
  import { elapsed, STATUS_COLOR, statusLabel, hideStatusBadge } from "$lib/format";
  import { isMerging } from "./merge-train";
```

Replace the badge block (`164-168`) so merging wins ahead of ready:

```svelte
      {#if isMerging(session, nowMs)}
        <span class="badge merging">{m.status_merging()}</span>
      {:else if session.readyToMerge}
        <span class="badge">{m.status_ready_to_merge()}</span>
      {:else if !hideStatus}
        <span class="badge">{statusLabel(session.status)}</span>
      {/if}
```

Pass merging to the pip (`131-132`):

```svelte
    <div class="pip-col">
      <StatusPip status={session.status} ready={session.readyToMerge} merging={isMerging(session, nowMs)} />
    </div>
```

Add the amber pulsing badge style after the `.badge` rule (`489-495`):

```css
  /* MERGING: the one colored, moving badge — amber + pulse marks the in-flight
     merge train, louder than the quiet muted text badges around it. */
  .badge.merging {
    color: var(--color-amber);
    animation: pip-pulse 1.5s ease-out infinite;
  }
```

- [ ] **Step 5: Implement the pip variant**

In `ui/src/lib/components/StatusPip.svelte`, add the `merging` prop (`5`) and let it take priority — an amber pulsing dot:

```svelte
  let {
    status,
    ready = false,
    merging = false,
  }: { status: SessionStatus; ready?: boolean; merging?: boolean } = $props();
  const color = $derived(
    merging ? "var(--color-amber)" : ready ? "var(--color-green)" : STATUS_COLOR[status],
  );
```

In the markup, add a first branch before the `{#if ready}`:

```svelte
{#if merging}
  <span class="pip pulse" style="--c:{color}" role="img" aria-label={label} title={label}></span>
{:else if ready}
  <span class="pip check" style="--c:{color}" aria-hidden="true">✓</span>
{:else if status === "blocked"}
```

(The `label` derivation already exists; reuse it.)

- [ ] **Step 6: Run test to verify it passes**

Run: `cd ui && bun run test -- UnitRow`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add ui/src/lib/components/UnitRow.svelte ui/src/lib/components/StatusPip.svelte ui/messages/en.json ui/messages/de.json ui/src/lib/components/UnitRow.browser.test.ts
git commit -m "feat(ui): amber pulsing MERGING badge + pip"
```

---

## Task 10: UI — "Merging" group in Herd.svelte + `herd_merging_group` key

**Files:**
- Modify: `ui/src/lib/components/Herd.svelte` (group block before `ready` at `162`, style after `.awaiting-head,.ready-head` at `308-316`)
- Modify: `ui/messages/en.json` + `ui/messages/de.json`
- Test: `ui/src/lib/components/Herd.browser.test.ts`

- [ ] **Step 1: Add the i18n key (both locales)**

In `ui/messages/en.json`, next to `herd_ready_group` (`163`):

```json
  "herd_merging_group": "Merging ({count})",
```

In `ui/messages/de.json`, next to its `herd_ready_group`:

```json
  "herd_merging_group": "Merge läuft ({count})",
```

- [ ] **Step 2: Write the failing test**

Add to `ui/src/lib/components/Herd.browser.test.ts`:

```typescript
it("renders a Merging group for in-train sessions", async () => {
  const s = { ...baseSession("m1"), readyToMerge: true, mergingSince: Date.now(), mergingTrainId: "t" };
  const screen = render(Herd, {
    sessions: [s],
    selectedId: null,
    nowMs: Date.now(),
    onselect: () => {},
    onnew: () => {},
    git: { m1: { kind: "github", state: "open", checks: "success", deployConfigured: false } },
    activity: {},
  });
  await expect.element(screen.getByText(/Merging \(1\)/)).toBeInTheDocument();
});
```

> Reuse this file's existing render harness + `baseSession`.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ui && bun run test -- Herd`
Expected: FAIL — no Merging group.

- [ ] **Step 4: Implement the group block**

In `ui/src/lib/components/Herd.svelte`, insert before the `{#if partition.ready.length > 0}` block (`163`):

```svelte
      {#if partition.merging.length > 0}
        <div class="merging-head micro">
          {m.herd_merging_group({ count: partition.merging.length })}
        </div>
        {#each partition.merging as session (session.id)}
          <UnitRow
            {session}
            selected={session.id === selectedId}
            {nowMs}
            {onselect}
            git={git[session.id]}
            activity={activity[session.id]}
            {ondecommission}
          />
        {/each}
      {/if}
```

Add the amber header style. Extend the existing amber-header rule selector (`286-287`) to include `.merging-head`:

```css
  .ci-head,
  .reviewing-head,
  .merging-head {
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ui && bun run test -- Herd`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/components/Herd.svelte ui/messages/en.json ui/messages/de.json ui/src/lib/components/Herd.browser.test.ts
git commit -m "feat(ui): Merging group above Ready-to-merge"
```

---

## Task 11: UI — fire `startMergeTrain` from `onmergetrain`

**Files:**
- Modify: `ui/src/routes/+page.svelte` (`onmergetrain` `243-267`, import `48`)

`+page.svelte` is integration glue (no direct unit test). The store/api/badge pieces are tested above; this is verified by the manual smoke in Task 15.

- [ ] **Step 1: Implement the wiring**

In `ui/src/routes/+page.svelte`, add `startMergeTrain` to the api import (`48` is the merge-train helpers import; the api functions are imported elsewhere — add to the `$lib/api` import):

```typescript
import { /* …existing… */ createSession, startMergeTrain } from "$lib/api";
```

> Add `startMergeTrain` to whichever existing `from "$lib/api"` import statement already brings in `createSession`.

In `onmergetrain`, after `selectedId = s.id;` (`259`), mark the scoped PRs. The `prs` list (`ReadyPr[]`) carries PR numbers, not session ids — re-derive the session ids from the same scoped repo so the mark targets exactly the train's sessions:

```typescript
      const s = await createSession({
        repoPath,
        baseBranch,
        prompt: m.herd_merge_train_prompt({ prs: formatReadyPrs(prs) }),
        model: null,
      });
      selectedId = s.id;
      // Mark this repo's ready PR-sessions as "merging" so the list shows them
      // in-flight. Fire-and-forget + fail-soft: a marking error must not abort
      // the launch — the train (session s) is already running. The scoped set is
      // the ready-to-merge sessions in this repo with an open PR.
      const ids = store.sessions
        .filter((x) => x.repoPath === repoPath && x.readyToMerge && store.git[x.id]?.state === "open")
        .map((x) => x.id);
      startMergeTrain(ids, s.id).catch(() => toasts.info(m.toast_merge_train_mark_failed()));
      showBacklog = false;
      if (mobile.current) mobileScreen = "detail";
```

- [ ] **Step 2: Add the fail-soft toast key (both locales)**

In `ui/messages/en.json`, next to `toast_merge_train_failed`:

```json
  "toast_merge_train_mark_failed": "Merge train started, but marking its PRs failed.",
```

In `ui/messages/de.json`:

```json
  "toast_merge_train_mark_failed": "Merge-Train gestartet, aber das Markieren der PRs ist fehlgeschlagen.",
```

- [ ] **Step 3: Verify type-check + lint**

Run: `cd ui && bun run check && bun run lint`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add ui/src/routes/+page.svelte ui/messages/en.json ui/messages/de.json
git commit -m "feat(ui): mark scoped PRs merging when the train launches"
```

---

## Task 12: Feature-discovery catalog entry

**Files:**
- Modify: `ui/src/lib/feature-announcements.ts` (`18-58`)
- Modify: `ui/messages/en.json` + `ui/messages/de.json`

- [ ] **Step 1: Add the catalog entry**

In `ui/src/lib/feature-announcements.ts`, append to `featureAnnouncements` (after the `merge-train-shortcut` entry at `57`):

```typescript
  {
    id: "merge-train-in-progress",
    sinceVersion: "1.17.0",
    titleKey: "feat_merge_in_progress_title",
    bodyKey: "feat_merge_in_progress_body",
  },
```

> Confirm `sinceVersion`: root `package.json` is `1.16.0`; the merge-train-shortcut entry already targets `1.17.0`, so this ships in the same `1.17.0` line. If the next release tag has moved by implementation time, match the merge-train-shortcut entry's `sinceVersion`.

- [ ] **Step 2: Add the message keys (both locales)**

In `ui/messages/en.json`, next to `feat_merge_train_body` (`139`):

```json
  "feat_merge_in_progress_title": "Merge train shows progress",
  "feat_merge_in_progress_body": "When you start a merge train, the PRs it's working through move into a Merging group with an amber badge instead of staying in Ready to merge — and each clears as it lands.",
```

In `ui/messages/de.json`, next to its `feat_merge_train_body`:

```json
  "feat_merge_in_progress_title": "Merge-Train zeigt Fortschritt",
  "feat_merge_in_progress_body": "Wenn du einen Merge-Train startest, wandern die PRs, die er abarbeitet, mit einem bernsteinfarbenen Badge in eine Merge-läuft-Gruppe statt in „Bereit zum Mergen“ zu bleiben — und jeder verschwindet, sobald er gemergt ist.",
```

- [ ] **Step 3: Verify the i18n + catalog gates**

Run: `cd ui && bun run check:i18n` then `cd .. && bash scripts/check-feature-catalog.sh`
Expected: both PASS.

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/feature-announcements.ts ui/messages/en.json ui/messages/de.json
git commit -m "feat(ui): announce merge-train progress in feature catalog"
```

---

## Task 13: Full verification + rebase

**Files:** none (validation only)

- [ ] **Step 1: Install deps if missing (fresh worktree)**

```bash
bun install && (cd ui && bun install)
```

- [ ] **Step 2: Server gates**

Run: `bunx tsc --noEmit && bun run lint && bun test ./test`
Expected: all PASS.

- [ ] **Step 3: UI gates**

Run: `cd ui && bun run check && bun run lint && bun run test`
Expected: all PASS (includes `check:i18n` if wired into `check`; if not, run `bun run check:i18n` separately).

- [ ] **Step 4: Feature-catalog + branch-hygiene gates**

Run: `bash scripts/check-feature-catalog.sh && bash scripts/check-branch-hygiene.sh`
Expected: both PASS.

- [ ] **Step 5: Rebase onto latest main (shared main has advanced to #360+)**

```bash
git fetch origin
git rebase origin/main
bun install && (cd ui && bun install)   # reinstall after rebase (new deps on main)
```
Re-run Steps 2–4 after the rebase. Resolve any conflicts (most likely in `ui/messages/*.json`, `feature-announcements.ts`, `src/server.ts` handler array, `src/store.ts` COLS — all additive).

- [ ] **Step 6: Manual smoke (real app)**

Use the `verify` skill / `bun run update` to run the live app: park ≥2 PRs as ready-to-merge in one repo, click **Merge train**, confirm the parked PRs jump to a **Merging** group with an amber pulsing badge while the train session runs, and that each row leaves the group as its PR merges.

- [ ] **Step 7: Open the PR**

Only after all gates pass. PR title: `feat(ui): show merge-train PRs as Merging in the session list`.

---

## Self-Review notes

- **Spec coverage:** data model (T1), server set/clear/sweep + event (T2), endpoint (T3), three clear triggers (T4), UI types/event (T5), store+api (T6), `isMerging`/TTL (T7), partition group + precedence (T8), badge+pip (T9), group render (T10), launch wiring (T11), i18n keys folded into T9/T10/T11/T12, feature catalog (T12), gates+rebase (T13). All spec sections map to a task.
- **Type consistency:** `setMerging(ids, trainId)` / `clearMerging(id)` / `clearMergingForTrain(trainId)` / `sweepStaleMerging(now?)`; `startMergeTrain(ids, trainId)`; `isMerging(s, now?)`; `partitionSessions(…, now?)` returns `{…, merging, ready, …}`; event `session:merging {id, since}`; fields `mergingSince`/`mergingTrainId`. Names consistent across server + UI.
- **Constant:** `MERGE_STALE_MS = 30*60_000` duplicated in `src/service.ts` and `ui/src/lib/components/merge-train.ts` (cross-package; kept identical — noted in both doc comments).
