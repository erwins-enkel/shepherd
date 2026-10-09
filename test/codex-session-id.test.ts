import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  backfillCodexProviderSessionIds,
  codexLaunchMarker,
  findCodexLaunchSessionId,
  findCodexRolloutById,
  rolloutHeaders,
} from "../src/codex-session-id";
import { SessionStore } from "../src/store";

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

/** Codex's real naming: `rollout-<timestamp>-<thread id>.jsonl`. */
const named = (id: string) => `rollout-2026-08-01T10-00-00-${id}.jsonl`;

test("findCodexRolloutById resolves the rollout named after the id, in a dated subdirectory", () => {
  const dir = join(sessionsDir, "2026", "08", "01");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, named("uuid-A"));
  writeFileSync(
    path,
    JSON.stringify({ type: "session_meta", payload: { id: "uuid-A", cwd: CWD } }),
  );
  writeRollout(named("uuid-B"), { id: "uuid-B", cwd: CWD, source: "cli" }, 3000);
  expect(findCodexRolloutById("uuid-A", home)).toBe(path);
});

test("findCodexRolloutById ignores cwd, source and recency — the id alone decides", () => {
  writeRollout(named("mine"), { id: "mine", cwd: "/shared", source: "vscode" }, 1000);
  writeRollout(named("sibling"), { id: "sibling", cwd: "/shared", source: "cli" }, 5000);
  expect(findCodexRolloutById("mine", home)).toBe(join(sessionsDir, named("mine")));
});

test("findCodexRolloutById falls back to payload.session_id (legacy header)", () => {
  writeRollout(named("uuid-legacy"), { session_id: "uuid-legacy", cwd: CWD }, 1000);
  expect(findCodexRolloutById("uuid-legacy", home)).toBe(join(sessionsDir, named("uuid-legacy")));
});

test("findCodexRolloutById refuses a file whose header names another conversation", () => {
  writeRollout(named("uuid-A"), { id: "uuid-other", cwd: CWD, source: "cli" }, 1000);
  writeRollout(named("x-uuid-A"), "}{ not json", 2000);
  expect(findCodexRolloutById("uuid-A", home)).toBeNull();
});

test("findCodexRolloutById reads a large header (system prompt of hundreds of KB)", () => {
  const big = "x".repeat(200_000);
  writeRollout(
    named("uuid-big"),
    JSON.stringify({
      type: "session_meta",
      payload: { id: "uuid-big", cwd: CWD, source: "cli", base_instructions: big },
    }),
    2000,
  );
  expect(findCodexRolloutById("uuid-big", home)).toBe(join(sessionsDir, named("uuid-big")));
});

test("findCodexRolloutById: unknown id or missing sessions dir → null (graceful)", () => {
  writeRollout(named("uuid-A"), { id: "uuid-A", cwd: CWD, source: "cli" }, 1000);
  expect(findCodexRolloutById("uuid-missing", home)).toBeNull();
  const empty = mkdtempSync(join(tmpdir(), "codex-empty-"));
  try {
    expect(findCodexRolloutById("uuid-A", empty)).toBeNull();
    expect(findCodexLaunchSessionId(CWD, "launch", 0, empty)).toBeNull();
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

function launchMessage(launchId: string, role = "user"): string {
  return JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{ type: "input_text", text: codexLaunchMarker(launchId) + "task" }],
    },
  });
}

test("Codex launch attribution separates concurrent shared-cwd tasks regardless of write order", () => {
  writeRollout("rollout-a.jsonl", { id: "a", cwd: CWD, source: "cli" }, 3000, [
    launchMessage("launch-a"),
  ]);
  writeRollout("rollout-b.jsonl", { id: "b", cwd: CWD, source: "cli" }, 1000, [
    launchMessage("launch-b"),
  ]);
  writeRollout("rollout-operator.jsonl", { id: "operator", cwd: CWD, source: "cli" }, 4000);
  writeRollout("rollout-role.jsonl", { id: "role", cwd: CWD, source: "exec" }, 5000, [
    launchMessage("launch-a"),
  ]);
  expect(findCodexLaunchSessionId(CWD, "launch-a", 0, home)).toBe("a");
  expect(findCodexLaunchSessionId(CWD, "launch-b", 0, home)).toBe("b");
  expect(findCodexLaunchSessionId(CWD, "missing", 0, home)).toBeNull();
});

test("Codex launch attribution refuses duplicate histories and ignores later quoted markers", () => {
  writeRollout("rollout-a.jsonl", { id: "a", cwd: CWD, source: "cli" }, 1000, [
    launchMessage("launch"),
  ]);
  writeRollout("rollout-fork.jsonl", { id: "fork", cwd: CWD, source: "cli" }, 2000, [
    launchMessage("launch"),
  ]);
  expect(findCodexLaunchSessionId(CWD, "launch", 0, home)).toBeNull();
  writeRollout("rollout-later.jsonl", { id: "later", cwd: CWD, source: "cli" }, 3000, [
    launchMessage("unrelated", "assistant"),
    launchMessage("quoted"),
  ]);
  expect(findCodexLaunchSessionId(CWD, "quoted", 0, home)).toBeNull();
});

test("Codex launch attribution tolerates incomplete records and rejects wrong cwd", () => {
  writeRollout("rollout-partial.jsonl", { id: "partial", cwd: CWD, source: "cli" }, 1000, [
    '{"type":',
  ]);
  writeRollout("rollout-other.jsonl", { id: "other", cwd: "/other", source: "cli" }, 2000, [
    launchMessage("launch"),
  ]);
  expect(findCodexLaunchSessionId(CWD, "launch", 0, home)).toBeNull();
  writeRollout("rollout-partial.jsonl", { id: "partial", cwd: CWD, source: "cli" }, 3000, [
    launchMessage("launch"),
  ]);
  expect(findCodexLaunchSessionId(CWD, "launch", 0, home)).toBe("partial");
});

