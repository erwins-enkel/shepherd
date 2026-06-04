# Session reattach after herdr restart — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-pair a session with its live herdr agent by a stable key (worktree cwd, name tiebreak) and adopt the new terminalId, so a herdr daemon restart self-heals instead of orphaning every session as "done" and instead of spawning duplicate `claude --resume` processes.

**Architecture:** One pure matcher `matchAgent(session, agents)` in `herdr.ts` replaces the three terminalId-only lookups: `reconcile()` (boot), `StatusPoller.tick()` (live), and `SessionService.resume()` (UI Resume). terminalId stays the fast path; on a miss it falls back to `cwd === worktreePath` (name tiebreak when a cwd is shared). On a cwd match the new terminalId is persisted to `herdrAgentId`.

**Tech Stack:** TypeScript, Bun test runner. Root package (`bun test ./test`).

---

### Task 1: `matchAgent` pure matcher in `herdr.ts`

**Files:**
- Modify: `src/herdr.ts` (add exported function near `mapState`)
- Test: `test/herdr.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/herdr.test.ts`:

```ts
import { matchAgent } from "../src/herdr";

const mkAgent = (over: Partial<import("../src/herdr").HerdrAgent>) =>
  ({
    agent: "claude",
    agentStatus: "working",
    cwd: "/wt/a",
    name: "",
    paneId: "p",
    tabId: "t",
    terminalId: "term_x",
    workspaceId: "w",
    ...over,
  }) as import("../src/herdr").HerdrAgent;

const sess = { herdrAgentId: "term_old", worktreePath: "/wt/a", name: "alpha" };

test("matchAgent: terminalId fast path wins even if cwd differs", () => {
  const a = mkAgent({ terminalId: "term_old", cwd: "/elsewhere" });
  expect(matchAgent(sess, [a, mkAgent({ terminalId: "term_x" })])).toBe(a);
});

test("matchAgent: falls back to a single cwd match and ignores the stale id", () => {
  const a = mkAgent({ terminalId: "term_new", cwd: "/wt/a" });
  expect(matchAgent(sess, [a])).toBe(a);
});

test("matchAgent: cwd shared by 2+ agents → disambiguate by name", () => {
  const a = mkAgent({ terminalId: "t1", cwd: "/wt/a", name: "alpha" });
  const b = mkAgent({ terminalId: "t2", cwd: "/wt/a", name: "beta" });
  expect(matchAgent(sess, [a, b])).toBe(a);
});

test("matchAgent: cwd ambiguous AND name ambiguous → null", () => {
  const a = mkAgent({ terminalId: "t1", cwd: "/wt/a", name: "alpha" });
  const b = mkAgent({ terminalId: "t2", cwd: "/wt/a", name: "alpha" });
  expect(matchAgent(sess, [a, b])).toBeNull();
});

test("matchAgent: no terminalId and no cwd match → null", () => {
  expect(matchAgent(sess, [mkAgent({ terminalId: "t9", cwd: "/other" })])).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./test/herdr.test.ts`
Expected: FAIL — `matchAgent` is not exported / not a function.

- [ ] **Step 3: Implement `matchAgent`**

In `src/herdr.ts`, add directly below the `mapState` function:

```ts
/**
 * Resolve a session to its live herdr agent by a STABLE key. terminalId is the fast
 * path but is volatile across a herdr daemon restart, so on a miss we fall back to the
 * immutable worktree cwd. A cwd shared by 2+ agents (non-isolated same-repo sessions)
 * is disambiguated by agent name; still ambiguous → no match (never risk mis-pairing).
 */
export function matchAgent(
  s: { herdrAgentId: string; worktreePath: string; name: string },
  agents: HerdrAgent[],
): HerdrAgent | null {
  const byId = agents.find((a) => a.terminalId === s.herdrAgentId);
  if (byId) return byId;
  const byCwd = agents.filter((a) => a.cwd === s.worktreePath);
  if (byCwd.length === 1) return byCwd[0]!;
  if (byCwd.length > 1) {
    const byName = byCwd.filter((a) => a.name === s.name);
    if (byName.length === 1) return byName[0]!;
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./test/herdr.test.ts`
Expected: PASS (all matchAgent tests green).

- [ ] **Step 5: Commit**

```bash
git add src/herdr.ts test/herdr.test.ts
git commit -m "feat(herdr): stable matchAgent (cwd fallback, name tiebreak)"
```

---

### Task 2: `reconcile()` adopts the live agent on boot

**Files:**
- Modify: `src/reconcile.ts`
- Test: `test/reconcile.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/reconcile.test.ts`:

