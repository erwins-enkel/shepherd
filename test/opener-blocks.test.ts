import { expect, test } from "bun:test";
import {
  attributeOpener,
  blockRows,
  firstRequest,
  fitCalibration,
  openerSample,
  quantile,
  reconcileError,
  type OpenerSample,
} from "../scripts/opener-blocks";

const HOME = "/home/op";
const SETS = { personal: new Set(["grilling"]), shepherd: new Set(["shepherd-cli"]) };

const SYSTEM = [
  "You are Claude Code.",
  "Static base prompt.",
  [
    "dynamic part",
    "# Claude in Chrome browser automation\nchrome guidance",
    "# Memory\nmemory how-to",
    "# Environment\nlinux",
    "<engineering-posture>\nposture\n</engineering-posture>",
    "",
    "<plan-gate-directive>\nplan gate\n</plan-gate-directive>",
  ].join("\n"),
];
const TOOLS = [
  { name: "Artifact", description: "publish pages ".repeat(20) },
  { name: "Bash", description: "run commands" },
  { name: "AskUserQuestion", description: "ask" },
];
const INSTRUCTIONS = [
  "<system-reminder>\nCodebase and user instructions are shown below.\n\n",
  `Contents of ${HOME}/.claude/CLAUDE.md (user's private global instructions):\n\nbe concise\n\n`,
  "Contents of /repo/CLAUDE.md (project instructions):\n\nrepo rules\n\n",
  `Contents of ${HOME}/.claude/projects/-repo/memory/MEMORY.md (auto-memory):\n\n- [a](a.md) — b\n`,
].join("");
const USER = {
  role: "user",
  content: [
    { type: "text", text: INSTRUCTIONS },
    { type: "text", text: "<system-reminder>\nAs you answer the user's questions, gitStatus" },
    { type: "text", text: "Fix issue #1: the thing is broken." },
  ],
};
const SYSMSG = {
  role: "system",
  content: [
    "SessionStart hook additional context: <EXTREMELY_IMPORTANT>\nYou have superpowers.\n",
    "# Environment\nYou have been invoked in the following environment:\n - cwd\n",
    "The following deferred tools are now available via ToolSearch. Names only:\n",
    "WebSearch\nmcp__plugin_sentry_sentry__find_issues\nmcp__shepherd__queue_step\n",
    "Available agent types for the Agent tool:\n",
    "- Explore: read-only search\n- vercel:ai-architect: AI apps\n",
    "# MCP Server Instructions\n\nThe following MCP servers have provided instructions:\n\n",
    "## plugin:context7:context7\nUse context7.\n\n",
    "The following skills are available for use with the Skill tool:\n\n",
    "- grilling: Grill the user.\n- shepherd-cli: Drive the server.\n",
    "- vercel:deploy: Deploy.\n- vercel:nextjs\n- anthropic-skills:pdf\n- simplify: Simplify code.\n",
    "  continuation of simplify\n",
    "While bypass permissions mode is active:\nuse Bash freely",
  ].join(""),
};

/** A transcript: two shapes/requests (only the first main one counts), a sidechain assistant
 *  (ignored), and a duplicated request id (counted once). */
function transcript(): string[] {
  const rec = (o: object) => JSON.stringify(o);
  return [
    rec({
      type: "api-request-shape",
      shapeHash: "S1",
      shape: { system: SYSTEM.map((text) => ({ text })), tools: TOOLS },
    }),
    rec({ type: "api-request-blob", hash: "U", message: USER }),
    rec({ type: "api-request-blob", hash: "M", message: SYSMSG }),
    rec({
      type: "assistant",
      isSidechain: true,
      requestId: "side",
      message: { usage: { input_tokens: 9 } },
    }),
    rec({ type: "api-request", querySource: "agent:explore", shapeHash: "S1", tail: [] }),
    rec({
      type: "api-request",
      querySource: "repl_main_thread",
      shapeHash: "S1",
      tail: ["U", "M"],
    }),
    rec({
      type: "assistant",
      requestId: "r1",
      message: {
        usage: { input_tokens: 2, cache_read_input_tokens: 300, cache_creation_input_tokens: 700 },
      },
    }),
    rec({ type: "assistant", requestId: "r1", message: { usage: { input_tokens: 1 } } }),
    "not json {",
    rec({ type: "api-request", querySource: "repl_main_thread", shapeHash: "S2", tail: [] }),
    rec({ type: "assistant", requestId: "r2", message: { usage: { input_tokens: 5 } } }),
  ];
}

function sum(m: Map<string, number>): number {
  return [...m.values()].reduce((a, b) => a + b, 0);
}

test("firstRequest: first MAIN request, its blobs, measured opener and unique main request count", () => {
  const fr = firstRequest(transcript())!;
  expect(fr.tokens).toBe(1002);
  expect(fr.requests).toBe(2); // r1 (deduped) + r2; the sidechain request is not the session's
  expect(fr.messages.map((m) => m.role)).toEqual(["user", "system"]);
});

