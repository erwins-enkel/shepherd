import { describe, expect, it } from "bun:test";
import { ReadyNotifier, READY_DWELL_MS, READY_WARMUP_MS } from "../src/ready-notify";
import type { ReadyNotifierDeps } from "../src/ready-notify";
import type { Session } from "../src/types";
import type { NotifyInput } from "../src/push";

// Minimal Session stub — the fake `isReady` ignores the contents, so only `id`/`name` matter.
function sess(id: string): Session {
  return { id, name: id } as Session;
}

interface Harness {
  notifier: ReadyNotifier;
  notifyCalls: NotifyInput[];
  set: (...ids: string[]) => void;
  advance: (ms: number) => void;
  setSessions: (...ids: string[]) => void;
  setReducedMode: (on: boolean) => void;
  setNotifyResult: (ok: boolean) => void;
  now: () => number;
}

function makeHarness(opts?: { sessions?: string[]; ready?: string[] }): Harness {
  let t = 1_000_000;
  let reduced = true;
  let notifyResult = true;
  const readyIds = new Set<string>(opts?.ready ?? []);
  let sessionIds = new Set<string>(opts?.sessions ?? []);
  const notifyCalls: NotifyInput[] = [];

  const deps: ReadyNotifierDeps = {
    listSessions: () => [...sessionIds].map(sess),
    workingBlocked: () => ({}),
    gitSnapshot: () => ({}),
    reviewingIds: () => [],
    notify: async (input) => {
      notifyCalls.push(input);
      return notifyResult;
    },
    reducedMode: () => reduced,
    now: () => t,
    isReady: (s) => readyIds.has(s.id),
  };

  return {
    notifier: new ReadyNotifier(deps),
    notifyCalls,
    set: (...ids) => {
      readyIds.clear();
      for (const id of ids) readyIds.add(id);
    },
    advance: (ms) => {
      t += ms;
    },
    setSessions: (...ids) => {
      sessionIds = new Set(ids);
    },
    setReducedMode: (on) => {
      reduced = on;
    },
    setNotifyResult: (ok) => {
      notifyResult = ok;
    },
    now: () => t,
  };
}

const readyCalls = (h: Harness) => h.notifyCalls.filter((c) => c.kind === "ready");

