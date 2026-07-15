import { test, expect } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accumulate,
  parseLine,
  dashify,
  jsonlPathFor,
  dominantModelOf,
  foldSessionBuckets,
  SessionUsageRollup,
  type RollupSession,
} from "../src/usage";
import { sessionCost } from "../src/usage";

function asst(opts: {
  model?: string;
  requestId?: string;
  ts?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  w5m?: number;
  w1h?: number;
  sidechain?: boolean;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: opts.ts ?? "2026-05-30T09:31:01.924Z",
    requestId: opts.requestId,
    ...(opts.sidechain ? { isSidechain: true } : {}),
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

test("jsonlPathFor roots under {spawnAccountDir}/projects when a swap/pool account is given", () => {
  // A claude-swap agent runs with CLAUDE_CONFIG_DIR=<account>, so it writes its JSONL to
  // <account>/projects/…, NOT the server's active config.claudeProjectsDir. Resolution must
  // follow the account or every transcript readback (usage/activity/halt/auth-url) misses.
  const acct = "/home/p/.local/share/claude-swap/sessions/acme";
  const p = jsonlPathFor("/home/p/Work/r", "abc-123", acct);
  expect(p).toBe(`${acct}/projects/-home-p-Work-r/abc-123.jsonl`);
});

test("jsonlPathFor falls back to the active projects dir when spawnAccountDir is null", () => {
  expect(jsonlPathFor("/home/p/Work/r", "abc-123", null)).toBe(
    jsonlPathFor("/home/p/Work/r", "abc-123"),
  );
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

// ── fullRecaches + sidechainCount ─────────────────────────────────────────────

test("opener cold record is NOT a fullRecache (no prior warm record)", () => {
  const u = accumulate([asst({ requestId: "r1", cacheRead: 0, w5m: 1000 })]);
  expect(u.fullRecaches).toBe(0);
});

test("warm → cold main-thread sequence counts as 1 fullRecache", () => {
  const u = accumulate([
    asst({ requestId: "r1", cacheRead: 5000, w5m: 0 }), // warm
    asst({ requestId: "r2", cacheRead: 0, w5m: 8000 }), // cold after warm → recache
  ]);
  expect(u.fullRecaches).toBe(1);
});

test("record with cacheRead>0 is never a fullRecache", () => {
  const u = accumulate([
    asst({ requestId: "r1", cacheRead: 5000 }), // warm
    asst({ requestId: "r2", cacheRead: 3000, w5m: 500 }), // still warm → not a recache
  ]);
  expect(u.fullRecaches).toBe(0);
});

test("sidechain cold record is NOT counted and does not reset main-thread warm state", () => {
  const u = accumulate([
    asst({ requestId: "r1", cacheRead: 5000 }), // main warm
    asst({ requestId: "r2", cacheRead: 0, w5m: 2000, sidechain: true }), // sidechain cold — should not count or reset
    asst({ requestId: "r3", cacheRead: 4000 }), // main warm again — still no recache
  ]);
  expect(u.fullRecaches).toBe(0);
});

test("cold→cold run counts at most once (first cold after warm)", () => {
  const u = accumulate([
    asst({ requestId: "r1", cacheRead: 5000 }), // warm
    asst({ requestId: "r2", cacheRead: 0, w5m: 1000 }), // cold → recache #1
    asst({ requestId: "r3", cacheRead: 0, w5m: 1000 }), // cold again → prev was 0, not warm, so no new recache
  ]);
  expect(u.fullRecaches).toBe(1);
});

test("duplicate requestId row does not corrupt edge detection (warm, dup-warm, cold → exactly 1)", () => {
  const u = accumulate([
    asst({ requestId: "r1", cacheRead: 5000 }), // warm, accepted
    asst({ requestId: "r1", cacheRead: 5000 }), // duplicate — skipped, must not advance prev
    asst({ requestId: "r2", cacheRead: 0, w5m: 3000 }), // cold after warm → 1 recache
  ]);
  expect(u.fullRecaches).toBe(1);
});

test("warm → cold with no cache write is NOT a fullRecache (cacheWrite>0 guard)", () => {
  const u = accumulate([
    asst({ requestId: "r1", cacheRead: 5000 }), // warm
    asst({ requestId: "r2", cacheRead: 0, w5m: 0, w1h: 0 }), // cold but no write → not a recache
  ]);
  expect(u.fullRecaches).toBe(0);
});

test("sidechainCount tallies isSidechain accepted records", () => {
  const u = accumulate([
    asst({ requestId: "r1", sidechain: true }),
    asst({ requestId: "r2", sidechain: true }),
    asst({ requestId: "r2", sidechain: true }), // duplicate — not counted
    asst({ requestId: "r3" }), // main — not counted
  ]);
  expect(u.sidechainCount).toBe(2);
});

// ── dominantModelOf ───────────────────────────────────────────────────────────

test("dominantModelOf picks the model with max weighted units", () => {
  expect(dominantModelOf({ "claude-opus-4-8": 100, "claude-sonnet-4-6": 200 })).toBe(
    "claude-sonnet-4-6",
  );
});

test("dominantModelOf skips the 'unknown' sentinel", () => {
  expect(dominantModelOf({ unknown: 9999, "claude-opus-4-8": 10 })).toBe("claude-opus-4-8");
});

test("dominantModelOf returns null on empty record", () => {
  expect(dominantModelOf({})).toBeNull();
});

test("dominantModelOf returns null when only 'unknown' is present", () => {
  expect(dominantModelOf({ unknown: 500 })).toBeNull();
});

// ── foldSessionBuckets ────────────────────────────────────────────────────────

// Fixture: two different hours + one ts=0 record, with distinct models and multiple token kinds.
// Anchored relative to "now" (~1 day ago) so the records always sit well inside the rollup's
// 30-day prune window. These used to be hard-coded 2026-05-30 calendar dates, which crossed the
// 30-day horizon as real time advanced and broke `verify` on every PR (issue #1222). Hour A and
// hour B are adjacent, distinct hour buckets — the fold/window/cutoff tests below depend on that.
const HOUR_MS = 3_600_000;
const HOUR_A_FLOOR = Math.floor((Date.now() - 86_400_000) / HOUR_MS) * HOUR_MS;
const TS_A = new Date(HOUR_A_FLOOR + 31 * 60_000 + 1_000).toISOString(); // hour A, :31:01
const TS_B = new Date(HOUR_A_FLOOR + HOUR_MS + 15 * 60_000).toISOString(); // hour B (= A+1h), :15:00

// Wall-clock anchor for the rollup tests below. The rollup prunes records older than
// `now − 30d`, so passing real `Date.now()` while the fixtures are pinned to fixed
// dates is a time-bomb: once the wall clock passes 30d after TS_A/TS_B, the fixtures
// age out of the window, get pruned, and windowedAccum() returns null. Anchoring `now`
// just after hour B keeps TS_A/TS_B deterministically in-window forever.
const NOW = Date.parse(TS_B) + 60_000;

// Make a ts=0 record by using an invalid timestamp
function asstNoTs(opts: Parameters<typeof asst>[0]): string {
  const o = JSON.parse(asst(opts));
  o.timestamp = "invalid"; // Date.parse("invalid") === NaN → 0
  return JSON.stringify(o);
}

const multiHourLinesFixed = [
  asst({
    requestId: "r1",
    model: "claude-opus-4-8",
    input: 100,
    output: 50,
    cacheRead: 10,
    w5m: 5,
    w1h: 3,
    ts: TS_A,
  }),
  asst({
    requestId: "r2",
    model: "claude-sonnet-4-6",
    input: 200,
    output: 80,
    cacheRead: 20,
    w5m: 8,
    ts: TS_B,
  }),
  asst({ requestId: "r3", model: "claude-opus-4-8", input: 50, output: 30, ts: TS_B }),
  asstNoTs({ requestId: "r4", model: "claude-haiku-4-5", input: 40, output: 20 }),
];

test("foldSessionBuckets: summing all buckets matches sessionCost totals (no window)", () => {
  const fold = foldSessionBuckets(multiHourLinesFixed);
  const ref = sessionCost(multiHourLinesFixed);

  let input = 0,
    output = 0,
    cacheRead = 0,
    cacheWrite = 0,
    weightedUnits = 0,
    cacheReadUnits = 0;
  const rawByModel: Record<string, number> = {};
  for (const b of fold.buckets.values()) {
    input += b.input;
    output += b.output;
    cacheRead += b.cacheRead;
    cacheWrite += b.cacheWrite;
    weightedUnits += b.weightedUnits;
    cacheReadUnits += b.cacheReadUnits;
    for (const [model, tokens] of Object.entries(b.rawByModel)) {
      rawByModel[model] = (rawByModel[model] ?? 0) + tokens;
    }
  }

  expect(input).toBe(ref.usage.input);
  expect(output).toBe(ref.usage.output);
  expect(cacheRead).toBe(ref.usage.cacheRead);
  expect(cacheWrite).toBe(ref.usage.cacheWrite);
  expect(weightedUnits).toBeCloseTo(ref.weightedUnits, 10);
  expect(cacheReadUnits).toBeCloseTo(ref.cacheReadUnits, 10);
  expect(rawByModel).toEqual(ref.usage.byModel);
  expect(fold.rawByModel).toEqual(ref.usage.byModel);
});

test("foldSessionBuckets: messageCount equals sessionCost messageCount", () => {
  const fold = foldSessionBuckets(multiHourLinesFixed);
  const ref = sessionCost(multiHourLinesFixed);
  expect(fold.messageCount).toBe(ref.usage.messageCount);
});

test("foldSessionBuckets: dedupes by requestId across buckets", () => {
  const dup = [
    asst({ requestId: "dup1", input: 100, ts: TS_A }),
    asst({ requestId: "dup1", input: 100, ts: TS_B }), // same requestId, different hour → skipped
  ];
  const fold = foldSessionBuckets(dup);
  expect(fold.messageCount).toBe(1);
  let total = 0;
  for (const b of fold.buckets.values()) total += b.input;
  expect(total).toBe(100);
});

test("foldSessionBuckets: ts=0 record folds into bucket 0", () => {
  const lines = [asstNoTs({ requestId: "r0", input: 77 })];
  const fold = foldSessionBuckets(lines);
  expect(fold.buckets.has(0)).toBe(true);
  expect(fold.buckets.get(0)!.input).toBe(77);
  expect(fold.buckets.get(0)!.rawByModel["claude-opus-4-8"]).toBe(77);
});

// ── SessionUsageRollup ────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rollup-test-"));
}

function makeSession(dir: string, id: string): RollupSession {
  return { id, worktreePath: dir, claudeSessionId: id };
}

// Override jsonlPathFor for tests by using worktreePath as the directory directly.
// We monkey-patch via a wrapper that creates a TestRollup subclass.
class TestRollup extends SessionUsageRollup {
  constructor(private dir: string) {
    super();
  }
  // Override to use dir+sessionId.jsonl as path
  protected override pathFor(worktreePath: string, sessionId: string): string {
    return join(this.dir, `${sessionId}.jsonl`);
  }
}

test("SessionUsageRollup: incremental append — second refresh sees appended bytes", async () => {
  const dir = makeTmpDir();
  const sessionId = "sess-inc";
  const path = join(dir, `${sessionId}.jsonl`);
  const lines1 = [asst({ requestId: "a1", input: 100, output: 50, ts: TS_A })];
  writeFileSync(path, lines1.join("\n") + "\n");

  const r = new TestRollup(dir);
  const sessions = [makeSession(dir, sessionId)];
  const now = NOW;
  await r.refresh(sessions, now);

  const w1 = r.windowedAccum(sessionId, 0);
  expect(w1).not.toBeNull();
  expect(w1!.input).toBe(100);

  // Append more bytes
  const lines2 = [asst({ requestId: "a2", input: 200, output: 80, ts: TS_B })];
  writeFileSync(path, [...lines1, ...lines2].join("\n") + "\n");
  await r.refresh(sessions, now);

  const ref = sessionCost([...lines1, ...lines2]);
  const w2 = r.windowedAccum(sessionId, 0);
  expect(w2!.input).toBe(ref.usage.input);
  expect(w2!.output).toBe(ref.usage.output);
  expect(w2!.weightedUnits).toBeCloseTo(ref.weightedUnits, 10);
});

test("SessionUsageRollup: single-flight — concurrent refresh() calls don't double-count", async () => {
  const dir = makeTmpDir();
  const sessionId = "sess-sf";
  const path = join(dir, `${sessionId}.jsonl`);
  // Use records WITHOUT requestId so they WOULD double-count if read twice
  const lines = [
    asst({ input: 100, output: 50 }), // no requestId
    asst({ input: 200, output: 80 }), // no requestId
  ];
  writeFileSync(path, lines.join("\n") + "\n");

  const r = new TestRollup(dir);
  const sessions = [makeSession(dir, sessionId)];
  const now = NOW;
  // Fire two concurrent refreshes
  await Promise.all([r.refresh(sessions, now), r.refresh(sessions, now)]);

  const w = r.windowedAccum(sessionId, 0);
  expect(w).not.toBeNull();
  // Should only count each record once
  expect(w!.input).toBe(300);
  expect(w!.output).toBe(130);
  expect(w!.messageCount).toBe(2);
});

test("SessionUsageRollup: dedupe before accumulate — duplicate requestId across chunks counted once", async () => {
  const dir = makeTmpDir();
  const sessionId = "sess-dup";
  const path = join(dir, `${sessionId}.jsonl`);
  const line = asst({ requestId: "dup-x", input: 100, output: 50, ts: TS_A });

  // First refresh with one record
  writeFileSync(path, line + "\n");
  const r = new TestRollup(dir);
  const sessions = [makeSession(dir, sessionId)];
  const now = NOW;
  await r.refresh(sessions, now);

  // Append the same requestId again (simulating duplicate)
  const dup = asst({ requestId: "dup-x", input: 100, output: 50, ts: TS_B });
  writeFileSync(path, line + "\n" + dup + "\n");
  await r.refresh(sessions, now);

  const w = r.windowedAccum(sessionId, 0);
  expect(w!.messageCount).toBe(1);
  expect(w!.input).toBe(100);
});

test("SessionUsageRollup: exact-cutoff windowing (cutoff>0) equals sessionCost(lines, cutoff)", async () => {
  const dir = makeTmpDir();
  const sessionId = "sess-cutoff";
  const path = join(dir, `${sessionId}.jsonl`);
  const lines = [
    asst({ requestId: "c1", input: 100, output: 50, cacheRead: 10, ts: TS_A }),
    asst({ requestId: "c2", input: 200, output: 80, ts: TS_B }),
    asstNoTs({ requestId: "c3", input: 40, output: 20 }), // ts=0 always included
  ];
  writeFileSync(path, lines.join("\n") + "\n");

  const r = new TestRollup(dir);
  const sessions = [makeSession(dir, sessionId)];
  const now = NOW;
  await r.refresh(sessions, now);

  // cutoff = floor of hour B = exclude TS_A records
  const hourBFloor = Math.floor(Date.parse(TS_B) / 3_600_000) * 3_600_000;
  const ref = sessionCost(lines, hourBFloor);
  const w = r.windowedAccum(sessionId, hourBFloor);
  expect(w).not.toBeNull();
  expect(w!.input).toBe(ref.usage.input);
  expect(w!.output).toBe(ref.usage.output);
  expect(w!.weightedUnits).toBeCloseTo(ref.weightedUnits, 10);
  expect(w!.cacheReadUnits).toBeCloseTo(ref.cacheReadUnits, 10);
});

test("SessionUsageRollup: cutoff===0 uses unpruned running agg — old record pruned from array but still in agg", async () => {
  const dir = makeTmpDir();
  const sessionId = "sess-agg";
  const path = join(dir, `${sessionId}.jsonl`);
  // Use ts=1 (epoch+1ms) for an old record
  const oldLine = JSON.stringify({
    type: "assistant",
    timestamp: new Date(1).toISOString(),
    requestId: "old1",
    message: {
      model: "claude-opus-4-8",
      usage: {
        input_tokens: 500,
        output_tokens: 100,
        cache_read_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      },
    },
  });
  const recentLine = asst({ requestId: "new1", input: 10, ts: TS_B });
  writeFileSync(path, [oldLine, recentLine].join("\n") + "\n");

  const r = new TestRollup(dir);
  const sessions = [makeSession(dir, sessionId)];
  // now = 30d + 60s + 2ms after ts=1, so the old record is prunable
  const THIRTY_DAYS = 30 * 86_400_000;
  const now = 1 + THIRTY_DAYS + 60_000 + 2;
  await r.refresh(sessions, now);

  const w = r.windowedAccum(sessionId, 0);
  expect(w).not.toBeNull();
  // cutoff===0 uses unpruned agg — both records counted
  expect(w!.messageCount).toBe(2);
  expect(w!.input).toBe(510);
});

test("SessionUsageRollup: 30d prune — array shrank, agg did not; requestId removed from seen", async () => {
  const dir = makeTmpDir();
  const sessionId = "sess-prune";
  const path = join(dir, `${sessionId}.jsonl`);
  const oldLine = JSON.stringify({
    type: "assistant",
    timestamp: new Date(1).toISOString(),
    requestId: "prune1",
    message: {
      model: "claude-opus-4-8",
      usage: {
        input_tokens: 300,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      },
    },
  });
  writeFileSync(path, oldLine + "\n");

  const r = new TestRollup(dir);
  const sessions = [makeSession(dir, sessionId)];
  const THIRTY_DAYS = 30 * 86_400_000;
  const now = 1 + THIRTY_DAYS + 60_000 + 2;
  await r.refresh(sessions, now);

  // The windowed (cutoff>0) view returns null because the only record was pruned from records[]
  const cutoff = now - THIRTY_DAYS;
  const w = r.windowedAccum(sessionId, cutoff);
  // Record ts=1 < cutoff, so not in window; ts=0 records are always included but there are none
  expect(w).toBeNull(); // messageCount===0 → null

  // But cutoff===0 still shows the agg
  const wAgg = r.windowedAccum(sessionId, 0);
  expect(wAgg).not.toBeNull();
  expect(wAgg!.messageCount).toBe(1);
});

test("SessionUsageRollup: truncation reset — size < offset resets state", async () => {
  const dir = makeTmpDir();
  const sessionId = "sess-trunc";
  const path = join(dir, `${sessionId}.jsonl`);
  const lines = [asst({ requestId: "t1", input: 100, ts: TS_A })];
  writeFileSync(path, lines.join("\n") + "\n");

  const r = new TestRollup(dir);
  const sessions = [makeSession(dir, sessionId)];
  const now = NOW;
  await r.refresh(sessions, now);

  const w1 = r.windowedAccum(sessionId, 0);
  expect(w1!.input).toBe(100);

  // Truncate: write fewer bytes (smaller file)
  const newLines = [asst({ requestId: "t2", input: 50, ts: TS_A })];
  writeFileSync(path, newLines.join("\n") + "\n");
  await r.refresh(sessions, now);

  // After reset, only the new content should be counted
  const w2 = r.windowedAccum(sessionId, 0);
  expect(w2!.input).toBe(50);
  expect(w2!.messageCount).toBe(1);
});

test("SessionUsageRollup: drop inactive sessions not in sessions arg", async () => {
  const dir = makeTmpDir();
  const sessA = "sess-drop-a";
  const sessB = "sess-drop-b";
  writeFileSync(
    join(dir, `${sessA}.jsonl`),
    asst({ requestId: "da1", input: 100, ts: TS_A }) + "\n",
  );
  writeFileSync(
    join(dir, `${sessB}.jsonl`),
    asst({ requestId: "db1", input: 200, ts: TS_A }) + "\n",
  );

  const r = new TestRollup(dir);
  const now = NOW;
  await r.refresh([makeSession(dir, sessA), makeSession(dir, sessB)], now);

  expect(r.windowedAccum(sessA, 0)).not.toBeNull();
  expect(r.windowedAccum(sessB, 0)).not.toBeNull();

  // Drop sessB from sessions list
  await r.refresh([makeSession(dir, sessA)], now);

  expect(r.windowedAccum(sessA, 0)).not.toBeNull();
  expect(r.windowedAccum(sessB, 0)).toBeNull();
});

test("SessionUsageRollup: windowedAccum returns null for unknown sessionId", async () => {
  const r = new SessionUsageRollup();
  expect(r.windowedAccum("no-such-session", 0)).toBeNull();
});

test("SessionUsageRollup: windowedAccum returns null for empty in-window set (messageCount===0)", async () => {
  const dir = makeTmpDir();
  const sessionId = "sess-empty-win";
  const path = join(dir, `${sessionId}.jsonl`);
  // Record is in hour A; cutoff is hour B → no in-window records
  writeFileSync(path, asst({ requestId: "ew1", input: 100, ts: TS_A }) + "\n");

  const r = new TestRollup(dir);
  const sessions = [makeSession(dir, sessionId)];
  const now = NOW;
  await r.refresh(sessions, now);

  const hourBFloor = Math.floor(Date.parse(TS_B) / 3_600_000) * 3_600_000;
  // TS_A is in hour 09:xx, hourBFloor is 10:00; TS_A < hourBFloor → excluded
  const w = r.windowedAccum(sessionId, hourBFloor);
  expect(w).toBeNull();
});

test("SessionUsageRollup: dominantModel for cutoff>0 from in-window raw tokens; cutoff===0 from session-wide agg", async () => {
  const dir = makeTmpDir();
  const sessionId = "sess-dom";
  const path = join(dir, `${sessionId}.jsonl`);
  // Hour A: opus with lots of tokens
  // Hour B: sonnet with fewer tokens
  const lines = [
    asst({ requestId: "dm1", model: "claude-opus-4-8", input: 1000, output: 500, ts: TS_A }),
    asst({ requestId: "dm2", model: "claude-sonnet-4-6", input: 50, output: 20, ts: TS_B }),
  ];
  writeFileSync(path, lines.join("\n") + "\n");

  const r = new TestRollup(dir);
  const sessions = [makeSession(dir, sessionId)];
  const now = NOW;
  await r.refresh(sessions, now);

  // cutoff===0 → session-wide: opus dominates
  const wAll = r.windowedAccum(sessionId, 0);
  expect(wAll!.dominantModel).toBe("claude-opus-4-8");

  // cutoff = hour B floor → only hour B in window → sonnet dominates
  const hourBFloor = Math.floor(Date.parse(TS_B) / 3_600_000) * 3_600_000;
  const wB = r.windowedAccum(sessionId, hourBFloor);
  expect(wB!.dominantModel).toBe("claude-sonnet-4-6");
});

test("SessionUsageRollup: prune walks all records even when first record is ts=0", async () => {
  // Regression: the old guard `st.records[0].ts > 0 && st.records[0].ts < cutoff` would
  // skip the prune loop entirely when the first record has ts=0, leaving stale real-ts
  // records and their requestIds in `seen` unbounded. The observable effect of that bug:
  // "old-real" stays in `seen`, so a later re-append of that requestId is deduped away.
  // With the fix, "old-real" is removed from `seen` during prune, so the re-appended line
  // IS counted. This test observes that via the in-window input total.
  const dir = makeTmpDir();
  const sessionId = "sess-prune-ts0-first";
  const path = join(dir, `${sessionId}.jsonl`);
  const THIRTY_DAYS = 30 * 86_400_000;

  // ts=0 record (invalid timestamp → Date.parse → NaN → 0)
  const ts0Line = asstNoTs({ requestId: "ts0-rec", input: 11 });

  // Old real-ts record: ts=1 (epoch+1ms), will be prunable
  const oldLine = JSON.stringify({
    type: "assistant",
    timestamp: new Date(1).toISOString(),
    requestId: "old-real",
    message: {
      model: "claude-opus-4-8",
      usage: {
        input_tokens: 777,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      },
    },
  });

  // Recent record
  const recentLine = asst({ requestId: "recent-rec", input: 99, ts: TS_B });

  // Order: ts=0 FIRST, then old real-ts, then recent — the bug skipped the prune when [0].ts===0
  writeFileSync(path, [ts0Line, oldLine, recentLine].join("\n") + "\n");

  const r = new TestRollup(dir);
  const sessions = [makeSession(dir, sessionId)];
  // now far enough past ts=1 to make oldLine prunable
  const now = 1 + THIRTY_DAYS + 60_000 + 2;
  await r.refresh(sessions, now);

  // Sanity: ts=0 record is still counted in-window (never pruned)
  const cutoff = now - THIRTY_DAYS - 60_000;
  const wAfterFirst = r.windowedAccum(sessionId, cutoff);
  expect(wAfterFirst).not.toBeNull();
  expect(wAfterFirst!.input >= 11).toBe(true); // ts0Line still present

  // KEY assertion: re-append a NEW line reusing requestId "old-real" with a recent timestamp
  // and a distinctive input (500). If the prune correctly removed "old-real" from `seen`,
  // the rollup will accept this line and count it. If the bug is present ("old-real" still in
  // `seen`), the line is deduped away and the total stays at 11+99=110.
  const reAppendedLine = JSON.stringify({
    type: "assistant",
    timestamp: new Date(now - 1).toISOString(), // recent: well within window (>= cutoff=3)
    requestId: "old-real",
    message: {
      model: "claude-opus-4-8",
      usage: {
        input_tokens: 500,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      },
    },
  });
  appendFileSync(path, reAppendedLine + "\n");
  await r.refresh(sessions, now);

  // With the fix: "old-real" was pruned from `seen` → re-appended line accepted → 11+99+500=610
  // With the bug: "old-real" still in `seen` → re-appended line deduped → 11+99=110 (assertion fails)
  const wAfterReappend = r.windowedAccum(sessionId, cutoff);
  expect(wAfterReappend).not.toBeNull();
  expect(wAfterReappend!.input).toBe(11 + 99 + 500); // 610
});