test("Codex launch attribution distinguishes fork thread ids sharing a session root", () => {
  writeRollout(
    "rollout-root.jsonl",
    { id: "root", session_id: "root", cwd: CWD, source: "cli" },
    1000,
    [launchMessage("launch")],
  );
  writeRollout(
    "rollout-fork.jsonl",
    { id: "fork", session_id: "root", cwd: CWD, source: "cli" },
    2000,
    [launchMessage("launch")],
  );
  expect(findCodexLaunchSessionId(CWD, "launch", 0, home)).toBeNull();
});

test("Codex launch attribution accepts the daemon TUI's vscode source (Codex 0.160+)", () => {
  writeRollout("rollout-daemon.jsonl", { id: "daemon", cwd: CWD, source: "vscode" }, 1000, [
    launchMessage("launch"),
  ]);
  expect(findCodexLaunchSessionId(CWD, "launch", 0, home)).toBe("daemon");
});

test("Codex launch attribution ignores subagent threads (object source) carrying the marker", () => {
  writeRollout(
    "rollout-sub.jsonl",
    JSON.stringify({
      type: "session_meta",
      payload: {
        id: "sub",
        cwd: CWD,
        source: { subagent: { thread_spawn: { parent_thread_id: "main" } } },
      },
    }),
    2000,
    [launchMessage("launch")],
  );
  writeRollout("rollout-main.jsonl", { id: "main", cwd: CWD, source: "cli" }, 1000, [
    launchMessage("launch"),
  ]);
  expect(findCodexLaunchSessionId(CWD, "launch", 0, home)).toBe("main");
});

test("Codex launch attribution honours the mtime floor and scans past any recency cap", () => {
  writeRollout("rollout-target.jsonl", { id: "target", cwd: CWD, source: "cli" }, 4000, [
    launchMessage("launch"),
  ]);
  // 30 newer, non-matching rollouts would push the target past any 24-item cap.
  for (let i = 0; i < 30; i++) {
    writeRollout(
      `rollout-noise-${i}.jsonl`,
      { id: `n${i}`, cwd: "/other", source: "cli" },
      5000 + i,
    );
  }
  expect(findCodexLaunchSessionId(CWD, "launch", 0, home)).toBe("target");
  // notBeforeMs is in ms; the target's mtime 4000s = 4_000_000 ms is older → excluded.
  expect(findCodexLaunchSessionId(CWD, "launch", 4_500_000, home)).toBeNull();
});

describe("backfillCodexProviderSessionIds", () => {
  function codexRow(store: SessionStore, launchId: string, worktreePath = CWD) {
    return store.create({
      name: launchId,
      prompt: "task",
      repoPath: "/repo",
      baseBranch: "main",
      branch: null,
      worktreePath,
      isolated: true,
      herdrSession: "default",
      herdrAgentId: `term-${launchId}`,
      agentProvider: "codex",
      codexLaunchId: launchId,
    });
  }
  const nowSec = () => Math.floor(Date.now() / 1000);

  test("fills a resolvable row, leaves ambiguous and rollout-less rows empty, and is idempotent", () => {
    const store = new SessionStore(":memory:");
    const daemon = codexRow(store, "launch-daemon");
    const forked = codexRow(store, "launch-forked");
    const gone = codexRow(store, "launch-gone");
    writeRollout("rollout-d.jsonl", { id: "d", cwd: CWD, source: "vscode" }, nowSec(), [
      launchMessage("launch-daemon"),
    ]);
    writeRollout("rollout-f1.jsonl", { id: "f1", cwd: CWD, source: "cli" }, nowSec(), [
      launchMessage("launch-forked"),
    ]);
    writeRollout("rollout-f2.jsonl", { id: "f2", cwd: CWD, source: "cli" }, nowSec(), [
      launchMessage("launch-forked"),
    ]);

    expect(backfillCodexProviderSessionIds(store, () => rolloutHeaders(home))).toBe(1);
    expect(store.get(daemon.id)?.providerSessionId).toBe("d");
    expect(store.get(forked.id)?.providerSessionId).toBe("");
    expect(store.get(gone.id)?.providerSessionId).toBe("");

    expect(backfillCodexProviderSessionIds(store, () => rolloutHeaders(home))).toBe(0);
    expect(store.get(daemon.id)?.providerSessionId).toBe("d");
  });

  test("shares ONE header walk across rows and skips it when nothing is missing", () => {
    const store = new SessionStore(":memory:");
    let walks = 0;
    const listHeaders = () => {
      walks += 1;
      return rolloutHeaders(home);
    };
    expect(backfillCodexProviderSessionIds(store, listHeaders)).toBe(0);
    expect(walks).toBe(0);

    codexRow(store, "a", "/wt/a");
    codexRow(store, "b", "/wt/b");
    backfillCodexProviderSessionIds(store, listHeaders);
    expect(walks).toBe(1);
  });

  test("never throws — a failing store or walk degrades to 0", () => {
    const broken = {
      listCodexRowsMissingProviderSessionId: () => {
        throw new Error("db gone");
      },
      fillProviderSessionId: () => false,
    };
    expect(backfillCodexProviderSessionIds(broken)).toBe(0);
    const store = new SessionStore(":memory:");
    codexRow(store, "a");
    expect(
      backfillCodexProviderSessionIds(store, () => {
        throw new Error("walk failed");
      }),
    ).toBe(0);
  });
});