```ts
test("reconcile re-pairs a session whose terminalId went stale but agent is live at the same cwd", () => {
  const store = new SessionStore(":memory:");
  const s = store.create({ ...base, worktreePath: "/wt/z", herdrAgentId: "term_stale" });

  reconcile(store, {
    list: () => [
      {
        name: "x",
        terminalId: "term_fresh",
        agentStatus: "working",
        agent: "claude",
        cwd: "/wt/z",
        paneId: "p",
        tabId: "t",
        workspaceId: "w",
      },
    ],
  } as any);

  const out = store.get(s.id);
  expect(out?.status).toBe("running");
  expect(out?.herdrAgentId).toBe("term_fresh"); // adopted the new id
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/reconcile.test.ts`
Expected: FAIL — session marked `done` and `herdrAgentId` still `term_stale` (current terminalId-only lookup misses).

- [ ] **Step 3: Rewrite `reconcile()` to use `matchAgent` + adopt**

Replace the entire body of `src/reconcile.ts` with:

```ts
import type { SessionStore } from "./store";
import { mapState, matchAgent, type HerdrDriver } from "./herdr";

export function reconcile(store: SessionStore, herdr: Pick<HerdrDriver, "list">): void {
  const agents = herdr.list();
  for (const s of store.list({ activeOnly: true })) {
    const agent = matchAgent(s, agents);
    if (!agent) store.update(s.id, { status: "done", lastState: "done" });
    else
      store.update(s.id, {
        status: mapState(agent.agentStatus),
        lastState: agent.agentStatus,
        herdrAgentId: agent.terminalId, // re-point if the daemon reassigned it (no-op when same)
      });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./test/reconcile.test.ts`
