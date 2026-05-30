import { test, expect } from "bun:test";
import { accumulate, parseLine, dashify, jsonlPathFor } from "../src/usage";

function asst(opts: {
  model?: string;
  requestId?: string;
  ts?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  w5m?: number;
  w1h?: number;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: opts.ts ?? "2026-05-30T09:31:01.924Z",
    requestId: opts.requestId,
    message: {
      model: opts.model ?? "claude-opus-4-8",
      usage: {
        input_tokens: opts.input ?? 0,
        output_tokens: opts.output ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation: {
          ephemeral_5m_input_tokens: opts.w5m ?? 0,
          ephemeral_1h_input_tokens: opts.w1h ?? 0,
        },
      },
    },
  });
}

test("dashify replaces / and . with -", () => {
  expect(dashify("/home/patrick/Work/foo")).toBe("-home-patrick-Work-foo");
  expect(dashify("/home/patrick/.config/clawdzilla")).toBe("-home-patrick--config-clawdzilla");
});

test("jsonlPathFor composes projects dir + dashified cwd + session id", () => {
  const p = jsonlPathFor("/home/p/Work/r", "abc-123");
  expect(p.endsWith("/-home-p-Work-r/abc-123.jsonl")).toBe(true);
});

test("parseLine ignores non-assistant and usage-less records", () => {
  expect(parseLine(JSON.stringify({ type: "user", message: {} }))).toBeNull();
  expect(parseLine(JSON.stringify({ type: "assistant", message: {} }))).toBeNull();
  expect(parseLine("not json")).toBeNull();
  expect(parseLine("")).toBeNull();
});

test("accumulate sums token kinds and total", () => {
  const u = accumulate([
    asst({ requestId: "r1", input: 100, output: 50, cacheRead: 10, w5m: 5, w1h: 5 }),
    asst({ requestId: "r2", input: 200, output: 80 }),
  ]);
  expect(u.input).toBe(300);
  expect(u.output).toBe(130);
  expect(u.cacheRead).toBe(10);
  expect(u.cacheWrite).toBe(10); // 5m + 1h
  expect(u.total).toBe(300 + 130 + 10 + 10);
  expect(u.messageCount).toBe(2);
});

test("accumulate dedupes by requestId", () => {
  const u = accumulate([
    asst({ requestId: "r1", input: 100, output: 50 }),
    asst({ requestId: "r1", input: 100, output: 50 }), // retried iteration — skipped
    asst({ requestId: "r2", input: 7 }),
  ]);
  expect(u.input).toBe(107);
  expect(u.messageCount).toBe(2);
});

test("accumulate tracks byModel totals and lastActivity", () => {
  const u = accumulate([
    asst({
      requestId: "r1",
      model: "claude-opus-4-8",
      input: 10,
      output: 5,
      ts: "2026-05-30T09:00:00.000Z",
    }),
    asst({
      requestId: "r2",
      model: "claude-sonnet-4-6",
      input: 20,
      ts: "2026-05-30T10:00:00.000Z",
    }),
  ]);
  expect(u.byModel["claude-opus-4-8"]).toBe(15);
  expect(u.byModel["claude-sonnet-4-6"]).toBe(20);
  expect(u.lastActivity).toBe(Date.parse("2026-05-30T10:00:00.000Z"));
});

test("empty input → zeroed usage", () => {
  const u = accumulate([]);
  expect(u.total).toBe(0);
  expect(u.lastActivity).toBeNull();
});
