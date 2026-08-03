import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseCodexUsage,
  parseCodexActivity,
  readCodexTranscriptSignals,
  codexSessionActivity,
  CodexTranscriptLocator,
} from "../src/codex-activity";

const FIXTURE_PATH = join(import.meta.dir, "fixtures/codex-activity/rollout-role-exec.jsonl");
const FIXTURE = readFileSync(FIXTURE_PATH, "utf8");

describe("parseCodexUsage", () => {
  // The invariant that catches BOTH token traps in one assertion:
  //  - cumulative total_token_usage (summing events would 6× overcount)
  //  - cached_input_tokens ⊂ input_tokens (double-counting cache reads)
  // Expected value is the LAST token_count's total_tokens, an independent literal
  // from the fixture (52976), not recomputed the way the code computes it.
  test("total equals the last token_count's total_tokens (not the sum)", () => {
    const u = parseCodexUsage(FIXTURE, "gpt-5.6-sol");
    expect(u.total).toBe(52976);
  });

  test("maps disjoint buckets: cacheRead is the cached subset, input excludes it", () => {
    const u = parseCodexUsage(FIXTURE, "gpt-5.6-sol");
    expect(u.cacheRead).toBe(34304); // cached_input_tokens
    expect(u.input).toBe(52001 - 34304); // input_tokens − cached_input_tokens
    expect(u.output).toBe(975); // output_tokens, reasoning NOT added
    expect(u.cacheWrite).toBe(0); // OpenAI: no write premium
    // disjoint-bucket sum must reconstruct the reported total
    expect(u.input + u.output + u.cacheRead + u.cacheWrite).toBe(u.total);
  });

  test("messageCount counts token_count events; byModel keyed by the model hint", () => {
    const u = parseCodexUsage(FIXTURE, "gpt-5.6-sol");
    expect(u.messageCount).toBe(2);
    expect(u.byModel).toEqual({ "gpt-5.6-sol": 52976 });
    expect(u.lastActivity).toBe(Date.parse("2026-07-17T05:45:32.000Z"));
  });

  test("no model hint → byModel keyed 'unknown'", () => {
    const u = parseCodexUsage(FIXTURE);
    expect(u.byModel).toEqual({ unknown: 52976 });
  });

  test("no token_count events → zeroed usage, no throw", () => {
    const u = parseCodexUsage('{"type":"session_meta","payload":{"cwd":"/x"}}\n');
    expect(u.total).toBe(0);
    expect(u.messageCount).toBe(0);
    expect(u.lastActivity).toBeNull();
  });
});

describe("parseCodexActivity", () => {
  test("exec call → '$ <cmd>' summary, ts from the record", () => {
    const entries = parseCodexActivity(FIXTURE, -1);
    const ok = entries.find((e) => e.summary === "$ git diff --stat");
    expect(ok).toBeDefined();
    expect(ok!.tool).toBe("exec");
    expect(ok!.ts).toBe(Date.parse("2026-07-17T05:45:20.000Z"));
  });

  // status carries stall detection (snapshotFrom reads only `pending`), so all
  // three states must be derived correctly.
  test("status: ok / error (nonzero Exit code) / pending (no output)", () => {
    const entries = parseCodexActivity(FIXTURE, -1);
    const byCmd = (needle: string) => entries.find((e) => e.summary.includes(needle))!;
    expect(byCmd("git diff").status).toBe("ok"); // Exit code: 0
    expect(byCmd("bun test").status).toBe("error"); // Exit code: 1
    expect(byCmd("sleep 5").status).toBe("pending"); // no matching output
  });

  test("degradation: unknown input shape → no throw, falls back to the tool name", () => {
    const entries = parseCodexActivity(FIXTURE, -1);
    const weird = entries.find((e) => e.tool === "apply_patch");
    expect(weird).toBeDefined();
    expect(weird!.summary.length).toBeGreaterThan(0); // some fallback, not a crash
  });

  test("empty / garbage input → [] (no throw)", () => {
    expect(parseCodexActivity("", -1)).toEqual([]);
    expect(parseCodexActivity("not json\n{broken", -1)).toEqual([]);
  });

  // Real reviewer rollouts wrap apply_patch in an `exec` call whose input builds a
  // `*** Begin Patch` string (no `cmd:`); surfacing the touched file beats "exec".
  test("exec wrapping apply_patch → 'patch <file>' summary", () => {
    const input =
      'const patch = "*** Begin Patch\\n*** Update File: src/withdrawal.ts\\n+foo";\n' +
      "await tools.apply_patch({input: patch});\n";
    const rec = JSON.stringify({
      timestamp: "2026-07-17T05:45:40.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        status: "completed",
        call_id: "c1",
        name: "exec",
        input,
      },
    });
    const entries = parseCodexActivity(rec + "\n", -1);
    expect(entries[0]!.summary).toBe("patch withdrawal.ts");
  });

  test("limit returns the most-recent N (oldest→newest)", () => {
    const all = parseCodexActivity(FIXTURE, -1);
    const last2 = parseCodexActivity(FIXTURE, 2);
    expect(last2).toEqual(all.slice(-2));
  });
});

