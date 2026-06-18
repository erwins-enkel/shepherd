import { describe, expect, it } from "bun:test";
import type { DiffFile } from "./types";
import {
  CALLOUT_TONES,
  DIFF_BLOCK_MAX_LINES,
  FILE_TREE_CHANGES,
  capDiffBlock,
  joinDiffBlocks,
  parseVisualBlocks,
  reconcileFileTree,
} from "./visual-blocks";

// ── parseVisualBlocks ────────────────────────────────────────────────────────

describe("parseVisualBlocks", () => {
  it("returns [] for non-array input", () => {
    expect(parseVisualBlocks(null)).toEqual([]);
    expect(parseVisualBlocks(undefined)).toEqual([]);
    expect(parseVisualBlocks("string")).toEqual([]);
    expect(parseVisualBlocks(42)).toEqual([]);
    expect(parseVisualBlocks({ type: "rich-text", id: "1", markdown: "x" })).toEqual([]);
  });

  it("drops blocks with missing id", () => {
    const result = parseVisualBlocks([{ type: "rich-text", markdown: "hello" }]);
    expect(result).toEqual([]);
  });

  it("drops blocks with empty id", () => {
    const result = parseVisualBlocks([{ type: "rich-text", id: "", markdown: "hello" }]);
    expect(result).toEqual([]);
  });

  it("drops blocks with unknown type", () => {
    const result = parseVisualBlocks([{ type: "fancy-thing", id: "1", markdown: "x" }]);
    expect(result).toEqual([]);
  });

  it("accepts valid rich-text block", () => {
    const result = parseVisualBlocks([
      { type: "rich-text", id: "r1", markdown: "hello **world**" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "rich-text", id: "r1", markdown: "hello **world**" });
  });

  it("accepts rich-text with empty markdown string", () => {
    const result = parseVisualBlocks([{ type: "rich-text", id: "r1", markdown: "" }]);
    expect(result).toHaveLength(1);
  });

  it("drops rich-text missing markdown", () => {
    const result = parseVisualBlocks([{ type: "rich-text", id: "r1" }]);
    expect(result).toEqual([]);
  });

  it("accepts valid callout block", () => {
    const result = parseVisualBlocks([
      { type: "callout", id: "c1", tone: "info", markdown: "note" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "callout", id: "c1", tone: "info", markdown: "note" });
  });

  it("drops callout with bad tone", () => {
    const result = parseVisualBlocks([
      { type: "callout", id: "c1", tone: "unknown-tone", markdown: "note" },
    ]);
    expect(result).toEqual([]);
  });

  it("drops callout missing markdown", () => {
    const result = parseVisualBlocks([{ type: "callout", id: "c1", tone: "risk" }]);
    expect(result).toEqual([]);
  });

  it("accepts all valid callout tones", () => {
    for (const tone of CALLOUT_TONES) {
      const result = parseVisualBlocks([{ type: "callout", id: "c1", tone, markdown: "x" }]);
      expect(result).toHaveLength(1);
    }
  });

  it("accepts valid file-tree block", () => {
    const result = parseVisualBlocks([
      {
        type: "file-tree",
        id: "ft1",
        title: "Changed files",
        entries: [{ path: "src/foo.ts", change: "added" }],
      },
    ]);
    expect(result).toHaveLength(1);
    const block = result[0];
    expect(block.type).toBe("file-tree");
    if (block.type === "file-tree") {
      expect(block.entries).toHaveLength(1);
      expect(block.title).toBe("Changed files");
    }
  });

  it("drops file-tree with all-invalid entries", () => {
    const result = parseVisualBlocks([
      {
        type: "file-tree",
        id: "ft1",
        entries: [
          { path: "", change: "added" }, // empty path
          { path: "x.ts", change: "invented" }, // bad change
          { change: "added" }, // missing path
        ],
      },
    ]);
    expect(result).toEqual([]);
  });

  it("keeps only valid entries in file-tree", () => {
    const result = parseVisualBlocks([
      {
        type: "file-tree",
        id: "ft1",
        entries: [
          { path: "good.ts", change: "modified" },
          { path: "", change: "added" }, // invalid: empty path
          { path: "also-good.ts", change: "removed" },
        ],
      },
    ]);
    expect(result).toHaveLength(1);
    const block = result[0];
    if (block.type === "file-tree") {
      expect(block.entries).toHaveLength(2);
      expect(block.entries[0].path).toBe("good.ts");
      expect(block.entries[1].path).toBe("also-good.ts");
    }
  });

  it("coerces optional note in file-tree entry when string", () => {
    const result = parseVisualBlocks([
      {
        type: "file-tree",
        id: "ft1",
        entries: [{ path: "src/foo.ts", change: "added", note: "important" }],
      },
    ]);
    const block = result[0];
    if (block.type === "file-tree") {
      expect(block.entries[0].note).toBe("important");
    }
  });

  it("drops note from file-tree entry when not a string", () => {
    const result = parseVisualBlocks([
      {
        type: "file-tree",
        id: "ft1",
        entries: [{ path: "src/foo.ts", change: "added", note: 123 }],
      },
    ]);
    const block = result[0];
    if (block.type === "file-tree") {
      expect(block.entries[0].note).toBeUndefined();
    }
  });

  it("drops title from file-tree when not a string", () => {
    const result = parseVisualBlocks([
      {
        type: "file-tree",
        id: "ft1",
        title: 999,
        entries: [{ path: "src/foo.ts", change: "added" }],
      },
    ]);
    const block = result[0];
    if (block.type === "file-tree") {
      expect(block.title).toBeUndefined();
    }
  });

  it("accepts valid diff block", () => {
    const result = parseVisualBlocks([
      { type: "diff", id: "d1", path: "src/foo.ts", summary: "Added feature" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "diff",
      id: "d1",
      path: "src/foo.ts",
      summary: "Added feature",
    });
  });

  it("drops diff missing summary", () => {
    const result = parseVisualBlocks([{ type: "diff", id: "d1", path: "src/foo.ts" }]);
    expect(result).toEqual([]);
  });

  it("drops diff with empty path", () => {
    const result = parseVisualBlocks([{ type: "diff", id: "d1", path: "", summary: "x" }]);
    expect(result).toEqual([]);
  });

  it("strips incoming file field from diff block", () => {
    const result = parseVisualBlocks([
      {
        type: "diff",
        id: "d1",
        path: "src/foo.ts",
        summary: "changes",
        file: {
          path: "src/foo.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          binary: false,
          hunks: [],
        },
      },
    ]);
    expect(result).toHaveLength(1);
    expect((result[0] as { file?: unknown }).file).toBeUndefined();
  });

  it("drops annotation without note", () => {
    const result = parseVisualBlocks([
      {
        type: "diff",
        id: "d1",
        path: "src/foo.ts",
        summary: "x",
        annotations: [{ label: "A", note: "good" }, { label: "B" }],
      },
    ]);
    const block = result[0];
    if (block.type === "diff") {
      expect(block.annotations).toHaveLength(1);
      expect(block.annotations![0].note).toBe("good");
    }
  });

  it("strips lines/side keys from annotations", () => {
    const result = parseVisualBlocks([
      {
        type: "diff",
        id: "d1",
        path: "src/foo.ts",
        summary: "x",
        annotations: [{ note: "prose", lines: [1, 2], side: "left", label: "L" }],
      },
    ]);
    const block = result[0];
    if (block.type === "diff") {
      const ann = block.annotations![0] as Record<string, unknown>;
      expect(ann.lines).toBeUndefined();
      expect(ann.side).toBeUndefined();
      expect(ann.note).toBe("prose");
      expect(ann.label).toBe("L");
    }
  });

  it("preserves input order of surviving blocks", () => {
    const result = parseVisualBlocks([
      { type: "rich-text", id: "r1", markdown: "first" },
      { type: "callout", id: "c1", tone: "info", markdown: "second" },
      { type: "rich-text", id: "r2", markdown: "third" },
    ]);
    expect(result.map((b) => b.id)).toEqual(["r1", "c1", "r2"]);
  });
});

// ── joinDiffBlocks ────────────────────────────────────────────────────────────

describe("joinDiffBlocks", () => {
  const fooFile: DiffFile = {
    path: "src/foo.ts",
    status: "modified",
    additions: 5,
    deletions: 2,
    binary: false,
    hunks: [],
  };
  const barFile: DiffFile = {
    path: "src/bar.ts",
    status: "added",
    additions: 10,
    deletions: 0,
    binary: false,
    hunks: [],
  };

  it("attaches matching DiffFile to diff block", () => {
    const blocks = parseVisualBlocks([
      { type: "diff", id: "d1", path: "src/foo.ts", summary: "updated foo" },
    ]);
    const result = joinDiffBlocks(blocks, [fooFile, barFile]);
    expect(result).toHaveLength(1);
    const block = result[0];
    if (block.type === "diff") {
      expect(block.file).toBe(fooFile);
    }
  });

  it("drops unmatched diff block", () => {
    const blocks = parseVisualBlocks([
      { type: "diff", id: "d1", path: "src/missing.ts", summary: "x" },
    ]);
    const result = joinDiffBlocks(blocks, [fooFile]);
    expect(result).toEqual([]);
  });

  it("passes non-diff blocks through unchanged", () => {
    const blocks = parseVisualBlocks([
      { type: "rich-text", id: "r1", markdown: "hello" },
      { type: "callout", id: "c1", tone: "decision", markdown: "decided" },
    ]);
    const result = joinDiffBlocks(blocks, [fooFile]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(blocks[0]);
    expect(result[1]).toEqual(blocks[1]);
  });

  it("does not mutate input blocks array", () => {
    const blocks = parseVisualBlocks([
      { type: "diff", id: "d1", path: "src/foo.ts", summary: "x" },
    ]);
    const original = [...blocks];
    joinDiffBlocks(blocks, [fooFile]);
    expect(blocks).toEqual(original);
  });

  it("does not mutate input diffFiles array", () => {
    const diffFiles = [fooFile, barFile];
    const blocks = parseVisualBlocks([
      { type: "diff", id: "d1", path: "src/foo.ts", summary: "x" },
    ]);
    joinDiffBlocks(blocks, diffFiles);
    expect(diffFiles).toHaveLength(2);
    expect(diffFiles[0]).toBe(fooFile);
  });
});

// ── reconcileFileTree ─────────────────────────────────────────────────────────

describe("reconcileFileTree", () => {
  const diffFiles: DiffFile[] = [
    {
      path: "src/foo.ts",
      status: "modified",
      additions: 3,
      deletions: 1,
      binary: false,
      hunks: [],
    },
    { path: "src/bar.ts", status: "deleted", additions: 0, deletions: 5, binary: false, hunks: [] },
    { path: "src/baz.ts", status: "renamed", additions: 0, deletions: 0, binary: false, hunks: [] },
  ];

  it("overrides entry change with real status from diffFiles", () => {
    const blocks = parseVisualBlocks([
      {
        type: "file-tree",
        id: "ft1",
        entries: [{ path: "src/foo.ts", change: "added" }], // wrong change
      },
    ]);
    const result = reconcileFileTree(blocks, diffFiles);
    const block = result[0];
    if (block.type === "file-tree") {
      expect(block.entries[0].change).toBe("modified");
    }
  });

  it("maps deleted DiffFileStatus to removed FileTreeChange", () => {
    const blocks = parseVisualBlocks([
      {
        type: "file-tree",
        id: "ft1",
        entries: [{ path: "src/bar.ts", change: "added" }],
      },
    ]);
    const result = reconcileFileTree(blocks, diffFiles);
    const block = result[0];
    if (block.type === "file-tree") {
      expect(block.entries[0].change).toBe("removed");
    }
  });

  it("drops entries whose path is not in diffFiles", () => {
    const blocks = parseVisualBlocks([
      {
        type: "file-tree",
        id: "ft1",
        entries: [
          { path: "src/foo.ts", change: "modified" },
          { path: "invented/path.ts", change: "added" }, // not in diff
        ],
      },
    ]);
    const result = reconcileFileTree(blocks, diffFiles);
    const block = result[0];
    if (block.type === "file-tree") {
      expect(block.entries).toHaveLength(1);
      expect(block.entries[0].path).toBe("src/foo.ts");
    }
  });

  it("drops whole block when all entries are invented", () => {
    const blocks = parseVisualBlocks([
      {
        type: "file-tree",
        id: "ft1",
        entries: [{ path: "invented/path.ts", change: "added" }],
      },
    ]);
    const result = reconcileFileTree(blocks, diffFiles);
    expect(result).toEqual([]);
  });

  it("passes non-file-tree blocks unchanged", () => {
    const blocks = parseVisualBlocks([{ type: "rich-text", id: "r1", markdown: "hello" }]);
    const result = reconcileFileTree(blocks, diffFiles);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(blocks[0]);
  });

  it("does not mutate input", () => {
    const blocks = parseVisualBlocks([
      {
        type: "file-tree",
        id: "ft1",
        entries: [{ path: "src/foo.ts", change: "added" }],
      },
    ]);
    const originalChange = (blocks[0] as { type: "file-tree"; entries: { change: string }[] })
      .entries[0].change;
    reconcileFileTree(blocks, diffFiles);
    expect(
      (blocks[0] as { type: "file-tree"; entries: { change: string }[] }).entries[0].change,
    ).toBe(originalChange);
  });
});

// ── capDiffBlock ──────────────────────────────────────────────────────────────

describe("capDiffBlock", () => {
  const makeDiffFile = (lineCounts: number[]): DiffFile => ({
    path: "src/file.ts",
    status: "modified",
    additions: 0,
    deletions: 0,
    binary: false,
    hunks: lineCounts.map((n) => ({
      header: "@@ -1,1 +1,1 @@",
      lines: Array.from({ length: n }, (_, i) => ({
        kind: "add" as const,
        content: `line ${i}`,
        newNo: i + 1,
      })),
    })),
  });

  it("returns file unchanged when total lines ≤ DIFF_BLOCK_MAX_LINES", () => {
    const file = makeDiffFile([100, 200]);
    const result = capDiffBlock(file);
    expect(result).toBe(file); // same reference
  });

  it("returns truncated copy when total lines exceed DIFF_BLOCK_MAX_LINES", () => {
    const file = makeDiffFile([300, 400]); // 700 lines > 600
    const result = capDiffBlock(file);
    expect(result).not.toBe(file);
    expect(result.truncated).toBe(true);
    expect(result.hunks).toEqual([]);
  });

  it("preserves other fields in truncated copy", () => {
    const file = makeDiffFile([700]);
    const result = capDiffBlock(file);
    expect(result.path).toBe(file.path);
    expect(result.status).toBe(file.status);
    expect(result.additions).toBe(file.additions);
  });

  it("does not mutate input file", () => {
    const file = makeDiffFile([700]);
    const originalHunks = file.hunks;
    capDiffBlock(file);
    expect(file.hunks).toBe(originalHunks);
    expect(file.truncated).toBeUndefined();
  });

  it("uses DIFF_BLOCK_MAX_LINES = 600", () => {
    expect(DIFF_BLOCK_MAX_LINES).toBe(600);
  });

  it("accepts custom maxLines param", () => {
    const file = makeDiffFile([50]);
    const result = capDiffBlock(file, 30);
    expect(result.truncated).toBe(true);
  });
});

// ── constant arrays ────────────────────────────────────────────────────────────

describe("constant arrays", () => {
  it("CALLOUT_TONES contains expected values", () => {
    expect(CALLOUT_TONES).toContain("info");
    expect(CALLOUT_TONES).toContain("decision");
    expect(CALLOUT_TONES).toContain("risk");
    expect(CALLOUT_TONES).toContain("warning");
    expect(CALLOUT_TONES).toContain("success");
    expect(CALLOUT_TONES).toHaveLength(5);
  });

  it("FILE_TREE_CHANGES contains expected values", () => {
    expect(FILE_TREE_CHANGES).toContain("added");
    expect(FILE_TREE_CHANGES).toContain("modified");
    expect(FILE_TREE_CHANGES).toContain("removed");
    expect(FILE_TREE_CHANGES).toContain("renamed");
    expect(FILE_TREE_CHANGES).toHaveLength(4);
  });
});
