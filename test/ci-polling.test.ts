import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCiPolling, isCiWaitCommand } from "../src/ci-polling";
import { codexCiPolling, readCodexTranscriptSignals } from "../src/codex-activity";
import { signalFromText } from "../src/activity-signal";

const T0 = Date.parse("2026-11-07T10:00:00Z");
const iso = (i: number) => new Date(T0 + i * 30_000).toISOString();

/** One Claude assistant record making one tool call. */
function claudeCall(
  i: number,
  name: string,
  input: Record<string, unknown>,
  usage = { input_tokens: 10, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2_000 },
  id = `msg_${i}`,
) {
  return {
    type: "assistant",
    timestamp: iso(i),
    message: {
      id,
      usage,
      content: [{ type: "tool_use", id: `tu_${i}`, name, input }],
    },
  };
}
const bash = (i: number, command: string) => claudeCall(i, "Bash", { command });
const POLL = "sleep 30 && gh run view 123 --json status,conclusion";

test("isCiWaitCommand accepts sleeps and CI reads only", () => {
  expect(isCiWaitCommand("sleep 30")).toBe(true);
  expect(isCiWaitCommand(POLL)).toBe(true);
  expect(isCiWaitCommand("gh pr checks 12 --watch")).toBe(true);
  expect(isCiWaitCommand("gh run watch 99; sleep 5")).toBe(true);
  expect(isCiWaitCommand("gh run list --branch x | head -3")).toBe(true);
  expect(isCiWaitCommand("gh api repos/o/r/commits/abc/check-runs")).toBe(true);
  expect(isCiWaitCommand("git push && gh pr checks")).toBe(false);
  expect(isCiWaitCommand("gh run view 123 --log-failed")).toBe(false);
  expect(isCiWaitCommand("bun test")).toBe(false);
  expect(isCiWaitCommand("")).toBe(false);
});

test("Claude: a trailing run of 3+ CI polls is detected with its input tokens", () => {
  const objs = [bash(0, "git push"), bash(1, POLL), bash(2, POLL), bash(3, POLL)];
  expect(claudeCiPolling(objs)).toEqual({
    polls: 3,
    inputTokens: 3 * 42_010,
    since: T0 + 30_000,
  });
});

test("Claude: two polls, or a run broken by other work, is not polling", () => {
  expect(claudeCiPolling([bash(0, POLL), bash(1, POLL)])).toBeNull();
  const broken = [
    bash(0, POLL),
    bash(1, POLL),
    claudeCall(2, "Read", { file_path: "/x" }),
    bash(3, POLL),
  ];
  expect(claudeCiPolling(broken)).toBeNull();
  expect(claudeCiPolling([bash(0, POLL), bash(1, POLL), bash(2, "git push")])).toBeNull();
  expect(claudeCiPolling([bash(0, "sleep 30"), bash(1, "sleep 30"), bash(2, "sleep 30")])).toBe(
    null,
  );
});

test("Claude: one API message split over records is priced once", () => {
  const u = { input_tokens: 0, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 0 };
  const objs = [
    claudeCall(0, "Bash", { command: "gh pr checks" }, u, "m1"),
    claudeCall(1, "Bash", { command: "gh pr checks" }, u, "m1"),
    claudeCall(2, "Bash", { command: "gh pr checks" }, u, "m2"),
  ];
  expect(claudeCiPolling(objs)?.inputTokens).toBe(2_000);
});

/** Codex rollout records: an `exec` call and a cumulative token_count event. */
const codexExec = (i: number, cmd: string) => ({
  type: "response_item",
  timestamp: iso(i),
  payload: {
    type: "custom_tool_call",
    name: "exec",
    call_id: `c${i}`,
    input: `await tools.exec_command({cmd: ${JSON.stringify(cmd)}, workdir: "/w"})`,
  },
});
const codexShell = (i: number, command: string[]) => ({
  type: "response_item",
  timestamp: iso(i),
  payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command }) },
});
const tokens = (i: number, input: number) => ({
  type: "event_msg",
  timestamp: iso(i),
  payload: { type: "token_count", info: { total_token_usage: { input_tokens: input } } },
});

test("Codex: polling is priced as the cumulative input delta across the run", () => {
  const objs = [
    codexExec(0, "git push"),
    tokens(0, 100_000),
    codexExec(1, POLL),
    tokens(1, 142_000),
    codexShell(2, ["bash", "-lc", "gh run view 123"]),
    tokens(2, 184_000),
    codexExec(3, "sleep 30; gh pr checks 9"),
    tokens(3, 226_000),
  ];
  expect(codexCiPolling(objs)).toEqual({
    polls: 3,
    inputTokens: 126_000,
    since: T0 + 30_000,
  });
});

test("Codex: an interleaved non-wait call ends the run", () => {
  const objs = [
    codexExec(0, POLL),
    codexExec(1, POLL),
    codexExec(2, "bun test"),
    codexExec(3, POLL),
  ];
  expect(codexCiPolling(objs)).toBeNull();
});

test("the activity signal carries the reading only while the agent polls", () => {
  const polling = [bash(0, POLL), bash(1, POLL), bash(2, POLL)];
  const text = (objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join("\n");
  expect(signalFromText(text(polling))?.ciPolling?.polls).toBe(3);
  expect(signalFromText(text([...polling, bash(3, "bun test")]))?.ciPolling).toBeUndefined();
});

test("the Codex probe's activity signal carries the reading too", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-polling-"));
  try {
    const path = join(dir, "rollout.jsonl");
    const objs = [codexExec(0, POLL), codexExec(1, POLL), codexExec(2, POLL)];
    writeFileSync(path, objs.map((o) => JSON.stringify(o)).join("\n"));
    expect(readCodexTranscriptSignals(path).activity?.ciPolling?.polls).toBe(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