describe("readCodexTranscriptSignals", () => {
  test("feeds BOTH snapshot and activity from one parse (like the claude peer)", () => {
    const { snapshot, activity } = readCodexTranscriptSignals(FIXTURE_PATH);
    expect(activity).not.toBeNull();
    expect(snapshot).not.toBeNull();
    // heat-strip: recent tool-use timestamps are present
    expect(activity!.recentTs.length).toBeGreaterThan(0);
    // an errored call tints its slice red
    expect(activity!.recentErrTs).toContain(Date.parse("2026-07-17T05:45:25.000Z"));
    // the last call (sleep... wait, apply_patch at 05:45:31) has no output → pending,
    // which is exactly what stall detection reads.
    expect(snapshot!.pending).toBe(true);
  });

  test("missing file → both null (no throw)", () => {
    const r = readCodexTranscriptSignals(join(import.meta.dir, "fixtures/does-not-exist.jsonl"));
    expect(r.snapshot).toBeNull();
    expect(r.activity).toBeNull();
  });
});

describe("codexSessionActivity", () => {
  test("reads + parses a rollout into the same entries parseCodexActivity yields", async () => {
    expect(await codexSessionActivity(FIXTURE_PATH, -1)).toEqual(parseCodexActivity(FIXTURE, -1));
  });

  test("missing file → [] (the Activity tab degrades, never 500s)", async () => {
    expect(await codexSessionActivity(join(import.meta.dir, "fixtures/nope.jsonl"))).toEqual([]);
  });

  test("unreadable path (a directory) → [] rather than a throw", async () => {
    expect(await codexSessionActivity(import.meta.dir)).toEqual([]);
  });
});