Expected: PASS (new test + the existing "marks gone as done" / "running" tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/reconcile.ts test/reconcile.test.ts
git commit -m "fix(reconcile): adopt live agent by cwd, re-point stale terminalId on boot"
```

---

### Task 3: `StatusPoller.tick()` adopts live agents (self-heal mid-session)

**Files:**
- Modify: `src/poller.ts` (`tick` + `reconcileAgent`)
- Test: `test/poller.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/poller.test.ts`:

```ts
test("tick adopts a resurrected agent by cwd, re-points the id, emits, and does NOT reap", () => {
  const store = new SessionStore(":memory:");
  const s = store.create({ ...baseSession, worktreePath: "/wt", herdrAgentId: "term_stale" });
  const emitted: { id: string; status: string }[] = [];

  const agents: HerdrAgent[] = [
    {
      agent: "claude",
      agentStatus: "working",
      cwd: "/wt",
      paneId: "p",
      tabId: "t",
      name: "x",
      terminalId: "term_fresh",
      workspaceId: "w",
    },
  ];

  const poller = new StatusPoller(
    store,
    { list: () => agents, read: () => "" } as any,
    (id, status) => emitted.push({ id, status }),
    () => {},
  );

  poller.tick();
  const out = store.get(s.id);
  expect(out?.herdrAgentId).toBe("term_fresh"); // adopted, not reaped
  expect(out?.status).toBe("running");
  expect(emitted).toContainEqual({ id: s.id, status: "running" });
});

test("tick reaps when neither terminalId nor cwd matches a live agent", () => {
  const store = new SessionStore(":memory:");
  const s = store.create({ ...baseSession, worktreePath: "/wt", herdrAgentId: "term_stale" });

  const poller = new StatusPoller(
    store,
    { list: () => [], read: () => "" } as any,
    () => {},
    () => {},
  );

  poller.tick();
  expect(store.get(s.id)?.status).toBe("done");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./test/poller.test.ts`
Expected: FIRST test FAILS — current `byTerm.get(s.herdrAgentId)` misses `term_stale`, so `reapGone` sets `done` and id stays `term_stale`. (Second test already passes.)

- [ ] **Step 3a: Switch `tick()` to the matcher**

In `src/poller.ts`, update the import line (add `matchAgent`):

```ts
import { mapState, matchAgent, type HerdrDriver, type HerdrAgent } from "./herdr";
```

Replace the `tick()` body:

```ts
  tick(): void {
    const agents = this.herdr.list();
    const activeIds = new Set<string>();
    for (const s of this.store.list({ activeOnly: true })) {
      activeIds.add(s.id);
      const agent = matchAgent(s, agents);
      if (!agent) this.reapGone(s);
      else this.reconcileAgent(s, agent);
    }
    this.pruneInactive(activeIds);
  }
```

- [ ] **Step 3b: Adopt the new terminalId inside `reconcileAgent`**

Replace the `reconcileAgent` method body so it persists + emits when the id changed, and uses the fresh id for downstream block/probe handling:

```ts
  /** Sync a live agent's status into the store and route its block/stall handling. */
  private reconcileAgent(s: Session, agent: HerdrAgent): void {
    const status = mapState(agent.agentStatus);
    const idChanged = agent.terminalId !== s.herdrAgentId;
    if (idChanged || status !== s.status || agent.agentStatus !== s.lastState) {
      this.store.update(s.id, {
        status,
        lastState: agent.agentStatus,
        ...(idChanged ? { herdrAgentId: agent.terminalId } : {}),
      });
      this.onChange(s.id, status); // nudge clients to re-attach the PTY to the fresh terminal
    }
    if (idChanged) s = { ...s, herdrAgentId: agent.terminalId };
    // There's a next action again → drop the manual "ready to merge" parking so
    // the row rejoins the active group. Sticky otherwise (idle/done keep it).
    if ((status === "running" || status === "blocked") && s.readyToMerge) {
      this.store.update(s.id, { readyToMerge: false });
      this.onReady(s.id, false);
    }
    if (status === "blocked") this.maybeClassify(s.id, s.herdrAgentId);
    else if (status === "running") this.maybeProbe(s);
    else this.clearBlock(s.id);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./test/poller.test.ts`
Expected: PASS (new adopt + reap tests, and all existing poller tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/poller.ts test/poller.test.ts
git commit -m "fix(poller): adopt resurrected agents by cwd instead of reaping them"
```

---

### Task 4: `SessionService.resume()` adopts instead of duplicate-spawning

**Files:**
- Modify: `src/service.ts` (`resume`)
- Test: `test/service.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/service.test.ts` (uses the existing `resumable` helper + `SessionStore` already imported in that file):

```ts
test("resume adopts a live agent found by cwd under a new terminalId — no duplicate spawn", () => {
  const store = new SessionStore(":memory:");
  let startCalls = 0;
  const svc = new SessionService({
    store,
    namer: async () => "x",
    worktree: { create: () => ({}) as any, remove: () => {} } as any,
    herdr: {
      start: () => {
        startCalls++;
        return { terminalId: "term_should_not_happen" } as any;
      },
      list: () => [
        {
          agent: "claude",
          agentStatus: "working",
          cwd: "/wt/x",
          name: "x",
          paneId: "p",
          tabId: "t",
          terminalId: "term_fresh",
          workspaceId: "w",
        },
      ],
      stop: () => {},
      send: () => {},
    } as any,
  });
  const s = resumable(store, { model: "opus" }); // worktreePath "/wt/x", herdrAgentId "term_old"

  const out = svc.resume(s.id);
  expect(startCalls).toBe(0); // agent already live → must NOT respawn
  expect(out?.herdrAgentId).toBe("term_fresh"); // adopted the new id
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/service.test.ts`
Expected: FAIL — current liveness check is terminalId-only, so it misses `term_fresh`, calls `herdr.start` (startCalls === 1) and re-points to `term_should_not_happen`.

- [ ] **Step 3: Use `matchAgent` in `resume()`**

In `src/service.ts`, add `matchAgent` to the herdr import (find the existing `from "./herdr"` import and include it). Then replace the liveness lines in `resume()`:

```ts
    const s = this.deps.store.get(id);
    if (!s || s.status === "archived" || !s.claudeSessionId) return null;
    const agent = matchAgent(s, this.deps.herdr.list());
    if (agent) {
      // Already live (idle at the prompt, or restored by a herdr restart under a new
      // terminalId). Adopt the fresh id if it drifted; never spawn a second claude.
      if (agent.terminalId !== s.herdrAgentId) {
        this.deps.store.update(id, { herdrAgentId: agent.terminalId });
        return this.deps.store.get(id);
      }
      return s;
    }
    const argv = ["claude", "--dangerously-skip-permissions", "--resume", s.claudeSessionId];
```

(Leave the rest of `resume()` — the argv build, `herdr.start`, and the post-spawn `store.update` — unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./test/service.test.ts`
Expected: PASS (new adopt test + the existing "respawns claude --resume" / "omits --model" tests still green — those use `list: () => []`, so they still spawn).

- [ ] **Step 5: Commit**

```bash
git add src/service.ts test/service.test.ts
git commit -m "fix(service): resume adopts a live agent by cwd, never double-spawns"
```

---

### Task 5: Full verification

**Files:** none (validation only)

- [ ] **Step 1: Lint**

Run: `bun run lint`
Expected: no errors.

- [ ] **Step 2: Full root test suite**

Run: `bun test ./test`
Expected: all green (no regressions in reconcile/poller/service/herdr or elsewhere).

- [ ] **Step 3: Type check**

Run: `bunx tsc --noEmit`
Expected: no errors.

---

## Notes for the implementer

- This is a **root-package** (server) change only — no `ui/` changes. The `session:status` event the poller already emits is what nudges the open UI to re-attach its PTY (the server resolves the terminal from `s.herdrAgentId` at attach time, so adopting the new id in the store is sufficient).
- `matchAgent` only ever sees **active** sessions (callers iterate `activeOnly` / `resume` guards on archived), and archived sessions' worktrees are removed, so a cwd collision with an archived session can't happen.
- Do not change worktree/cwd computation or the `claude --resume` argv — out of scope.
