import { describe, it, expect } from "vitest";
import { composeKeystrokes, insertNewlineAt } from "./compose";

describe("composeKeystrokes", () => {
  it("maps empty input to a bare CR (Enter passthrough)", () => {
    expect(composeKeystrokes("")).toBe("\r");
  });
  it("wraps text in bracketed-paste markers and submits with a trailing CR", () => {
    expect(composeKeystrokes("hello")).toBe("\x1b[200~hello\x1b[201~\r");
  });
  it("keeps multi-line content literal inside one paste", () => {
    expect(composeKeystrokes("first\nsecond")).toBe("\x1b[200~first\nsecond\x1b[201~\r");
  });
});

describe("insertNewlineAt", () => {
  it("inserts a newline at the caret and advances it", () => {
    expect(insertNewlineAt("ab", 2, 2)).toEqual({ value: "ab\n", caret: 3 });
  });
  it("inserts at the start", () => {
    expect(insertNewlineAt("ab", 0, 0)).toEqual({ value: "\nab", caret: 1 });
  });
  it("replaces a selection with a newline", () => {
    expect(insertNewlineAt("abcd", 1, 3)).toEqual({ value: "a\nd", caret: 2 });
  });
});
