import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  classifyPaneWrite,
  HerdrDriver,
  matchAgent,
  matchAgents,
  resolvePaneId,
  sanitizeHerdrAgentName,
  type HerdrAgent,
} from "../src/herdr";
import { setDetectedHerdrVersion } from "../src/herdr-capabilities";

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

// Pin the compile-cache dir + disable the disk-TMPDIR redirect so buildWrappedArgv's output is
// deterministic (mirrors test/herdr.test.ts), keeping the `pane run` argv assertion stable.
let prevNcc: string | undefined;
let prevAgentTmp: string | undefined;
beforeEach(() => {
  setDetectedHerdrVersion("0.7.5");
  prevNcc = process.env.SHEPHERD_NODE_COMPILE_CACHE;
  process.env.SHEPHERD_NODE_COMPILE_CACHE = "/disk/ncc";
  prevAgentTmp = process.env.SHEPHERD_AGENT_TMPDIR;
  process.env.SHEPHERD_AGENT_TMPDIR = "";
});
afterEach(() => {
  setDetectedHerdrVersion(null);
  if (prevNcc === undefined) delete process.env.SHEPHERD_NODE_COMPILE_CACHE;
  else process.env.SHEPHERD_NODE_COMPILE_CACHE = prevNcc;
  if (prevAgentTmp === undefined) delete process.env.SHEPHERD_AGENT_TMPDIR;
  else process.env.SHEPHERD_AGENT_TMPDIR = prevAgentTmp;
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

test("start (0.7.5, TRUSTED): tab create → pane run joined argv → NO registration → resolve by auto-detect", async () => {
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

  // The wrapped argv is typed into the pane's shell as ONE POSIX-quoted command line (herdr's
  // `pane run` types-into-shell, it doesn't execvp — a raw spread would shatter multi-word args).
  const paneRun = calls.find((c) => c[0] === "pane" && c[1] === "run")!;
  expect(paneRun.slice(0, 3)).toEqual(["pane", "run", "p_075"]);
  expect(paneRun.length).toBe(4); // pane, run, paneId, single joined command line
  expect(paneRun[3]).toContain("'claude' 'go'");
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
  expect(paneRun.length).toBe(4); // still a single joined command line
  expect(paneRun[3]).toContain("'--append-system-prompt' 'line one\nline two'");
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

// ── cwd-collision name disambiguation tolerates 0.7.5 sanitization ────────────

/** Two 0.7.5 agents sharing a cwd, each with a SANITIZED herdr name, plus stale terminalIds (as
 *  after a daemon restart). The sessions still hold their RAW names. */
const SANITIZED_AGENTS: HerdrAgent[] = [
  {
    agent: "claude",
    agentStatus: "working",
    cwd: "/wt/shared",
    name: "review-task-09", // sanitized from "review TASK-09"
    paneId: "pA",
    tabId: "tA",
    terminalId: "term_A",
    workspaceId: "w1",
  },
  {
    agent: "claude",
    agentStatus: "working",
    cwd: "/wt/shared",
    name: "review-task-10", // sanitized from "review TASK-10"
    paneId: "pB",
    tabId: "tB",
    terminalId: "term_B",
    workspaceId: "w1",
  },
];

test("matchAgent (0.7.5): same-cwd sessions re-pair by SANITIZED name after stale terminalId", () => {
  // terminalId is stale (daemon restart) → cwd fallback; cwd is contended → name disambiguation.
  const s = { herdrAgentId: "stale", worktreePath: "/wt/shared", name: "review TASK-10" };
  expect(matchAgent(s, SANITIZED_AGENTS)?.terminalId).toBe("term_B");
});

test("matchAgents (0.7.5): both same-cwd sessions resolve via sanitized-name arbitration", () => {
  const sessions = [
    { id: "s1", herdrAgentId: "stale1", worktreePath: "/wt/shared", name: "review TASK-09" },
    { id: "s2", herdrAgentId: "stale2", worktreePath: "/wt/shared", name: "review TASK-10" },
  ];
  const out = matchAgents(sessions, SANITIZED_AGENTS);
  expect(out.get("s1")?.terminalId).toBe("term_A");
  expect(out.get("s2")?.terminalId).toBe("term_B");
});

test("stop (0.7.5): closes the recorded tab of a started agent", async () => {
  const { d, calls } = mkDriver(route);
  await d.start("flatten", "/wt/a", ["claude", "go"]);
  calls.length = 0;
  await d.stop("term_075");
  expect(calls.some((c) => c[0] === "tab" && c[1] === "close" && c[2] === "t_075")).toBe(true);
});
