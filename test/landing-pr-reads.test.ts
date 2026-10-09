/**
 * Unit tests for LandingPrReads (src/landing-pr-reads.ts, #2873): the drain's shared,
 * fingerprint-gated read of an epic landing PR.
 */
import { test, expect, describe } from "bun:test";
import { LANDING_PR_RECHECK_MS, LandingPrReads, landingPrSettled } from "../src/landing-pr-reads";
import type { GitForge, OpenPrSnapshot, PrStatus } from "../src/forge/types";

const REPO = "/repo";
const BRANCH = "epic/7-landing";
const TICK_MS = 30_000;

function pr(over: Partial<PrStatus> = {}): PrStatus {
  return {
    state: "open",
    number: 9,
    checks: "success",
    mergeable: true,
    mergeStateStatus: "blocked",
    headSha: "h1",
    deployConfigured: false,
    ...over,
  };
}

interface Harness {
  reads: LandingPrReads;
  forge: GitForge;
  calls: () => number;
  setStatus: (s: PrStatus | Error) => void;
  setKey: (k: string | null) => void;
  setNow: (ms: number) => void;
  setSnapshot: (s: { at: number; value: OpenPrSnapshot } | null) => void;
  /** Hold every prStatus call until the promise settles (null = answer at once). */
  setGate: (g: Promise<void> | null) => void;
  /** One drain tick: begin, then read. */
  tick: () => Promise<PrStatus>;
}

function harness(opts: { fork?: boolean; snapshot?: boolean } = {}): Harness {
  let now = 0;
  let key: string | null = "k1";
  let status: PrStatus | Error = pr();
  let snapshot: { at: number; value: OpenPrSnapshot } | null = null;
  let gate: Promise<void> | null = null;
  let calls = 0;
  const forge = {
    kind: "github",
    slug: "o/r",
    isFork: opts.fork,
    prStatus: async () => {
      calls++;
      if (gate) await gate;
      if (status instanceof Error) throw status;
      return status;
    },
  } as unknown as GitForge;
  const reads = new LandingPrReads({
    now: () => now,
    freshness: () => key,
    snapshot: opts.snapshot === false ? undefined : { peekCurrent: () => snapshot },
  });
  return {
    reads,
    forge,
    calls: () => calls,
    setStatus: (s) => (status = s),
    setKey: (k) => (key = k),
    setNow: (ms) => (now = ms),
    setSnapshot: (s) => (snapshot = s),
    setGate: (g) => (gate = g),
    tick: () => {
      reads.beginTick();
      return reads.read(REPO, forge, BRANCH);
    },
  };
}

function snapshotWith(status: PrStatus): OpenPrSnapshot {
  return { prs: [], statuses: new Map([[BRANCH, status]]), capped: false };
}

describe("landingPrSettled", () => {
  test.each([
    ["blocked, checks done", pr(), false, true],
    ["clean", pr({ mergeStateStatus: "clean" }), false, true],
    ["unstable, red", pr({ checks: "failure", mergeStateStatus: "unstable" }), false, true],
    ["behind", pr({ mergeStateStatus: "behind" }), false, true],
    ["draft", pr({ mergeStateStatus: "draft", isDraft: true }), false, true],
    ["checks pending", pr({ checks: "pending" }), false, false],
    ["checks still running", pr({ checks: "failure", runningChecks: ["ci / test"] }), false, false],
    ["mergeability computing", pr({ mergeable: null }), false, false],
    ["merge state unknown", pr({ mergeStateStatus: "unknown" }), false, false],
    ["no checks yet in a CI repo", pr({ checks: "none" }), false, false],
    ["no checks in a no-CI repo", pr({ checks: "none" }), true, true],
    ["merged", pr({ state: "merged" }), false, false],
    ["closed", pr({ state: "closed" }), false, false],
    ["none", pr({ state: "none" }), false, false],
  ] as const)("%s", (_name, status, noCi, settled) => {
    expect(landingPrSettled(status, noCi)).toBe(settled);
  });
});