test("firstRequest: a transcript without recorded requests yields null", () => {
  expect(firstRequest(transcript().filter((l) => !l.includes("api-request")))).toBeNull();
  expect(firstRequest([])).toBeNull();
});

test("attributeOpener: every character lands in exactly one block", () => {
  const blocks = attributeOpener(firstRequest(transcript())!, SETS, HOME);
  const total =
    SYSTEM.join("").length +
    TOOLS.reduce((n, t) => n + JSON.stringify(t).length, 0) +
    USER.content.reduce((n, c) => n + c.text.length, 0) +
    SYSMSG.content.length;
  expect(sum(blocks)).toBe(total);
});

test("attributeOpener: names each block by its source", () => {
  const b = attributeOpener(firstRequest(transcript())!, SETS, HOME);
  expect(b.get("tool:Artifact")).toBe(JSON.stringify(TOOLS[0]).length);
  expect(b.get("tool:AskUserQuestion")).toBe(JSON.stringify(TOOLS[2]).length);
  expect(b.get("tools:core")).toBe(JSON.stringify(TOOLS[1]).length);
  expect(b.get("system:cc-base")).toBe(SYSTEM[0]!.length + SYSTEM[1]!.length);
  expect(b.get("shepherd:engineering-posture")).toBe(
    "<engineering-posture>\nposture\n</engineering-posture>".length,
  );
  expect(b.has("shepherd:plan-gate-directive")).toBe(true);
  for (const name of [
    "system:chrome",
    "system:memory-howto",
    "system:cc-dynamic",
    "claudemd:user",
    "claudemd:project",
    "claudemd:memory-index",
    "user:context",
    "task-prompt",
    "hook:superpowers",
    "sysmsg:env",
    "deferred:builtin",
    "deferred:sentry",
    "deferred:shepherd",
    "agents:builtin",
    "agents:plugin",
    "mcp:context7",
    "skills:personal",
    "skills:shepherd",
    "skills:plugin:vercel",
    "skills:claude-ai",
    "skills:bundled+repo",
    "sysmsg:bypass",
  ]) {
    expect(b.get(name) ?? 0).toBeGreaterThan(0);
  }
  // A continuation line stays with the skill above it.
  expect(b.get("skills:bundled+repo")).toBe(
    "- simplify: Simplify code.\n  continuation of simplify\n".length,
  );
  expect(b.get("task-prompt")).toBe("Fix issue #1: the thing is broken.".length);
});

test("attributeOpener: no Shepherd anchor → the whole last system block is Claude Code's", () => {
  const fr = firstRequest(transcript())!;
  fr.shape.system = [{ text: "a" }, { text: "b" }, { text: "dyn <short-slug>\nx\n</short-slug>" }];
  const b = attributeOpener(fr, SETS, HOME);
  expect([...b.keys()].some((k) => k.startsWith("shepherd:"))).toBe(false);
});

function sample(json: number, text: number, requests = 1): OpenerSample {
  return {
    blocks: new Map([
      ["tools:core", json],
      ["task-prompt", text],
    ]),
    tokens: json * 0.3 + text * 0.4,
    requests,
  };
}

test("fitCalibration recovers the per-kind tokens/char; reconcileError is then zero", () => {
  const samples = [sample(1000, 3000), sample(5000, 1000), sample(2000, 2000)];
  const cal = fitCalibration(samples);
  expect(cal.json).toBeCloseTo(0.3, 9);
  expect(cal.text).toBeCloseTo(0.4, 9);
  for (const s of samples) expect(reconcileError(s, cal)).toBeCloseTo(0, 9);
});

test("fitCalibration refuses a degenerate sample set", () => {
  expect(() => fitCalibration([sample(1000, 0)])).toThrow();
});

test("blockRows: median per block, weighted by requests, heaviest first", () => {
  const cal = { json: 1, text: 1 };
  const rows = blockRows([sample(10, 100, 1), sample(30, 1, 50)], cal);
  expect(rows.map((r) => r.name)).toEqual(["tools:core", "task-prompt"]);
  expect(rows[0]).toEqual({ name: "tools:core", median: 30, weighted: 10 + 30 * 50 });
});

test("quantile: nearest rank; empty → 0", () => {
  expect(quantile([5, 1, 3], 0.5)).toBe(3);
  expect(quantile([5, 1, 3], 0.1)).toBe(1);
  expect(quantile([5, 1, 3], 0.9)).toBe(5);
  expect(quantile([], 0.5)).toBe(0);
});

test("openerSample wires extraction and attribution together", () => {
  const s = openerSample(transcript(), SETS, HOME)!;
  expect(s.tokens).toBe(1002);
  expect(s.requests).toBe(2);
  expect(s.blocks.get("tool:Artifact")).toBeGreaterThan(0);
});
