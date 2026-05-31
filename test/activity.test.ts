import { test, expect } from "bun:test";
import { parseActivity, sessionActivity } from "../src/activity";

function toolUse(name: string, input: unknown, id = "t1", ts = "2026-05-31T10:00:00.000Z"): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: ts,
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  });
}

function toolResult(
  id: string,
  opts: { is_error?: boolean; content?: unknown } = {},
  ts = "2026-05-31T10:00:01.000Z",
): string {
  return JSON.stringify({
    type: "user",
    timestamp: ts,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          is_error: opts.is_error,
          content: opts.content ?? "",
        },
      ],
    },
  });
}

test("Edit summarizes as edited <basename>", () => {
  const e = parseActivity(toolUse("Edit", { file_path: "/a/b/server.ts" }));
  expect(e).toHaveLength(1);
  expect(e[0]).toMatchObject({ tool: "Edit", summary: "edited server.ts" });
});

test("ts is parsed from the tool_use line timestamp", () => {
  const e = parseActivity(
    toolUse("Read", { file_path: "/a/z.ts" }, "i", "2026-05-31T10:00:00.000Z"),
  );
  expect(e[0]!.ts).toBe(Date.parse("2026-05-31T10:00:00.000Z"));
});

test("status: ok when a non-error result follows, error on is_error, pending when none", () => {
  const lines = [
    toolUse("Read", { file_path: "/x/a.ts" }, "r1"),
    toolResult("r1", { is_error: false }),
    toolUse("Bash", { command: "bun test" }, "b1"),
    toolResult("b1", { is_error: true }),
    toolUse("Read", { file_path: "/x/c.ts" }, "r2"),
  ].join("\n");
  const e = parseActivity(lines);
  expect(e.map((x) => x.status)).toEqual(["ok", "error", "pending"]);
});

test("returns the most recent `limit` entries in chronological order", () => {
  const lines = Array.from({ length: 5 }, (_, i) =>
    toolUse("Read", { file_path: `/x/f${i}.ts` }, `id${i}`, `2026-05-31T10:0${i}:00.000Z`),
  ).join("\n");
  const e = parseActivity(lines, 3);
  expect(e.map((x) => x.summary)).toEqual(["read f2.ts", "read f3.ts", "read f4.ts"]);
});

test("Bash summary is $ <command>, truncated past ~60 chars", () => {
  expect(parseActivity(toolUse("Bash", { command: "bun test" }))[0]!.summary).toBe("$ bun test");
  const s = parseActivity(toolUse("Bash", { command: "x".repeat(80) }))[0]!.summary;
  expect(s.startsWith("$ ")).toBe(true);
  expect(s.endsWith("…")).toBe(true);
  expect(s.length).toBeLessThanOrEqual(2 + 61);
});

test("summaries per tool family", () => {
  const cases: [string, unknown, string][] = [
    ["Write", { file_path: "/a/notes.md" }, "wrote notes.md"],
    ["MultiEdit", { file_path: "/a/x.ts" }, "edited x.ts"],
    ["NotebookEdit", { notebook_path: "/a/n.ipynb" }, "edited n.ipynb"],
    ["Read", { file_path: "/a/y.ts" }, "read y.ts"],
    ["Grep", { pattern: "foo" }, 'searched "foo"'],
    ["Glob", { pattern: "**/*.ts" }, "globbed **/*.ts"],
    ["Task", { subagent_type: "Explore" }, "dispatched Explore"],
    ["Task", {}, "dispatched agent"],
    ["Skill", { skill: "superpowers:brainstorming" }, "skill superpowers:brainstorming"],
    ["TodoWrite", { todos: [] }, "updated todos"],
    ["WebFetch", { url: "https://example.com/p" }, "fetched example.com"],
    ["WebSearch", { query: "svelte 5" }, 'web search "svelte 5"'],
    ["FancyNewTool", {}, "fancynewtool"],
  ];
  for (const [name, input, expected] of cases) {
    expect(parseActivity(toolUse(name, input))[0]!.summary).toBe(expected);
  }
});

test("ignores assistant messages without tool_use", () => {
  const textMsg = JSON.stringify({
    type: "assistant",
    timestamp: "2026-05-31T10:00:00.000Z",
    message: { content: [{ type: "text", text: "hi" }] },
  });
  expect(parseActivity(textMsg)).toEqual([]);
});

test("skips malformed lines and blanks", () => {
  const lines = ["", "not json", toolUse("Read", { file_path: "/a/z.ts" }), "  "].join("\n");
  const e = parseActivity(lines);
  expect(e).toHaveLength(1);
  expect(e[0]!.summary).toBe("read z.ts");
});

test("sessionActivity returns [] for a missing file", async () => {
  expect(await sessionActivity("/nonexistent/definitely-not-here.jsonl")).toEqual([]);
});
