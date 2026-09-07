import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  agentsHoldingName,
  classifyPaneWrite,
  HerdrDriver,
  matchAgent,
  matchAgents,
  resolvePaneId,
  sanitizeHerdrAgentName,
  type HerdrAgent,
} from "../src/herdr";
import { setDetectedHerdrVersion } from "../src/herdr-capabilities";
import { SpawnCanceled } from "../src/spawn-progress";
import { readTypedScript } from "./helpers/spawn-script";

// ── captured 0.7.5 (protocol 17) reply fixtures ──────────────────────────────
const FIX = join(import.meta.dir, "fixtures/herdr-responses/v0.7.5");
const fixture = (name: string): string => readFileSync(join(FIX, `${name}.json`), "utf8");

const WORKSPACE_LIST = fixture("workspace-list");
const TAB_CREATE = fixture("tab-create");
const PANE_RUN = fixture("pane-run");
const REPORT_SESSION = fixture("report-agent-session");
const REPORT_AGENT = fixture("report-agent");
const AGENT_LIST = fixture("agent-list-registered");
const AGENT_READ = fixture("agent-read");
const SEND_TEXT = fixture("pane-send-text");
const SEND_KEYS = fixture("pane-send-keys");
const TAB_LIST = fixture("tab-list");
const OK = JSON.stringify({ result: { type: "ok" } });

/** Route a captured fixture by the herdr subcommand the runner is invoked with. */
function route(args: string[]): string {
  const [a, b] = args;
  if (a === "workspace" && b === "list") return WORKSPACE_LIST;
  if (a === "tab" && b === "create") return TAB_CREATE;
  if (a === "pane" && b === "run") return PANE_RUN;
  if (a === "pane" && b === "report-agent-session") return REPORT_SESSION;
  if (a === "pane" && b === "report-agent") return REPORT_AGENT;
  if (a === "agent" && b === "list") return AGENT_LIST;
  if (a === "tab" && b === "list") return TAB_LIST;
  if (a === "agent" && b === "read") return AGENT_READ;
  if (a === "pane" && b === "send-text") return SEND_TEXT;
  if (a === "pane" && b === "send-keys") return SEND_KEYS;
  return OK; // agent rename / tab rename / tab close
}

/** A HerdrDriver whose sync + async runners share ONE fake that records every call. */
function mkDriver(fake: (args: string[]) => string): { d: HerdrDriver; calls: string[][] } {
  const calls: string[][] = [];
  const runner = (args: string[]) => {
    calls.push(args);
    return fake(args);
  };
  // no-op sleep so the trusted auto-detect poll never actually waits in tests
  return {
    d: new HerdrDriver(
      runner,
      async (args) => runner(args),
      async () => {},
    ),
    calls,
  };
}

// Pin the compile-cache dir so buildWrappedArgv's output is deterministic (mirrors
// test/herdr.test.ts), and point the agent tmp dir at a scratch dir — that is where the #1967 spawn
// scripts land, so the test owns and removes them instead of leaving them in the system tmp dir.
let prevNcc: string | undefined;
let prevAgentTmp: string | undefined;
let scratch: string;
beforeEach(() => {
  setDetectedHerdrVersion("0.7.5");
  prevNcc = process.env.SHEPHERD_NODE_COMPILE_CACHE;
  process.env.SHEPHERD_NODE_COMPILE_CACHE = "/disk/ncc";
  prevAgentTmp = process.env.SHEPHERD_AGENT_TMPDIR;
  scratch = mkdtempSync(join(tmpdir(), "shepherd-herdr075-"));
  process.env.SHEPHERD_AGENT_TMPDIR = scratch;
});
afterEach(() => {
  setDetectedHerdrVersion(null);
  if (prevNcc === undefined) delete process.env.SHEPHERD_NODE_COMPILE_CACHE;
  else process.env.SHEPHERD_NODE_COMPILE_CACHE = prevNcc;
  if (prevAgentTmp === undefined) delete process.env.SHEPHERD_AGENT_TMPDIR;
  else process.env.SHEPHERD_AGENT_TMPDIR = prevAgentTmp;
  rmSync(scratch, { recursive: true, force: true });
});

// ── pure leaves ──────────────────────────────────────────────────────────────

