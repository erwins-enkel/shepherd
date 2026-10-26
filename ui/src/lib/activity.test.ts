import { describe, it, expect } from "vitest";
import { glyph, clock } from "./activity";

describe("glyph", () => {
  it("maps edit-family tools to ✎", () => {
    for (const t of ["Edit", "MultiEdit", "NotebookEdit", "Write"]) {
      expect(glyph(t)).toBe("✎");
    }
  });
  it("maps read/bash/search/todo/dispatch/web to their glyphs", () => {
    expect(glyph("Read")).toBe("⤷");
    expect(glyph("Bash")).toBe("$");
    expect(glyph("Grep")).toBe("⌕");
    expect(glyph("Glob")).toBe("⌕");
    expect(glyph("TodoWrite")).toBe("⊞");
    for (const t of ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]) {
      expect(glyph(t)).toBe("⊞");
    }
    expect(glyph("Task")).toBe("◆");
    expect(glyph("Skill")).toBe("◆");
    expect(glyph("WebFetch")).toBe("⇲");
  });
  it("falls back to · for unknown tools", () => {
    expect(glyph("FancyNewTool")).toBe("·");
  });
});

describe("clock", () => {
  it("formats a ms-epoch as local HH:MM", () => {
    const ts = new Date("2026-05-31T14:32:00").getTime();
    expect(clock(ts)).toBe("14:32");
  });
});
