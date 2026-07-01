import { test, expect } from "bun:test";
import {
  SessionLiveness,
  type LivenessOutcome,
  type TranscriptSignals,
} from "../src/session-liveness";
import { STRIP_WINDOW_MS } from "../src/activity-signal";
import { type StallConfig } from "../src/stall";

const STALL_CFG: StallConfig = { stallMs: 10_000, pendingStallMs: 20_000 };

/** Build a `SessionLiveness` with fake herdr reads. `readImpl`/`readAsyncImpl` default
 *  to throwing (unused in most tests) — pass what a given test needs. */
function makeLiveness(opts: {
  read?: (term: string, mode: string) => string;
  readAsync?: (term: string, mode: string) => Promise<string>;
  cfg?: StallConfig;
}) {
  return new SessionLiveness({
    read:
      opts.read ??
      (() => {
        throw new Error("unexpected sync read");
      }),
    readAsync: opts.readAsync ?? (() => Promise.reject(new Error("unexpected async read"))),
    stallCfg: () => opts.cfg ?? STALL_CFG,
  });
}

function transcriptSignals(lastTs: number, pending = false): TranscriptSignals {
  return { snapshot: { lastTs, pending }, activity: null };
}

async function resolve(
  step: { outcome: LivenessOutcome } | { pending: Promise<LivenessOutcome> },
): Promise<LivenessOutcome> {
  return "outcome" in step ? step.outcome : await step.pending;
}

// ── transcript path: fresh → moving → frozen ────────────────────────────────

test("transcript: not-stalled candidate clears broad (clearBroad)", () => {
  const live = makeLiveness({});
  let now = 1_700_000_000_000;
  // prime the transcript baseline (first sighting → interim, but records lastTranscriptTs)
  const first = live.step("t", transcriptSignals(now - 1), now, false);
  expect("pending" in first).toBe(true);

  now += 1000;
  // newest ts advances past the primed baseline → transcript path; snapshot not stalled
  const second = live.step("t", transcriptSignals(now), now, false);
  expect("outcome" in second).toBe(true);
  expect((second as { outcome: LivenessOutcome }).outcome).toEqual({ verdict: "clearBroad" });
});

test("transcript: stalled candidate — fresh first sighting → clearStall, frozen next → fire, moving → clearStall", () => {
  let visible = "still chewing on it";
  const l = makeLiveness({ read: () => visible, cfg: STALL_CFG });
  let now = 1_700_000_000_000;
  const staleTs = now - STALL_CFG.stallMs - 1; // already stalled candidate

  // first sighting: no baseline yet → routes to interim (records lastTranscriptTs only)
  const s1 = l.step("t", transcriptSignals(staleTs), now, false);
  expect("pending" in s1).toBe(true);

  // next probe: newest ts still stale but > previous baseline (staleTs) so it's
  // seen as advancing relative to the recorded baseline — use a slightly later ts.
  now += 1000;
  const nextTs = staleTs + 1;
  const s2 = l.step("t", transcriptSignals(nextTs), now, false);
  expect("outcome" in s2).toBe(true);
  // first sample of the transcript liveness diff → "fresh", not "frozen" → clearStall
  expect((s2 as { outcome: LivenessOutcome }).outcome).toEqual({ verdict: "clearStall" });

  // terminal unchanged next probe → frozen → fire (carries visible)
  now += 1000;
  const s3 = l.step("t", transcriptSignals(nextTs + 1), now, false);
  expect((s3 as { outcome: LivenessOutcome }).outcome).toEqual({ verdict: "fire", visible });

  // terminal now moves → clearStall
  visible = "Computing… (1s)";
  now += 1000;
  const s4 = l.step("t", transcriptSignals(nextTs + 2), now, false);
  expect((s4 as { outcome: LivenessOutcome }).outcome).toEqual({ verdict: "clearStall" });
});

// ── hung command (pending) bypass ───────────────────────────────────────────

test("hung command (pending past pendingStallMs) fires even while the terminal keeps changing", () => {
  let frame = 0;
  const live = makeLiveness({ read: () => `Computing… (${frame}s)`, cfg: STALL_CFG });
  let now = 1_700_000_000_000;
  const staleTs = now - STALL_CFG.pendingStallMs - 1;

  const s1 = live.step("t", transcriptSignals(staleTs, true), now, false);
  expect("pending" in s1).toBe(true); // first sighting → interim

  now += 1000;
  frame += 1;
  const s2 = live.step("t", transcriptSignals(staleTs + 1, true), now, false);
  // pending bypasses the moving-gate entirely → fires on first transcript-path probe
  expect((s2 as { outcome: LivenessOutcome }).outcome).toEqual({
    verdict: "fire",
    visible: `Computing… (${frame}s)`,
  });

  now += 1000;
  frame += 1;
  const s3 = live.step("t", transcriptSignals(staleTs + 2, true), now, false);
  expect((s3 as { outcome: LivenessOutcome }).outcome).toEqual({
    verdict: "fire",
    visible: `Computing… (${frame}s)`,
  });
});