test("sanitizeHerdrAgentName coerces Shepherd labels into herdr's name grammar", () => {
  expect(sanitizeHerdrAgentName("TASK-01")).toBe("task-01");
  expect(sanitizeHerdrAgentName("review TASK-09")).toBe("review-task-09");
  expect(sanitizeHerdrAgentName("plan-review TASK-707")).toBe("plan-review-task-707");
  expect(sanitizeHerdrAgentName("9foo")).toBe("foo"); // first char must be [a-z]
  expect(sanitizeHerdrAgentName("---")).toBe("agent"); // nothing survives → fallback
  expect(sanitizeHerdrAgentName("")).toBe("agent");
  const long = sanitizeHerdrAgentName("a".repeat(50));
  expect(long).toBe("a".repeat(32)); // truncated to 32
  // Every output must satisfy herdr's grammar.
  const grammar = /^[a-z][a-z0-9_-]{0,31}$/;
  for (const raw of ["TASK-01", "review TASK-09", "plan-review TASK-707", "9foo", "!!", ""]) {
    expect(sanitizeHerdrAgentName(raw)).toMatch(grammar);
  }
});

test("resolvePaneId maps terminal_id → pane_id, null when gone or pane-less", () => {
  const agents: HerdrAgent[] = [
    {
      agent: "claude",
      agentStatus: "working",
      cwd: "/wt/a",
      name: "x",
      paneId: "p1",
      tabId: "t1",
      terminalId: "term_1",
      workspaceId: "w1",
    },
  ];
  expect(resolvePaneId(agents, "term_1")).toBe("p1");
  expect(resolvePaneId(agents, "term_gone")).toBeNull();
  expect(resolvePaneId([{ ...agents[0]!, paneId: "" }], "term_1")).toBeNull();
});

test("classifyPaneWrite: CR/LF → Enter key, everything else → literal text", () => {
  expect(classifyPaneWrite("\r")).toEqual({ kind: "keys", keys: ["Enter"] });
  expect(classifyPaneWrite("\n")).toEqual({ kind: "keys", keys: ["Enter"] });
  expect(classifyPaneWrite("\r\n")).toEqual({ kind: "keys", keys: ["Enter"] });
  expect(classifyPaneWrite("hello")).toEqual({ kind: "text", text: "hello" });
  // The bracketed-paste-wrapped steer blob rides send-text verbatim (markers preserved).
  const blob = "\x1b[200~multi\nline\x1b[201~";
  expect(classifyPaneWrite(blob)).toEqual({ kind: "text", text: blob });
  // A lone ESC stays literal text (only the Enter key name is spike-confirmed).
  expect(classifyPaneWrite("\x1b")).toEqual({ kind: "text", text: "\x1b" });
});

// ── start() via external registration ────────────────────────────────────────

test("start (0.7.5, TRUSTED): tab create → pane run spawn script → NO registration → resolve by auto-detect", async () => {
  const { d, calls } = mkDriver(route);
  const agent = await d.start("review TASK-09", "/wt/a", ["claude", "go"]);

  // Resolved from the live list (herdr auto-detected it), joined on the pane we ran in.
  expect(agent).toMatchObject({ terminalId: "term_075", paneId: "p_075", tabId: "t_075" });

  // No legacy `agent start`, and the root pane is reused (never closed).
  expect(calls.some((c) => c[0] === "agent" && c[1] === "start")).toBe(false);
  expect(calls.some((c) => c[0] === "pane" && c[1] === "close")).toBe(false);

  // TRUSTED spawns register NOTHING — herdr owns the status (≤0.7.4 parity). A push would claim
  // authority and freeze herdr's own detection, so the driver must not report-agent(-session).
  expect(calls.some((c) => c[1] === "report-agent-session")).toBe(false);
  expect(calls.some((c) => c[1] === "report-agent")).toBe(false);

  // herdr's `pane run` TYPES into the shell, it doesn't execvp — so the wrapped argv rides a
  // throwaway script (#1967) and only `sh '<path>'` is typed. The script execs the exact argv,
  // POSIX-quoted (a raw spread would shatter multi-word args).
  const paneRun = calls.find((c) => c[0] === "pane" && c[1] === "run")!;
  expect(paneRun.slice(0, 3)).toEqual(["pane", "run", "p_075"]);
  expect(paneRun.length).toBe(4); // pane, run, paneId, single typed command line
  expect(readTypedScript(paneRun[3])).toContain("exec 'env' ");
  expect(readTypedScript(paneRun[3])).toContain("'claude' 'go'");
});

