import { test, expect, describe, spyOn } from "bun:test";
import {
  GO_MARKER,
  EXECUTOR_MODEL,
  phaseSplit,
  counterfactuals,
  cohortOf,
  phaseRow,
  cohortSummary,
  PHASE_HEADERS,
  phaseRowCells,
  SUMMARY_HEADERS,
  summaryCells,
  KIND_HEADERS,
  execKindCells,
  DIST_HEADERS,
  distributionRows,
  BUCKET_HEADERS,
  lengthBucketRows,
} from "../scripts/usage-phase-split";
import { weightedUnits, coldResumeUnits, MAIN_SESSION_CACHE_TTL } from "../src/pricing";
import { planGoSteer } from "../src/service";

const OPUS = "claude-opus-5-5";

interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cw5?: number;
  cw1h?: number;
}

let reqSeq = 0;
function asst(
  u: Usage,
  opts: { model?: string; requestId?: string; sidechain?: boolean; content?: unknown[] } = {},
): string {
  return JSON.stringify({
    type: "assistant",
    isSidechain: opts.sidechain ?? false,
    requestId: opts.requestId ?? `req-${++reqSeq}`,
    timestamp: "2026-11-01T00:00:00.000Z",
    message: {
      role: "assistant",
      model: opts.model ?? OPUS,
      content: opts.content ?? [],
      usage: {
        input_tokens: u.input ?? 0,
        output_tokens: u.output ?? 0,
        cache_read_input_tokens: u.cacheRead ?? 0,
        cache_creation_input_tokens: (u.cw5 ?? 0) + (u.cw1h ?? 0),
        cache_creation: {
          ephemeral_5m_input_tokens: u.cw5 ?? 0,
          ephemeral_1h_input_tokens: u.cw1h ?? 0,
        },
      },
    },
  });
}

function user(content: unknown, sidechain = false): string {
  return JSON.stringify({
    type: "user",
    isSidechain: sidechain,
    message: { role: "user", content },
  });
}

const GO = `\n\n<pasted_content id="27e8">\n${planGoSteer(false)}\n</pasted_content id="27e8">`;

function planWrite(content: string): unknown[] {
  return [
    { type: "tool_use", name: "Write", input: { file_path: "/wt/.shepherd-plan.md", content } },
  ];
}

/** opener 10k ctx → planning grows to 50k → Go → two exec turns at ~55k/60k ctx. */
function session(): string[] {
  return [
    user("do the task"),
    asst({ input: 2_000, cw1h: 8_000, output: 100 }), // opener ctx 10k
    asst(
      { input: 10, cacheRead: 10_000, cw1h: 30_000, output: 500 },
      { content: planWrite("x".repeat(4_000)) },
    ),
    asst({ input: 10, cacheRead: 40_000, cw1h: 9_990, output: 300 }), // ctx 50k = P
    user(GO),
    asst({ input: 10, cacheRead: 50_000, cw1h: 4_990, output: 2_000 }),
    asst({ input: 10, cacheRead: 55_000, cw1h: 4_990, output: 1_000 }),
  ];
}

