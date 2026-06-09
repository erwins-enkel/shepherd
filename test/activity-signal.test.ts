import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  latestMeaningfulSummary,
  readActivitySignal,
  signalFrom,
  signalFromText,
  readTranscriptSignals,
  STRIP_WINDOW_MS,
} from "../src/activity-signal";
import { snapshotFromText } from "../src/stall";
import type { ActivityEntry } from "../src/activity";
import { MAX_TAIL_BYTES } from "../src/activity";

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

// ── signalFrom (pure, from parsed entries) ────────────────────────────────────

test("signalFrom: null when no activity at all", () => {
  expect(signalFrom([], 0)).toBeNull();
});

test("signalFrom: heartbeat ts + meaningful summary from parsed entries", () => {
  const entries = [entry("Read", "read a.ts", 1_000), entry("Edit", "edited b.ts", 2_000)];
  const signal = signalFrom(entries, 5_000);
  expect(signal).toEqual({
    lastActivityTs: 5_000,
    summary: "edited b.ts",
    recentTs: [1_000, 2_000],
    recentErrTs: [],
  });
});

// ── signalFromText / readTranscriptSignals ────────────────────────────────────

test("signalFromText returns null for text with no parseable records", () => {
  expect(signalFromText("")).toBeNull();
  expect(signalFromText("not json\n")).toBeNull();
});

test("signalFromText derives heartbeat + meaningful summary from text", () => {
  const text = [
    toolLine("Edit", { file_path: "/a/b/poller.ts" }, "u1", "2026-05-31T10:00:00.000Z"),
    resultLine("u1", "2026-05-31T10:05:00.000Z"),
  ].join("\n");
  const signal = signalFromText(text);
  expect(signal).not.toBeNull();
  expect(signal!.lastActivityTs).toBe(Date.parse("2026-05-31T10:05:00.000Z"));
  expect(signal!.summary).toBe("edited poller.ts");
});

test("readTranscriptSignals: one read yields both snapshot + activity", () => {
  const dir = mkdtempSync(join(tmpdir(), "transcript-signals-"));
  const path = join(dir, "s.jsonl");
  try {
    const lines = [
      toolLine("Edit", { file_path: "/a/poller.ts" }, "u1", "2026-05-31T10:00:00.000Z"),
      resultLine("u1", "2026-05-31T10:00:01.000Z"),
      toolLine("Bash", { command: "bun test" }, "u2", "2026-05-31T10:05:00.000Z"),
    ];
    writeFileSync(path, lines.join("\n"));
    const { snapshot, activity } = readTranscriptSignals(path);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.pending).toBe(true); // u2 has no result yet
    expect(snapshot!.lastTs).toBe(Date.parse("2026-05-31T10:05:00.000Z"));
    expect(activity).not.toBeNull();
    expect(activity!.summary).toBe("$ bun test");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readTranscriptSignals: missing file → both null", () => {
  const { snapshot, activity } = readTranscriptSignals(
    join(tmpdir(), "does-not-exist-shepherd-transcript.jsonl"),
  );
  expect(snapshot).toBeNull();
  expect(activity).toBeNull();
});

// ── signalFrom: recentTs / recentErrTs windowing ──────────────────────────────

test("signalFrom: recentTs keeps only events within 8min of lastActivityTs", () => {
  const last = 10_000_000;
  const entries = [
    entry("Read", "old", last - 9 * 60_000), // outside 8min window → dropped
    entry("Read", "in", last - 60_000), // inside
    entry("Edit", "newer", last - 1_000), // inside
  ];
  const signal = signalFrom(entries, last);
  expect(signal!.recentTs).toEqual([last - 60_000, last - 1_000]);
  expect(signal!.recentErrTs).toEqual([]);
});

test("signalFrom: recentErrTs is the subset of recentTs whose tool errored", () => {
  const last = 10_000_000;
  const entries = [
    entry("Bash", "$ ok", last - 30_000, "ok"),
    entry("Bash", "$ boom", last - 10_000, "error"),
  ];
  const signal = signalFrom(entries, last);
  expect(signal!.recentTs).toEqual([last - 30_000, last - 10_000]);
  expect(signal!.recentErrTs).toEqual([last - 10_000]);
});

