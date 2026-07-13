import { test, expect } from "bun:test";
import {
  anchorEdit,
  parseTranscriptEdits,
  buildAgentNotes,
  buildReviewNotes,
  type TranscriptEdit,
} from "../src/diff-annotations";
import type { DiffFile } from "../src/types";

// Build a modified DiffFile from a list of new-side lines (kind + content + newNo).
function file(path: string, lines: { kind: "add" | "ctx"; content: string }[]): DiffFile {
  let newNo = 1;
  return {
    path,
    status: "modified",
    additions: lines.filter((l) => l.kind === "add").length,
    deletions: 0,
    binary: false,
    hunks: [{ header: "@@", lines: lines.map((l) => ({ ...l, newNo: newNo++ })) }],
  };
}

// A transcript turn: message.id groups a text block + edit tool_use blocks (each its own line).
function turn(id: string, text: string, edits: object[]): string {
  const lines = [
    JSON.stringify({
      type: "assistant",
      message: { id, role: "assistant", content: [{ type: "text", text }] },
    }),
    ...edits.map((input) =>
      JSON.stringify({ type: "assistant", message: { id, role: "assistant", content: [input] } }),
    ),
  ];
  return lines.join("\n");
}
const editUse = (name: string, input: object) => ({ type: "tool_use", name, input });

// ── anchorEdit (pure) ───────────────────────────────────────────────────────

test("anchorEdit anchors a unique multi-line signature to the first added line", () => {
  const rows = [
    { no: 10, content: "  ctx before", isAdd: false },
    { no: 11, content: "const alpha = computeThing();", isAdd: true },
    { no: 12, content: "return alpha + beta;", isAdd: true },
  ];
  expect(anchorEdit("const alpha = computeThing();\nreturn alpha + beta;", rows)).toBe(11);
});

test("anchorEdit drops an ambiguous (non-unique) signature — never anchors wrong", () => {
  const rows = [
    { no: 1, content: "return;", isAdd: true },
    { no: 2, content: "return;", isAdd: true },
  ];
  expect(anchorEdit("return;", rows)).toBeNull();
});

test("anchorEdit drops a short single-line signature (too ambiguous)", () => {
  const rows = [{ no: 1, content: "}", isAdd: true }];
  expect(anchorEdit("}", rows)).toBeNull();
});

test("anchorEdit drops when the signature matches only context lines (not in the diff)", () => {
  const rows = [
    { no: 5, content: "unchanged distinctive context line here", isAdd: false },
    { no: 6, content: "another unchanged distinctive context", isAdd: false },
  ];
  expect(
    anchorEdit(
      "unchanged distinctive context line here\nanother unchanged distinctive context",
      rows,
    ),
  ).toBeNull();
});

test("anchorEdit matches despite indentation differences (trim-normalized)", () => {
  const rows = [{ no: 3, content: "        deeplyIndentedDistinctiveCall();", isAdd: true }];
  expect(anchorEdit("deeplyIndentedDistinctiveCall();", rows)).toBe(3);
});

// ── parseTranscriptEdits (pure) ─────────────────────────────────────────────

const WT = "/home/u/wt";

test("parseTranscriptEdits extracts Edit / MultiEdit / Write with turn reasoning", () => {
  const text = [
    turn("m1", "Reason for edit one that is sufficiently long.", [
      editUse("Edit", { file_path: `${WT}/src/a.ts`, old_string: "x", new_string: "NEW A" }),
    ]),
    turn("m2", "Reason for the multi edit, also long enough here.", [
      editUse("MultiEdit", {
        file_path: `${WT}/src/b.ts`,
        edits: [
          { old_string: "o1", new_string: "M1" },
          { old_string: "o2", new_string: "M2" },
        ],
      }),
    ]),
    turn("m3", "Reason for the write op, plenty long for the gate.", [
      editUse("Write", { file_path: `${WT}/src/c.ts`, content: "WHOLE FILE" }),
    ]),
  ].join("\n");
  const ops = parseTranscriptEdits(text, WT);
  expect(ops.map((o) => [o.tool, o.path, o.newString])).toEqual([
    ["Edit", "src/a.ts", "NEW A"],
    ["MultiEdit", "src/b.ts", "M1"],
    ["MultiEdit", "src/b.ts", "M2"],
    ["Write", "src/c.ts", "WHOLE FILE"],
  ]);
  expect(ops[0]!.reasoning).toContain("Reason for edit one");
});

