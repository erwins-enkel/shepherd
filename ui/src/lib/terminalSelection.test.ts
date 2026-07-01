import { describe, it, expect } from "vitest";
import { trimTrailingWhitespace } from "./terminalSelection";

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
