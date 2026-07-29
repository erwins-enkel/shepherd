import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseCodexUsage,
  parseCodexActivity,
  readCodexTranscriptSignals,
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