// ── transcript ↔ interim routing ─────────────────────────────────────────────

test("routing: first sighting (no baseline) → interim; advancing ts → transcript; stale ts → interim", async () => {
  const live = makeLiveness({ readAsync: () => Promise.resolve("v") });
  let now = 1_700_000_000_000;

  const s1 = live.step("t", transcriptSignals(now), now, false);
  expect("pending" in s1).toBe(true); // no baseline yet

  now += 1000;
  const s2 = live.step("t", transcriptSignals(now), now, false); // advances past baseline
  expect("outcome" in s2).toBe(true);

  now += 1000;
  // newest ts does NOT advance (same as previous probe's recorded baseline) → interim
  const s3 = live.step("t", transcriptSignals(now - 1000), now, false);
  expect("pending" in s3).toBe(true);
});

// ── interim: one-cycle deferral + heat-strip + hookFresh suppression ────────

test("interim: first sample defers (none); unchanged past stallMs fires; changed clears + emits windowed heartbeat", async () => {
  let visible = "frozen output";
  const live = makeLiveness({ readAsync: () => Promise.resolve(visible), cfg: STALL_CFG });
  let now = 1_700_000_000_000;

  // route to interim via first sighting
  const s1 = await resolve(live.step("t", { snapshot: null, activity: null }, now, false));
  expect(s1).toEqual({ verdict: "none", activity: null, clearStaleBlock: true });

  // still frozen, not yet past stallMs
  now += STALL_CFG.stallMs - 1;
  const s2 = await resolve(live.step("t", { snapshot: null, activity: null }, now, false));
  expect(s2).toEqual({ verdict: "none", activity: null, clearStaleBlock: true });

  // past stallMs, still frozen → fire
  now += 2;
  const s3 = await resolve(live.step("t", { snapshot: null, activity: null }, now, false));
  expect(s3.verdict).toBe("fire");
  expect(s3.visible).toBe(visible);
  expect(s3.clearStaleBlock).toBe(true);

  // now the buffer changes → clearStall + heartbeat activity with a windowed recentTs
  visible = "moving output";
  now += 1000;
  const s4 = await resolve(live.step("t", { snapshot: null, activity: null }, now, false));
  expect(s4.verdict).toBe("clearStall");
  expect(s4.activity).not.toBeNull();
  expect(s4.activity!.lastActivityTs).toBe(now);
  expect(s4.activity!.recentTs).toEqual([now]);
  expect(s4.activity!.summary).toBeNull();
  expect(s4.activity!.recentErrTs).toEqual([]);
  expect(s4.clearStaleBlock).toBe(true);
});

// ── heat-strip windowing + hookFresh suppression ────────────────────────────

test("interim: ticks older than STRIP_WINDOW_MS are dropped from recentTs", async () => {
  let visible = "a";
  let counter = 0;
  const live = makeLiveness({ readAsync: () => Promise.resolve(visible), cfg: STALL_CFG });
  let now = 1_700_000_000_000;

  // baseline
  await resolve(live.step("t", { snapshot: null, activity: null }, now, false));

  const ticks: number[] = [];
  const totalSpan = STRIP_WINDOW_MS * 2;
  let elapsed = 0;
  let lastActivity: LivenessOutcome["activity"] = null;
  while (elapsed < totalSpan) {
    counter += 1;
    visible = `frame ${counter}`;
    now += 7000;
    elapsed += 7000;
    const out = await resolve(live.step("t", { snapshot: null, activity: null }, now, false));
    if (out.activity) {
      ticks.push(now);
      lastActivity = out.activity;
    }
  }
  expect(lastActivity).not.toBeNull();
  for (const ts of lastActivity!.recentTs) {
    expect(ts).toBeGreaterThanOrEqual(now - STRIP_WINDOW_MS);
    expect(ts).toBeLessThanOrEqual(now);
  }
  // the earliest pushed tick must have been dropped since it's outside the window
  expect(lastActivity!.recentTs).not.toContain(ticks[0]);
});

test("interim: hookFresh suppresses the tick push and heartbeat activity even when the buffer changes", async () => {
  let visible = "a";
  const live = makeLiveness({ readAsync: () => Promise.resolve(visible), cfg: STALL_CFG });
  let now = 1_700_000_000_000;

  await resolve(live.step("t", { snapshot: null, activity: null }, now, false));

  visible = "b";
  now += 1000;
  const out = await resolve(live.step("t", { snapshot: null, activity: null }, now, true)); // hookFresh
  expect(out.verdict).toBe("clearStall"); // still detects the change for stall purposes
  expect(out.activity).toBeNull(); // but suppresses the heartbeat
});

// ── dispatch-time invariant (BLOCKING) ──────────────────────────────────────

