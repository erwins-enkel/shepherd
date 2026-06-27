import { test, expect } from "bun:test";
import { SessionRouter, type SessionConsumer } from "../src/session-router";
import type { SessionStateChange, SnapshotAccessors } from "../src/session-snapshot";
import type { Session } from "../src/types";
import type { GitState } from "../src/forge/types";

// ── fixtures ──────────────────────────────────────────────────────────────────

function makeSession(id: string, repoPath: string): Session {
  return { id, repoPath } as unknown as Session;
}

const GIT_STATE: GitState = {
  kind: "github",
  state: "open",
  checks: "success",
  deployConfigured: false,
};

/** Counting accessor — records how many times getSession was read. */
function countingAcc(session: Session | null): SnapshotAccessors & { calls: number } {
  const acc = {
    calls: 0,
    getSession(): Session | null {
      acc.calls++;
      return session;
    },
  };
  return acc;
}

/** A consumer that records its handle start/finish in a shared log. */
function recordingConsumer(name: string, log: string[]): SessionConsumer {
  return {
    name,
    async handle(): Promise<void> {
      log.push(`${name}:start`);
      log.push(`${name}:finish`);
    },
  };
}

// A manually-controlled deferred so ordering is proven deterministically, not by timing.
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ── 1. Ordering / serialization (the key test) ────────────────────────────────

test("autopilot handle starts only after drain handle fully resolves (onGit)", async () => {
  const log: string[] = [];
  const gate = deferred();

  const drain: SessionConsumer = {
    name: "drain",
    async handle(): Promise<void> {
      log.push("drain:start");
      await gate.promise; // block until the test releases it
      log.push("drain:finish");
    },
  };
  const autopilot: SessionConsumer = {
    name: "autopilot",
    async handle(): Promise<void> {
      log.push("autopilot:start");
    },
  };

  const router = new SessionRouter({ getSession: () => makeSession("s1", "/r") }, [
    drain,
    autopilot,
  ]);

  const done = router.onGit("s1", GIT_STATE);

  // Let microtasks flush: drain has started and is parked on the deferred.
  await Promise.resolve();
  await Promise.resolve();
  expect(log).toEqual(["drain:start"]);
  // Autopilot must NOT have started while drain is still unresolved.
  expect(log).not.toContain("autopilot:start");

  // Release drain — only now may autopilot begin.
  gate.resolve();
  await done;

  expect(log).toEqual(["drain:start", "drain:finish", "autopilot:start"]);
});

test("autopilot handle starts only after drain handle fully resolves (onStatus)", async () => {
  const log: string[] = [];
  const gate = deferred();

  const drain: SessionConsumer = {
    name: "drain",
    async handle(): Promise<void> {
      log.push("drain:start");
      await gate.promise;
      log.push("drain:finish");
    },
  };
  const autopilot: SessionConsumer = {
    name: "autopilot",
    async handle(): Promise<void> {
      log.push("autopilot:start");
    },
  };

  const router = new SessionRouter({ getSession: () => makeSession("s1", "/r") }, [
    drain,
    autopilot,
  ]);

  const done = router.onStatus("s1", "idle");
  await Promise.resolve();
  await Promise.resolve();
  expect(log).toEqual(["drain:start"]);
  expect(log).not.toContain("autopilot:start");

  gate.resolve();
  await done;

  expect(log).toEqual(["drain:start", "drain:finish", "autopilot:start"]);
});

// ── 2. Single build per call ──────────────────────────────────────────────────

test("getSession is called exactly once per onStatus even with two consumers", async () => {
  const log: string[] = [];
  const acc = countingAcc(makeSession("s1", "/r"));
  const router = new SessionRouter(acc, [
    recordingConsumer("drain", log),
    recordingConsumer("autopilot", log),
  ]);
  await router.onStatus("s1", "idle");
  expect(acc.calls).toBe(1);
});

