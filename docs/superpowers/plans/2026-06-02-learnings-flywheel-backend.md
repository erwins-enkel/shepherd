# Learnings Flywheel — Backend (capture + distiller + API) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the four learning signals, run a read-only distiller spawn that proposes house rules from them, and expose list/approve/dismiss/distill APIs — the server half of PR1 (no UI yet).

**Architecture:** Two new SQLite tables (`signals`, `learnings`) on the existing `bun:sqlite` `SessionStore`. Signals are captured at four existing seams (operator reply, critic `changes_requested`, block, stall). A new `DistillerService` mirrors `ReviewService` exactly: a read-only `claude` spawn writes a JSON proposals file into a scratch dir, a `tick()` finalizes it into `proposed` learnings. New REST handlers under `/api/learnings` list/approve/dismiss rules and trigger a manual distill. A `learnings:update` WS event carries the global pending count.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, `bun test ./test`. Spec: `docs/superpowers/specs/2026-06-02-learnings-flywheel-design.md`.

**Scope note:** This plan is PR1-backend only. The Learnings drawer UI is a separate plan (Plan B). Prompt-injection, promote-to-CLAUDE.md, the per-repo distiller toggle, and self-audit are PR2 (out of scope here). The distiller in this plan runs for any repo with signals; nothing it produces reaches a live agent until PR2.

**Conventions (verified against the codebase):**
- IDs: `randomUUID()` from `node:crypto` (already imported in `src/store.ts`).
- `this.db` is a `bun:sqlite` `Database`; tables created with `this.db.run(\`CREATE TABLE IF NOT EXISTS …\`)` in the `SessionStore` constructor (`src/store.ts:51-105`).
- Tests: `new SessionStore(":memory:")`, `import { test, expect } from "bun:test"`, run with `bun test ./test`.
- Route handlers return a `Response` when they own the request or `null` to fall through (`src/server.ts`). `safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot)` validates a `?repo=` param (see `handleRepoConfig`, `src/server.ts:156-171`).
- Distiller spawn argv MUST follow the critic's hard-won ordering (`src/review.ts:begin`): `--settings '{"disableAllHooks":true}'`, `--disable-slash-commands`, `--allowedTools <list>`, then a single-value flag (`--permission-mode dontAsk`) **before** the trailing prompt positional. Bare `Write` (never path-scoped). Never `--dangerously-skip-permissions`.

---

## File Structure

- **Create** `src/distiller.ts` — `DistillerService` (spawn + finalize proposed rules), `distillPrompt()`, default scratch/file helpers.
- **Create** `test/store-learnings.test.ts` — signals + learnings store methods.
- **Create** `test/distiller.test.ts` — `DistillerService` with injected herdr/scratch/readProposals (no real spawn).
- **Create** `test/signal-capture.test.ts` — the four capture seams write rows.
- **Modify** `src/types.ts` — add `Signal`, `SignalKind`, `Learning`, `LearningStatus`.
- **Modify** `src/store.ts` — `signals` + `learnings` tables and their methods.
- **Modify** `src/service.ts` — capture `reply` signal.
- **Modify** `src/review.ts` — capture `critic` signal on `changes_requested`; widen the store `Pick`.
- **Modify** `src/signals.ts` (new) — `attachSignalCapture(events, store)` for block/stall via the `session:block` event.
- **Create** `test/signals-attach.test.ts` — block/stall capture from events.
- **Modify** `src/server.ts` — `handleLearnings` (GET list, POST approve/dismiss/distill); register it; add `distiller` to `AppDeps`.
- **Modify** `src/index.ts` — construct `DistillerService`, wire `attachSignalCapture`, daily tick, pass into server deps; emit `learnings:update`.

---

## Task 1: Signal + Learning types

**Files:**
- Modify: `src/types.ts` (append at end of file)

- [ ] **Step 1: Add the types**

Append to `src/types.ts`:

```typescript
export type SignalKind = "reply" | "critic" | "block" | "stall";

export interface Signal {
  id: string;
  repoPath: string;
  sessionId: string | null;
  kind: SignalKind;
  payload: string;
  ts: number;
}

export type LearningStatus = "proposed" | "active" | "promoted" | "dismissed";

export interface Learning {
  id: string;
  repoPath: string;
  rule: string;
  rationale: string;
  evidence: string[]; // signal ids the distiller cited
  status: LearningStatus;
  evidenceCount: number;
  ineffectiveCount: number;
  createdAt: number;
  updatedAt: number;
  lastEvidenceAt: number | null;
}
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: PASS (no new errors; types are not yet referenced).

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(learnings): Signal and Learning types"
```

---

## Task 2: `signals` table + store methods