test("interim uses the probe-DISPATCH now, not read-completion time, for ticks/window/stall timing", async () => {
  let visible = "a";
  let clock = 1_700_000_000_000;
  // readAsync bumps the mutable clock BEFORE resolving, simulating a slow read that
  // completes after time has moved on. The dispatch `now` passed to step() must still
  // govern the emitted tick/window and the stall-timing math.
  const live = makeLiveness({
    readAsync: () => {
      const captured = visible;
      clock += 50_000; // time passes while the read is "in flight"
      return Promise.resolve(captured);
    },
    cfg: STALL_CFG,
  });

  const dispatchNow = clock;
  await resolve(live.step("t", { snapshot: null, activity: null }, dispatchNow, false)); // baseline

  visible = "b";
  const dispatchNow2 = clock; // dispatch-time now, BEFORE the read bumps `clock`
  const out = await resolve(
    live.step("t", { snapshot: null, activity: null }, dispatchNow2, false),
  );
  expect(out.activity!.lastActivityTs).toBe(dispatchNow2); // NOT the post-read clock
  expect(out.activity!.recentTs).toEqual([dispatchNow2]);
});

// ── in-flight guard ──────────────────────────────────────────────────────────

test("in-flight guard: a second step() routed to interim while a read is pending resolves to none, no duplicate read", async () => {
  let reads = 0;
  let resolveFirst!: (v: string) => void;
  const firstRead = new Promise<string>((res) => {
    resolveFirst = res;
  });
  const live = makeLiveness({
    readAsync: () => {
      reads += 1;
      return reads === 1 ? firstRead : Promise.reject(new Error("no second read expected"));
    },
    cfg: STALL_CFG,
  });

  const now = 1_700_000_000_000;
  const first = live.step("t", { snapshot: null, activity: null }, now, false);
  expect("pending" in first).toBe(true);

  // dispatch a second probe before the first read resolves
  const second = live.step("t", { snapshot: null, activity: null }, now + 10, false);
  expect("pending" in second).toBe(true);
  const secondOutcome = await (second as { pending: Promise<LivenessOutcome> }).pending;
  expect(secondOutcome).toEqual({ verdict: "none" }); // in-flight skip: no clearStaleBlock

  resolveFirst("v");
  const firstOutcome = await (first as { pending: Promise<LivenessOutcome> }).pending;
  expect(firstOutcome.clearStaleBlock).toBe(true);
  expect(reads).toBe(1); // only one actual read dispatched
});

// ── clearStaleBlock ──────────────────────────────────────────────────────────

test("clearStaleBlock set on every completed interim read, not on throw or in-flight skip", async () => {
  let shouldThrow = true;
  const live = makeLiveness({
    readAsync: () => (shouldThrow ? Promise.reject(new Error("boom")) : Promise.resolve("v")),
    cfg: STALL_CFG,
  });
  const now = 1_700_000_000_000;

  const failed = await resolve(live.step("t", { snapshot: null, activity: null }, now, false));
  expect(failed).toEqual({ verdict: "none" }); // no clearStaleBlock on throw

  shouldThrow = false;
  const ok = await resolve(live.step("t", { snapshot: null, activity: null }, now + 1000, false));
  expect(ok.clearStaleBlock).toBe(true);
});

// ── read-failure invariant (BLOCKING) ───────────────────────────────────────

test("read-failure on the transcript confirming probe does not set lastVisible — next success is a fresh first sighting", () => {
  let shouldThrow = true;
  const visible = "output-A";
  const live = makeLiveness({
    read: () =>
      shouldThrow
        ? (() => {
            throw new Error("read failed");
          })()
        : visible,
    cfg: STALL_CFG,
  });
  let now = 1_700_000_000_000;
  const staleTs = now - STALL_CFG.stallMs - 1;

  // first sighting → interim (routing only, no transcript read yet)
  const s1 = live.step("t", transcriptSignals(staleTs), now, false);
  expect("pending" in s1).toBe(true);

  // advance past baseline → transcript path, stalled candidate → attempts read → throws
  now += 1000;
  const s2 = live.step("t", transcriptSignals(staleTs + 1), now, false);
  expect((s2 as { outcome: LivenessOutcome }).outcome).toEqual({ verdict: "none" });

  // now reads succeed: lastVisible must still be unset (the throw never set it) →
  // this probe is a FRESH first sighting, not a frozen match against "output-A" → clearStall
  shouldThrow = false;
  now += 1000;
  const s3 = live.step("t", transcriptSignals(staleTs + 2), now, false);
  expect((s3 as { outcome: LivenessOutcome }).outcome).toEqual({ verdict: "clearStall" });

  // next probe with the SAME visible buffer → now frozen → fire
  now += 1000;
  const s4 = live.step("t", transcriptSignals(staleTs + 3), now, false);
  expect((s4 as { outcome: LivenessOutcome }).outcome).toEqual({ verdict: "fire", visible });
});
