import { test, expect } from "bun:test";
import { sessionCost } from "../src/usage";

// Weights from src/pricing.ts:
// opus:   input=5, output=25, cacheRead=0.5, cacheWrite5m=6.25, cacheWrite1h=10
// sonnet: input=3, output=15, cacheRead=0.3, cacheWrite5m=3.75, cacheWrite1h=6

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

const OLD_TS = "2026-01-01T00:00:00.000Z";
const NEW_TS = "2026-06-01T00:00:00.000Z";

test("weightedUnits equals hand-computed sum across two models", () => {
  // opus record: input=1000, output=500 → wu = (1000*5 + 500*25) / 1e6 = (5000+12500)/1e6 = 0.0175
  // sonnet record: input=2000, output=100 → wu = (2000*3 + 100*15) / 1e6 = (6000+1500)/1e6 = 0.0075
  const lines = [
    asst({ requestId: "r1", model: "claude-opus-4-8", input: 1000, output: 500 }),
    asst({ requestId: "r2", model: "claude-sonnet-4-6", input: 2000, output: 100 }),
  ];
  const result = sessionCost(lines);
  expect(result.weightedUnits).toBeCloseTo(0.0175 + 0.0075, 8);
});

test("weightedByModel splits correctly across two models", () => {
  const lines = [
    asst({ requestId: "r1", model: "claude-opus-4-8", input: 1000, output: 500 }),
    asst({ requestId: "r2", model: "claude-sonnet-4-6", input: 2000, output: 100 }),
  ];
  const result = sessionCost(lines);
  expect(result.weightedByModel["claude-opus-4-8"]).toBeCloseTo(0.0175, 8);
  expect(result.weightedByModel["claude-sonnet-4-6"]).toBeCloseTo(0.0075, 8);
});

test("cacheReadUnits equals cacheRead * weight.cacheRead / 1e6", () => {
  // opus cacheRead weight = 0.5; cacheRead=4000 → 4000*0.5/1e6 = 0.002
  const lines = [asst({ requestId: "r1", model: "claude-opus-4-8", cacheRead: 4000 })];
  const result = sessionCost(lines);
  expect(result.cacheReadUnits).toBeCloseTo(0.002, 8);
});

test("usage.input/output/cacheRead/total/messageCount match raw sums", () => {
  const lines = [
    asst({ requestId: "r1", input: 100, output: 50, cacheRead: 10, w5m: 5, w1h: 3 }),
    asst({ requestId: "r2", input: 200, output: 80, cacheRead: 20 }),
  ];
  const result = sessionCost(lines);
  expect(result.usage.input).toBe(300);
  expect(result.usage.output).toBe(130);
  expect(result.usage.cacheRead).toBe(30);
  expect(result.usage.cacheWrite).toBe(8); // 5+3
  expect(result.usage.total).toBe(300 + 130 + 30 + 8);
  expect(result.usage.messageCount).toBe(2);
});

test("sinceMs excludes old record from every figure", () => {
  const sinceMs = Date.parse("2026-03-01T00:00:00.000Z");
  // old record ts < sinceMs → excluded
  // new record ts > sinceMs → included
  const lines = [
    asst({ requestId: "r1", model: "claude-opus-4-8", input: 1000, output: 500, ts: OLD_TS }),
    asst({ requestId: "r2", model: "claude-opus-4-8", input: 300, output: 100, ts: NEW_TS }),
  ];
  const result = sessionCost(lines, sinceMs);
  // only r2 included: input=300, output=100 → wu = (300*5 + 100*25)/1e6 = (1500+2500)/1e6 = 0.004
  expect(result.usage.input).toBe(300);
  expect(result.usage.output).toBe(100);
  expect(result.usage.messageCount).toBe(1);
  expect(result.weightedUnits).toBeCloseTo(0.004, 8);
});

test("requestId dedupe counts duplicated line once", () => {
  const lines = [
    asst({ requestId: "r1", model: "claude-opus-4-8", input: 1000 }),
    asst({ requestId: "r1", model: "claude-opus-4-8", input: 1000 }), // duplicate
  ];
  const result = sessionCost(lines);
  expect(result.usage.input).toBe(1000);
  expect(result.usage.messageCount).toBe(1);
  // wu = 1000*5/1e6 = 0.005
  expect(result.weightedUnits).toBeCloseTo(0.005, 8);
});

test("record with ts=0 is always included even when sinceMs is set", () => {
  const sinceMs = Date.parse("2026-03-01T00:00:00.000Z");
  const lines = [
    // No timestamp → ts=0 → always included
    JSON.stringify({
      type: "assistant",
      requestId: "r1",
      message: {
        model: "claude-opus-4-8",
        usage: { input_tokens: 500, output_tokens: 0 },
      },
    }),
  ];
  const result = sessionCost(lines, sinceMs);
  expect(result.usage.input).toBe(500);
  expect(result.usage.messageCount).toBe(1);
});

test("fullRecaches and sidechainCount are 0", () => {
  const lines = [
    asst({ requestId: "r1", cacheRead: 5000 }),
    asst({ requestId: "r2", cacheRead: 0, w5m: 8000 }),
  ];
  const result = sessionCost(lines);
  expect(result.usage.fullRecaches).toBe(0);
  expect(result.usage.sidechainCount).toBe(0);
});