test("start (0.7.5, SANDBOXED): pane run → register (report-agent-session + --state working) → resolve", async () => {
  const { d, calls } = mkDriver(route);
  // A sandboxed spawn's argv carries the bwrap wrap — herdr can't observe it, so it MUST register.
  const agent = await d.start("review TASK-09", "/wt/a", ["bwrap", "--", "claude", "go"]);
  expect(agent).toMatchObject({ terminalId: "term_075", paneId: "p_075" });

  const session = calls.find((c) => c[1] === "report-agent-session")!;
  expect(session[2]).toBe("p_075");
  expect(session[session.indexOf("--agent") + 1]).toBe("review-task-09");
  const report = calls.find((c) => c[1] === "report-agent")!;
  expect(report[2]).toBe("p_075");
  expect(report[report.indexOf("--agent") + 1]).toBe("review-task-09");
  expect(report[report.indexOf("--state") + 1]).toBe("working");
});

test("start (0.7.5): pane run preserves a multi-word/newline argv element as ONE shell token", async () => {
  const { d, calls } = mkDriver(route);
  // The --append-system-prompt value is a single argv element containing spaces AND a newline;
  // it must survive as one POSIX-quoted token, not shatter into bogus shell words.
  await d.start("x", "/wt/a", ["claude", "--append-system-prompt", "line one\nline two"]);
  const paneRun = calls.find((c) => c[0] === "pane" && c[1] === "run")!;
  expect(paneRun.length).toBe(4); // still a single typed command line
  expect(readTypedScript(paneRun[3])).toContain("'--append-system-prompt' 'line one\nline two'");
});

test("start (0.7.5): a multi-KB spawn types a line that fits Darwin's tty MAX_INPUT (#1967)", async () => {
  const { d, calls } = mkDriver(route);
  // The real shape: a --settings overlay plus a several-KB --append-system-prompt directive. Typed
  // verbatim (the pre-#1967 transport) this line was ~10 KB and Darwin truncated it at ~1024 bytes,
  // mid-JSON, leaving an unterminated quote and no `claude` — the 30s auto-detect timeout.
  const settings = JSON.stringify({ hooks: { Notification: ["x".repeat(2000)] } });
  const directive = "You are an autonomous agent.\n".repeat(300);
  await d.start("x", "/wt/a", [
    "claude",
    "--settings",
    settings,
    "--append-system-prompt",
    directive,
  ]);

  const paneRun = calls.find((c) => c[0] === "pane" && c[1] === "run")!;
  // `readTypedScript` asserts the < MAX_INPUT bound; the script itself carries the full command.
  const script = readTypedScript(paneRun[3]);
  expect(script).toContain(settings);
  expect(script).toContain(directive);
  expect(script.length).toBeGreaterThan(10_000);
});

test("start (0.7.5, TRUSTED): auto-detect polls the agent list until the agent appears", async () => {
  let listCalls = 0;
  const { d } = mkDriver((args) => {
    if (args[0] === "agent" && args[1] === "list") {
      listCalls++;
      // herdr hasn't detected the freshly pane-run claude yet on the first two polls.
      if (listCalls < 3) return JSON.stringify({ result: { type: "agent_list", agents: [] } });
    }
    return route(args);
  });
  const agent = await d.start("x", "/wt/a", ["claude", "go"]);
  expect(agent.terminalId).toBe("term_075");
  expect(listCalls).toBeGreaterThanOrEqual(3);
});

test("start (0.7.5, SANDBOXED): a cancel after pane run rolls the tab back, registering nothing", async () => {
  // The sandboxed branch resolves through a quick registration, not a poll loop, so without a
  // checkpoint right after `pane run` it would hand back a live agent for a spawn the operator
  // had already cancelled — and the session would be persisted behind their back.
  const controller = new AbortController();
  const { d, calls } = mkDriver((args) => {
    if (args[0] === "pane" && args[1] === "run") controller.abort();
    return route(args);
  });

  await expect(
    d.start("flatten", "/wt/a", ["bwrap", "--", "claude", "go"], undefined, {
      signal: controller.signal,
    }),
  ).rejects.toBeInstanceOf(SpawnCanceled);

  expect(calls.some((c) => c[1] === "report-agent-session")).toBe(false);
  // The tab — and the process `pane run` just launched inside it — is torn down.
  expect(calls.some((c) => c[0] === "tab" && c[1] === "close" && c[2] === "t_075")).toBe(true);
});