**Files:**
- Modify: `src/store.ts` (constructor + new methods; imports already include `randomUUID`)
- Test: `test/store-learnings.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/store-learnings.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";

test("addSignal stores and lists newest-first within a repo", () => {
  const s = new SessionStore(":memory:");
  const a = s.addSignal({ repoPath: "/r", sessionId: "s1", kind: "reply", payload: "use bun" });
  expect(a.id).toBeTruthy();
  expect(a.kind).toBe("reply");
  s.addSignal({ repoPath: "/r", sessionId: "s1", kind: "block", payload: "menu" });
  s.addSignal({ repoPath: "/other", sessionId: null, kind: "stall", payload: "quiet" });
  const got = s.listSignals("/r");
  expect(got.length).toBe(2);
  expect(got.map((g) => g.kind)).toEqual(["block", "reply"]); // newest first
});

test("listSignals honors sinceTs and limit", () => {
  const s = new SessionStore(":memory:");
  for (let i = 0; i < 5; i++) {
    s.addSignal({ repoPath: "/r", sessionId: null, kind: "reply", payload: `p${i}` });
  }
  expect(s.listSignals("/r", { limit: 2 }).length).toBe(2);
  const all = s.listSignals("/r");
  const cutoff = all[2]!.ts;
  expect(s.listSignals("/r", { sinceTs: cutoff }).every((g) => g.ts >= cutoff)).toBe(true);
});

test("pruneSignals drops rows older than cutoff and returns count", () => {
  const s = new SessionStore(":memory:");
  const old = s.addSignal({ repoPath: "/r", sessionId: null, kind: "reply", payload: "old" });
  const removed = s.pruneSignals(old.ts + 1);
  expect(removed).toBe(1);
  expect(s.listSignals("/r").length).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/store-learnings.test.ts`
Expected: FAIL — `addSignal is not a function`.

- [ ] **Step 3: Add the table to the constructor**

In `src/store.ts`, inside the `SessionStore` constructor, after the `reviews` table `this.db.run(...)` block (near line 84), add:

```typescript
this.db.run(`CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY, repoPath TEXT NOT NULL, sessionId TEXT,
  kind TEXT NOT NULL, payload TEXT NOT NULL, ts INTEGER NOT NULL)`);
this.db.run(`CREATE INDEX IF NOT EXISTS signals_repo_ts ON signals (repoPath, ts)`);
```

- [ ] **Step 4: Add the methods**

In `src/store.ts`, add a `Signal` import to the existing `./types` import, then add these methods to the `SessionStore` class (place after the reviews methods, near line 330):

```typescript
// ── learning signals ─────────────────────────────────────────────────────────
addSignal(input: {
  repoPath: string;
  sessionId: string | null;
  kind: import("./types").SignalKind;
  payload: string;
}): import("./types").Signal {
  const sig: import("./types").Signal = {
    id: randomUUID(),
    repoPath: input.repoPath,
    sessionId: input.sessionId,
    kind: input.kind,
    payload: input.payload,
    ts: Date.now(),
  };
  this.db.run(`INSERT INTO signals (id, repoPath, sessionId, kind, payload, ts) VALUES (?,?,?,?,?,?)`, [
    sig.id,
    sig.repoPath,
    sig.sessionId,
    sig.kind,
    sig.payload,
    sig.ts,
  ]);
  return sig;
}

listSignals(repoPath: string, opts?: { sinceTs?: number; limit?: number }): import("./types").Signal[] {
  const since = opts?.sinceTs ?? 0;
  const limit = opts?.limit ?? 1000;
  const rows = this.db
    .query(
      `SELECT id, repoPath, sessionId, kind, payload, ts FROM signals
       WHERE repoPath = ? AND ts >= ? ORDER BY ts DESC LIMIT ?`,
    )
    .all(repoPath, since, limit) as import("./types").Signal[];
  return rows;
}

pruneSignals(beforeTs: number): number {
  const n = (this.db.query(`SELECT COUNT(*) AS c FROM signals WHERE ts < ?`).get(beforeTs) as {
    c: number;
  }).c;
  this.db.run(`DELETE FROM signals WHERE ts < ?`, [beforeTs]);
  return n;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test ./test/store-learnings.test.ts`
Expected: PASS (3 signal tests pass; learnings tests come in Task 3).

- [ ] **Step 6: Commit**

```bash
git add src/store.ts test/store-learnings.test.ts
git commit -m "feat(learnings): signals table + store methods"
```

---

## Task 3: `learnings` table + store methods

**Files:**
- Modify: `src/store.ts`
- Test: `test/store-learnings.test.ts` (append)

- [ ] **Step 1: Add the failing tests**

Append to `test/store-learnings.test.ts`:

```typescript
test("addLearning defaults to proposed; listLearnings filters by status", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({
    repoPath: "/r",
    rule: "run cd ui && bun run check:i18n before pushing",
    rationale: "agents forget the DE catalog",
    evidence: ["sig1", "sig2"],
  });
  expect(l.status).toBe("proposed");
  expect(l.evidence).toEqual(["sig1", "sig2"]);
  expect(l.evidenceCount).toBe(2);
  expect(s.listLearnings("/r", { status: "proposed" }).length).toBe(1);
  expect(s.listLearnings("/r", { status: "active" }).length).toBe(0);
});

test("setLearningStatus transitions and can edit rule text; getLearning round-trips", () => {
  const s = new SessionStore(":memory:");
  const l = s.addLearning({ repoPath: "/r", rule: "old", rationale: "", evidence: [] });
  const up = s.setLearningStatus(l.id, "active", "new wording")!;
  expect(up.status).toBe("active");
  expect(up.rule).toBe("new wording");
  expect(s.getLearning(l.id)?.status).toBe("active");
  expect(s.setLearningStatus("missing", "dismissed")).toBeNull();
});

test("pendingLearningCount counts proposed across all repos", () => {
  const s = new SessionStore(":memory:");
  s.addLearning({ repoPath: "/a", rule: "x", rationale: "", evidence: [] });
  const b = s.addLearning({ repoPath: "/b", rule: "y", rationale: "", evidence: [] });
  s.setLearningStatus(b.id, "active");
  expect(s.pendingLearningCount()).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/store-learnings.test.ts`
