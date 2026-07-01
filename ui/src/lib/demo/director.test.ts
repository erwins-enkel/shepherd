import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { director } from "./director";
import { demoState } from "./state";
import { bus } from "./bus";
import { ptyStream } from "./pty/stream";
import type { WsEvent } from "$lib/types";

/** Collect every bus frame emitted from subscription time until `unsub()`. */
function collectBus() {
  const frames: WsEvent[] = [];
  const unsub = bus.subscribe((ev) => frames.push(ev));
  return { frames, unsub };
}

/** Collect every PTY byte push for `id` until `unsub()`. */
function collectPty(id: string) {
  const bytes: string[] = [];
  const unsub = ptyStream.subscribe(id, (b) => bytes.push(b));
  return { bytes, unsub };
}

const idsOf = (frames: WsEvent[], event: string) =>
  frames
    .filter((f) => f.event === event)
    .map((f) => (f.data as { id?: string }).id)
    .filter((x): x is string => typeof x === "string");

beforeEach(() => {
  vi.useFakeTimers();
  demoState.reset();
});

afterEach(() => {
  director.stopAll();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("director ambient liveness", () => {
  it("emits evolving session:activity + PTY bytes for WORKING sessions only", () => {
    const { frames, unsub } = collectBus();
    const coupon = collectPty("coupon");
    const child = collectPty("checkout-child");
    const rounding = collectPty("rounding"); // READY, not working
    const ogimg = collectPty("ogimg"); // MERGING, not working

    director.start();
    vi.advanceTimersByTime(15_000);

    // Working sessions tick.
    expect(idsOf(frames, "session:activity")).toContain("coupon");
    expect(idsOf(frames, "session:activity")).toContain("checkout-child");
    expect(coupon.bytes.length).toBeGreaterThan(0);
    expect(child.bytes.length).toBeGreaterThan(0);

    // Activity evolves (lastActivityTs strictly grows across ticks for coupon).
    const couponActs = frames
      .filter((f) => f.event === "session:activity" && (f.data as { id: string }).id === "coupon")
      .map((f) => (f.data as { activity: { lastActivityTs: number } }).activity.lastActivityTs);
    expect(couponActs.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < couponActs.length; i++)
      expect(couponActs[i]).toBeGreaterThan(couponActs[i - 1]);

    // Non-working sessions get NO ambient loop.
    expect(idsOf(frames, "session:activity")).not.toContain("rounding");
    expect(rounding.bytes.length).toBe(0);
    expect(ogimg.bytes.length).toBe(0);

    unsub();
    coupon.unsub();
    child.unsub();
    rounding.unsub();
    ogimg.unsub();
  });

  it("start() is idempotent — a double call does not double-spin loops", () => {
    director.start();
    director.start();
    const { frames, unsub } = collectBus();

    // A doubled loop would fire two ticks at the SAME timestamp each interval; assert
    // every coupon tick has a distinct lastActivityTs (a single loop, not two).
    vi.advanceTimersByTime(15_000);
    const ts = frames
      .filter((f) => f.event === "session:activity" && (f.data as { id: string }).id === "coupon")
      .map((f) => (f.data as { activity: { lastActivityTs: number } }).activity.lastActivityTs);
    expect(ts.length).toBeGreaterThan(0);
    expect(new Set(ts).size).toBe(ts.length);

    unsub();
  });

  it("stopAll() clears everything — no further emits or pushes after teardown", () => {
    director.start();
    vi.advanceTimersByTime(10_000);

    director.stopAll();
    const { frames, unsub } = collectBus();
    const coupon = collectPty("coupon");
    vi.advanceTimersByTime(60_000);

    expect(frames.length).toBe(0);
    expect(coupon.bytes.length).toBe(0);

    unsub();
    coupon.unsub();
  });
});

describe("director mutation reactions", () => {
  it("merge → lands the PR (git merged + status + mergetrain:landed), bounded", () => {
    director.start();
    const { frames, unsub } = collectBus();

    demoState.mergePr("ogimg");
    vi.advanceTimersByTime(20_000);

    expect(idsOf(frames, "session:git")).toContain("ogimg");
    expect(idsOf(frames, "session:status")).toContain("ogimg");
    expect(frames.some((f) => f.event === "mergetrain:landed")).toBe(true);
    expect(demoState.gitState("ogimg")?.state).toBe("merged");

    // No infinite re-trigger: landed frames are bounded even over a long advance.
    const landedBefore = frames.filter((f) => f.event === "mergetrain:landed").length;
    vi.advanceTimersByTime(120_000);
    const landedAfter = frames.filter((f) => f.event === "mergetrain:landed").length;
    expect(landedAfter).toBe(landedBefore);

    unsub();
  });

  it("merge → also posts the recap payoff (session:recap), matching world.recaps", () => {
    director.start();
    const { frames, unsub } = collectBus();

    demoState.mergePr("ogimg");
    vi.advanceTimersByTime(20_000);

    const recapFrames = frames.filter((f) => f.event === "session:recap");
    expect(recapFrames.length).toBe(1);
    const emitted = (recapFrames[0].data as { id: string; recap: unknown }).recap;
    expect(emitted).toBeTruthy();
    expect(demoState.recaps()["ogimg"]).toEqual(emitted);

    // Landing again doesn't stack/duplicate the recap — content survives a re-land unchanged.
    demoState.mergePr("ogimg");
    vi.advanceTimersByTime(20_000);
    expect(demoState.recaps()["ogimg"]).toEqual(emitted);

    unsub();
  });

  it("plan-gate release → session starts working (status running + ambient begins)", () => {
    // authstore is PLAN-GATE awaiting Go; approve the gate so release is permitted.
    const gate = demoState.planGates()["authstore"];
    if (gate) gate.approved = true;

    director.start();
    const { frames, unsub } = collectBus();
    const term = collectPty("authstore");

    demoState.releasePlanGate("authstore");
    vi.advanceTimersByTime(15_000);

    expect(idsOf(frames, "session:status")).toContain("authstore");
    // Ambient now drives authstore: activity ticks + terminal bytes appear.
    expect(idsOf(frames, "session:activity")).toContain("authstore");
    expect(term.bytes.length).toBeGreaterThan(0);

    unsub();
    term.unsub();
  });

  it("steer/reply → agent responds with terminal lines + activity, then settles", () => {
    director.start();
    const term = collectPty("coupon");
    const before = term.bytes.length;

    demoState.reply("coupon", "also handle the expired-code path");
    vi.advanceTimersByTime(8_000);

    expect(term.bytes.length).toBeGreaterThan(before);

    term.unsub();
  });

  it("reply resuming a held session (neon) keeps ticking via ambient, not just the burst", () => {
    director.start();
    const { frames, unsub } = collectBus();
    const term = collectPty("neon");

    demoState.reply("neon", "use option B — keep the read replica");
    vi.advanceTimersByTime(3_000); // let the one-shot burst + settle fire

    const activityAfterBurst = idsOf(frames, "session:activity").filter(
      (id) => id === "neon",
    ).length;
    const bytesAfterBurst = term.bytes.length;
    expect(activityAfterBurst).toBeGreaterThan(0);
    expect(bytesAfterBurst).toBeGreaterThan(0);

    // Advance well past the burst window — an ambient loop (not a one-shot) keeps
    // emitting session:activity + PTY bytes for neon.
    vi.advanceTimersByTime(15_000);
    const activityLater = idsOf(frames, "session:activity").filter((id) => id === "neon").length;
    expect(activityLater).toBeGreaterThan(activityAfterBurst);
    expect(term.bytes.length).toBeGreaterThan(bytesAfterBurst);

    unsub();
    term.unsub();
  });

  it("answering plan questions on a PLANNING session (authstore) skips the code-editing burst and ambient", () => {
    director.start();
    const { frames, unsub } = collectBus();
    const term = collectPty("authstore");

    demoState.answerPlanQuestions("authstore");
    vi.advanceTimersByTime(15_000);

    // No code-editing terminal lines — the plan-answer reaction is not the steer burst.
    expect(term.bytes.some((b) => b.includes("apply.ts"))).toBe(false);
    expect(term.bytes.some((b) => b.includes("folding that into the current change"))).toBe(false);

    // Not treated as "working" — no ambient loop spun up for authstore.
    const activityCount = idsOf(frames, "session:activity").filter(
      (id) => id === "authstore",
    ).length;
    vi.advanceTimersByTime(15_000);
    const activityCountLater = idsOf(frames, "session:activity").filter(
      (id) => id === "authstore",
    ).length;
    expect(activityCountLater).toBe(activityCount);

    unsub();
    term.unsub();
  });

  it("epic advance → spawns the next child session and drives it", () => {
    director.start();
    const { frames, unsub } = collectBus();

    demoState.approveEpicNext("/demo/acme/storefront", 100);
    vi.advanceTimersByTime(15_000);

    const spawned = frames
      .filter((f) => f.event === "session:new")
      .map((f) => (f.data as { id: string }).id);
    expect(spawned.length).toBeGreaterThan(0);
    const child = spawned[0];
    // The freshly spawned child gets ambient activity.
    expect(idsOf(frames, "session:activity")).toContain(child);

    unsub();
  });

  it("spawn-from-held → drives the newly spawned session", () => {
    director.start();
    const { frames, unsub } = collectBus();

    const held = demoState.held()[0];
    const session = demoState.spawnHeld(held.id);
    expect(session).not.toBeNull();
    const sid = session!.id;
    const term = collectPty(sid);

    vi.advanceTimersByTime(15_000);

    expect(idsOf(frames, "session:activity")).toContain(sid);
    expect(term.bytes.length).toBeGreaterThan(0);

    unsub();
    term.unsub();
  });
});

describe("director archive stops the ambient loop", () => {
  it("archiving a working session stops its loop — no further activity/PTY for that id", () => {
    director.start();
    const { frames, unsub } = collectBus();
    const coupon = collectPty("coupon");

    vi.advanceTimersByTime(5_000);
    expect(coupon.bytes.length).toBeGreaterThan(0);

    demoState.archiveSession("coupon");
    const activityBefore = idsOf(frames, "session:activity").filter((id) => id === "coupon").length;
    const bytesBefore = coupon.bytes.length;

    vi.advanceTimersByTime(60_000);

    const activityAfter = idsOf(frames, "session:activity").filter((id) => id === "coupon").length;
    expect(activityAfter).toBe(activityBefore);
    expect(coupon.bytes.length).toBe(bytesBefore);

    unsub();
    coupon.unsub();
  });

  it("archiving a session with no ambient loop is a safe no-op", () => {
    director.start();
    expect(() => demoState.archiveSession("rounding")).not.toThrow();
    expect(() => demoState.archiveSession("does-not-exist")).not.toThrow();
  });
});

describe("director reset integration", () => {
  it("reset stops old timers and restarts ambient for the re-seeded working set", () => {
    director.start();
    vi.advanceTimersByTime(10_000);

    const { frames, unsub } = collectBus();
    demoState.reset();
    vi.advanceTimersByTime(12_000);

    // Fresh ambient runs post-reset.
    expect(idsOf(frames, "session:activity")).toContain("coupon");

    // No double-emit from leaked pre-reset timers: coupon ticks carry distinct
    // timestamps (a leaked+fresh loop would fire two ticks at the same instant).
    const { frames: f2, unsub: u2 } = collectBus();
    vi.advanceTimersByTime(15_000);
    const ts = f2
      .filter((f) => f.event === "session:activity" && (f.data as { id: string }).id === "coupon")
      .map((f) => (f.data as { activity: { lastActivityTs: number } }).activity.lastActivityTs);
    expect(ts.length).toBeGreaterThan(0);
    expect(new Set(ts).size).toBe(ts.length);

    unsub();
    u2();
  });
});
