import { describe, expect, test } from "bun:test";
import {
  LABEL_BYTES,
  OpRegistry,
  RING,
  SLOTS,
  StallMonitor,
  allocRegistryBuffers,
  formatStallReport,
  sanitizeLabel,
} from "../src/loop-watchdog-core";

const fresh = () => new OpRegistry(allocRegistryBuffers());

describe("OpRegistry", () => {
  test("tracks an in-flight op until it ends, then moves it to the ring", () => {
    const reg = fresh();
    const slot = reg.start("POST /api/sessions", 1_000);
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(reg.snapshot().inFlight).toEqual([{ label: "POST /api/sessions", start: 1_000 }]);

    reg.end(slot, 1_250);
    const snap = reg.snapshot();
    expect(snap.inFlight).toEqual([]);
    expect(snap.recent).toEqual([{ label: "POST /api/sessions", start: 1_000, end: 1_250 }]);
  });

  test("a second view over the SAME buffers sees the writes — the worker's side of the contract", () => {
    const buffers = allocRegistryBuffers();
    const writer = new OpRegistry(buffers);
    const reader = new OpRegistry(buffers);
    writer.beat(42_000);
    writer.start("GET /api/health", 41_900);
    expect(reader.lastBeat()).toBe(42_000);
    expect(reader.snapshot().inFlight.map((o) => o.label)).toEqual(["GET /api/health"]);
  });

  test("lists in-flight ops oldest first", () => {
    const reg = fresh();
    reg.start("b", 2_000);
    reg.start("a", 1_000);
    reg.start("c", 3_000);
    expect(reg.snapshot().inFlight.map((o) => o.label)).toEqual(["a", "b", "c"]);
  });

  test("overflow is counted, never blocks, and freed slots are reused", () => {
    const reg = fresh();
    const slots = Array.from({ length: SLOTS }, (_, i) => reg.start(`op${i}`, i));
    expect(slots.every((s) => s >= 0)).toBe(true);
    expect(reg.start("one too many", 999)).toBe(-1);
    expect(reg.snapshot().dropped).toBe(1);

    reg.end(slots[0]!, 1_000);
    expect(reg.start("reused", 1_001)).toBe(slots[0]!);
  });

  test("the ring keeps only the newest RING finished ops, in order", () => {
    const reg = fresh();
    for (let i = 0; i < RING + 5; i++) reg.end(reg.start(`op${i}`, i), i + 1);
    const recent = reg.snapshot().recent;
    expect(recent).toHaveLength(RING);
    expect(recent[0]!.label).toBe("op5");
    expect(recent.at(-1)!.label).toBe(`op${RING + 4}`);
  });

  test("end() on an invalid slot is a no-op", () => {
    const reg = fresh();
    reg.end(-1, 1);
    reg.end(SLOTS, 1);
    expect(reg.snapshot().recent).toEqual([]);
  });

  test("truncates long labels on a UTF-8 character boundary", () => {
    const reg = fresh();
    // Multi-byte glyphs straddling the byte cap must not decode as U+FFFD garbage.
    const label = "ä".repeat(LABEL_BYTES);
    reg.start(label, 1);
    const got = reg.snapshot().inFlight[0]!.label;
    expect(new TextEncoder().encode(got).length).toBeLessThanOrEqual(LABEL_BYTES);
    expect(got).not.toContain("�");
    expect(got).toBe("ä".repeat(LABEL_BYTES / 2));
  });

  test("strips control characters so a label cannot forge log lines", () => {
    expect(sanitizeLabel("GET /x\n[loop-watchdog] fake\r\u0007")).toBe(
      "GET /x [loop-watchdog] fake  ",
    );
    const reg = fresh();
    reg.start("a\nb", 1);
    expect(reg.snapshot().inFlight[0]!.label).toBe("a b");
  });
});

describe("StallMonitor", () => {
  const cfg = { stallReportMs: 10_000, pingFreshMs: 5_000 };

  test("pings while the heartbeat is fresh, withholds once it goes stale", () => {
    const m = new StallMonitor(cfg);
    expect(m.tick(100_000, 101_000).ping).toBe(true);
    expect(m.tick(100_000, 104_999).ping).toBe(true);
    expect(m.tick(100_000, 105_000).ping).toBe(false);
  });

  test("never pings before the first heartbeat", () => {
    expect(new StallMonitor(cfg).tick(0, 1).ping).toBe(false);
  });

  test("reports a stall exactly once per episode, then its recovery", () => {
    const m = new StallMonitor(cfg);
    expect(m.tick(100_000, 109_999).reportStall).toBe(false);
    expect(m.tick(100_000, 110_000).reportStall).toBe(true);
    // Still frozen: no repeat report.
    expect(m.tick(100_000, 130_000).reportStall).toBe(false);

    // Loop came back with a heartbeat at 135s: recovery measures beat-to-beat.
    const back = m.tick(135_000, 135_500);
    expect(back.recoveredAfterMs).toBe(35_000);
    expect(back.ping).toBe(true);

    // A fresh stall later is a new episode and reports again.
    expect(m.tick(135_000, 145_000).reportStall).toBe(true);
  });

  test("a short hiccup below the threshold neither reports nor recovers", () => {
    const m = new StallMonitor(cfg);
    const d = m.tick(100_000, 107_000);
    expect(d.reportStall).toBe(false);
    expect(d.recoveredAfterMs).toBeNull();
    expect(d.ping).toBe(false); // but it is too stale to vouch for
  });
});

describe("formatStallReport", () => {
  test("names in-flight and recent ops with ISO timestamps, one prefixed line each", () => {
    const now = Date.UTC(2026, 8, 23, 19, 37, 52);
    const lines = formatStallReport(
      {
        lastBeat: now - 12_000,
        inFlight: [{ label: "POST /api/sessions/abc/hooks", start: now - 12_300 }],
        recent: [{ label: "GET /api/sessions", start: now - 13_000, end: now - 12_990 }],
        dropped: 2,
      },
      now,
      4242,
      true,
    );
    expect(lines.every((l) => l.startsWith("[loop-watchdog]"))).toBe(true);
    const text = lines.join("\n");
    expect(text).toContain("event loop stalled 12.0s");
    expect(text).toContain("pid 4242");
    expect(text).toContain("2026-09-23T19:37:39.700Z  running 12.3s  POST /api/sessions/abc/hooks");
    expect(text).toContain("took 10ms  GET /api/sessions");
    expect(text).toContain("untracked (registry full): 2");
    expect(text).toContain("pings withheld");
  });

  test("says so plainly when nothing will restart the process", () => {
    const text = formatStallReport(
      { lastBeat: 1, inFlight: [], recent: [], dropped: 0 },
      20_000,
      1,
      false,
    ).join("\n");
    expect(text).toContain("in flight (oldest first): none");
    expect(text).toContain("no systemd watchdog armed");
    expect(text).not.toContain("untracked");
  });
});