describe("LandingPrReads", () => {
  test("one read per tick: every pass of a tick shares one lookup", async () => {
    const h = harness();
    h.reads.beginTick();
    const a = await h.reads.read(REPO, h.forge, BRANCH);
    const b = await h.reads.read(REPO, h.forge, BRANCH);
    expect(a).toBe(b);
    expect(h.calls()).toBe(1);
  });

  test("one read per tick even when it fails; the next tick retries", async () => {
    const h = harness();
    h.setStatus(new Error("gh down"));
    h.reads.beginTick();
    await expect(h.reads.read(REPO, h.forge, BRANCH)).rejects.toThrow("gh down");
    await expect(h.reads.read(REPO, h.forge, BRANCH)).rejects.toThrow("gh down");
    expect(h.calls()).toBe(1);
    h.setStatus(pr());
    await h.tick();
    expect(h.calls()).toBe(2);
  });

  test("branches and repos are read separately", async () => {
    const h = harness();
    h.reads.beginTick();
    await h.reads.read(REPO, h.forge, BRANCH);
    await h.reads.read(REPO, h.forge, "epic/8-other");
    await h.reads.read("/other", h.forge, BRANCH);
    expect(h.calls()).toBe(3);
  });

  test("a settled PR is not read again while the fingerprint holds — 10 min of ticks", async () => {
    const h = harness({ snapshot: false });
    for (let t = 0; t <= 10 * 60_000; t += TICK_MS) {
      h.setNow(t);
      expect((await h.tick()).mergeStateStatus).toBe("blocked");
    }
    expect(h.calls()).toBe(1);
  });

  test("a settled PR is re-checked once LANDING_PR_RECHECK_MS has passed", async () => {
    const h = harness({ snapshot: false });
    await h.tick();
    h.setNow(LANDING_PR_RECHECK_MS - 1);
    await h.tick();
    expect(h.calls()).toBe(1);
    h.setNow(LANDING_PR_RECHECK_MS);
    await h.tick();
    expect(h.calls()).toBe(2);
  });

  test("a moved fingerprint means a fresh read on the next tick", async () => {
    const h = harness({ snapshot: false });
    await h.tick();
    h.setNow(TICK_MS);
    h.setKey("k2");
    h.setStatus(pr({ mergeStateStatus: "clean" }));
    expect((await h.tick()).mergeStateStatus).toBe("clean");
    expect(h.calls()).toBe(2);
  });

  test.each([
    ["running checks", pr({ checks: "pending", runningChecks: ["ci / test"] })],
    ["mergeability computing", pr({ mergeable: null })],
    ["a merged PR", pr({ state: "merged" })],
  ])("%s are read every tick", async (_name, status) => {
    const h = harness();
    h.setStatus(status);
    for (let i = 0; i < 3; i++) {
      h.setNow(i * TICK_MS);
      await h.tick();
    }
    expect(h.calls()).toBe(3);
  });

  test("without a fingerprint key nothing is reused across ticks", async () => {
    const h = harness();
    h.setKey(null);
    h.setSnapshot({ at: 0, value: snapshotWith(pr()) });
    await h.tick();
    h.setNow(TICK_MS);
    await h.tick();
    expect(h.calls()).toBe(2);
  });

  test("an own write forces a per-head read next tick; the tick's memo stays", async () => {
    const h = harness({ snapshot: false });
    await h.tick();
    h.setNow(TICK_MS);
    h.reads.invalidate(REPO, BRANCH);
    await h.reads.read(REPO, h.forge, BRANCH); // same tick: the pre-write view
    expect(h.calls()).toBe(1);
    h.setNow(2 * TICK_MS);
    await h.tick();
    expect(h.calls()).toBe(2);
    h.setNow(3 * TICK_MS);
    await h.tick(); // settled again, same key → reused
    expect(h.calls()).toBe(2);
  });

  test("a read racing an own write records nothing", async () => {
    const h = harness({ snapshot: false });
    let release!: () => void;
    h.setGate(new Promise<void>((r) => (release = r)));
    const read = h.tick();
    h.reads.invalidate(REPO, BRANCH); // a write lands while the read is in flight
    release();
    await read;
    h.setGate(null);
    h.setNow(TICK_MS);
    await h.tick();
    expect(h.calls()).toBe(2);
  });

  describe("open-PR snapshot", () => {
    test("a current snapshot holding the branch settled serves the read", async () => {
      const h = harness();
      h.setNow(60_000);
      h.setSnapshot({ at: 50_000, value: snapshotWith(pr({ mergeStateStatus: "clean" })) });
      expect((await h.tick()).mergeStateStatus).toBe("clean");
      expect(h.calls()).toBe(0);
    });

    test("a snapshot status is then reused like a read, timed from the snapshot's fetch", async () => {
      const h = harness();
      h.setSnapshot({ at: 0, value: snapshotWith(pr()) });
      await h.tick();
      h.setSnapshot(null);
      h.setNow(LANDING_PR_RECHECK_MS - 1);
      await h.tick();
      expect(h.calls()).toBe(0);
      h.setNow(LANDING_PR_RECHECK_MS);
      await h.tick();
      expect(h.calls()).toBe(1);
    });

    test("a snapshot fetched before the last read is not used", async () => {
      const h = harness();
      h.setKey(null);
      h.setNow(10_000);
      await h.tick(); // read at 10s, no key → not reusable
      h.setKey("k2");
      h.setNow(TICK_MS + 10_000);
      h.setSnapshot({ at: 5_000, value: snapshotWith(pr()) });
      await h.tick();
      expect(h.calls()).toBe(2);
    });

    test("a snapshot fetched before an own write is not used; one fetched after is", async () => {
      const h = harness();
      h.setStatus(pr({ checks: "failure" }));
      await h.tick();
      h.setNow(10_000);
      h.reads.invalidate(REPO, BRANCH); // e.g. the CI re-run
      h.setSnapshot({ at: 5_000, value: snapshotWith(pr({ checks: "failure" })) });
      h.setNow(TICK_MS);
      h.setStatus(pr({ checks: "pending" }));
      expect((await h.tick()).checks).toBe("pending");
      expect(h.calls()).toBe(2);
      h.setSnapshot({ at: TICK_MS + 1, value: snapshotWith(pr({ checks: "success" })) });
      h.setNow(2 * TICK_MS);
      expect((await h.tick()).checks).toBe("success");
      expect(h.calls()).toBe(2);
    });

    test.each([
      ["transient for the branch", { at: 0, value: snapshotWith(pr({ checks: "pending" })) }],
      [
        "older than LANDING_PR_RECHECK_MS",
        { at: -LANDING_PR_RECHECK_MS, value: snapshotWith(pr()) },
      ],
      ["without the branch", { at: 0, value: { prs: [], statuses: new Map(), capped: false } }],
    ])("a snapshot %s is not used", async (_name, snap) => {
      const h = harness();
      h.setSnapshot(snap as { at: number; value: OpenPrSnapshot });
      await h.tick();
      expect(h.calls()).toBe(1);
    });

    test("a fork-mode forge never uses the snapshot", async () => {
      const h = harness({ fork: true });
      h.setSnapshot({ at: 0, value: snapshotWith(pr()) });
      await h.tick();
      expect(h.calls()).toBe(1);
    });
  });
});