test("getSession is called exactly once per onGit even with two consumers", async () => {
  const log: string[] = [];
  const acc = countingAcc(makeSession("s1", "/r"));
  const router = new SessionRouter(acc, [
    recordingConsumer("drain", log),
    recordingConsumer("autopilot", log),
  ]);
  await router.onGit("s1", GIT_STATE);
  expect(acc.calls).toBe(1);
});

// ── 3. Unknown session ────────────────────────────────────────────────────────

test("unknown session (getSession null) calls no consumer and no hooks", async () => {
  const log: string[] = [];
  let settled = 0;
  const router = new SessionRouter(
    { getSession: () => null },
    [recordingConsumer("drain", log), recordingConsumer("autopilot", log)],
    { onStatusSettled: () => settled++ },
  );
  await router.onStatus("missing", "idle");
  await router.onGit("missing", GIT_STATE);
  expect(log).toEqual([]);
  expect(settled).toBe(0);
});

// ── 4. Failure isolation ──────────────────────────────────────────────────────

test("a throwing first consumer is caught; second consumer and settled hook still run", async () => {
  const log: string[] = [];
  const warnings: string[] = [];
  let settled = 0;

  const failing: SessionConsumer = {
    name: "drain",
    async handle(): Promise<void> {
      log.push("drain:start");
      throw new Error("boom");
    },
  };

  const router = new SessionRouter(
    { getSession: () => makeSession("s1", "/r") },
    [failing, recordingConsumer("autopilot", log)],
    { onStatusSettled: () => settled++ },
    (msg) => warnings.push(msg),
  );

  // Must not throw.
  await router.onStatus("s1", "idle");

  expect(log).toEqual(["drain:start", "autopilot:start", "autopilot:finish"]);
  expect(settled).toBe(1);
  expect(warnings.some((w) => w.includes("drain"))).toBe(true);
});

// ── 5. Settled hook ordering ───────────────────────────────────────────────────

test("onStatus fires the settled hook after the consumer chain", async () => {
  const log: string[] = [];
  const gate = deferred();

  const slow: SessionConsumer = {
    name: "drain",
    async handle(): Promise<void> {
      log.push("consumer:start");
      await gate.promise;
      log.push("consumer:finish");
    },
  };

  const router = new SessionRouter({ getSession: () => makeSession("s1", "/r") }, [slow], {
    onStatusSettled: () => log.push("settled"),
  });

  const done = router.onStatus("s1", "idle");
  await Promise.resolve();
  await Promise.resolve();
  // Settled has NOT fired yet — the chain is still parked on the deferred.
  expect(log).toEqual(["consumer:start"]);

  gate.resolve();
  await done;
  expect(log).toEqual(["consumer:start", "consumer:finish", "settled"]);
});

test("onGit invokes the settled hook never", async () => {
  const log: string[] = [];
  const router = new SessionRouter(
    { getSession: () => makeSession("s1", "/r") },
    [recordingConsumer("drain", log)],
    {
      onStatusSettled: () => log.push("settled"),
    },
  );
  await router.onGit("s1", GIT_STATE);
  expect(log).toEqual(["drain:start", "drain:finish"]);
});

// ── 6. Same snapshot object reaches both consumers (identity) ──────────────────

test("the same snapshot object instance reaches every consumer (not rebuilt)", async () => {
  const seen: SessionStateChange[] = [];
  const capture = (name: string): SessionConsumer => ({
    name,
    async handle(change): Promise<void> {
      seen.push(change);
    },
  });
  const router = new SessionRouter({ getSession: () => makeSession("s1", "/r") }, [
    capture("drain"),
    capture("autopilot"),
  ]);
  await router.onGit("s1", GIT_STATE);
  expect(seen.length).toBe(2);
  expect(seen[0]).toBe(seen[1]); // identical change object
  expect(seen[0]!.snapshot).toBe(seen[1]!.snapshot); // identical snapshot
});
