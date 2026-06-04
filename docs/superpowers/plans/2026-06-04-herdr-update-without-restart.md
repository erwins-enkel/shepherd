# herdr update without a shepherd restart — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a herdr update without restarting shepherd, so the UI never 502s — shepherd pauses its herdr-touching loops during the update, runs it as a managed child, verifies success by re-reading the version, then resumes.

**Architecture:** A shared `maintenance` flag pauses every loop that shells out to herdr (so the 1s poller can't resurrect the herdr server mid-update) and makes the `HerdrDriver` runner fail fast. `HerdrUpdateService.apply()` spawns `herdr server stop; herdr update` as a tracked child, streams its output, awaits exit under a watchdog, determines success from a re-read `herdr --version` (not the lying exit code), emits a terminal result, and clears maintenance in `finally`. No `systemctl restart shepherd`, no `systemd-run`, no journalctl.

**Tech Stack:** Bun + TypeScript (root server), SvelteKit 5 + Paraglide i18n (`ui/`). Tests: `bun test ./test` (root), `cd ui && bun run test` (vitest).

**Spec:** `docs/superpowers/specs/2026-06-04-herdr-update-without-restart-design.md`

**Per-task gate:** after each task, run `bun run lint && bunx tsc --noEmit` (root) and the relevant test runner; commit only when green.

---

## Task 1: Maintenance gate singleton

**Files:**
- Create: `src/maintenance.ts`
- Test: `test/maintenance.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/maintenance.test.ts`:

```ts
import { test, expect } from "bun:test";
import { maintenance } from "../src/maintenance";

test("starts inactive", () => {
  expect(maintenance.active).toBe(false);
});

test("begin() activates, end() deactivates", () => {
  maintenance.begin();
  expect(maintenance.active).toBe(true);
  maintenance.end();
  expect(maintenance.active).toBe(false);
});

test("emits change only on an actual transition", () => {
  const seen: boolean[] = [];
  const off = maintenance.on("change", (v: boolean) => seen.push(v));
  maintenance.begin();
  maintenance.begin(); // already active → no second emit
  maintenance.end();
  maintenance.end(); // already inactive → no second emit
  off();
  expect(seen).toEqual([true, false]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/maintenance.test.ts`
Expected: FAIL — `Cannot find module "../src/maintenance"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/maintenance.ts`:

```ts
import { EventEmitter } from "node:events";

/**
 * Single source of truth for "herdr is mid-update — don't touch it." While
 * active, every periodic loop that shells out to herdr pauses (so the 1s poller
 * can't resurrect the herdr server between `herdr server stop` and `herdr
 * update`) and the HerdrDriver runner fails fast. Exactly one instance is shared
 * across the process. `on("change", fn)` returns an unsubscribe so callers don't
 * leak listeners.
 */
class HerdrMaintenance extends EventEmitter {
  private _active = false;
  get active(): boolean {
    return this._active;
  }
  begin(): void {
    if (this._active) return;
    this._active = true;
    this.emit("change", true);
  }
  end(): void {
    if (!this._active) return;
    this._active = false;
    this.emit("change", false);
  }
  /** Subscribe to active-state transitions; returns an unsubscribe fn. */
  on(event: "change", fn: (active: boolean) => void): () => void {
    super.on(event, fn);
    return () => void super.off(event, fn);
  }
}

export const maintenance = new HerdrMaintenance();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/maintenance.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/maintenance.ts test/maintenance.test.ts
git commit -m "feat(herdr-update): shared maintenance gate"
```

---

## Task 2: Harden the HerdrDriver runner (timeout + maintenance fail-fast)

**Files:**
- Modify: `src/herdr.ts:1-28`
- Test: `test/herdr.test.ts` (append)

The runner currently has no timeout (a hung herdr CLI freezes Bun's single thread) and runs even mid-update (resurrecting the server). Add a timeout and a fail-fast when maintenance is active.

- [ ] **Step 1: Write the failing test**

Append to `test/herdr.test.ts`:

```ts
import { maintenance } from "../src/maintenance";
import { HerdrUnavailableError, makeHerdrRunner } from "../src/herdr";

test("runner throws fast (no spawn) while maintenance is active", () => {
  let spawned = 0;
  const runner = makeHerdrRunner(() => {
    spawned++;
    return "{}";
  });
  maintenance.begin();
  try {
    expect(() => runner(["agent", "list"])).toThrow(HerdrUnavailableError);
    expect(spawned).toBe(0); // never reached the exec
  } finally {
    maintenance.end();
  }
});

test("runner delegates to exec when maintenance is inactive", () => {
  const runner = makeHerdrRunner(() => "ok");
  expect(runner(["agent", "list"])).toBe("ok");
});
```

> Note on imports: if `test/herdr.test.ts` already imports from `bun:test`, do not re-import `test`/`expect`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/herdr.test.ts`
Expected: FAIL — `makeHerdrRunner` / `HerdrUnavailableError` not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/herdr.ts`, replace the top of the file (lines 1-28) so the runner is built by an exported factory that injects the raw exec (keeps it unit-testable) and enforces both the maintenance gate and a timeout:

```ts
import { execFileSync } from "node:child_process";
import { config } from "./config";
import { maintenance } from "./maintenance";
import type { HerdrState, SessionStatus } from "./types";

// … (HerdrAgent / HerdrTab interfaces unchanged) …

export type Runner = (args: string[]) => string;

/** A herdr CLI call attempted while an update is in flight. Thrown WITHOUT
 *  spawning, so nothing resurrects the herdr server mid-update. */
export class HerdrUnavailableError extends Error {
  constructor() {
    super("herdr is unavailable (update in progress)");
    this.name = "HerdrUnavailableError";
  }
}

/** Hard ceiling on any synchronous herdr CLI call. `execFileSync` blocks Bun's
 *  single JS thread, so an unbounded call against a half-down server would freeze
 *  every HTTP response (the persistent-502 we are fixing). 10s is far above a
 *  healthy call yet bounds the worst case. */
const HERDR_TIMEOUT_MS = 10_000;

/** Build a Runner around a raw exec fn. Refuses (throws) while maintenance is
 *  active; otherwise delegates. Exported so tests can inject a fake exec. */
export function makeHerdrRunner(exec: (args: string[]) => string): Runner {
  return (args) => {
    if (maintenance.active) throw new HerdrUnavailableError();
    return exec(args);
  };
}

const defaultRunner: Runner = makeHerdrRunner((args) =>
  execFileSync(config.herdrBin, args, { encoding: "utf8", timeout: HERDR_TIMEOUT_MS }),
);
```

Leave the rest of `herdr.ts` (the `HerdrAgent`/`HerdrTab` interfaces, `mapState`, `HerdrDriver`) unchanged — `HerdrDriver`'s constructor still defaults to `defaultRunner`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/herdr.test.ts`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/herdr.ts test/herdr.test.ts
git commit -m "feat(herdr): runner timeout + fail-fast during maintenance"
```

---

## Task 3: Pause the status poller during maintenance

**Files:**
- Modify: `src/poller.ts:1-6,34-44`
- Test: `test/poller.test.ts` (append; create if absent)

If the poller ran during maintenance it would call `herdr.list()` (resurrecting the server) and, worse, see every agent "gone" and reap all live sessions. Guard the tick.

- [ ] **Step 1: Write the failing test**

Append to `test/poller.test.ts` (if the file doesn't exist, create it with a `bun:test` import header):

```ts
import { test, expect } from "bun:test";
import { StatusPoller } from "../src/poller";
import { maintenance } from "../src/maintenance";

test("tick() is a no-op while maintenance is active (no herdr call, no reap)", () => {
  let listCalls = 0;
  const store = {
    list: () => {
      throw new Error("store.list must not be reached during maintenance");
    },
  } as unknown as import("../src/store").SessionStore;
  const herdr = {
    list: () => {
      listCalls++;
      return [];
    },
    read: () => "",
  };
  const poller = new StatusPoller(
    store,
    herdr,
    () => {},
    () => {},
  );
  maintenance.begin();
  try {
    poller.tick();
    expect(listCalls).toBe(0);
  } finally {
    maintenance.end();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test ./test/poller.test.ts`
Expected: FAIL — `store.list must not be reached` (tick currently calls `herdr.list()` then `store.list`).

- [ ] **Step 3: Write minimal implementation**

In `src/poller.ts` add the import (top of file, after the existing imports):

```ts
import { maintenance } from "./maintenance";
```

Then guard `tick()`:

```ts
  tick(): void {
    // herdr is mid-update: don't poll — a list() here would resurrect the herdr
    // server and (seeing no agents) wrongly reap every live session.
    if (maintenance.active) return;
    const byTerm = new Map(this.herdr.list().map((a) => [a.terminalId, a]));
    const activeIds = new Set<string>();
    for (const s of this.store.list({ activeOnly: true })) {
      activeIds.add(s.id);
      const agent = byTerm.get(s.herdrAgentId);
      if (!agent) this.reapGone(s);
      else this.reconcileAgent(s, agent);
    }
    this.pruneInactive(activeIds);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test ./test/poller.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/poller.ts test/poller.test.ts
git commit -m "feat(poller): pause polling during herdr maintenance"
```

---

## Task 4: Pause the other herdr-touching interval loops

**Files:**
- Modify: `src/index.ts` (the `sweepOrphanTabs` body ~line 94; the `setInterval` callbacks for review ~208, drain ~311, distiller ~322; the `calibrate` body ~345)

These loops shell out to herdr on a timer. The driver's fail-fast (Task 2) already prevents resurrection, but guarding the ticks avoids needless throws/log-noise and any unhandled rejection from a loop that doesn't catch. One-line guards only. No new tests — verified by `tsc` + the manual smoke in Task 8.

- [ ] **Step 1: Add the import**

At the top of `src/index.ts`, alongside the other `./` imports, add:

```ts
import { maintenance } from "./maintenance";
```

- [ ] **Step 2: Guard `sweepOrphanTabs`**

In the `sweepOrphanTabs` arrow (currently starting `const sweepOrphanTabs = () => {`), make the first line of the body:

```ts
const sweepOrphanTabs = () => {
  if (maintenance.active) return;
  try {
    const closed = reapOrphanTabs(herdr);
    if (closed.length) console.warn(`[tabs] reaped ${closed.length} orphan helper tab(s)`);
  } catch (err) {
    console.warn("[tabs] orphan sweep failed:", err);
  }
};
```

- [ ] **Step 3: Guard the review / drain / distiller interval ticks**

Replace these three `setInterval` lines:

```ts
setInterval(() => void reviewService.tick(), 15_000);
```
with
```ts
setInterval(() => {
  if (maintenance.active) return;
  void reviewService.tick();
}, 15_000);
```

```ts
setInterval(() => void drain.tick().catch((err) => console.warn("[drain] tick:", err)), 30_000);
```
with
```ts
setInterval(() => {
  if (maintenance.active) return;
  void drain.tick().catch((err) => console.warn("[drain] tick:", err));
}, 30_000);
```

```ts
setInterval(() => void distiller.tick(), 30_000);
```
with
```ts
setInterval(() => {
  if (maintenance.active) return;
  void distiller.tick();
}, 30_000);
```

- [ ] **Step 4: Guard `calibrate`**

Make the first line of the `calibrate` body (`const calibrate = async () => {`) return early:

```ts
const calibrate = async () => {
  if (maintenance.active) return;
  try {
    await accountIndex.refresh(Date.now());
    const ok = await usageLimits.calibrate(Date.now());
    if (ok) events.emit("usage:limits", usageLimits.limits(Date.now()));
  } catch (err) {
    console.warn("[usage] calibration failed:", err);
  }
};
```

- [ ] **Step 5: Verify it compiles**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat(loops): pause herdr-touching sweeps during maintenance"
```

---

## Task 5: Rewrite `HerdrUpdateService.apply()` as a managed child (no restart)

**Files:**
- Modify: `src/herdr-update.ts` (whole file: trim `buildUpdateScript`, drop `defaultLaunch`/`defaultFollow`, rewrite deps + `apply()`)
- Rewrite: `test/herdr-update.test.ts` (replace the restart/launch/follow tests)

This is the core change. `apply()` returns `{ started }` immediately (the endpoint answers 202) and runs the update in the background: spawn `herdr server stop; herdr update`, stream output, await exit under a 5-min watchdog, decide success by re-reading `herdr --version`, emit a terminal result, and **always** clear maintenance in `finally`.

- [ ] **Step 1: Rewrite the tests first**

Replace the entire contents of `test/herdr-update.test.ts` with:

```ts
import { test, expect } from "bun:test";
import {
  HerdrUpdateService,
  buildUpdateScript,
  compareSemver,
  UPDATE_LOG_PREFIX,
  type HerdrUpdateResult,
} from "../src/herdr-update";

const LOG = "/home/op/.shepherd/herdr-update.log";

// ── buildUpdateScript: stop → update, NO restart, durable audit log ──────────
test("buildUpdateScript: stops herdr then updates, in that order", () => {
  const s = buildUpdateScript(LOG, "0.6.5", "0.6.6");
  const stop = s.indexOf("herdr server stop");
  const update = s.indexOf("herdr update;");
  expect(stop).toBeGreaterThanOrEqual(0);
  expect(update).toBeGreaterThan(stop);
});

test("buildUpdateScript: never restarts shepherd or shells systemd", () => {
  const s = buildUpdateScript(LOG, "0.6.5", "0.6.6");
  expect(s).not.toContain("systemctl");
  expect(s).not.toContain("systemd-run");
  expect(s).not.toContain("restart shepherd");
});

test("buildUpdateScript: echoes a greppable marker for the two real steps", () => {
  const s = buildUpdateScript(LOG, "0.6.5", "0.6.6");
  const markers = s.split("\n").filter((l) => l.includes(UPDATE_LOG_PREFIX));
  // stopping / running / exited rc = 3 markers (no restart markers anymore)
  expect(markers.length).toBe(3);
  expect(s).toContain(`${UPDATE_LOG_PREFIX} herdr update exited rc=$rc`);
});

test("buildUpdateScript: appends a delimited, timestamped, versioned block", () => {
  const s = buildUpdateScript(LOG, "0.6.5", "0.6.6");
  expect(s).toContain(`LOG='${LOG}'`);
  expect(s).toContain('| tee -a "$LOG"');
  expect(s).toContain("=== herdr-update $(date -u +%Y-%m-%dT%H:%M:%SZ) 0.6.5 -> 0.6.6 ===");
  expect(s).toContain('mkdir -p "$(dirname "$LOG")"');
});

test("buildUpdateScript: sanitizes versions so a payload can't inject shell", () => {
  const s = buildUpdateScript(LOG, "0.6.5", '0.6.6"; rm -rf ~ #');
  expect(s).not.toContain("rm -rf");
  expect(s).toContain("0.6.5 -> 0.6.6 ===");
});

test("buildUpdateScript: missing versions degrade to 'unknown'", () => {
  const s = buildUpdateScript(LOG, null, undefined);
  expect(s).toContain("unknown -> unknown ===");
});

// ── compareSemver ────────────────────────────────────────────────────────────
test("compareSemver: orders numerically", () => {
  expect(compareSemver("0.6.5", "0.6.3")).toBe(1);
  expect(compareSemver("0.6.3", "0.6.5")).toBe(-1);
  expect(compareSemver("0.10.0", "0.9.0")).toBe(1);
  expect(compareSemver("0.6", "0.6.0")).toBe(0);
});

// ── check(): unchanged behavior ──────────────────────────────────────────────
test("current < latest → updateAvailable true, notes carried", async () => {
  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.5.10\n",
    fetchLatest: async () => ({ version: "0.6.5", notes: "### Added\n- scrollback" }),
  });
  const s = await svc.check(1000);
  expect(s.current).toBe("0.5.10");
  expect(s.latest).toBe("0.6.5");
  expect(s.updateAvailable).toBe(true);
  expect(s.notes).toBe("### Added\n- scrollback");
});

test("current == latest → updateAvailable false", async () => {
  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.6.5",
    fetchLatest: async () => ({ version: "0.6.5" }),
  });
  const s = await svc.check(2000);
  expect(s.updateAvailable).toBe(false);
});

test("versionRunner throws → fail-safe, no badge, error set", async () => {
  const svc = new HerdrUpdateService({
    versionRunner: () => {
      throw new Error("herdr: command not found");
    },
    fetchLatest: async () => ({ version: "0.6.5" }),
  });
  const s = await svc.check(4000);
  expect(s.updateAvailable).toBe(false);
  expect(s.error).toContain("command not found");
});

// ── apply(): maintenance lifecycle, success/failure detection ─────────────────

/** Build a service primed with a known current→latest, injecting all seams so
 *  no real process spawns. `runUpdate` resolves immediately by default. */
function primed(opts: {
  installedAfter: string; // what `herdr --version` reports AFTER the update
  latest?: string;
  current?: string;
  runUpdate?: (onLine: (l: string) => void, signal: AbortSignal) => Promise<void>;
  watchdogMs?: number;
}) {
  const begun: boolean[] = [];
  const dones: HerdrUpdateResult[] = [];
  let versionCalls = 0;
  const svc = new HerdrUpdateService({
    // first call (during check) returns `current`; later calls return installedAfter
    versionRunner: () => {
      versionCalls++;
      return `herdr ${versionCalls === 1 ? (opts.current ?? "0.6.7") : opts.installedAfter}`;
    },
    fetchLatest: async () => ({ version: opts.latest ?? "0.6.8" }),
    runUpdate: opts.runUpdate ?? (async () => {}),
    onLog: () => {},
    onStatus: () => {},
    onDone: (r) => dones.push(r),
    maintenance: {
      begin: () => begun.push(true),
      end: () => begun.push(false),
    },
    watchdogMs: opts.watchdogMs ?? 300_000,
  });
  return { svc, begun, dones };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

test("apply(): success when re-read version equals target; maintenance begins then ends", async () => {
  const { svc, begun, dones } = primed({ installedAfter: "0.6.8", latest: "0.6.8" });
  await svc.check(1); // sets current=0.6.7, latest=0.6.8, updateAvailable
  expect(svc.apply()).toEqual({ started: true });
  await settle();
  expect(begun).toEqual([true, false]); // begin, then end
  expect(dones).toHaveLength(1);
  expect(dones[0]).toMatchObject({ ok: true, to: "0.6.8" });
});

test("apply(): failure when version unchanged even though the child exits 0 (rc lies)", async () => {
  const { svc, begun, dones } = primed({ installedAfter: "0.6.7", latest: "0.6.8" });
  await svc.check(1); // current=0.6.7
  svc.apply();
  await settle();
  expect(dones[0]).toMatchObject({ ok: false });
  expect(begun).toEqual([true, false]); // maintenance still cleared
});

test("apply(): maintenance is cleared even when runUpdate throws", async () => {
  const { svc, begun, dones } = primed({
    installedAfter: "0.6.8",
    runUpdate: async () => {
      throw new Error("spawn failed");
    },
  });
  await svc.check(1);
  svc.apply();
  await settle();
  expect(begun).toEqual([true, false]);
  expect(dones[0]).toMatchObject({ ok: false, error: expect.stringContaining("spawn failed") });
});

test("apply(): watchdog aborts a hung update and clears maintenance", async () => {
  const { svc, begun, dones } = primed({
    installedAfter: "0.6.7",
    watchdogMs: 20,
    runUpdate: (_onLine, signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  });
  await svc.check(1);
  svc.apply();
  await new Promise((r) => setTimeout(r, 60));
  expect(begun).toEqual([true, false]);
  expect(dones[0]).toMatchObject({ ok: false });
});

test("apply(): double-launch guarded while one is in flight", async () => {
  let runs = 0;
  const { svc } = primed({
    installedAfter: "0.6.8",
    runUpdate: async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 30));
    },
  });
  await svc.check(1);
  expect(svc.apply()).toEqual({ started: true });
  expect(svc.apply()).toEqual({ started: false }); // still applying
  await new Promise((r) => setTimeout(r, 60));
  expect(runs).toBe(1);
});

test("apply(): streams runUpdate lines to onLog", async () => {
  const received: string[] = [];
  const svc = new HerdrUpdateService({
    versionRunner: () => "herdr 0.6.8",
    fetchLatest: async () => ({ version: "0.6.8" }),
    runUpdate: async (onLine) => {
      onLine("downloading 0.6.8...");
      onLine("updated to 0.6.8");
    },
    onLog: (l) => received.push(l),
    maintenance: { begin: () => {}, end: () => {} },
  });
  await svc.check(1);
  svc.apply();
  await settle();
  expect(received).toEqual(["downloading 0.6.8...", "updated to 0.6.8"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test ./test/herdr-update.test.ts`
Expected: FAIL — `HerdrUpdateResult` not exported; `runUpdate`/`onStatus`/`onDone`/`maintenance`/`watchdogMs` deps unknown; old behavior mismatches.

- [ ] **Step 3: Rewrite `src/herdr-update.ts`**

Apply these changes:

(a) Imports — drop nothing, keep `spawn`, add the maintenance + status type:

```ts
import { execFileSync, spawn } from "node:child_process";
import { config } from "./config";
import { maintenance as sharedMaintenance } from "./maintenance";
import type { HerdrUpdateStatus } from "./types";

export type { HerdrUpdateStatus };
```

(b) Keep `compareSemver`, `sanitizeVersion`, `SEMVER_RE`, `LATEST_URL`, `UPDATE_LOG_PREFIX` as-is.

(c) Replace `buildUpdateScript` with the trimmed version (no restart, 3 markers, tee kept):

```ts
export function buildUpdateScript(
  logPath: string,
  from?: string | null,
  to?: string | null,
): string {
  const f = sanitizeVersion(from);
  const t = sanitizeVersion(to);
  const q = `'${logPath.replace(/'/g, "'\\''")}'`;
  // Shepherd stays up during the update (no restart), so it captures this
  // script's stdout live for the modal. The `tee -a` is kept anyway: it makes
  // `cat <logPath>` a durable post-mortem that survives even a shepherd crash.
  return [
    `LOG=${q}`,
    'mkdir -p "$(dirname "$LOG")"',
    "{",
    `  echo "=== herdr-update $(date -u +%Y-%m-%dT%H:%M:%SZ) ${f} -> ${t} ==="`,
    `  echo '${UPDATE_LOG_PREFIX} stopping herdr server'`,
    "  herdr server stop || true",
    `  echo '${UPDATE_LOG_PREFIX} running herdr update'`,
    "  herdr update; rc=$?",
    `  echo "${UPDATE_LOG_PREFIX} herdr update exited rc=$rc"`,
    '} 2>&1 | tee -a "$LOG"',
  ].join("\n");
}
```

(d) Add the result type, just above the deps interface:

```ts
/** Terminal outcome of an apply(), emitted once via onDone. Drives the modal's
 *  ✓/✗ state. Success is decided by a re-read `herdr --version`, NOT the child's
 *  exit code (`herdr update` exits 0 even when it prints "Herdr was not updated"). */
export interface HerdrUpdateResult {
  ok: boolean;
  from: string | null;
  to: string | null;
  error?: string;
}
```

(e) Replace `HerdrUpdateDeps` with:

```ts
export interface HerdrUpdateDeps {
  /** inject point for tests; defaults to running the herdr binary's --version */
  versionRunner?: () => string;
  /** inject point for tests; defaults to fetching herdr.dev/latest.json */
  fetchLatest?: () => Promise<{ version: string; notes?: string }>;
  /**
   * Run the update child, streaming each output line to onLine, resolving when
   * it exits. The AbortSignal fires on watchdog timeout — the default kills the
   * child. Default: spawn `bash -lc <buildUpdateScript>`.
   */
  runUpdate?: (onLine: (line: string) => void, signal: AbortSignal) => Promise<void>;
  /** each log line streamed from the running update; default: no-op */
  onLog?: (line: string) => void;
  /** the recomputed status after the update settles; default: no-op */
  onStatus?: (status: HerdrUpdateStatus) => void;
  /** the terminal result, emitted exactly once per apply(); default: no-op */
  onDone?: (result: HerdrUpdateResult) => void;
  /** maintenance gate; defaults to the shared process singleton */
  maintenance?: { begin(): void; end(): void };
  /** watchdog ceiling before a hung `herdr update` is force-killed (default 5min) */
  watchdogMs?: number;
}
```

(f) In the class, replace the `launch`/`follow` fields + their constructor wiring with the new deps, and delete `defaultLaunch` and `defaultFollow` entirely. The new field block + constructor:

```ts
export class HerdrUpdateService {
  private versionRunner: () => string;
  private fetchLatest: () => Promise<{ version: string; notes?: string }>;
  private runUpdate: (onLine: (line: string) => void, signal: AbortSignal) => Promise<void>;
  private onLog: (line: string) => void;
  private onStatus: (status: HerdrUpdateStatus) => void;
  private onDone: (result: HerdrUpdateResult) => void;
  private maintenance: { begin(): void; end(): void };
  private watchdogMs: number;
  private last: HerdrUpdateStatus | null = null;
  private applying = false;

  constructor(deps: HerdrUpdateDeps = {}) {
    this.versionRunner =
      deps.versionRunner ??
      (() => execFileSync(config.herdrBin, ["--version"], { encoding: "utf8" }));
    this.fetchLatest =
      deps.fetchLatest ??
      (() =>
        fetch(LATEST_URL).then((r) => r.json() as Promise<{ version: string; notes?: string }>));
    this.runUpdate = deps.runUpdate ?? ((onLine, signal) => this.defaultRunUpdate(onLine, signal));
    this.onLog = deps.onLog ?? (() => {});
    this.onStatus = deps.onStatus ?? (() => {});
    this.onDone = deps.onDone ?? (() => {});
    this.maintenance = deps.maintenance ?? sharedMaintenance;
    this.watchdogMs = deps.watchdogMs ?? 5 * 60 * 1000;
  }
```

(g) Add the default child runner (replaces `defaultLaunch`/`defaultFollow`). Reuses the old line-buffering logic but over the child's own pipes:

```ts
  /** Spawn `bash -lc <script>` in shepherd's own process tree (NOT detached —
   *  there is no longer a shepherd restart to outlive), stream stdout+stderr to
   *  onLine, resolve on exit. The signal (watchdog) force-kills a hung child. */
  private defaultRunUpdate(
    onLine: (line: string) => void,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve) => {
      const script = buildUpdateScript(
        config.herdrUpdateLogPath,
        this.last?.current,
        this.last?.latest,
      );
      const child = spawn("bash", ["-lc", script], { stdio: ["ignore", "pipe", "pipe"] });
      const kill = () => child.kill("SIGKILL");
      if (signal.aborted) kill();
      else signal.addEventListener("abort", kill, { once: true });

      let buf = "";
      const handleChunk = (chunk: Buffer | string) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trimEnd();
          if (trimmed) onLine(trimmed);
        }
      };
      child.stdout?.on("data", handleChunk);
      child.stderr?.on("data", handleChunk);
      const finish = () => {
        signal.removeEventListener("abort", kill);
        if (buf.trim()) onLine(buf.trim());
        resolve();
      };
      child.on("exit", finish);
      child.on("error", (err) => {
        onLine(`herdr update spawn failed: ${err.message}`);
        finish();
      });
    });
  }

  /** Parse the installed version from `herdr --version`; null if unreadable. */
  private installedVersion(): string | null {
    const m = SEMVER_RE.exec(this.versionRunner());
    return m ? m[1]! : null;
  }
```

(h) Replace `apply()` (and remove the old `current()` doc references to follow/launch only — `current()` itself stays) with:

```ts
  /** Last computed status, or null before the first check. */
  current(): HerdrUpdateStatus | null {
    return this.last;
  }

  /** Kick off the update in the background. Returns immediately so the HTTP
   *  endpoint can answer 202; progress streams via onLog and the terminal
   *  outcome via onDone. Guards against a double-launch while one is in flight. */
  apply(): { started: boolean } {
    if (this.applying) return { started: false };
    this.applying = true;
    console.warn(
      `[herdr-update] applying ${this.last?.current ?? "?"} -> ${this.last?.latest ?? "?"}; ` +
        `Shepherd stays up (audit log: ${config.herdrUpdateLogPath})`,
    );
    this.maintenance.begin();
    void this.runOnce();
    return { started: true };
  }

  /** Background body of apply(): run the update under a watchdog, decide success
   *  from a re-read version, emit status + a terminal result, and ALWAYS clear
   *  maintenance + the applying guard in finally. */
  private async runOnce(): Promise<void> {
    const from = this.last?.current ?? null;
    const to = this.last?.latest ?? null;
    const ctrl = new AbortController();
    const watchdog = setTimeout(() => ctrl.abort(), this.watchdogMs);
    let result: HerdrUpdateResult;
    try {
      await this.runUpdate((line) => this.onLog(line), ctrl.signal);
      if (ctrl.signal.aborted) {
        result = { ok: false, from, to, error: "herdr update timed out" };
      } else {
        const after = this.installedVersion();
        const ok = !!after && !!to && after === to;
        this.last = {
          current: after ?? from,
          latest: to,
          updateAvailable: !!after && !!to && compareSemver(to, after) > 0,
          notes: null,
          checkedAt: Date.now(),
          error: ok ? undefined : "herdr was not updated",
        };
        this.onStatus(this.last);
        result = ok
          ? { ok: true, from, to }
          : { ok: false, from, to: after ?? to, error: "herdr was not updated" };
      }
    } catch (err) {
      result = {
        ok: false,
        from,
        to,
        error: err instanceof Error ? err.message : "herdr update failed",
      };
    } finally {
      clearTimeout(watchdog);
      this.maintenance.end();
      this.applying = false;
    }
    this.onDone(result);
  }

  // … check() stays exactly as it is …
```

Keep `check()` unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test ./test/herdr-update.test.ts`
Expected: PASS (all rewritten tests).

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors. (If `index.ts` errors because it passes `onLog` only — that's fine, all deps are optional; wiring happens in Task 6.)

- [ ] **Step 6: Commit**

```bash
git add src/herdr-update.ts test/herdr-update.test.ts
git commit -m "feat(herdr-update): managed-child update, no shepherd restart"
```

---

## Task 6: Wire the new events in index.ts and forward the result

**Files:**
- Modify: `src/index.ts:368-370` (HerdrUpdateService construction)

`apply()` now emits a recomputed status and a terminal result through callbacks. Wire them to the event hub. The SSE bridge (`server.ts:1737`) already forwards every event generically, and `EventHub.emit` takes any string, so no server change is needed.

- [ ] **Step 1: Update the construction**

Replace:

```ts
const herdrUpdates = new HerdrUpdateService({
  onLog: (line) => events.emit("herdr-update:log", { line }),
});
```

with:

```ts
const herdrUpdates = new HerdrUpdateService({
  onLog: (line) => events.emit("herdr-update:log", { line }),
  // shepherd stays up now — push the recomputed status (clears the badge) and a
  // terminal ✓/✗ result the modal renders instead of waiting for a page reload.
  onStatus: (status) => events.emit("herdr-update:status", status),
  onDone: (result) => events.emit("herdr-update:done", result),
});
```

- [ ] **Step 2: Update the stale comment above it**

The comment at `src/index.ts:364-367` says applying "restarts the herdr server and bounces every live session." Update the last clause to reflect that shepherd no longer restarts:

```ts
// watch herdr.dev for a newer herdr release and surface an informational badge;
// unlike the git self-update this never auto-applies. Applying ends live agent
// panes (herdr update is destructive) but shepherd stays up — no restart, no 502.
// releases are rare, so a 6h cadence is plenty.
```

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the full root test suite**

Run: `bun test ./test`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(herdr-update): emit status + terminal result events"
```

---

## Task 7: UI — terminal result state, corrected copy, i18n

**Files:**
- Modify: `ui/src/lib/store.svelte.ts:25-26,153-158` (new `herdrUpdateDone` state + event case)
- Modify: `ui/src/routes/+page.svelte:743-753` (pass `done`, reset on close/open)
- Modify: `ui/src/lib/components/HerdrUpdateModal.svelte` (render terminal state; corrected copy)
- Modify: `ui/messages/en.json` and `ui/messages/de.json` (new keys + corrected strings)

- [ ] **Step 1: Add the store state + event handler**

In `ui/src/lib/store.svelte.ts`, near the existing herdr fields (lines 25-26):

```ts
  herdrUpdate = $state<HerdrUpdateStatus | null>(null);
  herdrUpdateLog = $state<string[]>([]);
  herdrUpdateDone = $state<{ ok: boolean; from: string | null; to: string | null; error?: string } | null>(null);
```

In the event switch (after the `herdr-update:log` case at line 157):

```ts
      case "herdr-update:done":
        this.herdrUpdateDone = ev.data as {
          ok: boolean;
          from: string | null;
          to: string | null;
          error?: string;
        };
        break;
```

- [ ] **Step 2: Pass `done` + reset it in the page**

In `ui/src/routes/+page.svelte`, the modal block (lines 743-753) becomes:

```svelte
{#if showHerdrUpdate && store.herdrUpdate && (store.herdrUpdate.updateAvailable || herdrUpdating)}
  <HerdrUpdateModal
    update={store.herdrUpdate}
    sessions={store.sessions.filter((s) => s.status === "running").length}
    log={store.herdrUpdateLog}
    done={store.herdrUpdateDone}
    onconfirm={() => {
      herdrUpdating = true;
      store.herdrUpdateDone = null; // fresh run: clear any prior result
      store.herdrUpdateLog = [];
    }}
    onclose={() => {
      showHerdrUpdate = false;
      herdrUpdating = false;
      store.herdrUpdateDone = null;
    }}
  />
{/if}
```

- [ ] **Step 3: Render the terminal state in the modal**

In `ui/src/lib/components/HerdrUpdateModal.svelte`:

Add `done` to the props block:

```ts
  let {
    update,
    sessions = 0,
    log = [],
    done = null,
    onconfirm,
    onclose,
  }: {
    update: HerdrUpdateStatus;
    sessions?: number;
    log?: string[];
    done?: { ok: boolean; from: string | null; to: string | null; error?: string } | null;
    onconfirm?: () => void;
    onclose?: () => void;
  } = $props();
```

Change `busy` so a finished result drops out of the busy state and re-enables closing:

```ts
  // Busy only while the update is in flight; a terminal `done` result ends it so
  // the operator can read the ✓/✗ outcome and close. (No page reload anymore —
  // shepherd stays up, so the modal must resolve itself.)
  const busy = $derived(submitting && !done);
```

Replace the busy/status block (the `{#if busy} … {/if}` region that renders `herdrupdate_busy` and the log) with one that also renders the terminal result:

```svelte
    {#if submitting}
      {#if done}
        <div class="status" class:ok={done.ok} class:fail={!done.ok} aria-live="polite">
          {#if done.ok}
            {m.herdrupdate_done_ok({ latest: done.to ?? update.latest ?? "" })}
          {:else}
            {m.herdrupdate_done_fail({ current: done.to ?? update.current ?? "" })}
          {/if}
        </div>
      {:else}
        <div class="status" aria-live="polite">{m.herdrupdate_busy()}</div>
      {/if}
      {#if log.length > 0}
        <div class="log-label micro">{m.herdrupdate_log_label()}</div>
        <pre class="log" bind:this={logEl}>{log.join("\n")}</pre>
      {/if}
    {/if}
```

Add to the actions block a Close button once done (so the user can dismiss the finished modal even though `onconfirm` set submitting):

```svelte
    <div class="actions">
      {#if done}
        <button type="button" class="later" onclick={() => onclose?.()}>{m.common_close()}</button>
      {:else if !busy}
        <button type="button" class="later" onclick={() => onclose?.()}
          >{m.herdrupdate_later()}</button
        >
      {/if}
      {#if !done}
        <button type="button" class="run" onclick={confirm} disabled={busy}>
          {sessions > 0 ? m.herdrupdate_confirm({ count: sessions }) : m.herdrupdate_confirm_plain()}
        </button>
      {/if}
    </div>
```

Add result colors to the `.status` style:

```css
  .status {
    color: var(--color-amber);
    font-size: 12px;
  }
  .status.ok {
    color: var(--color-green, var(--color-amber));
  }
  .status.fail {
    color: var(--color-red);
  }
```

Update the stale comment above `busy` (currently "…then restarts shepherd; the store auto-reconnects once the new build is live"):

```ts
  // herdr update restarts the herdr server (ending live panes) but shepherd
  // stays up — no reload. The modal resolves itself via the `done` result.
```

- [ ] **Step 4: Add/repair i18n keys (EN + DE — parity gate)**

In `ui/messages/en.json`, replace the two stale strings and add two keys:

```json
  "herdrupdate_instructions": "Updating restarts the herdr server and ends live agent panes. Shepherd keeps running — no page reload.",
  "herdrupdate_busy": "Updating… the herdr server is restarting and live panes will end. Shepherd stays up.",
  "herdrupdate_done_ok": "Updated to {latest}. Live panes ended; Shepherd stayed up.",
  "herdrupdate_done_fail": "Update did not complete — still on {current}. Check the log; you can retry.",
```

In `ui/messages/de.json`, the matching set:

```json
  "herdrupdate_instructions": "Das Update startet den herdr-Server neu und beendet laufende Agent-Panes. Shepherd läuft weiter – kein Neuladen der Seite.",
  "herdrupdate_busy": "Aktualisiere… der herdr-Server startet neu und laufende Panes enden. Shepherd bleibt aktiv.",
  "herdrupdate_done_ok": "Auf {latest} aktualisiert. Laufende Panes beendet; Shepherd blieb aktiv.",
  "herdrupdate_done_fail": "Update nicht abgeschlossen – weiterhin auf {current}. Prüfe das Log; du kannst es erneut versuchen.",
```

> Keep the keys positioned next to the existing `herdrupdate_*` block in both files. Both files must end up with the identical key set (the `check:i18n` gate enforces this).

- [ ] **Step 5: Verify the UI**

Run: `cd ui && bun run check && bun run check:i18n`
Expected: both pass (no type errors, catalogs in parity).

- [ ] **Step 6: Run UI tests**

Run: `cd ui && bun run test`
Expected: PASS. (If a `HerdrUpdateModal` component test asserts old copy, update its expectation to the new strings.)

- [ ] **Step 7: Commit**

```bash
git add ui/src/lib/store.svelte.ts ui/src/routes/+page.svelte ui/src/lib/components/HerdrUpdateModal.svelte ui/messages/en.json ui/messages/de.json
git commit -m "feat(ui): herdr-update terminal result + no-restart copy"
```

---

## Task 8: Full verification + manual smoke

**Files:** none (verification only)

- [ ] **Step 1: Root checks**

Run: `bun run lint && bunx tsc --noEmit && bun test ./test`
Expected: all green.

- [ ] **Step 2: UI checks**

Run: `cd ui && bun install && bun run check && bun run check:i18n && bun run test`
Expected: all green.

- [ ] **Step 3: Grep for leftover restart coupling**

Run: `grep -rn "restart shepherd\|systemd-run\|herdr-update -f\|systemctl --user restart shepherd" src/`
Expected: no matches in `src/herdr-update.ts` (the only legitimate remaining `systemctl restart` is in `deploy/update.sh`, the git self-update — out of scope).

- [ ] **Step 4: Confirm the maintenance gate is reachable from every herdr loop**

Run: `grep -rn "maintenance.active" src/`
Expected: matches in `herdr.ts` (runner), `poller.ts` (tick), and `index.ts` (sweepOrphanTabs, review, drain, distiller, calibrate).

- [ ] **Step 5: Manual smoke (optional, only if a real herdr update is pending)**

This is destructive (ends live agent panes). Only run when no important agents are live. From the UI, open the herdr-update modal and click Update. Observe:
- The UI does **not** 502 at any point (shepherd stays up).
- The log streams `>>> herdr-update: stopping herdr server` → `running herdr update` → `exited rc=…`.
- The modal resolves to ✓ "Updated to X" (or ✗ "still on Y" with a retry hint).
- `cat ~/.shepherd/herdr-update.log` shows the appended block.
- `herdr status` shows server + client on the new version.

- [ ] **Step 6: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "test(herdr-update): verification fixes"
```

---

## Notes for the executor

- **i18n is mandatory** — every new user-facing string must exist in BOTH `en.json` and `de.json` with the same key (the `check:i18n` gate fails otherwise).
- **Branch hygiene** — this branch is cut from `main`; rebase (never merge) if main moves. Run `bun install` per package after a rebase.
- **Out of scope** — do not touch `deploy/update.sh`; its `systemctl restart shepherd` is the git self-update (new shepherd code) and is correct.
- **Why success is keyed off the version, not rc** — `herdr update` exits 0 even when it prints "Herdr was not updated"; trusting rc is the original bug.