describe("CodexTranscriptLocator", () => {
  const SESSION = {
    id: "sess-1",
    worktreePath: "/wt/task-1",
    createdAt: 10_000_000,
    isolated: true,
  };

  /** Controllable clock + a spy-able finder — no filesystem in the loop. */
  function harness(found: { id: string; path: string } | null) {
    let now = 0;
    let result = found;
    const calls: Array<{ worktreePath: string; notBeforeMs: number }> = [];
    const locator = new CodexTranscriptLocator({
      now: () => now,
      find: (worktreePath, notBeforeMs) => {
        calls.push({ worktreePath, notBeforeMs });
        return result;
      },
    });
    return {
      locator,
      calls,
      advance: (ms: number) => {
        now += ms;
      },
      setResult: (r: { id: string; path: string } | null) => {
        result = r;
      },
    };
  }

  const HIT = { id: "roll-a", path: "/codex/rollout-a.jsonl" };

  test("resolves through find() and memoises — the 5s poll does not rescan", () => {
    const h = harness(HIT);
    expect(h.locator.pathFor(SESSION)).toBe(HIT.path);
    h.advance(5_000);
    expect(h.locator.pathFor(SESSION)).toBe(HIT.path);
    h.advance(5_000);
    expect(h.locator.pathFor(SESSION)).toBe(HIT.path);
    expect(h.calls.length).toBe(1);
  });

  test("scans with the createdAt mtime floor, minus the clock-skew allowance", () => {
    const h = harness(HIT);
    h.locator.pathFor(SESSION);
    expect(h.calls[0]).toEqual({
      worktreePath: SESSION.worktreePath,
      notBeforeMs: SESSION.createdAt - 5 * 60_000,
    });
  });

  test("past the TTL it re-derives — a restore's NEW rollout is picked up", () => {
    const h = harness(HIT);
    expect(h.locator.pathFor(SESSION)).toBe(HIT.path);
    const next = { id: "roll-b", path: "/codex/rollout-b.jsonl" };
    h.setResult(next);
    h.advance(29_000); // still inside the TTL → stale path, no rescan
    expect(h.locator.pathFor(SESSION)).toBe(HIT.path);
    h.advance(2_000); // 31s > TTL
    expect(h.locator.pathFor(SESSION)).toBe(next.path);
    expect(h.calls.length).toBe(2);
  });

  test("misses back off exponentially, capped, and clear on a later hit", () => {
    const h = harness(null);
    expect(h.locator.pathFor(SESSION)).toBeNull(); // scan 1 → backoff 2s
    h.advance(1_000);
    expect(h.locator.pathFor(SESSION)).toBeNull(); // inside backoff → no scan
    expect(h.calls.length).toBe(1);
    h.advance(1_000);
    expect(h.locator.pathFor(SESSION)).toBeNull(); // scan 2 → backoff 4s
    expect(h.calls.length).toBe(2);

    // widen past the cap: 8s, 16s→capped 15s, …
    for (const step of [4_000, 8_000, 15_000, 15_000]) {
      h.advance(step);
      expect(h.locator.pathFor(SESSION)).toBeNull();
    }
    expect(h.calls.length).toBe(6);

    // a rollout finally appears: the next attempt after the cap resolves and drops the backoff
    h.setResult(HIT);
    h.advance(15_000);
    expect(h.locator.pathFor(SESSION)).toBe(HIT.path);
    h.setResult(null); // a hit is memoised, so no rescan can undo it inside the TTL
    h.advance(1_000);
    expect(h.locator.pathFor(SESSION)).toBe(HIT.path);
    expect(h.calls.length).toBe(7);
  });

  test("non-isolated session → null without ever scanning (cwd is unattributable)", () => {
    const h = harness(HIT);
    expect(h.locator.pathFor({ ...SESSION, isolated: false })).toBeNull();
    expect(h.calls.length).toBe(0);
  });

  test("reset() drops both the memoised hit and the backoff", () => {
    const h = harness(HIT);
    expect(h.locator.pathFor(SESSION)).toBe(HIT.path);
    h.locator.reset(SESSION.id);
    expect(h.locator.pathFor(SESSION)).toBe(HIT.path);
    expect(h.calls.length).toBe(2);
  });

  test("caches per session id — two sessions never share a resolution", () => {
    const h = harness(HIT);
    expect(h.locator.pathFor(SESSION)).toBe(HIT.path);
    const other = {
      id: "sess-2",
      worktreePath: "/wt/task-2",
      createdAt: 20_000_000,
      isolated: true,
    };
    const b = { id: "roll-b", path: "/codex/rollout-b.jsonl" };
    h.setResult(b);
    expect(h.locator.pathFor(other)).toBe(b.path);
    expect(h.locator.pathFor(SESSION)).toBe(HIT.path);
    expect(h.calls.length).toBe(2);
  });
});
