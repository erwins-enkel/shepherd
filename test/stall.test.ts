import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isStalled, readSnapshot, snapshotFromText, DEFAULT_STALL } from "../src/stall";

const NOW = 1_000_000_000_000;

test("not stalled when last tool finished within the window", () => {
  const snap = { lastTs: NOW - 2 * 60_000, pending: false };
  expect(isStalled(snap, NOW, DEFAULT_STALL)).toBe(false);
});

test("stalled when a finished tool went quiet past stallMs", () => {
  const snap = { lastTs: NOW - 9 * 60_000, pending: false };
  expect(isStalled(snap, NOW, DEFAULT_STALL)).toBe(true);
});

test("a long-running (pending) tool is NOT a stall until the hung-command ceiling", () => {
  const running = { lastTs: NOW - 9 * 60_000, pending: true }; // 9m build, still going
  expect(isStalled(running, NOW, DEFAULT_STALL)).toBe(false);
  const hung = { lastTs: NOW - 21 * 60_000, pending: true };
  expect(isStalled(hung, NOW, DEFAULT_STALL)).toBe(true);
});

test("no measurable activity yet → never stalled", () => {
  expect(isStalled({ lastTs: 0, pending: false }, NOW, DEFAULT_STALL)).toBe(false);
});

test("readSnapshot returns null for a missing transcript", () => {
  expect(readSnapshot(join(tmpdir(), "does-not-exist-shepherd.jsonl"))).toBeNull();
});

test("snapshotFromText returns null for text with no tool_use", () => {
  expect(snapshotFromText("")).toBeNull();
  expect(snapshotFromText("not json\n")).toBeNull();
});

test("snapshotFromText derives lastTs + pending from the newest tool_use", () => {
  const text = [
    JSON.stringify({
      timestamp: "2026-05-31T10:00:00.000Z",
      message: { content: [{ type: "tool_use", id: "u1", name: "Edit", input: {} }] },
    }),
    JSON.stringify({
      timestamp: "2026-05-31T10:00:01.000Z",
      message: { content: [{ type: "tool_result", tool_use_id: "u1", is_error: false }] },
    }),
    JSON.stringify({
      timestamp: "2026-05-31T10:05:00.000Z",
      message: { content: [{ type: "tool_use", id: "u2", name: "Bash", input: {} }] },
    }),
  ].join("\n");
  const snap = snapshotFromText(text);
  expect(snap).not.toBeNull();
  expect(snap!.pending).toBe(true); // newest tool_use (u2) has no result
  expect(snap!.lastTs).toBe(Date.parse("2026-05-31T10:05:00.000Z"));
});

test("readSnapshot reads lastTs + pending from the newest tool_use", () => {
  const dir = mkdtempSync(join(tmpdir(), "stall-"));
  const path = join(dir, "s.jsonl");
  try {
    // an Edit (paired result → ok) then a Bash with no result yet (pending)
    const lines = [
      JSON.stringify({
        timestamp: "2026-05-31T10:00:00.000Z",
        message: { content: [{ type: "tool_use", id: "u1", name: "Edit", input: {} }] },
      }),
      JSON.stringify({
        timestamp: "2026-05-31T10:00:01.000Z",
        message: { content: [{ type: "tool_result", tool_use_id: "u1", is_error: false }] },
      }),
      JSON.stringify({
        timestamp: "2026-05-31T10:05:00.000Z",
        message: {
          content: [{ type: "tool_use", id: "u2", name: "Bash", input: { command: "bun test" } }],
        },
      }),
    ];
    writeFileSync(path, lines.join("\n"));
    const snap = readSnapshot(path);
    expect(snap).not.toBeNull();
    expect(snap!.pending).toBe(true); // newest tool_use (u2) has no result
    expect(snap!.lastTs).toBe(Date.parse("2026-05-31T10:05:00.000Z"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSnapshot advances lastTs to a long tool's completion, not its start", () => {
  const dir = mkdtempSync(join(tmpdir(), "stall-"));
  const path = join(dir, "s.jsonl");
  try {
    // a Bash that started 25m ago but only just finished — the result record is
    // the freshest activity, so lastTs must reflect it (else the stall sticks).
    const start = "2026-05-31T10:00:00.000Z";
    const done = "2026-05-31T10:25:00.000Z";
    const lines = [
      JSON.stringify({
        timestamp: start,
        message: {
          content: [{ type: "tool_use", id: "u1", name: "Bash", input: { command: "build" } }],
        },
      }),
      JSON.stringify({
        timestamp: done,
        message: { content: [{ type: "tool_result", tool_use_id: "u1", is_error: false }] },
      }),
    ];
    writeFileSync(path, lines.join("\n"));
    const snap = readSnapshot(path);
    expect(snap!.pending).toBe(false); // u1 now has a result
    expect(snap!.lastTs).toBe(Date.parse(done)); // completion, not the 25m-old start
    // measured from completion, it is NOT stalled
    expect(isStalled(snap!, Date.parse(done) + 60_000, DEFAULT_STALL)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSnapshot advances lastTs on a resumed turn with no new tool_use", () => {
  const dir = mkdtempSync(join(tmpdir(), "stall-"));
  const path = join(dir, "s.jsonl");
  try {
    // last tool_use is old, but the agent has since emitted a fresh assistant
    // turn (text only) — that progress must move lastTs and clear the stall.
    const lines = [
      JSON.stringify({
        timestamp: "2026-05-31T10:00:00.000Z",
        message: { content: [{ type: "tool_use", id: "u1", name: "Read", input: {} }] },
      }),
      JSON.stringify({
        timestamp: "2026-05-31T10:00:01.000Z",
        message: { content: [{ type: "tool_result", tool_use_id: "u1", is_error: false }] },
      }),
      JSON.stringify({
        timestamp: "2026-05-31T10:30:00.000Z",
        message: { content: [{ type: "text", text: "still thinking out loud" }] },
      }),
    ];
    writeFileSync(path, lines.join("\n"));
    const snap = readSnapshot(path);
    expect(snap!.pending).toBe(false);
    expect(snap!.lastTs).toBe(Date.parse("2026-05-31T10:30:00.000Z"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
