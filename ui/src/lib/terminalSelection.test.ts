import { describe, it, expect } from "vitest";
import { bufferText, trimTrailingWhitespace } from "./terminalSelection";

describe("trimTrailingWhitespace", () => {
  it("strips trailing spaces after a backslash-continued line (the reported case)", () => {
    const sel = "some command \\   \n  --flag value \\  \n  --other";
    expect(trimTrailingWhitespace(sel)).toBe("some command \\\n  --flag value \\\n  --other");
  });

  it("strips trailing tabs as well as spaces", () => {
    expect(trimTrailingWhitespace("foo\t \nbar")).toBe("foo\nbar");
  });

  it("handles the Windows \\r\\n row join (spaces sit before the \\r)", () => {
    expect(trimTrailingWhitespace("foo  \r\nbar\t\r\n")).toBe("foo\r\nbar\r\n");
  });

  it("trims trailing whitespace on the final line (no terminator)", () => {
    expect(trimTrailingWhitespace("only line   ")).toBe("only line");
  });

  it("leaves clean text untouched", () => {
    const clean = "a\nb\nc";
    expect(trimTrailingWhitespace(clean)).toBe(clean);
  });

  it("preserves leading indentation and interior whitespace", () => {
    expect(trimTrailingWhitespace("  a  b   \n\tc d")).toBe("  a  b\n\tc d");
  });

  it("keeps blank lines blank without collapsing them", () => {
    expect(trimTrailingWhitespace("a\n   \n b  \n")).toBe("a\n\n b\n");
  });

  it("returns empty string unchanged", () => {
    expect(trimTrailingWhitespace("")).toBe("");
  });
});

describe("bufferText", () => {
  const buf = (rows: [string, boolean?][]) => ({
    length: rows.length,
    getLine: (i: number) =>
      rows[i] && { translateToString: () => rows[i][0], isWrapped: rows[i][1] ?? false },
  });

  it("joins rows with newlines and trims each row's padding", () => {
    expect(bufferText(buf([["$ ls   "], ["a  b    "]]))).toBe("$ ls\na  b");
  });

  it("joins a soft-wrapped row onto its predecessor without a newline", () => {
    expect(bufferText(buf([["abcdef"], ["ghi  ", true], ["next"]]))).toBe("abcdefghi\nnext");
  });

  it("keeps a space at the wrap column of a row the next row continues", () => {
    const wrapped = {
      length: 2,
      getLine: (i: number) =>
        [
          { isWrapped: false, translateToString: (trim?: boolean) => (trim ? "fix" : "fix ") },
          { isWrapped: true, translateToString: () => "the bug" },
        ][i],
    };
    expect(bufferText(wrapped)).toBe("fix the bug");
  });

  it("drops the blank rows below the last output", () => {
    expect(bufferText(buf([["out"], ["   "], [""]]))).toBe("out");
  });

  it("returns an empty string for an empty buffer", () => {
    expect(bufferText(buf([]))).toBe("");
  });
});
