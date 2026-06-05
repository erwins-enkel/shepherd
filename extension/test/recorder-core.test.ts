import { describe, expect, it } from "vitest";
import { isFailedResponse, normalizeConsoleArgs, pushCapped } from "../src/lib/recorder-core";

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
    const circular: any = {};
    circular.self = circular;
    expect(normalizeConsoleArgs([circular])).toBe("[object Object]");
  });
});
