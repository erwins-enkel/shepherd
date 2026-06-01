import { describe, it, expect } from "vitest";
import { detectNotesKey } from "./notesAffordance";

describe("detectNotesKey", () => {
  it("detects the inline 'press n to add notes' hint", () => {
    expect(detectNotesKey("Notes: press n to add notes")).toBe("n");
  });

  it("detects the footer 'n to add notes' hint", () => {
    expect(
      detectNotesKey(
        "Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch · Esc to cancel",
      ),
    ).toBe("n");
  });

  it("finds the hint anywhere in a multi-line viewport scrape", () => {
    const screen = [
      "1. Auf NewTask-Dialog zurückfallen",
      "2. Button ausgrauen/ausblenden",
      "",
      "Notes: press n to add notes",
      "",
      "Chat about this",
    ].join("\n");
    expect(detectNotesKey(screen)).toBe("n");
  });

  it("returns the key verbatim when the prompt uses a different letter", () => {
    expect(detectNotesKey("press a to add notes")).toBe("a");
  });

  it("matches case-insensitively but preserves the displayed casing", () => {
    expect(detectNotesKey("N to add notes")).toBe("N");
  });

  it("returns null when no notes affordance is present", () => {
    expect(detectNotesKey("Enter to select · ↑/↓ to navigate · Esc to cancel")).toBe(null);
  });

  it("returns null for empty input", () => {
    expect(detectNotesKey("")).toBe(null);
  });

  it("does not match unrelated prose containing 'notes'", () => {
    expect(detectNotesKey("These are release notes for the project")).toBe(null);
  });
});