describe("phaseSplit", () => {
  test("no Go marker → null", () => {
    expect(phaseSplit([user("hi"), asst({ input: 5 })])).toBeNull();
  });

  test("Go marker survives the pasted_content wrapper and block content", () => {
    expect(phaseSplit([asst({ input: 1 }), user(GO)])).not.toBeNull();
    expect(phaseSplit([asst({ input: 1 }), user([{ type: "text", text: GO }])])).not.toBeNull();
  });

  test("marker quoted mid-message or in a sidechain does not count", () => {
    expect(phaseSplit([user(`please note: ${GO_MARKER}`)])).toBeNull();
    expect(phaseSplit([user(GO, true)])).toBeNull();
  });

  test("splits records at the first Go; P, O and plan size", () => {
    const s = phaseSplit(session())!;
    expect(s.planning.requests).toBe(3);
    expect(s.execution.requests).toBe(2);
    expect(s.contextAtGo).toBe(50_000);
    expect(s.openerContext).toBe(10_000);
    expect(s.planTokens).toBe(1_000);
    expect(s.planSizeKnown).toBe(true);
    expect(s.regated).toBe(false);
    expect(s.execution.output).toBe(3_000);
  });

  test("phase costs sum to the whole transcript's weighted units", () => {
    const lines = session();
    const s = phaseSplit(lines)!;
    const whole = lines
      .map((l) => JSON.parse(l))
      .filter((o) => o.type === "assistant")
      .reduce((acc, o) => {
        const u = o.message.usage;
        return (
          acc +
          weightedUnits(
            {
              input: u.input_tokens,
              output: u.output_tokens,
              cacheRead: u.cache_read_input_tokens,
              cacheWrite5m: u.cache_creation.ephemeral_5m_input_tokens,
              cacheWrite1h: u.cache_creation.ephemeral_1h_input_tokens,
            },
            OPUS,
          )
        );
      }, 0);
    expect(s.planning.units + s.execution.units).toBeCloseTo(whole, 9);
  });

  test("duplicate requestId lines count once", () => {
    const dup = asst({ input: 100, output: 10 }, { requestId: "same" });
    const s = phaseSplit([dup, dup, user(GO), asst({ input: 1 })])!;
    expect(s.planning.requests).toBe(1);
    expect(s.planning.input).toBe(100);
  });

  test("sidechains count toward cost but not toward P or O", () => {
    const s = phaseSplit([
      asst({ input: 900_000 }, { sidechain: true }),
      asst({ input: 1_000 }),
      asst({ input: 2_000 }),
      asst({ input: 700_000 }, { sidechain: true }),
      user(GO),
      asst({ cacheRead: 2_000 }),
    ])!;
    expect(s.openerContext).toBe(1_000);
    expect(s.contextAtGo).toBe(2_000);
    expect(s.planning.input).toBe(1_603_000);
    expect(s.planSizeKnown).toBe(false);
  });

  test("a later re-gate steer flags the session; later Go lines stay execution", () => {
    const s = phaseSplit([
      asst({ input: 1 }),
      user(GO),
      asst({ input: 1 }),
      user("STOP implementing. Your plan was edited after it was approved, …"),
      asst({ input: 1 }),
      user(GO),
      asst({ input: 1 }),
    ])!;
    expect(s.regated).toBe(true);
    expect(s.planning.requests).toBe(1);
    expect(s.execution.requests).toBe(3);
  });
});