test("start (0.7.5): a cancel before anything is created touches herdr at all only to look around", async () => {
  const controller = new AbortController();
  controller.abort();
  const { d, calls } = mkDriver(route);

  await expect(
    d.start("flatten", "/wt/a", ["claude", "go"], undefined, { signal: controller.signal }),
  ).rejects.toBeInstanceOf(SpawnCanceled);

  expect(calls.some((c) => c[0] === "tab" && c[1] === "create")).toBe(false);
});

test("start (0.7.5, TRUSTED): a cancel during auto-detection rolls the tab back", async () => {
  const controller = new AbortController();
  const { d, calls } = mkDriver((args) => {
    if (args[0] === "pane" && args[1] === "run") return route(args);
    // Never surface the agent, so the resolve sits in its poll loop where the cancel lands.
    if (args[0] === "agent" && args[1] === "list") {
      controller.abort();
      return JSON.stringify({ result: { agents: [] } });
    }
    return route(args);
  });

  await expect(
    d.start("flatten", "/wt/a", ["claude", "go"], undefined, { signal: controller.signal }),
  ).rejects.toBeInstanceOf(SpawnCanceled);

  expect(calls.some((c) => c[0] === "tab" && c[1] === "close" && c[2] === "t_075")).toBe(true);
});

test("start (0.7.5, SANDBOXED): rolls the tab back if registration keeps failing", async () => {
  const { d, calls } = mkDriver((args) => {
    if (args[1] === "report-agent-session") throw new Error("boom");
    return route(args);
  });
  await expect(d.start("flatten", "/wt/a", ["bwrap", "--", "claude", "go"])).rejects.toThrow();
  // The orphan tab is closed on failure.
  expect(calls.some((c) => c[0] === "tab" && c[1] === "close" && c[2] === "t_075")).toBe(true);
});

test("start (0.7.5): retries pane run until the shell is ready", async () => {
  let runAttempts = 0;
  const { d } = mkDriver((args) => {
    if (args[0] === "pane" && args[1] === "run") {
      runAttempts++;
      if (runAttempts < 2) throw new Error("agent_pane_busy");
    }
    return route(args);
  });
  const agent = await d.start("flatten", "/wt/a", ["claude", "go"]);
  expect(agent.terminalId).toBe("term_075");
  expect(runAttempts).toBe(2);
});

// ── read / send / relabel target pane_id ─────────────────────────────────────

test("read (0.7.5): resolves pane_id and reads it with the same agent read command", async () => {
  const { d, calls } = mkDriver(route);
  const text = await d.readAsync("term_075");
  expect(text).toBe("● Ready.\n> ");
  const read = calls.find((c) => c[0] === "agent" && c[1] === "read")!;
  expect(read[2]).toBe("p_075"); // target is the pane_id, not the terminal_id
});

test("read (0.7.5): a gone terminal reads as empty (no doomed CLI call)", async () => {
  const { d, calls } = mkDriver(route);
  expect(await d.readAsync("term_gone")).toBe("");
  expect(calls.some((c) => c[0] === "agent" && c[1] === "read")).toBe(false);
});

test("send (0.7.5): literal text via pane send-text, CR via pane send-keys Enter", async () => {
  const { d, calls } = mkDriver(route);
  await d.send("term_075", "\x1b[200~hi\x1b[201~");
  await d.send("term_075", "\r");
  const text = calls.find((c) => c[1] === "send-text")!;
  expect(text).toEqual(["pane", "send-text", "p_075", "\x1b[200~hi\x1b[201~"]);
  const keys = calls.find((c) => c[1] === "send-keys")!;
  expect(keys).toEqual(["pane", "send-keys", "p_075", "Enter"]);
});

test("send (0.7.5): a gone terminal throws (a steer is never silently dropped)", async () => {
  const { d } = mkDriver(route);
  await expect(d.send("term_gone", "hi")).rejects.toThrow(/no live pane/);
});

