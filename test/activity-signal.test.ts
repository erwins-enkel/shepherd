import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { latestMeaningfulSummary, readActivitySignal } from "../src/activity-signal";
import type { ActivityEntry } from "../src/activity";

// ── helpers ──────────────────────────────────────────────────────────────────

function entry(
  tool: string,
  summary: string,
  ts = 1_000_000,
  status: ActivityEntry["status"] = "ok",
): ActivityEntry {
  return { ts, tool, summary, status };
}

function toolLine(name: string, input: unknown, id: string, ts: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: ts,
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  });
}

function resultLine(id: string, ts: string, is_error = false): string {
  return JSON.stringify({
    type: "user",
    timestamp: ts,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, is_error, content: "" }],
    },
  });
}

// ── latestMeaningfulSummary ───────────────────────────────────────────────────

test("latestMeaningfulSummary returns null for empty entries", () => {
  expect(latestMeaningfulSummary([])).toBeNull();
});

test("latestMeaningfulSummary returns the newest non-noise entry's summary", () => {
  const entries: ActivityEntry[] = [
    entry("Edit", "edited foo.ts", 1000),
    entry("Bash", "$ bun test", 2000),
    entry("TodoWrite", "updated todos", 3000), // noise — should be skipped
  ];
  expect(latestMeaningfulSummary(entries)).toBe("$ bun test");
});

test("latestMeaningfulSummary skips all noise tools: TodoWrite, TaskList, TaskGet, TaskUpdate, TaskCreate", () => {
  const noiseTools = ["TodoWrite", "TaskList", "TaskGet", "TaskUpdate", "TaskCreate"];
  for (const tool of noiseTools) {
    const entries: ActivityEntry[] = [
      entry("Edit", "edited x.ts", 1000),
      entry(tool, "noise summary", 2000),
    ];
    expect(latestMeaningfulSummary(entries)).toBe("edited x.ts");
  }
});

test("latestMeaningfulSummary falls back to newest entry when all are noise", () => {
  const entries: ActivityEntry[] = [
    entry("TaskList", "listed tasks", 1000),
    entry("TodoWrite", "updated todos", 2000),
    entry("TaskCreate", "added task: do something", 3000),
  ];
  // all noise → return the newest (last) entry's summary
  expect(latestMeaningfulSummary(entries)).toBe("added task: do something");
});

test("latestMeaningfulSummary picks the newest non-noise even if it isn't last", () => {
  // entries sorted oldest→newest by convention (parseActivity returns them that way)
  const entries: ActivityEntry[] = [
    entry("Read", "read alpha.ts", 1000),
    entry("Write", "wrote beta.ts", 2000),
    entry("TodoWrite", "updated todos", 3000), // newest but noise
  ];
  expect(latestMeaningfulSummary(entries)).toBe("wrote beta.ts");
});

test("latestMeaningfulSummary returns the only non-noise entry when it exists", () => {
  const entries: ActivityEntry[] = [
    entry("TaskList", "listed tasks", 1000),
    entry("Bash", "$ echo hi", 1500),
    entry("TaskUpdate", "updated task 2", 2000),
  ];
  expect(latestMeaningfulSummary(entries)).toBe("$ echo hi");
});

// ── readActivitySignal ────────────────────────────────────────────────────────

test("readActivitySignal returns null for a missing file", () => {
  expect(readActivitySignal(join(tmpdir(), "does-not-exist-shepherd-activity.jsonl"))).toBeNull();
});

test("readActivitySignal returns null when the file has no parseable records", () => {
  const dir = mkdtempSync(join(tmpdir(), "activity-signal-"));
  const path = join(dir, "empty.jsonl");
  try {
    writeFileSync(path, "\n\nnot json\n");
    expect(readActivitySignal(path)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readActivitySignal returns expected ts + summary for a valid JSONL", () => {
  const dir = mkdtempSync(join(tmpdir(), "activity-signal-"));
  const path = join(dir, "s.jsonl");
  try {
    const lines = [
      toolLine("Edit", { file_path: "/a/b/poller.ts" }, "u1", "2026-05-31T10:00:00.000Z"),
      resultLine("u1", "2026-05-31T10:00:01.000Z"),
      toolLine("Bash", { command: "bun test" }, "u2", "2026-05-31T10:01:00.000Z"),
      resultLine("u2", "2026-05-31T10:05:00.000Z"), // newest record overall
    ];
    writeFileSync(path, lines.join("\n"));
    const signal = readActivitySignal(path);
    expect(signal).not.toBeNull();
    // heartbeat = newest record across entire transcript
    expect(signal!.lastActivityTs).toBe(Date.parse("2026-05-31T10:05:00.000Z"));
    // newest non-noise tool-use
    expect(signal!.summary).toBe("$ bun test");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readActivitySignal omits noise tools from summary but still returns signal", () => {
  const dir = mkdtempSync(join(tmpdir(), "activity-signal-"));
  const path = join(dir, "s.jsonl");
  try {
    const lines = [
      toolLine("Read", { file_path: "/x/config.ts" }, "u1", "2026-05-31T09:00:00.000Z"),
      resultLine("u1", "2026-05-31T09:00:01.000Z"),
      toolLine("TodoWrite", { todos: [] }, "u2", "2026-05-31T09:01:00.000Z"),
      resultLine("u2", "2026-05-31T09:01:01.000Z"),
    ];
    writeFileSync(path, lines.join("\n"));
    const signal = readActivitySignal(path);
    expect(signal).not.toBeNull();
    expect(signal!.summary).toBe("read config.ts"); // noise skipped
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