Expected: FAIL — `addLearning is not a function`.

- [ ] **Step 3: Add the table**

In the `SessionStore` constructor, after the `signals` index line from Task 2, add:

```typescript
this.db.run(`CREATE TABLE IF NOT EXISTS learnings (
  id TEXT PRIMARY KEY, repoPath TEXT NOT NULL, rule TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL, evidenceCount INTEGER NOT NULL DEFAULT 0,
  ineffectiveCount INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, lastEvidenceAt INTEGER)`);
this.db.run(`CREATE INDEX IF NOT EXISTS learnings_repo_status ON learnings (repoPath, status)`);
```

- [ ] **Step 4: Add the methods + hydrator**

Add to `SessionStore` (after the signal methods). Add `Learning` and `LearningStatus` to the `./types` import:

```typescript
private hydrateLearning(r: any): Learning {
  return {
    id: r.id,
    repoPath: r.repoPath,
    rule: r.rule,
    rationale: r.rationale,
    evidence: JSON.parse(r.evidence) as string[],
    status: r.status as LearningStatus,
    evidenceCount: r.evidenceCount,
    ineffectiveCount: r.ineffectiveCount,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastEvidenceAt: r.lastEvidenceAt,
  };
}

addLearning(input: { repoPath: string; rule: string; rationale: string; evidence: string[] }): Learning {
  const now = Date.now();
  const l: Learning = {
    id: randomUUID(),
    repoPath: input.repoPath,
    rule: input.rule,
    rationale: input.rationale,
    evidence: input.evidence,
    status: "proposed",
    evidenceCount: input.evidence.length,
    ineffectiveCount: 0,
    createdAt: now,
    updatedAt: now,
    lastEvidenceAt: input.evidence.length ? now : null,
  };
  this.db.run(
    `INSERT INTO learnings
       (id, repoPath, rule, rationale, evidence, status, evidenceCount, ineffectiveCount, createdAt, updatedAt, lastEvidenceAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      l.id, l.repoPath, l.rule, l.rationale, JSON.stringify(l.evidence), l.status,
      l.evidenceCount, l.ineffectiveCount, l.createdAt, l.updatedAt, l.lastEvidenceAt,
    ],
  );
  return l;
}

listLearnings(repoPath: string, opts?: { status?: LearningStatus }): Learning[] {
  const rows = opts?.status
    ? this.db
        .query(`SELECT * FROM learnings WHERE repoPath = ? AND status = ? ORDER BY updatedAt DESC`)
        .all(repoPath, opts.status)
    : this.db.query(`SELECT * FROM learnings WHERE repoPath = ? ORDER BY updatedAt DESC`).all(repoPath);
  return (rows as any[]).map((r) => this.hydrateLearning(r));
}

getLearning(id: string): Learning | null {
  const r = this.db.query(`SELECT * FROM learnings WHERE id = ?`).get(id) as any;
  return r ? this.hydrateLearning(r) : null;
}

setLearningStatus(id: string, status: LearningStatus, rule?: string): Learning | null {
  const cur = this.getLearning(id);
  if (!cur) return null;
  this.db.run(`UPDATE learnings SET status = ?, rule = ?, updatedAt = ? WHERE id = ?`, [
    status,
    rule ?? cur.rule,
    Date.now(),
    id,
  ]);
  return this.getLearning(id);
}