test("relabel (0.7.5): agent rename targets pane_id with a sanitized label; tab keeps raw label", async () => {
  const { d, calls } = mkDriver(route);
  await d.relabel("term_075", "review TASK-42");
  const rename = calls.find((c) => c[0] === "agent" && c[1] === "rename")!;
  expect(rename).toEqual(["agent", "rename", "p_075", "review-task-42"]);
  const tabRename = calls.find((c) => c[0] === "tab" && c[1] === "rename")!;
  expect(tabRename).toEqual(["tab", "rename", "t_075", "review TASK-42"]);
});

// ── cwd-collision disambiguation runs off TAB labels on 0.7.5 (#2029) ─────────
//
// These agents carry NO `name`, which is what the live daemon reports — verified by registering a
// throwaway agent: the `--agent` label surfaces under `agent`, and only for externally-registered
// spawns (a trusted auto-detected agent reports the bare kind `"claude"`, as here). The session's
// raw name therefore survives on ONE surface only: its tab label.

/** Two 0.7.5 agents sharing a cwd with stale terminalIds, as after a daemon restart. */
const UNNAMED_AGENTS: HerdrAgent[] = [
  {
    agent: "claude",
    agentStatus: "working",
    cwd: "/wt/shared",
    paneId: "pA",
    tabId: "tA",
    terminalId: "term_A",
    workspaceId: "w1",
  },
  {
    agent: "claude",
    agentStatus: "working",
    cwd: "/wt/shared",
    paneId: "pB",
    tabId: "tB",
    terminalId: "term_B",
    workspaceId: "w1",
  },
];

/** `tab create --label` / `tab rename` are given the RAW, human-facing session name. */
const TAB_LABELS = new Map([
  ["tA", "review TASK-09"],
  ["tB", "review TASK-10"],
]);

test("matchAgent (0.7.5): same-cwd sessions re-pair by TAB label after a stale terminalId", () => {
  // terminalId is stale (daemon restart) → cwd fallback; cwd is contended → name disambiguation.
  const s = { herdrAgentId: "stale", worktreePath: "/wt/shared", name: "review TASK-10" };
  expect(matchAgent(s, UNNAMED_AGENTS, () => TAB_LABELS)?.terminalId).toBe("term_B");
});

test("matchAgent (0.7.5): with no label source a contended cwd stays unresolved, never mis-paired", () => {
  const s = { herdrAgentId: "stale", worktreePath: "/wt/shared", name: "review TASK-10" };
  expect(matchAgent(s, UNNAMED_AGENTS)).toBeNull();
});

test("matchAgents (0.7.5): both same-cwd sessions resolve via tab-label arbitration", () => {
  const sessions = [
    { id: "s1", herdrAgentId: "stale1", worktreePath: "/wt/shared", name: "review TASK-09" },
    { id: "s2", herdrAgentId: "stale2", worktreePath: "/wt/shared", name: "review TASK-10" },
  ];
  const out = matchAgents(sessions, UNNAMED_AGENTS, () => TAB_LABELS);
  expect(out.get("s1")?.terminalId).toBe("term_A");
  expect(out.get("s2")?.terminalId).toBe("term_B");
});

test("the label source is NOT consulted when every session matches by terminalId", () => {
  // The claim that makes a `tab list`-backed thunk affordable on the 1s poller tick.
  let calls = 0;
  const src = () => {
    calls++;
    return TAB_LABELS;
  };
  const sessions = [
    { id: "s1", herdrAgentId: "term_A", worktreePath: "/wt/shared", name: "review TASK-09" },
    { id: "s2", herdrAgentId: "term_B", worktreePath: "/wt/shared", name: "review TASK-10" },
  ];
  const out = matchAgents(sessions, UNNAMED_AGENTS, src);
  expect(out.get("s1")?.terminalId).toBe("term_A");
  expect(calls).toBe(0);
});

test("the label source is memoized: one read arbitrates a whole contended pass", () => {
  let calls = 0;
  const src = () => {
    calls++;
    return TAB_LABELS;
  };
  const sessions = [
    { id: "s1", herdrAgentId: "stale1", worktreePath: "/wt/shared", name: "review TASK-09" },
    { id: "s2", herdrAgentId: "stale2", worktreePath: "/wt/shared", name: "review TASK-10" },
  ];
  matchAgents(sessions, UNNAMED_AGENTS, src);
  expect(calls).toBe(1);
});