test("parseTranscriptEdits ignores edits outside the worktree and non-edit tools", () => {
  const text = [
    turn("m1", "long enough reasoning text goes here", [
      editUse("Edit", { file_path: "/somewhere/else/x.ts", new_string: "OUT" }),
      editUse("Bash", { command: "ls" }),
    ]),
  ].join("\n");
  expect(parseTranscriptEdits(text, WT)).toEqual([]);
});

// ── buildAgentNotes (pure) ──────────────────────────────────────────────────

test("buildAgentNotes anchors a note and drops trivial reasoning", () => {
  const files = [
    file("src/a.ts", [
      { kind: "ctx", content: "// header" },
      { kind: "add", content: "const distinctiveThing = 1;" },
    ]),
  ];
  const edits: TranscriptEdit[] = [
    {
      path: "src/a.ts",
      tool: "Edit",
      newString: "const distinctiveThing = 1;",
      reasoning: "This introduces the distinctive thing to fix the bug.",
    },
    { path: "src/a.ts", tool: "Edit", newString: "const distinctiveThing = 1;", reasoning: "ok" }, // trivial → drop
  ];
  const notes = buildAgentNotes(edits, files);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({
    path: "src/a.ts",
    kind: "agent",
    side: "additions",
    lineNumber: 2,
    tool: "Edit",
  });
  expect(notes[0]!.text).toContain("distinctive thing");
});

test("buildAgentNotes enforces the per-file cap", () => {
  const lines = Array.from({ length: 12 }, (_, i) => ({
    kind: "add" as const,
    content: `uniqueLineNumber${i}();`,
  }));
  const files = [file("src/big.ts", lines)];
  const edits: TranscriptEdit[] = lines.map((l, i) => ({
    path: "src/big.ts",
    tool: "Edit",
    newString: l.content,
    reasoning: `A sufficiently long reasoning string number ${i} for the gate.`,
  }));
  expect(buildAgentNotes(edits, files)).toHaveLength(8); // PER_FILE_AGENT_CAP
});

test("buildAgentNotes skips binary/truncated files", () => {
  const files: DiffFile[] = [
    { path: "img.png", status: "modified", additions: 0, deletions: 0, binary: true, hunks: [] },
  ];
  const edits: TranscriptEdit[] = [
    {
      path: "img.png",
      tool: "Write",
      newString: "whatever content long enough",
      reasoning: "A long enough reasoning string here.",
    },
  ];
  expect(buildAgentNotes(edits, files)).toEqual([]);
});

// ── buildReviewNotes (pure) — routing, never re-drops ───────────────────────

test("buildReviewNotes routes matched→per-file, unattributed+out-of-diff→panel, never drops", () => {
  const filePaths = ["ui/src/lib/components/Viewport.svelte", "src/a.ts"];
  const findings = [
    "src/a.ts: real per-file bug", // matched → per-file
    "Viewport.svelte: basename bug", // matched via basename → per-file (right path)
    "does not satisfy the task", // unattributed → panel
    "src/gone.ts: stale finding", // out-of-diff → panel (NOT dropped)
  ];
  const notes = buildReviewNotes(findings, filePaths);
  expect(notes).toHaveLength(4); // nothing dropped
  expect(notes[0]).toEqual({ path: "src/a.ts", kind: "review", text: "real per-file bug" });
  expect(notes[1]).toEqual({
    path: "ui/src/lib/components/Viewport.svelte",
    kind: "review",
    text: "basename bug",
  });
  // unattributed + out-of-diff → panel (path ""), whole finding preserved as text
  expect(notes[2]).toEqual({ path: "", kind: "review", text: "does not satisfy the task" });
  expect(notes[3]).toEqual({ path: "", kind: "review", text: "src/gone.ts: stale finding" });
});
