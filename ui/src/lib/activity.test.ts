import { describe, it, expect } from "vitest";
import { glyph, clock, toolKind, groupActivity } from "./activity";
import type { ActivityEntry } from "./types";

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

// Factory helper for tests.
function entry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    ts: Date.now(),
    tool: "Read",
    summary: "test summary",
    status: "ok",
    ...overrides,
  };
}

describe("toolKind", () => {
  it("classifies edit-family tools as 'edit'", () => {
    expect(toolKind("Edit")).toBe("edit");
    expect(toolKind("MultiEdit")).toBe("edit");
    expect(toolKind("NotebookEdit")).toBe("edit");
    expect(toolKind("Write")).toBe("edit");
  });
  it("classifies Read as 'read'", () => {
    expect(toolKind("Read")).toBe("read");
  });
  it("classifies search tools as 'search'", () => {
    expect(toolKind("Grep")).toBe("search");
    expect(toolKind("Glob")).toBe("search");
  });
  it("classifies Bash as 'exec'", () => {
    expect(toolKind("Bash")).toBe("exec");
  });
  it("classifies task tools as 'tasks'", () => {
    expect(toolKind("TodoWrite")).toBe("tasks");
    expect(toolKind("TaskCreate")).toBe("tasks");
    expect(toolKind("TaskUpdate")).toBe("tasks");
    expect(toolKind("TaskList")).toBe("tasks");
    expect(toolKind("TaskGet")).toBe("tasks");
  });
  it("classifies agent tools as 'agent'", () => {
    expect(toolKind("Task")).toBe("agent");
    expect(toolKind("Agent")).toBe("agent");
    expect(toolKind("Skill")).toBe("agent");
  });
  it("classifies web tools as 'web'", () => {
    expect(toolKind("WebFetch")).toBe("web");
    expect(toolKind("WebSearch")).toBe("web");
  });
  it("classifies unknown tools as 'other'", () => {
    expect(toolKind("Frobnicate")).toBe("other");
    expect(toolKind("UnknownTool")).toBe("other");
  });
});

describe("groupActivity", () => {
  it("returns empty array for empty input", () => {
    expect(groupActivity([])).toEqual([]);
  });
  it("coalesces consecutive entries of the same kind into one group", () => {
    const entries = [
      entry({ tool: "Read", summary: "read 1" }),
      entry({ tool: "Read", summary: "read 2" }),
      entry({ tool: "Read", summary: "read 3" }),
    ];
    const groups = groupActivity(entries);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe("read");
    expect(groups[0]?.entries).toHaveLength(3);
    expect(groups[0]?.entries[0]?.summary).toBe("read 1");
    expect(groups[0]?.entries[2]?.summary).toBe("read 3");
  });
  it("creates separate groups for interleaved kinds", () => {
    const entries = [
      entry({ tool: "Read", summary: "read 1" }),
      entry({ tool: "Bash", summary: "bash 1" }),
      entry({ tool: "Read", summary: "read 2" }),
    ];
    const groups = groupActivity(entries);
    expect(groups).toHaveLength(3);
    expect(groups[0]?.kind).toBe("read");
    expect(groups[0]?.entries).toHaveLength(1);
    expect(groups[1]?.kind).toBe("exec");
    expect(groups[1]?.entries).toHaveLength(1);
    expect(groups[2]?.kind).toBe("read");
    expect(groups[2]?.entries).toHaveLength(1);
  });
  it("preserves order of groups and entries within groups", () => {
    const entries = [
      entry({ tool: "Edit", summary: "edit 1" }),
      entry({ tool: "Edit", summary: "edit 2" }),
      entry({ tool: "Bash", summary: "bash 1" }),
      entry({ tool: "WebFetch", summary: "fetch 1" }),
    ];
    const groups = groupActivity(entries);
    expect(groups).toHaveLength(3);
    expect(groups[0]?.kind).toBe("edit");
    expect(groups[0]?.entries[0]?.summary).toBe("edit 1");
    expect(groups[0]?.entries[1]?.summary).toBe("edit 2");
    expect(groups[1]?.kind).toBe("exec");
    expect(groups[1]?.entries[0]?.summary).toBe("bash 1");
    expect(groups[2]?.kind).toBe("web");
    expect(groups[2]?.entries[0]?.summary).toBe("fetch 1");
  });
});