// ── agent_name_taken squatter eviction keys on the TAB label too (#2033) ──────
//
// 0.7.5 sends no `agent.name`, so `agents.filter((a) => a.name === name)` selected the empty set:
// nothing was evicted, all three attempts re-collided, and the spawn failed with `agent_name_taken`
// instead of self-healing. The name survives on the TAB label, which `tab create --label` was given
// raw — compared in the sanitized space the registration actually binds.

/** The squatter (`t_sq`) plus OUR OWN freshly-created pane (`p_075`/`t_075`). Both tabs carry the
 *  same label, so the self-eviction guard is what keeps the spawn from closing its own tab. */
const COLLIDING_AGENTS = JSON.stringify({
  result: {
    type: "agent_list",
    agents: [
      {
        agent: "review-task-09",
        agent_status: "working",
        cwd: "/wt/a",
        pane_id: "p_sq",
        tab_id: "t_sq",
        terminal_id: "term_sq",
        workspace_id: "w1",
      },
      {
        agent: "review-task-09",
        agent_status: "working",
        cwd: "/wt/a",
        pane_id: "p_075",
        tab_id: "t_075",
        terminal_id: "term_075",
        workspace_id: "w1",
      },
    ],
  },
});

const COLLIDING_TABS = JSON.stringify({
  result: {
    type: "tab_list",
    tabs: [
      { tab_id: "t_sq", label: "review TASK-09", agent_status: "working", workspace_id: "w1" },
      { tab_id: "t_075", label: "review TASK-09", agent_status: "working", workspace_id: "w1" },
    ],
  },
});

function nameTaken(): Error {
  return Object.assign(new Error("herdr CLI error"), {
    stderr: JSON.stringify({ error: { code: "agent_name_taken", message: "name in use" } }),
  });
}

/** A 0.7.5 sandboxed spawn whose first registration collides; `attempts` counts the register calls. */
function collidingDriver(collisions: number) {
  let attempts = 0;
  const { d, calls } = mkDriver((args) => {
    if (args[0] === "pane" && args[1] === "report-agent-session") {
      attempts++;
      if (attempts <= collisions) throw nameTaken();
      return REPORT_SESSION;
    }
    if (args[0] === "agent" && args[1] === "list") return COLLIDING_AGENTS;
    if (args[0] === "tab" && args[1] === "list") return COLLIDING_TABS;
    return route(args);
  });
  return { d, calls, attempts: () => attempts };
}

/** The ≤0.7.4 shape: herdr populates `name` on every record. */
const NAMED_AGENTS: HerdrAgent[] = [
  { ...UNNAMED_AGENTS[0]!, name: "review TASK-09" },
  { ...UNNAMED_AGENTS[1]!, name: "review TASK-10" },
];

test("agentsHoldingName: a `name` hit wins outright and never reads the labels", () => {
  const labels = () => {
    throw new Error("labels must not be read when `name` already matched");
  };
  expect(agentsHoldingName(NAMED_AGENTS, "review TASK-09", labels).map((a) => a.tabId)).toEqual([
    "tA",
  ]);
});

test("agentsHoldingName: the label branch is a FALL-THROUGH, not a version switch", () => {
  // Deliberate, and a real behaviour change on a herdr that still sends `name`: when NOTHING holds
  // the name, the label is consulted anyway. herdr's own `agent_name_taken` names candidates with
  // `status=Unknown` — a holder absent from `agent list` — and before #2033 that spawn was
  // guaranteed to fail with nothing evicted. The label space searched is Shepherd's own.
  const orphaned: HerdrAgent[] = [{ ...NAMED_AGENTS[0]!, name: "renamed-out-of-band" }];
  expect(
    agentsHoldingName(orphaned, "review TASK-09", () => TAB_LABELS).map((a) => a.tabId),
  ).toEqual(["tA"]);
  // …but a name nobody holds on ANY surface still evicts nothing.
  expect(agentsHoldingName(NAMED_AGENTS, "nobody", () => TAB_LABELS)).toEqual([]);
});