test("signalFrom: zero-ts entries are excluded from recentTs", () => {
  const signal = signalFrom([entry("Read", "no ts", 0)], 5_000);
  expect(signal!.recentTs).toEqual([]);
});

test("signalFrom: an event exactly STRIP_WINDOW_MS old is kept (half-open window edge)", () => {
  const last = 10_000_000;
  const onEdge = last - STRIP_WINDOW_MS; // exactly at the cutoff → included
  const signal = signalFrom([entry("Read", "edge", onEdge)], last);
  expect(signal!.recentTs).toEqual([onEdge]);
});

test("signalFrom: pending entries count in recentTs but never in recentErrTs", () => {
  const last = 10_000_000;
  const signal = signalFrom([entry("Bash", "$ in flight", last - 5_000, "pending")], last);
  expect(signal!.recentTs).toEqual([last - 5_000]);
  expect(signal!.recentErrTs).toEqual([]);
});

// ── parity: tail-bounded read produces same signals as a full parse ────────────

test("readTranscriptSignals parity: signals from tail read equal signals from recent records only", () => {
  const dir = mkdtempSync(join(tmpdir(), "parity-signal-"));
  const path = join(dir, "parity.jsonl");
  try {
    // Build a transcript that EXCEEDS MAX_TAIL_BYTES (512 KB) so the tail read
    // genuinely truncates the file. Filler records use a distinct old timestamp
    // (2020-01-01) and a unique Bash command — if any filler leaked through the
    // tail cut, lastActivityTs and summary would differ from the expected values,
    // making the assertions non-tautological.
    //
    // Each filler pair (tool_use + tool_result) is ~400 B. We need > 512 KB of
    // filler, so 1500 pairs ≈ 600 KB safely exceeds the cap. The recent records
    // (< 2 KB) are appended last and must fully fit within the tail window.
    const FILLER_PAIRS = 1500;
    const fillerLines: string[] = [];
    for (let i = 0; i < FILLER_PAIRS; i++) {
      fillerLines.push(
        toolLine("Bash", { command: `echo filler-${i}` }, `filler${i}`, "2020-01-01T00:00:00.000Z"),
      );
      fillerLines.push(resultLine(`filler${i}`, "2020-01-01T00:00:01.000Z"));
    }
    const recentLines = [
      toolLine("Edit", { file_path: "/a/server.ts" }, "r1", "2026-05-31T10:00:00.000Z"),
      resultLine("r1", "2026-05-31T10:00:01.000Z"),
      toolLine("Bash", { command: "bun test" }, "r2", "2026-05-31T10:01:00.000Z"),
      resultLine("r2", "2026-05-31T10:05:00.000Z"),
    ];

    const fullContent = [...fillerLines, ...recentLines].join("\n");
    writeFileSync(path, fullContent);

    // Verify the file is actually larger than MAX_TAIL_BYTES so the truncation
    // path is exercised (not the whole-file-fits path).
    const fileSize = statSync(path).size;
    expect(fileSize).toBeGreaterThan(MAX_TAIL_BYTES);

    // Derive expected signals from ONLY the recent lines (what the tail should cover
    // after the filler is cut). The filler uses "2020-01-01" timestamps and
    // "$ echo filler-N" summaries — distinct enough that leakage would be detected.
    const recentText = recentLines.join("\n");
    const expectedActivity = signalFromText(recentText);
    const expectedSnapshot = snapshotFromText(recentText);

    // actual read via readTranscriptSignals (uses readTranscriptTail + 512 KB cap)
    const { snapshot, activity } = readTranscriptSignals(path);

    expect(activity).not.toBeNull();
    expect(snapshot).not.toBeNull();
    // heartbeat must match the recent records, not the filler's 2020 timestamp
    expect(activity!.lastActivityTs).toBe(expectedActivity!.lastActivityTs);
    // summary must be exactly the known recent tool — not any "$ echo filler-N" value
    expect(activity!.summary).toBe("$ bun test");
    expect(activity!.summary).toBe(expectedActivity!.summary);
    // stall snapshot must reflect recent records only
    expect(snapshot!.lastTs).toBe(expectedSnapshot!.lastTs);
    expect(snapshot!.pending).toBe(expectedSnapshot!.pending);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
