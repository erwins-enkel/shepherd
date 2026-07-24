import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { codexReviewerCorrelationMarker, findCodexSessionId } from "../src/codex-session-id";

let home: string;
let sessionsDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "codex-home-"));
  sessionsDir = join(home, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Write a rollout jsonl whose line 1 is a session_meta header, with an explicit mtime (seconds). */
function writeRollout(
  name: string,
  header: { session_id?: string; id?: string; cwd?: string; source?: string } | string,
  mtimeSec: number,
  extraLines: string[] = [],
): void {
  const line1 =
    typeof header === "string" ? header : JSON.stringify({ type: "session_meta", payload: header });
  const path = join(sessionsDir, name);
  writeFileSync(path, [line1, ...extraLines].join("\n") + "\n");
  utimesSync(path, mtimeSec, mtimeSec);
}

const CWD = "/home/u/.shepherd-worktrees/repo-feature";

function userMessage(text: string): string {
  return JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  });
}

test("returns the session id of an interactive (source=cli) rollout matching the cwd", () => {
  writeRollout("rollout-1.jsonl", { session_id: "uuid-A", cwd: CWD, source: "cli" }, 1000);
  expect(findCodexSessionId(CWD, 0, home)).toBe("uuid-A");
});

test("falls back to payload.id when session_id is absent (legacy header)", () => {
  writeRollout("rollout-legacy.jsonl", { id: "uuid-legacy", cwd: CWD, source: "cli" }, 1000);
  expect(findCodexSessionId(CWD, 0, home)).toBe("uuid-legacy");
});

test("newest matching rollout wins", () => {
  writeRollout("rollout-old.jsonl", { session_id: "uuid-old", cwd: CWD, source: "cli" }, 1000);
  writeRollout("rollout-new.jsonl", { session_id: "uuid-new", cwd: CWD, source: "cli" }, 2000);
  expect(findCodexSessionId(CWD, 0, home)).toBe("uuid-new");
});

test("ignores source=exec (headless role) rollouts sharing the cwd", () => {
  // exec rollout is NEWER but must be skipped; the older cli rollout is the interactive session.
  writeRollout("rollout-exec.jsonl", { session_id: "uuid-exec", cwd: CWD, source: "exec" }, 3000);
  writeRollout("rollout-cli.jsonl", { session_id: "uuid-cli", cwd: CWD, source: "cli" }, 2000);
  expect(findCodexSessionId(CWD, 0, home)).toBe("uuid-cli");
});

test("binds an exec rollout to its reviewer spawn even when a later exec shares the cwd", () => {
  const targetMarker = codexReviewerCorrelationMarker("spawn-target");
  const competitorMarker = codexReviewerCorrelationMarker("spawn-competitor");
  writeRollout(
    "rollout-target.jsonl",
    { session_id: "uuid-target", cwd: CWD, source: "exec" },
    2000,
    [
      userMessage("<recommended_plugins>preloaded by Codex</recommended_plugins>"),
      userMessage(`${targetMarker}\nReview target`),
    ],
  );
  writeRollout(
    "rollout-competitor.jsonl",
    { session_id: "uuid-competitor", cwd: CWD, source: "exec" },
    3000,
    [userMessage(`${competitorMarker}\nReview competitor`)],
  );

  expect(
    findCodexSessionId(CWD, 0, home, {
      source: "exec",
      correlationMarker: targetMarker,
    }),
  ).toBe("uuid-target");
});

test("does not fall back to the newest exec rollout when no marker matches", () => {
  writeRollout(
    "rollout-competitor.jsonl",
    { session_id: "uuid-competitor", cwd: CWD, source: "exec" },
    3000,
    [userMessage(`${codexReviewerCorrelationMarker("spawn-competitor")}\nReview competitor`)],
  );

  expect(
    findCodexSessionId(CWD, 0, home, {
      source: "exec",
      correlationMarker: codexReviewerCorrelationMarker("spawn-missing"),
    }),
  ).toBeNull();
});

test("skips rollouts older than notBeforeMs", () => {
  // mtime is in seconds; findCodexSessionId compares mtimeMs against notBeforeMs (ms).
  writeRollout("rollout-stale.jsonl", { session_id: "uuid-stale", cwd: CWD, source: "cli" }, 1000);
  // notBeforeMs = 2000_000 ms → file mtime 1000s = 1_000_000 ms is older → excluded.
  expect(findCodexSessionId(CWD, 2_000_000, home)).toBeNull();
});

test("matches on cwd, not other sessions in different worktrees", () => {
  writeRollout(
    "rollout-other.jsonl",
    { session_id: "uuid-other", cwd: "/somewhere/else", source: "cli" },
    3000,
  );
  writeRollout("rollout-mine.jsonl", { session_id: "uuid-mine", cwd: CWD, source: "cli" }, 2000);
  expect(findCodexSessionId(CWD, 0, home)).toBe("uuid-mine");
});

test("target beyond the 24 globally-newest rollouts is still found (scan is unbounded)", () => {
  // 30 newer, non-matching cli rollouts would push the target past any 24-item cap.
  for (let i = 0; i < 30; i++) {
    writeRollout(
      `rollout-noise-${i}.jsonl`,
      { session_id: `n${i}`, cwd: "/other/cwd", source: "cli" },
      5000 + i,
    );
  }
  writeRollout(
    "rollout-target.jsonl",
    { session_id: "uuid-target", cwd: CWD, source: "cli" },
    4000,
  );
  expect(findCodexSessionId(CWD, 0, home)).toBe("uuid-target");
});

test("no matching rollout → null", () => {
  writeRollout(
    "rollout-other.jsonl",
    { session_id: "uuid-other", cwd: "/nope", source: "cli" },
    1000,
  );
  expect(findCodexSessionId(CWD, 0, home)).toBeNull();
});

test("tolerates a malformed / non-session_meta header (skips it)", () => {
  writeRollout("rollout-garbage.jsonl", "}{ not json", 3000);
  writeRollout("rollout-wrongtype.jsonl", JSON.stringify({ type: "event_msg", payload: {} }), 2500);
  writeRollout("rollout-ok.jsonl", { session_id: "uuid-ok", cwd: CWD, source: "cli" }, 2000);
  expect(findCodexSessionId(CWD, 0, home)).toBe("uuid-ok");
});

test("reads a large header (system prompt of hundreds of KB)", () => {
  // base_instructions.text in a real header is tens of KB; ensure the first-line reader handles it.
  const big = "x".repeat(200_000);
  writeRollout(
    "rollout-big.jsonl",
    JSON.stringify({
      type: "session_meta",
      payload: { session_id: "uuid-big", cwd: CWD, source: "cli", base_instructions: big },
    }),
    2000,
  );
  expect(findCodexSessionId(CWD, 0, home)).toBe("uuid-big");
});

test("missing CODEX_HOME sessions dir → null (graceful)", () => {
  const empty = mkdtempSync(join(tmpdir(), "codex-empty-"));
  try {
    expect(findCodexSessionId(CWD, 0, empty)).toBeNull();
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