pendingLearningCount(): number {
  return (
    this.db.query(`SELECT COUNT(*) AS c FROM learnings WHERE status = 'proposed'`).get() as {
      c: number;
    }
  ).c;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test ./test/store-learnings.test.ts`
Expected: PASS (all signal + learning tests).

- [ ] **Step 6: Commit**

```bash
git add src/store.ts test/store-learnings.test.ts
git commit -m "feat(learnings): learnings table + store methods"
```

---

## Task 4: Capture the `reply` signal

**Files:**
- Modify: `src/service.ts:269-275` (`reply`)
- Test: `test/signal-capture.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/signal-capture.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { SessionService } from "../src/service";
import { SessionStore } from "../src/store";

function deps(store: SessionStore) {
  return {
    store,
    worktree: {} as any,
    herdr: { send: () => {} } as any,
    namer: (p: string) => p,
  };
}

test("reply records a 'reply' signal for the session's repo", () => {
  const store = new SessionStore(":memory:");
  const s = store.create({
    name: "n", prompt: "p", repoPath: "/r", baseBranch: "main", branch: "b",
    worktreePath: "/wt", isolated: true, herdrSession: "default", herdrAgentId: "t1",
  });
  const svc = new SessionService(deps(store) as any);
  expect(svc.reply(s.id, "use uv not pip")).toBe(true);
  const sigs = store.listSignals("/r");
  expect(sigs.length).toBe(1);
  expect(sigs[0]!.kind).toBe("reply");
  expect(sigs[0]!.payload).toBe("use uv not pip");
  expect(sigs[0]!.sessionId).toBe(s.id);
});

test("reply to a missing session records nothing", () => {
  const store = new SessionStore(":memory:");
  const svc = new SessionService(deps(store) as any);
  expect(svc.reply("nope", "x")).toBe(false);
  expect(store.listSignals("/r").length).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/signal-capture.test.ts`
Expected: FAIL — `sigs.length` is 0 (reply does not yet record).

- [ ] **Step 3: Add the capture**

In `src/service.ts`, modify `reply` (lines 269-275) to record before steering:

```typescript
reply(id: string, text: string): boolean {
  const s = this.deps.store.get(id);
  if (!s) return false;
  this.deps.store.addSignal({ repoPath: s.repoPath, sessionId: s.id, kind: "reply", payload: text });
  this.deps.herdr.send(s.herdrAgentId, text);
  this.deps.herdr.send(s.herdrAgentId, "\r");
  return true;
}
```

(`ServiceDeps.store` is the full `SessionStore`, so `addSignal` is already available — no interface change.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/signal-capture.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/service.ts test/signal-capture.test.ts
git commit -m "feat(learnings): capture operator reply as a signal"
```

---

## Task 5: Capture the `critic` signal

**Files:**
- Modify: `src/review.ts` (`ReviewServiceDeps` store Pick + `finalize`)
- Test: `test/signal-capture.test.ts` (append)

- [ ] **Step 1: Add the failing test**

Append to `test/signal-capture.test.ts`:

```typescript
import { ReviewService } from "../src/review";

test("critic changes_requested records a 'critic' signal", async () => {
  const store = new SessionStore(":memory:");
  const session = store.create({
    name: "n", prompt: "p", repoPath: "/repo", baseBranch: "main", branch: "b",
    worktreePath: "/wt", isolated: true, herdrSession: "default", herdrAgentId: "t1",
  });
  const svc = new ReviewService({
    store,
    herdr: { start: () => ({ terminalId: "rev1" }), stop: () => {} } as any,
    worktree: { createDetached: () => ({ worktreePath: "/rev-wt" }), remove: () => {} } as any,
    resolveForge: () => null,
    onChange: () => {},
    now: () => 1,
    readVerdict: () => ({ decision: "request-changes", summary: "2 issues", body: "## findings" }),
  });
  svc.consider(session, { state: "open", checks: "success", headSha: "abc", number: 7 } as any);
  await svc.tick();
  const sigs = store.listSignals("/repo");
  expect(sigs.length).toBe(1);
  expect(sigs[0]!.kind).toBe("critic");
  expect(sigs[0]!.payload).toContain("2 issues");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/signal-capture.test.ts`
Expected: FAIL — critic signal not recorded (length 0).

- [ ] **Step 3: Widen the store Pick**

In `src/review.ts`, `ReviewServiceDeps.store` Pick (lines 40-43), add `"addSignal"` and `"get"`:

```typescript
store: Pick<
  SessionStore,
  "getRepoConfig" | "getReview" | "putReview" | "dropReview" | "snapshotReviews" | "addSignal" | "get"
>;
```

- [ ] **Step 4: Record in finalize**

In `src/review.ts` `finalize`, after `this.deps.store.putReview(verdict);` and before `this.deps.onChange(...)`, add:

```typescript
if (verdict.decision === "changes_requested") {
  const sess = this.deps.store.get(f.sessionId);
  if (sess) {
    this.deps.store.addSignal({
      repoPath: f.repoPath,
      sessionId: f.sessionId,
      kind: "critic",
      payload: `${verdict.summary}\n\n${verdict.body}`,
    });
  }
}
```

(`f.repoPath` is already on `InFlight`; the `get` lookup just confirms the session still exists.)

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test ./test/signal-capture.test.ts && bun test ./test/review.test.ts`
Expected: PASS (new test passes; existing review tests still pass).

- [ ] **Step 6: Commit**

```bash
git add src/review.ts test/signal-capture.test.ts
git commit -m "feat(learnings): capture critic changes_requested as a signal"
```

---

## Task 6: Capture `block` + `stall` signals from events

**Files:**
- Create: `src/signals.ts`
- Test: `test/signals-attach.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/signals-attach.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { EventHub } from "../src/events";
import { SessionStore } from "../src/store";
import { attachSignalCapture } from "../src/signals";

function mk() {
  const store = new SessionStore(":memory:");
  const s = store.create({
    name: "n", prompt: "p", repoPath: "/r", baseBranch: "main", branch: "b",
    worktreePath: "/wt", isolated: true, herdrSession: "default", herdrAgentId: "t1",
  });
  const events = new EventHub();
  attachSignalCapture(events, store);
  return { store, s, events };
}

test("session:block with a menu shape records a 'block' signal", () => {
  const { store, s, events } = mk();
  events.emit("session:block", {
    id: s.id,
    block: { shape: "menu", options: [], tail: ["1. yes", "2. no"] },
  });
  const sigs = store.listSignals("/r");
  expect(sigs.length).toBe(1);
  expect(sigs[0]!.kind).toBe("block");
  expect(sigs[0]!.payload).toContain("yes");
});

test("session:block with a stall shape records a 'stall' signal", () => {
  const { store, s, events } = mk();
  events.emit("session:block", { id: s.id, block: { shape: "stall", options: [], tail: ["quiet"] } });
  expect(store.listSignals("/r")[0]!.kind).toBe("stall");
});

test("a cleared block (block: null) records nothing", () => {
  const { store, s, events } = mk();
  events.emit("session:block", { id: s.id, block: null });
  expect(store.listSignals("/r").length).toBe(0);
});

test("block for an unknown session records nothing", () => {
  const { store, events } = mk();
  events.emit("session:block", { id: "nope", block: { shape: "menu", options: [], tail: [] } });
  // only the known session's repo is "/r"; unknown id has no repoPath to attribute
  expect(store.listSignals("/r").length).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/signals-attach.test.ts`
Expected: FAIL — `Cannot find module '../src/signals'`.

- [ ] **Step 3: Implement `attachSignalCapture`**

Create `src/signals.ts`:

```typescript
import type { EventHub } from "./events";
import type { SessionStore } from "./store";
import type { BlockReason } from "./blocked";

/**
 * Capture `block` and `stall` learning signals off the `session:block` event.
 * Reply signals are captured in SessionService.reply; critic signals in ReviewService.
 * A `stall`-shaped block becomes a "stall" signal; every other shape a "block" signal.
 * Cleared blocks (block: null) and unknown sessions are ignored.
 */
export function attachSignalCapture(
  events: Pick<EventHub, "subscribe">,
  store: Pick<SessionStore, "get" | "addSignal">,
): () => void {
  return events.subscribe((event, data) => {
    if (event !== "session:block") return;
    const { id, block } = data as { id: string; block: BlockReason | null };
    if (!block) return;
    const s = store.get(id);
    if (!s) return;
    store.addSignal({
      repoPath: s.repoPath,
      sessionId: s.id,
      kind: block.shape === "stall" ? "stall" : "block",
      payload: block.tail.join("\n"),
    });
  });
}
```

(`EventHub.subscribe` returns an unsubscribe fn — `src/events.ts:3-6`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/signals-attach.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/signals.ts test/signals-attach.test.ts
git commit -m "feat(learnings): capture block/stall signals from events"
```

---

## Task 7: `DistillerService`

**Files:**
- Create: `src/distiller.ts`
- Test: `test/distiller.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/distiller.test.ts`:

```typescript
import { test, expect } from "bun:test";
import { DistillerService } from "../src/distiller";
import { SessionStore } from "../src/store";

function seedSignals(store: SessionStore, repo: string, n: number) {
  for (let i = 0; i < n; i++) {
    store.addSignal({ repoPath: repo, sessionId: null, kind: "reply", payload: `correction ${i}` });
  }
}

function mkDeps(store: SessionStore, proposals: any, onChange = () => {}) {
  const started: { dir: string }[] = [];
  return {
    deps: {
      store,
      herdr: { start: () => ({ terminalId: "dist1" }), stop: () => {} } as any,
      scratch: {
        create: () => {
          const d = { dir: `/scratch/${started.length}` };
          started.push(d);
          return d;
        },
        remove: () => {},
      },
      onChange,
      now: () => 1000,
      minSignals: 3,
      writeSignals: () => {},
      readProposals: () => proposals,
    },
    started,
  };
}

test("consider spawns when enough new signals, tick stores proposed learnings", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 3);
  const { deps } = mkDeps(store, {
    rules: [{ rule: "use bun not npm", rationale: "repo is bun", evidence: ["x"] }],
  });
  const d = new DistillerService(deps as any);
  d.consider("/r");
  await d.tick();
  const learnings = store.listLearnings("/r", { status: "proposed" });
  expect(learnings.length).toBe(1);
  expect(learnings[0]!.rule).toBe("use bun not npm");
});

test("consider does nothing below the signal threshold", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 2);
  const { deps, started } = mkDeps(store, { rules: [] });
  const d = new DistillerService(deps as any);
  d.consider("/r");
  expect(started.length).toBe(0);
});

test("distillNow forces a run regardless of threshold", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 1);
  const { deps, started } = mkDeps(store, { rules: [] });
  const d = new DistillerService(deps as any);
  d.distillNow("/r");
  expect(started.length).toBe(1);
});

test("duplicate rule text is not re-proposed", async () => {
  const store = new SessionStore(":memory:");
  store.addLearning({ repoPath: "/r", rule: "use bun not npm", rationale: "", evidence: [] });
  seedSignals(store, "/r", 3);
  const { deps } = mkDeps(store, {
    rules: [{ rule: "Use Bun not npm", rationale: "dup", evidence: [] }],
  });
  const d = new DistillerService(deps as any);
  d.distillNow("/r");
  await d.tick();
  expect(store.listLearnings("/r").length).toBe(1); // unchanged
});

test("onChange fires after a run that produced rules", async () => {
  const store = new SessionStore(":memory:");
  seedSignals(store, "/r", 3);
  let fired = 0;
  const { deps } = mkDeps(store, { rules: [{ rule: "x", rationale: "", evidence: [] }] }, () => fired++);
  const d = new DistillerService(deps as any);
  d.distillNow("/r");
  await d.tick();
  expect(fired).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/distiller.test.ts`
Expected: FAIL — `Cannot find module '../src/distiller'`.

- [ ] **Step 3: Implement `DistillerService`**

Create `src/distiller.ts`:

```typescript
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionStore } from "./store";
import type { HerdrDriver } from "./herdr";
import type { Signal } from "./types";

const PROPOSALS_FILE = ".shepherd-learnings.json";

interface RawRule {
  rule?: unknown;
  rationale?: unknown;
  evidence?: unknown;
}
interface RawProposals {
  rules?: unknown;
}

interface InFlight {
  repoPath: string;
  dir: string;
  terminalId: string;
  startedAt: number;
  finalizing?: boolean;
}

export interface DistillerDeps {
  store: Pick<SessionStore, "listSignals" | "addLearning" | "listLearnings">;
  herdr: Pick<HerdrDriver, "start" | "stop">;
  scratch: { create: () => { dir: string }; remove: (dir: string) => void };
  onChange: () => void;
  model?: string | null;
  now?: () => number;
  timeoutMs?: number;
  windowMs?: number; // how far back to read signals (default 60d)
  minSignals?: number; // threshold for consider() (default 5)
  writeSignals?: (dir: string, signals: Signal[], existingRules: string[]) => void;
  readProposals?: (dir: string) => RawProposals | null;
}

export class DistillerService {
  private inflight = new Map<string, InFlight>();
  private now: () => number;
  private timeoutMs: number;
  private windowMs: number;
  private minSignals: number;
  private writeSignals: NonNullable<DistillerDeps["writeSignals"]>;
  private readProposals: (dir: string) => RawProposals | null;

  constructor(private deps: DistillerDeps) {
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? 10 * 60 * 1000;
    this.windowMs = deps.windowMs ?? 60 * 24 * 60 * 60 * 1000;
    this.minSignals = deps.minSignals ?? 5;
    this.writeSignals = deps.writeSignals ?? defaultWriteSignals;
    this.readProposals = deps.readProposals ?? defaultReadProposals;
  }

  /** Start a distill run for `repoPath` if enough recent signals exist and none is in flight. */
  consider(repoPath: string): void {
    if (this.inflight.has(repoPath)) return;
    const since = this.now() - this.windowMs;
    const signals = this.deps.store.listSignals(repoPath, { sinceTs: since });
    if (signals.length < this.minSignals) return;
    this.begin(repoPath, signals);
  }

  /** Force a distill run regardless of the signal threshold (manual trigger). */
  distillNow(repoPath: string): void {
    if (this.inflight.has(repoPath)) return;
    const since = this.now() - this.windowMs;
    const signals = this.deps.store.listSignals(repoPath, { sinceTs: since });
    this.begin(repoPath, signals);
  }

  private begin(repoPath: string, signals: Signal[]): void {
    const { dir } = this.deps.scratch.create();
    const existing = this.deps.store
      .listLearnings(repoPath)
      .filter((l) => l.status !== "dismissed")
      .map((l) => l.rule);
    try {
      this.writeSignals(dir, signals, existing);
    } catch (err) {
      console.warn(`[distill] write signals failed for ${repoPath}:`, err);
      this.deps.scratch.remove(dir);
      return;
    }
    // Read-only distiller — same hard-won spawn contract as the critic
    // (src/review.ts:begin). NOT --dangerously-skip-permissions: it reads
    // untrusted agent/repo text. dontAsk MUST be last (after the variadic
    // --allowedTools) so the trailing prompt isn't swallowed. Bare Write only.
    const argv = [
      "claude",
      "--session-id",
      randomUUID(),
      "--settings",
      '{"disableAllHooks":true}',
      "--disable-slash-commands",
      "--allowedTools",
      "Read",
      "Grep",
      "Glob",
      "Write",
    ];
    if (this.deps.model) argv.push("--model", this.deps.model);
    argv.push("--permission-mode", "dontAsk");
    argv.push(distillPrompt());
    let terminalId: string;
    try {
      terminalId = this.deps.herdr.start("distill", dir, argv).terminalId;
    } catch (err) {
      console.warn(`[distill] spawn failed for ${repoPath}:`, err);
      this.deps.scratch.remove(dir);
      return;
    }
    this.inflight.set(repoPath, { repoPath, dir, terminalId, startedAt: this.now() });
  }

  /** Finalize any run whose proposals file is ready or that timed out. */
  async tick(): Promise<void> {
    for (const f of [...this.inflight.values()]) {
      if (f.finalizing) continue;
      const raw = this.readProposals(f.dir);
      const timedOut = this.now() - f.startedAt > this.timeoutMs;
      if (!raw && !timedOut) continue;
      f.finalizing = true;
      this.finalize(f, raw);
      this.inflight.delete(f.repoPath);
    }
  }

  private finalize(f: InFlight, raw: RawProposals | null): void {
    let added = 0;
    const have = new Set(
      this.deps.store.listLearnings(f.repoPath).map((l) => normalizeRule(l.rule)),
    );
    const rules = Array.isArray(raw?.rules) ? (raw!.rules as RawRule[]) : [];
    for (const r of rules) {
      if (typeof r?.rule !== "string" || !r.rule.trim()) continue;
      const key = normalizeRule(r.rule);
      if (have.has(key)) continue;
      have.add(key);
      this.deps.store.addLearning({
        repoPath: f.repoPath,
        rule: r.rule.trim().slice(0, 240),
        rationale: typeof r.rationale === "string" ? r.rationale : "",
        evidence: Array.isArray(r.evidence) ? r.evidence.filter((e): e is string => typeof e === "string") : [],
      });
      added++;
    }
    this.deps.herdr.stop(f.terminalId);
    this.deps.scratch.remove(f.dir);
    if (added > 0) this.deps.onChange();
  }
}

function normalizeRule(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export function distillPrompt(): string {
  return [
    "You are a code-review pattern analyst. Read `signals.json` in this directory.",
    "It is a JSON array of past corrections, blocks, stalls, and critic findings for one repository,",
    "plus `existingRules` — house rules already recorded (do NOT repeat these).",
    "Identify RECURRING, actionable mistakes worth a standing house rule for future agents.",
    "Ignore one-off noise. Write at most 5 crisp imperative rules.",
    `Write your output as JSON to \`${PROPOSALS_FILE}\` in this directory, shaped exactly:`,
    '{"rules": [{"rule": "<=160 char imperative", "rationale": "why", "evidence": ["signalId", ...]}]}',
    "If nothing recurs, write {\"rules\": []}. Do not write anything else.",
  ].join("\n");
}

function defaultWriteSignals(dir: string, signals: Signal[], existingRules: string[]): void {
  const payload = {
    signals: signals.map((s) => ({ kind: s.kind, payload: s.payload, ts: s.ts, id: s.id })),
    existingRules,
  };
  writeFileSync(join(dir, "signals.json"), JSON.stringify(payload, null, 2));
}

function defaultReadProposals(dir: string): RawProposals | null {
  const p = join(dir, PROPOSALS_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RawProposals;
  } catch {
    return null; // partial write; retry next tick
  }
}

/** Default scratch dir: a throwaway temp dir (the distiller needs no git, only Read/Write). */
export const defaultScratch = {
  create: () => ({ dir: mkdtempSync(join(tmpdir(), "shepherd-distill-")) }),
  remove: (dir: string) => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/distiller.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/distiller.ts test/distiller.test.ts
git commit -m "feat(learnings): DistillerService (read-only spawn proposes rules)"
```

---

## Task 8: `/api/learnings` route handler

**Files:**
- Modify: `src/server.ts` (add `handleLearnings`, register it, extend `AppDeps`)
- Test: covered via the existing server test pattern in `test/server.test.ts` (append)

- [ ] **Step 1: Add the failing test**

Append to `test/server.test.ts` (match its existing harness — inspect the top of that file for how it builds `AppDeps`/`makeApp`; reuse that helper. The test below assumes a `makeApp(deps)` helper returning a fetch handler, consistent with the file's other tests):

```typescript
import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
// NOTE: reuse this file's existing app/test harness (makeApp or buildHandler).
// The asserts below are the contract; adapt the request plumbing to the harness.

test("GET /api/learnings lists proposed rules for a repo", async () => {
  const store = new SessionStore(":memory:");
  store.addLearning({ repoPath: process.cwd(), rule: "use bun", rationale: "", evidence: [] });
  const app = makeTestApp({ store }); // existing helper in this file
  const res = await app(
    new Request(`http://x/api/learnings?repo=${encodeURIComponent(process.cwd())}&status=proposed`, {
      headers: authHeaders(), // existing helper
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { rule: string }[];
  expect(body.length).toBe(1);
  expect(body[0]!.rule).toBe("use bun");
});

test("POST /api/learnings/:id/approve flips status to active with edited text", async () => {
  const store = new SessionStore(":memory:");
  const l = store.addLearning({ repoPath: process.cwd(), rule: "old", rationale: "", evidence: [] });
  const app = makeTestApp({ store });
  const res = await app(
    new Request(`http://x/api/learnings/${l.id}/approve`, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json", Origin: allowedOrigin() },
      body: JSON.stringify({ rule: "new" }),
    }),
  );
  expect(res.status).toBe(200);
  expect(store.getLearning(l.id)?.status).toBe("active");
  expect(store.getLearning(l.id)?.rule).toBe("new");
});

test("POST /api/learnings/:id/dismiss flips status to dismissed", async () => {
  const store = new SessionStore(":memory:");
  const l = store.addLearning({ repoPath: process.cwd(), rule: "x", rationale: "", evidence: [] });
  const app = makeTestApp({ store });
  const res = await app(
    new Request(`http://x/api/learnings/${l.id}/dismiss`, {
      method: "POST",
      headers: { ...authHeaders(), Origin: allowedOrigin() },
    }),
  );
  expect(res.status).toBe(200);
  expect(store.getLearning(l.id)?.status).toBe("dismissed");
});
```

> **Implementer note:** Open `test/server.test.ts` first and reuse its real helpers (app builder, auth header, allowed-origin). If a `distiller` is required in `AppDeps`, pass a stub `{ distillNow: () => {} }`. Adjust the three asserts' plumbing to the harness; keep the assertions.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/server.test.ts`
Expected: FAIL — 404 / handler missing.

- [ ] **Step 3: Add `distiller` to `AppDeps`**

In `src/server.ts`, find the `AppDeps` type (the shape of `deps` passed to handlers) and add:

```typescript
distiller: { distillNow: (repoPath: string) => void };
```

- [ ] **Step 4: Implement `handleLearnings`**

In `src/server.ts`, add (mirroring `handleRepoConfig` for the `?repo=` validation and `handleSessionReply` for the `:id/action` shape):

```typescript
// /api/learnings — list (GET ?repo=), approve/dismiss (POST :id/action), distill (POST distill ?repo=)
async function handleLearnings({ req, parts, url, deps }: Ctx): Promise<Response | null> {
  if (parts[0] !== "api" || parts[1] !== "learnings") return null;

  // GET /api/learnings?repo=&status=
  if (req.method === "GET" && !parts[2]) {
    const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
    if (!dir) return json({ error: "invalid repo" }, 400);
    const status = url.searchParams.get("status") ?? undefined;
    return json(deps.store.listLearnings(dir, status ? { status: status as any } : undefined));
  }

  // POST /api/learnings/distill?repo=
  if (req.method === "POST" && parts[2] === "distill") {
    const dir = safeRepoDir(url.searchParams.get("repo") ?? "", config.repoRoot);
    if (!dir) return json({ error: "invalid repo" }, 400);
    deps.distiller.distillNow(dir);
    return json({ ok: true });
  }

  // POST /api/learnings/:id/approve  |  /:id/dismiss
  if (req.method === "POST" && parts[2] && (parts[3] === "approve" || parts[3] === "dismiss")) {
    const id = parts[2];
    let rule: string | undefined;
    if (parts[3] === "approve") {
      const body = (await req.json().catch(() => null)) as { rule?: unknown } | null;
      if (body && typeof body.rule === "string") rule = body.rule;
    }
    const status = parts[3] === "approve" ? "active" : "dismissed";
    const updated = deps.store.setLearningStatus(id, status, rule);
    if (!updated) return json({ error: "not found" }, 404);
    deps.events.emit("learnings:update", { pending: deps.store.pendingLearningCount() });
    return json(updated);
  }

  return null;
}
```

- [ ] **Step 5: Register the handler**

In `src/server.ts`, add `handleLearnings` to the ordered list of handlers the router tries (alongside `handleRepoConfig`, `handleSessionReply`, etc. — match the existing registration array/sequence).

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test ./test/server.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat(learnings): /api/learnings list/approve/dismiss/distill routes"
```

---

## Task 9: Wire the distiller + signal capture in `index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Construct the distiller and wire capture (after the ReviewService block, ~line 168)**

In `src/index.ts`, add the imports at the top with the other `./` imports:

```typescript
import { DistillerService, defaultScratch } from "./distiller";
import { attachSignalCapture } from "./signals";
```

Then after the ReviewService wiring (after line 168), add:

```typescript
// Learnings flywheel: capture block/stall signals, run the distiller on a slow
// cadence, and surface the proposed-rule count to clients.
attachSignalCapture(events, store);
const distiller = new DistillerService({
  store,
  herdr,
  scratch: defaultScratch,
  onChange: () => events.emit("learnings:update", { pending: store.pendingLearningCount() }),
});
setInterval(() => void distiller.tick(), 30_000);
// Daily: prune old signals, then consider a distill per repo with enough recent signal.
const runDistillSweep = () => {
  store.pruneSignals(Date.now() - 60 * 24 * 60 * 60 * 1000);
  for (const dir of listRepos(config.repoRoot)) distiller.consider(dir);
};
setTimeout(runDistillSweep, 10_000); // once shortly after boot
setInterval(runDistillSweep, 24 * 60 * 60 * 1000);
```

(`listRepos` is already imported in `index.ts` — it's used by `BacklogPoller` at line 223.)

- [ ] **Step 2: Pass the distiller into server deps**

Find where `AppDeps` is assembled and the server is started in `index.ts` (the object literal passed to the server with `store`, `service`, `events`, etc.) and add:

```typescript
distiller,
```

- [ ] **Step 3: Typecheck + full server test suite**

Run: `bunx tsc --noEmit && bun test ./test`
Expected: PASS (all server tests, including new learnings/distiller/signal tests).

- [ ] **Step 4: Lint**

Run: `bun run lint`
Expected: PASS (fix any formatting the linter flags).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(learnings): wire distiller + signal capture into server bootstrap"
```

---

## Task 10: Full verification

- [ ] **Step 1: Run the whole root suite + typecheck + lint**

Run: `bunx tsc --noEmit && bun test ./test && bun run lint`
Expected: All PASS.

- [ ] **Step 2: Smoke the API manually (optional but recommended)**

Start the server (`bun run start` or the project's dev entry), then:

```bash
# list (expect [] for a fresh repo)
curl -s "http://127.0.0.1:<port>/api/learnings?repo=<repo>" -H "Authorization: Bearer $SHEPHERD_TOKEN"
# force a distill (expect {"ok":true})
curl -s -X POST "http://127.0.0.1:<port>/api/learnings/distill?repo=<repo>" \
  -H "Authorization: Bearer $SHEPHERD_TOKEN" -H "Origin: <allowed-origin>"
```

Expected: 200s; after the distiller tick, `GET` returns any proposed rules.

- [ ] **Step 3: Final commit (if any lint/format churn)**

```bash
git add -A && git commit -m "chore(learnings): backend verification pass" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage (backend slice):**
- Signal capture table + 4 seams → Tasks 2, 4, 5, 6. ✓
- Distiller (read-only critic-pattern spawn, JSON proposals, threshold + manual + tick) → Task 7. ✓
- `learnings` lifecycle (proposed → active/dismissed) → Tasks 3, 8. ✓
- API (list/approve/dismiss/distill) → Task 8. ✓
- Wiring + daily tick + prune + `learnings:update` event → Task 9. ✓
- Dedup at propose time → Task 7 (`normalizeRule`). ✓
- Deferred to Plan B (UI) and PR2 (inject, promote, self-audit, per-repo toggle) — stated in Scope note. ✓

**Type consistency:** `Signal`, `SignalKind`, `Learning`, `LearningStatus` defined in Task 1 and used identically in store (2,3), capture (4,5,6), distiller (7), server (8). Store method names (`addSignal`, `listSignals`, `pruneSignals`, `addLearning`, `listLearnings`, `getLearning`, `setLearningStatus`, `pendingLearningCount`) are used verbatim in later tasks. Event name `learnings:update` consistent in Tasks 8 and 9.

**Placeholder scan:** Task 8's test note intentionally defers request-plumbing to the file's real harness (the assertions are concrete) — flagged for the implementer rather than guessed, because `test/server.test.ts`'s exact helper names must be read from the file. No other placeholders.