test("agentsHoldingName: falls back to the TAB label in herdr's sanitized name space", () => {
  // The raw label is what `tab create` was given; the registration bound `review-task-09`.
  expect(agentsHoldingName(UNNAMED_AGENTS, "review TASK-09", () => TAB_LABELS)).toHaveLength(1);
  expect(agentsHoldingName(UNNAMED_AGENTS, "review TASK-09", () => TAB_LABELS)[0]!.tabId).toBe(
    "tA",
  );
  // Sanitized-space equality: the caller may hold either form of the same name.
  expect(agentsHoldingName(UNNAMED_AGENTS, "review-task-10", () => TAB_LABELS)[0]!.tabId).toBe(
    "tB",
  );
});

test("agentsHoldingName: no labels → empty set, never a broader match", () => {
  // A failed `tab list` must NARROW the match. Widening it would close an unrelated agent's tab.
  expect(agentsHoldingName(UNNAMED_AGENTS, "review TASK-09", () => undefined)).toEqual([]);
});

test("agentsHoldingName: never keys on `agent` — the bare KIND must not alias a name", () => {
  // Both UNNAMED_AGENTS report `agent: "claude"` (trusted auto-detection). A session that sanitizes
  // to `claude` must not sweep up every claude in the fleet.
  expect(agentsHoldingName(UNNAMED_AGENTS, "claude", () => TAB_LABELS)).toEqual([]);
});

test("start (0.7.5, SANDBOXED): a register collision evicts the squatter by TAB label, then retries", async () => {
  const { d, calls, attempts } = collidingDriver(1);
  const agent = await d.start("review TASK-09", "/wt/a", ["bwrap", "--", "claude", "go"]);

  // The squatter — resolvable ONLY via its tab label — was evicted, and the retry made progress.
  expect(calls).toContainEqual(["tab", "close", "t_sq"]);
  expect(attempts()).toBe(2);
  expect(agent.terminalId).toBe("term_075");
});

test("start (0.7.5, SANDBOXED): the eviction never closes the tab the spawn just created", async () => {
  // Our own tab was labelled with the same name moments earlier, so it matches the label branch by
  // construction. Without the self-eviction guard the retry would close the pane it is spawning into.
  const { d, calls } = collidingDriver(1);
  await d.start("review TASK-09", "/wt/a", ["bwrap", "--", "claude", "go"]);

  const closed = calls.filter((c) => c[0] === "tab" && c[1] === "close").map((c) => c[2]);
  expect(closed).toContain("t_sq");
  expect(closed).not.toContain("t_075");
});

test("start (0.7.5, SANDBOXED): a persistent collision still rolls the tab back and throws", async () => {
  // Eviction is bounded — three attempts, then the spawn fails loudly and leaves no husk behind.
  const { d, calls, attempts } = collidingDriver(99);
  await expect(
    d.start("review TASK-09", "/wt/a", ["bwrap", "--", "claude", "go"]),
  ).rejects.toThrow();
  expect(attempts()).toBe(3);
  expect(calls).toContainEqual(["tab", "close", "t_075"]); // OUR tab, rolled back on the failure path
});

test("start (0.7.5, SANDBOXED): a failing tab list narrows the eviction instead of widening it", async () => {
  // No labels and no `agent.name` → nothing is identifiable, so nothing is closed. The spawn fails
  // exactly as it does today; it must never fall back to closing whatever else is in the list.
  let attempts = 0;
  const { d, calls } = mkDriver((args) => {
    if (args[0] === "pane" && args[1] === "report-agent-session") {
      attempts++;
      throw nameTaken();
    }
    if (args[0] === "agent" && args[1] === "list") return COLLIDING_AGENTS;
    if (args[0] === "tab" && args[1] === "list") throw new Error("herdr: tab list unavailable");
    return route(args);
  });
  await expect(
    d.start("review TASK-09", "/wt/a", ["bwrap", "--", "claude", "go"]),
  ).rejects.toThrow();
  expect(attempts).toBe(3);
  expect(calls.filter((c) => c[0] === "tab" && c[1] === "close").map((c) => c[2])).not.toContain(
    "t_sq",
  );
});

test("stop (0.7.5): closes the recorded tab of a started agent", async () => {
  const { d, calls } = mkDriver(route);
  await d.start("flatten", "/wt/a", ["claude", "go"]);
  calls.length = 0;
  await d.stop("term_075");
  expect(calls.some((c) => c[0] === "tab" && c[1] === "close" && c[2] === "t_075")).toBe(true);
});