describe("ReadyNotifier", () => {
  it("exports the documented constants", () => {
    expect(READY_DWELL_MS).toBe(5000);
    expect(READY_WARMUP_MS).toBe(15000);
  });

  it("seed/boot grace: a session already ready at arm never fires", async () => {
    const h = makeHarness({ sessions: ["a"], ready: ["a"] });
    await h.notifier.tick(); // arm tick — seeds "a" as notified, no fire
    expect(readyCalls(h).length).toBe(0);
    // Even after dwell + warm-up elapse it must stay silent (seeded notified).
    h.advance(READY_WARMUP_MS + READY_DWELL_MS + 1000);
    await h.notifier.tick();
    await h.notifier.tick();
    expect(readyCalls(h).length).toBe(0);
  });

  it("new entrant fires exactly once after warm-up + dwell", async () => {
    const h = makeHarness({ sessions: ["a"], ready: [] });
    await h.notifier.tick(); // arm tick (nothing ready → nothing seeded)
    // Satisfy warm-up first (firstSeen baseline was set on arm tick).
    h.advance(READY_WARMUP_MS + 1);
    h.set("a"); // now ready → dwell starts this tick
    await h.notifier.tick();
    expect(readyCalls(h).length).toBe(0); // dwell not met
    h.advance(READY_DWELL_MS + 1);
    await h.notifier.tick();
    expect(readyCalls(h).length).toBe(1);
    expect(readyCalls(h)[0]).toMatchObject({ kind: "ready", sessionId: "a", tag: "ready:a" });
    // Further ticks: no repeat.
    await h.notifier.tick();
    await h.notifier.tick();
    expect(readyCalls(h).length).toBe(1);
  });

  it("dwell: <5s no fire, crossing 5s one fire (warm-up already met)", async () => {
    const h = makeHarness({ sessions: ["a"], ready: [] });
    await h.notifier.tick(); // arm
    h.advance(READY_WARMUP_MS + 1); // warm-up satisfied
    h.set("a");
    await h.notifier.tick(); // dwell starts
    h.advance(READY_DWELL_MS - 1);
    await h.notifier.tick();
    expect(readyCalls(h).length).toBe(0);
    h.advance(2);
    await h.notifier.tick();
    expect(readyCalls(h).length).toBe(1);
  });

  it("warm-up: a session leaving before warm-up never fires", async () => {
    const h = makeHarness({ sessions: ["a"], ready: [] });
    await h.notifier.tick(); // arm, firstSeen("a") = now
    h.set("a"); // ready immediately
    await h.notifier.tick(); // dwell starts
    h.advance(READY_DWELL_MS + 1); // dwell met but warm-up NOT met
    await h.notifier.tick();
    expect(readyCalls(h).length).toBe(0); // warm-up gate holds
    h.set(); // leaves the ready set before warm-up elapses
    await h.notifier.tick();
    h.advance(READY_WARMUP_MS);
    await h.notifier.tick();
    expect(readyCalls(h).length).toBe(0);
  });

  it("warm-up: ready does not fire until warm-up elapses even with dwell met", async () => {
    const h = makeHarness({ sessions: ["a"], ready: [] });
    await h.notifier.tick(); // arm
    h.set("a");
    await h.notifier.tick(); // dwell starts
    h.advance(READY_DWELL_MS + 1); // dwell met, warm-up not
    await h.notifier.tick();
    expect(readyCalls(h).length).toBe(0);
    h.advance(READY_WARMUP_MS); // now warm-up met too
    await h.notifier.tick();
    expect(readyCalls(h).length).toBe(1);
  });

  it("send-gating: notify=false (focused) defers, never drops; flips to fire once", async () => {
    const h = makeHarness({ sessions: ["a"], ready: [] });
    h.setNotifyResult(false);
    await h.notifier.tick(); // arm
    h.advance(READY_WARMUP_MS + 1);
    h.set("a");
    await h.notifier.tick(); // dwell starts
    h.advance(READY_DWELL_MS + 1);
    await h.notifier.tick();
    await h.notifier.tick();
    // notify called but returned false → notified stays false → keeps trying.
    expect(readyCalls(h).length).toBeGreaterThanOrEqual(2);
    const callsBefore = readyCalls(h).length;
    // Flip to focused-off → real send.
    h.setNotifyResult(true);
    await h.notifier.tick();
    expect(readyCalls(h).length).toBe(callsBefore + 1);
    // Now notified → no more calls.
    await h.notifier.tick();
    expect(readyCalls(h).length).toBe(callsBefore + 1);
  });

  it("re-entry: leaving and re-entering restarts the dwell", async () => {
    const h = makeHarness({ sessions: ["a"], ready: [] });
    await h.notifier.tick(); // arm
    h.advance(READY_WARMUP_MS + 1); // warm-up satisfied for life
    h.set("a");
    await h.notifier.tick(); // dwell starts
    h.advance(READY_DWELL_MS - 1);
    h.set(); // leaves before firing → entry deleted
    await h.notifier.tick();
    expect(readyCalls(h).length).toBe(0);
    h.set("a"); // re-enters → fresh dwell
    await h.notifier.tick();
    h.advance(READY_DWELL_MS - 1);
    await h.notifier.tick();
    expect(readyCalls(h).length).toBe(0); // fresh dwell not yet met
    h.advance(2);
    await h.notifier.tick();
    expect(readyCalls(h).length).toBe(1);
  });

  it("mode off: never fires; toggling off mid-dwell re-seeds (no fire) on re-enable", async () => {
    const h = makeHarness({ sessions: ["a"], ready: ["a"] });
    h.setReducedMode(false);
    await h.notifier.tick();
    h.advance(READY_WARMUP_MS + READY_DWELL_MS + 1000);
    await h.notifier.tick();
    expect(readyCalls(h).length).toBe(0);

    // Turn on → arm tick seeds "a" (already ready) as notified.
    h.setReducedMode(true);
    await h.notifier.tick();
    h.advance(READY_WARMUP_MS + READY_DWELL_MS + 1000);
    await h.notifier.tick();
    expect(readyCalls(h).length).toBe(0);

    // Mid-flight: a NEW session arrives and reaches ready, mid-dwell, then mode toggles off.
    h.setSessions("a", "b");
    h.set("a", "b");
    await h.notifier.tick(); // b dwell starts
    h.advance(READY_DWELL_MS - 1);
    h.setReducedMode(false); // clears state mid-dwell
    await h.notifier.tick();
    h.setReducedMode(true); // re-arm → re-seed b (ready) as notified
    await h.notifier.tick();
    h.advance(READY_WARMUP_MS + READY_DWELL_MS + 1000);
    await h.notifier.tick();
    expect(readyCalls(h).length).toBe(0); // re-seeded, must not fire
  });

  it("prunes dwell/firstSeen for sessions that disappear", async () => {
    const h = makeHarness({ sessions: ["a"], ready: [] });
    await h.notifier.tick(); // arm
    h.advance(READY_WARMUP_MS + 1);
    h.set("a");
    await h.notifier.tick(); // dwell for a
    h.setSessions(); // a disappears
    h.set();
    await h.notifier.tick();
    // a comes back as a brand-new session → warm-up restarts (firstSeen pruned).
    h.setSessions("a");
    h.set("a");
    await h.notifier.tick(); // firstSeen(a)=now, dwell starts
    h.advance(READY_DWELL_MS + 1); // dwell met but fresh warm-up not
    await h.notifier.tick();
    expect(readyCalls(h).length).toBe(0);
  });
});