describe("counterfactuals", () => {
  test("tier re-prices execution records at the executor model", () => {
    const s = phaseSplit(session())!;
    const cf = counterfactuals(s);
    expect(cf.actual).toBeCloseTo(s.execution.units, 9);
    const exec = s.execRecords.reduce((a, r) => a + weightedUnits(r, EXECUTOR_MODEL), 0);
    expect(cf.tier).toBeCloseTo(exec, 9);
    expect(cf.tier).toBeLessThan(cf.actual);
  });

  test("reset drops the carried planning context and pays one fresh opener write", () => {
    const s = phaseSplit(session())!;
    const cf = counterfactuals(s);
    const carried = 50_000 - (10_000 + 1_000); // P − O
    const savedUnits = weightedUnits(
      { input: 0, output: 0, cacheRead: carried * 2, cacheWrite5m: 0, cacheWrite1h: 0 },
      OPUS,
    );
    const opener = coldResumeUnits(11_000, OPUS, MAIN_SESSION_CACHE_TTL);
    expect(cf.reset).toBeCloseTo(cf.actual - savedUnits + opener, 9);
    expect(cf.combined).toBeLessThan(cf.tier);
    expect(cf.combined).toBeLessThan(cf.reset);
  });

  test("a cold first execution turn: carried tokens leave its writes too, no second opener write", () => {
    // P = 50k, O = 10k opener + 0 plan → carried 40k. The first exec turn rebuilt the cache cold:
    // 24k warm read + 30k written (54k ctx). Fresh agent: 40k fewer prefix tokens — all 24k reads,
    // then 16k of the writes — and that trimmed write IS its opener write (no extra charge).
    const s = phaseSplit([
      asst({ input: 2_000, cw1h: 8_000 }),
      asst({ cacheRead: 10_000, cw1h: 40_000 }),
      user(GO),
      asst({ cacheRead: 24_000, cw1h: 30_000, output: 500 }),
    ])!;
    const cf = counterfactuals(s);
    const fresh = { input: 0, output: 500, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 14_000 };
    expect(cf.reset).toBeCloseTo(weightedUnits(fresh, OPUS), 9);
    expect(cf.combined).toBeCloseTo(weightedUnits(fresh, EXECUTOR_MODEL), 9);
    expect(cf.inPane).toBeCloseTo(cf.tier, 9);
    expect(cf.reset).toBeLessThan(cf.actual);
  });

  test("warm first execution turn: in-pane switch pays one cold rebuild of ctx@Go", () => {
    const s = phaseSplit(session())!;
    const cf = counterfactuals(s);
    expect(cf.inPane).toBeCloseTo(
      cf.tier + coldResumeUnits(50_000, EXECUTOR_MODEL, MAIN_SESSION_CACHE_TTL),
      9,
    );
  });

  test("no execution turn after Go → all-zero counterfactuals, no unknown-model warning", () => {
    const warn = spyOn(console, "warn");
    try {
      const cf = counterfactuals(phaseSplit([asst({ input: 5_000 }), user(GO)])!);
      expect(cf).toEqual({ actual: 0, tier: 0, reset: 0, combined: 0, inPane: 0 });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("P ≤ O clamps the carried context to zero", () => {
    const s = phaseSplit([asst({ input: 5_000 }), user(GO), asst({ cacheRead: 5_000 })])!;
    const cf = counterfactuals(s);
    expect(cf.reset).toBeCloseTo(
      cf.actual + coldResumeUnits(5_000, OPUS, MAIN_SESSION_CACHE_TTL),
      9,
    );
  });
});

describe("cohorts", () => {
  test("switched only when the execution effort is the one in force and differs", () => {
    expect(cohortOf({ executionEffort: "medium", activeEffort: "medium", effort: "high" })).toBe(
      "switched",
    );
    expect(cohortOf({ executionEffort: "medium", activeEffort: "high", effort: "high" })).toBe(
      "baseline",
    );
    expect(cohortOf({ executionEffort: null, activeEffort: null, effort: "high" })).toBe(
      "baseline",
    );
    expect(cohortOf({ executionEffort: "high", activeEffort: "high", effort: "high" })).toBe(
      "baseline",
    );
  });

  test("summary: per-cohort n, medians, savings % and an all row; cells match headers", () => {
    const s = phaseSplit(session())!;
    const meta = { desig: "TASK-1", model: OPUS };
    const a = phaseRow({ ...meta, cohort: "switched" }, s);
    const b = phaseRow({ ...meta, desig: "TASK-2", cohort: "baseline" }, s);
    const c = phaseRow({ ...meta, desig: "TASK-3", cohort: "baseline" }, s);
    const sum = cohortSummary([a, b, c]);
    expect(sum.map((x) => [x.cohort, x.n])).toEqual([
      ["switched", 1],
      ["baseline", 2],
      ["all", 3],
    ]);
    const all = sum[2]!;
    expect(all.execShare).toBeCloseTo(
      s.execution.units / (s.planning.units + s.execution.units),
      9,
    );
    expect(all.execOutputPerReqMedian).toBe(1_500);
    expect(all.tierPct).toBeGreaterThan(0);
    expect(phaseRowCells(a)).toHaveLength(PHASE_HEADERS.length);
    expect(summaryCells(all)).toHaveLength(SUMMARY_HEADERS.length);
  });

  test("an empty cohort renders without NaN", () => {
    const sum = cohortSummary([]);
    expect(sum.every((x) => x.n === 0)).toBe(true);
    expect(summaryCells(sum[0]!).join(" ")).not.toContain("NaN");
  });
});

describe("supporting tables", () => {
  test("kind shares, distributions and length buckets match their headers", () => {
    const s = phaseSplit(session())!;
    const rows = [phaseRow({ desig: "TASK-1", model: OPUS, cohort: "baseline" }, s)];
    const kinds = execKindCells(rows);
    expect(kinds).toHaveLength(KIND_HEADERS.length);
    const shareSum = kinds.slice(1).reduce((a, c) => a + Number.parseFloat(c), 0);
    expect(shareSum).toBeCloseTo(100, 0);
    const dist = distributionRows(rows);
    expect(dist.every((r) => r.length === DIST_HEADERS.length)).toBe(true);
    expect(dist[1]).toEqual(["Context at Go (tokens)", "50,000", "50,000", "50,000"]);
    const buckets = lengthBucketRows(rows);
    expect(buckets.every((r) => r.length === BUCKET_HEADERS.length)).toBe(true);
    expect(buckets.map((b) => b[1])).toEqual(["1", "0", "0", "0"]);
  });

  test("empty input renders without NaN", () => {
    const cells = [execKindCells([]), ...distributionRows([]), ...lengthBucketRows([])].flat();
    expect(cells.join(" ")).not.toContain("NaN");
  });
});

describe("drift guard", () => {
  test("every Go steer variant starts with GO_MARKER", () => {
    expect(planGoSteer(false).startsWith(GO_MARKER)).toBe(true);
    expect(planGoSteer(true, { agentProvider: "claude" }).startsWith(GO_MARKER)).toBe(true);
    expect(planGoSteer(false, undefined, "edits").startsWith(GO_MARKER)).toBe(true);
  });
});
