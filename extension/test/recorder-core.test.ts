import { describe, expect, it } from "vitest";
import {
  isFailedResponse,
  normalizeConsoleArgs,
  parseRecorderBuffer,
  pushCapped,
  RECORDER_CAP,
} from "../src/lib/recorder-core";

describe("pushCapped", () => {
  it("appends then drops the oldest beyond the cap", () => {
    const buf: number[] = [];
    for (let i = 0; i < 5; i++) pushCapped(buf, i, 3);
    expect(buf).toEqual([2, 3, 4]);
  });
});

describe("isFailedResponse", () => {
  it("treats <400 as ok and ≥400 as failed", () => {
    expect(isFailedResponse(200)).toBe(false);
    expect(isFailedResponse(304)).toBe(false);
    expect(isFailedResponse(399)).toBe(false);
    expect(isFailedResponse(400)).toBe(true);
    expect(isFailedResponse(500)).toBe(true);
  });
});

describe("normalizeConsoleArgs", () => {
  it("joins strings, stringifies objects, and unwraps Errors", () => {
    expect(normalizeConsoleArgs(["a", "b"])).toBe("a b");
    expect(normalizeConsoleArgs(["x", { a: 1 }])).toBe('x {"a":1}');
    expect(normalizeConsoleArgs([new Error("boom")])).toBe("boom");
  });

  it("falls back to String() for un-stringifiable values", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(normalizeConsoleArgs([circular])).toBe("[object Object]");
  });
});

describe("parseRecorderBuffer", () => {
  const ts = "2026-10-25T00:00:00.000Z";

  it("rejects values that are not a buffer", () => {
    for (const raw of [null, undefined, 1, "x", [], { console: "x" }, { network: {} }]) {
      expect(parseRecorderBuffer(raw)).toBeNull();
    }
  });

  it("defaults a missing array to empty", () => {
    expect(parseRecorderBuffer({})).toEqual({ console: [], network: [] });
  });

  it("keeps well-typed entries and strips unknown fields", () => {
    const out = parseRecorderBuffer({
      console: [{ level: "warn", text: "w", ts, extra: "x" }],
      network: [
        { method: "GET", url: "/a", status: 404, ts, extra: 1 },
        { method: "GET", url: "/b", status: "error", ts },
        { method: "GET", url: "/c", status: "load-error", ts },
      ],
    });
    expect(out).toEqual({
      console: [{ level: "warn", text: "w", ts }],
      network: [
        { method: "GET", url: "/a", status: 404, ts },
        { method: "GET", url: "/b", status: "error", ts },
        { method: "GET", url: "/c", status: "load-error", ts },
      ],
    });
  });

  it("drops entries with forged level, status or field types", () => {
    const out = parseRecorderBuffer({
      console: [
        { level: "warn]\n```\nOUTSIDE", text: "x", ts },
        { level: "error", text: 1, ts },
        "not an entry",
      ],
      network: [
        { method: "GET", url: "/a", status: "0\n```\nNET", ts },
        { method: "GET", url: "/a", status: Number.NaN, ts },
        { method: "GET", url: "/a", status: 1e9, ts },
        { method: "GET", url: "/a", status: 404.5, ts },
        { method: 1, url: "/a", status: 500, ts },
      ],
    });
    expect(out).toEqual({ console: [], network: [] });
  });

  it("caps string lengths and keeps only the newest entries", () => {
    const many = Array.from({ length: RECORDER_CAP + 10 }, (_, i) => ({
      level: "error",
      text: String(i),
      ts,
    }));
    const out = parseRecorderBuffer({
      console: [...many, { level: "error", text: "t".repeat(5000), ts: "s".repeat(500) }],
      network: [{ method: "M".repeat(100), url: "u".repeat(5000), status: 500, ts }],
    });
    expect(out?.console).toHaveLength(RECORDER_CAP);
    expect(out?.console[0]?.text).toBe("11");
    const last = out?.console.at(-1);
    expect(last?.text).toHaveLength(2000);
    expect(last?.ts).toHaveLength(64);
    expect(out?.network[0]?.method).toHaveLength(16);
    expect(out?.network[0]?.url).toHaveLength(2048);
  });
});
