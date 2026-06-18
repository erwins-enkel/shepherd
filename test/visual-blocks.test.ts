import { describe, expect, it } from "bun:test";
import type { DiffFile, DiffHunk } from "../src/types";
import type { VisualBlock } from "../src/visual-blocks";

function asBlock<T extends VisualBlock["type"]>(
  b: VisualBlock | undefined,
  t: T,
): Extract<VisualBlock, { type: T }> {
  expect(b?.type).toBe(t);
  return b as Extract<VisualBlock, { type: T }>;
}
import {
  CALLOUT_TONES,
  DIFF_BLOCK_MAX_LINES,
  FILE_TREE_CHANGES,
  capDiffBlock,
  groundBlocks,
  joinCodeBlocks,
  joinDiffBlocks,
  markInferred,
  parseVisualBlocks,
  reconcileFileTree,
} from "../src/visual-blocks";

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
    const block = asBlock(result[0], "file-tree");
    expect(block.entries).toHaveLength(1);
    expect(block.title).toBe("Changed files");
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
    const block = asBlock(result[0], "file-tree");
    expect(block.entries).toHaveLength(2);
    expect(block.entries[0]!.path).toBe("good.ts");
    expect(block.entries[1]!.path).toBe("also-good.ts");
  });

  it("coerces optional note in file-tree entry when string", () => {
    const result = parseVisualBlocks([
      {
        type: "file-tree",
        id: "ft1",
        entries: [{ path: "src/foo.ts", change: "added", note: "important" }],
      },
    ]);
    const block = asBlock(result[0], "file-tree");
    expect(block.entries[0]!.note).toBe("important");
  });

  it("drops note from file-tree entry when not a string", () => {
    const result = parseVisualBlocks([
      {
        type: "file-tree",
        id: "ft1",
        entries: [{ path: "src/foo.ts", change: "added", note: 123 }],
      },
    ]);
    const block = asBlock(result[0], "file-tree");
    expect(block.entries[0]!.note).toBeUndefined();
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
    const block = asBlock(result[0], "file-tree");
    expect(block.title).toBeUndefined();
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
    const block = asBlock(result[0], "diff");
    expect(block.annotations).toHaveLength(1);
    expect(block.annotations![0]!.note).toBe("good");
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
    const block = asBlock(result[0], "diff");
    const ann = block.annotations![0] as unknown as Record<string, unknown>;
    expect(ann.lines).toBeUndefined();
    expect(ann.side).toBeUndefined();
    expect(ann.note).toBe("prose");
    expect(ann.label).toBe("L");
  });

  it("preserves input order of surviving blocks", () => {
    const result = parseVisualBlocks([
      { type: "rich-text", id: "r1", markdown: "first" },
      { type: "callout", id: "c1", tone: "info", markdown: "second" },
      { type: "rich-text", id: "r2", markdown: "third" },
    ]);
    expect(result.map((b) => b.id)).toEqual(["r1", "c1", "r2"]);
  });

  it("drops a later block with a duplicate id (keyed-each needs unique ids)", () => {
    const result = parseVisualBlocks([
      { type: "rich-text", id: "dup", markdown: "first" },
      { type: "callout", id: "dup", tone: "info", markdown: "second" },
      { type: "rich-text", id: "keep", markdown: "third" },
    ]);
    expect(result.map((b) => b.id)).toEqual(["dup", "keep"]);
    expect(result.map((b) => b.type)).toEqual(["rich-text", "rich-text"]);
  });

  it("reserves a duplicate id only once a VALID block used it", () => {
    // first block with id "x" is invalid (missing markdown) and dropped → the id is not reserved,
    // so the later valid block with the same id survives.
    const result = parseVisualBlocks([
      { type: "rich-text", id: "x" }, // invalid: no markdown → dropped, id not reserved
      { type: "callout", id: "x", tone: "risk", markdown: "real" },
    ]);
    expect(result.map((b) => b.id)).toEqual(["x"]);
    expect(result[0]?.type).toBe("callout");
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
    const block = asBlock(result[0], "diff");
    expect(block.file).toBe(fooFile);
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
    const block = asBlock(result[0], "file-tree");
    expect(block.entries[0]!.change).toBe("modified");
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
    const block = asBlock(result[0], "file-tree");
    expect(block.entries[0]!.change).toBe("removed");
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
    const block = asBlock(result[0], "file-tree");
    expect(block.entries).toHaveLength(1);
    expect(block.entries[0]!.path).toBe("src/foo.ts");
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
    const originalBlock = asBlock(blocks[0], "file-tree");
    const originalChange = originalBlock.entries[0]!.change;
    reconcileFileTree(blocks, diffFiles);
    expect(asBlock(blocks[0], "file-tree").entries[0]!.change).toBe(originalChange);
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

// ── groundBlocks ─────────────────────────────────────────────────────────────

describe("groundBlocks", () => {
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

  const makeHunkFile = (path: string, lineCount: number): DiffFile => ({
    path,
    status: "modified",
    additions: lineCount,
    deletions: 0,
    binary: false,
    hunks: [
      {
        header: "@@ -1,1 +1,1 @@",
        lines: Array.from({ length: lineCount }, (_, i) => ({
          kind: "add" as const,
          content: `line ${i}`,
          newNo: i + 1,
        })),
      },
    ],
  });

  describe("carrier present (pendingDiff non-empty)", () => {
    it("diff block matched to pendingDiff gets .file attached", () => {
      const blocks = parseVisualBlocks([
        { type: "diff", id: "d1", path: "src/foo.ts", summary: "changed foo" },
      ]);
      const result = groundBlocks(blocks, [fooFile, barFile], ["src/foo.ts", "src/bar.ts"]);
      expect(result).toHaveLength(1);
      const blk = asBlock(result[0], "diff");
      expect(blk.file).toBe(fooFile);
    });

    it("unmatched diff block is dropped", () => {
      const blocks = parseVisualBlocks([
        { type: "diff", id: "d1", path: "src/missing.ts", summary: "invented" },
      ]);
      const result = groundBlocks(blocks, [fooFile], ["src/foo.ts"]);
      expect(result).toEqual([]);
    });

    it("over-cap diff file is truncated", () => {
      const bigFile = makeHunkFile("src/foo.ts", DIFF_BLOCK_MAX_LINES + 1);
      const blocks = parseVisualBlocks([
        { type: "diff", id: "d1", path: "src/foo.ts", summary: "big change" },
      ]);
      const result = groundBlocks(blocks, [bigFile], ["src/foo.ts"]);
      const blk = asBlock(result[0], "diff");
      expect(blk.file?.truncated).toBe(true);
      expect(blk.file?.hunks).toEqual([]);
    });

    it("file-tree entries reconciled against real diff statuses", () => {
      const blocks = parseVisualBlocks([
        {
          type: "file-tree",
          id: "ft1",
          entries: [
            { path: "src/foo.ts", change: "added" }, // wrong: real is "modified"
            { path: "src/bar.ts", change: "modified" }, // wrong: real is "added"
            { path: "invented.ts", change: "added" }, // not in diff → dropped
          ],
        },
      ]);
      const result = groundBlocks(blocks, [fooFile, barFile], ["src/foo.ts", "src/bar.ts"]);
      expect(result).toHaveLength(1);
      const blk = asBlock(result[0], "file-tree");
      expect(blk.entries).toHaveLength(2);
      expect(blk.entries[0]!.change).toBe("modified");
      expect(blk.entries[1]!.change).toBe("added");
    });
  });

  describe("carrier empty (pendingDiff = [])", () => {
    it("diff blocks are dropped", () => {
      const blocks = parseVisualBlocks([
        { type: "diff", id: "d1", path: "src/foo.ts", summary: "x" },
      ]);
      const result = groundBlocks(blocks, [], ["src/foo.ts"]);
      expect(result).toEqual([]);
    });

    it("file-tree keeps only entries whose path is in changedFiles", () => {
      const blocks = parseVisualBlocks([
        {
          type: "file-tree",
          id: "ft1",
          entries: [
            { path: "src/foo.ts", change: "modified" },
            { path: "src/unknown.ts", change: "added" },
          ],
        },
      ]);
      const result = groundBlocks(blocks, [], ["src/foo.ts"]);
      expect(result).toHaveLength(1);
      const blk = asBlock(result[0], "file-tree");
      expect(blk.entries).toHaveLength(1);
      expect(blk.entries[0]!.path).toBe("src/foo.ts");
      // authored change preserved (no real diff to reconcile against)
      expect(blk.entries[0]!.change).toBe("modified");
    });

    it("file-tree block dropped when no entries are in changedFiles", () => {
      const blocks = parseVisualBlocks([
        {
          type: "file-tree",
          id: "ft1",
          entries: [{ path: "not-in-changed.ts", change: "added" }],
        },
      ]);
      const result = groundBlocks(blocks, [], ["src/foo.ts"]);
      expect(result).toEqual([]);
    });

    it("rich-text passes through untouched", () => {
      const blocks = parseVisualBlocks([{ type: "rich-text", id: "r1", markdown: "summary text" }]);
      const result = groundBlocks(blocks, [], []);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(blocks[0]);
    });

    it("callout passes through untouched", () => {
      const blocks = parseVisualBlocks([
        { type: "callout", id: "c1", tone: "info", markdown: "a note" },
      ]);
      const result = groundBlocks(blocks, [], []);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(blocks[0]);
    });
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

// ── Phase-2 validators ────────────────────────────────────────────────────────

describe("validateCode (type=code)", () => {
  it("accepts valid code block with filename only", () => {
    const result = parseVisualBlocks([{ type: "code", id: "c1", filename: "src/foo.ts" }]);
    expect(result).toHaveLength(1);
    const block = asBlock(result[0], "code");
    expect(block.filename).toBe("src/foo.ts");
  });

  it("accepts code block with optional language", () => {
    const result = parseVisualBlocks([
      { type: "code", id: "c1", filename: "src/foo.ts", language: "typescript" },
    ]);
    const block = asBlock(result[0], "code");
    expect(block.language).toBe("typescript");
  });

  it("drops code block missing filename", () => {
    const result = parseVisualBlocks([{ type: "code", id: "c1" }]);
    expect(result).toEqual([]);
  });

  it("drops code block with empty filename", () => {
    const result = parseVisualBlocks([{ type: "code", id: "c1", filename: "" }]);
    expect(result).toEqual([]);
  });

  it("strips incoming code field (server-populated)", () => {
    const result = parseVisualBlocks([
      { type: "code", id: "c1", filename: "src/foo.ts", code: "const x = 1;" },
    ]);
    const block = asBlock(result[0], "code");
    expect((block as unknown as Record<string, unknown>).code).toBeUndefined();
  });

  it("strips incoming truncated field (server-populated)", () => {
    const result = parseVisualBlocks([
      { type: "code", id: "c1", filename: "src/foo.ts", truncated: true },
    ]);
    const block = asBlock(result[0], "code");
    expect((block as unknown as Record<string, unknown>).truncated).toBeUndefined();
  });
});

describe("validateAnnotatedCode (type=annotated-code)", () => {
  it("accepts valid annotated-code block with filename only", () => {
    const result = parseVisualBlocks([{ type: "annotated-code", id: "ac1", filename: "new.ts" }]);
    expect(result).toHaveLength(1);
    const block = asBlock(result[0], "annotated-code");
    expect(block.filename).toBe("new.ts");
  });

  it("accepts annotations with label and note", () => {
    const result = parseVisualBlocks([
      {
        type: "annotated-code",
        id: "ac1",
        filename: "new.ts",
        annotations: [{ label: "Entry point", note: "This is where we start" }],
      },
    ]);
    const block = asBlock(result[0], "annotated-code");
    expect(block.annotations).toHaveLength(1);
    expect(block.annotations![0]!.note).toBe("This is where we start");
    expect(block.annotations![0]!.label).toBe("Entry point");
  });

  it("drops annotation missing note", () => {
    const result = parseVisualBlocks([
      {
        type: "annotated-code",
        id: "ac1",
        filename: "new.ts",
        annotations: [{ label: "X" }, { note: "valid" }],
      },
    ]);
    const block = asBlock(result[0], "annotated-code");
    expect(block.annotations).toHaveLength(1);
    expect(block.annotations![0]!.note).toBe("valid");
  });

  it("strips lines/side from annotations (prose-only, Phase-1 precedent)", () => {
    const result = parseVisualBlocks([
      {
        type: "annotated-code",
        id: "ac1",
        filename: "new.ts",
        annotations: [{ note: "desc", lines: [1, 2], side: "left" }],
      },
    ]);
    const block = asBlock(result[0], "annotated-code");
    const ann = block.annotations![0] as unknown as Record<string, unknown>;
    expect(ann.lines).toBeUndefined();
    expect(ann.side).toBeUndefined();
    expect(ann.note).toBe("desc");
  });

  it("drops annotated-code with empty filename", () => {
    const result = parseVisualBlocks([{ type: "annotated-code", id: "ac1", filename: "" }]);
    expect(result).toEqual([]);
  });

  it("strips incoming code and truncated (server-populated)", () => {
    const result = parseVisualBlocks([
      { type: "annotated-code", id: "ac1", filename: "new.ts", code: "body", truncated: true },
    ]);
    const block = asBlock(result[0], "annotated-code");
    const b = block as unknown as Record<string, unknown>;
    expect(b.code).toBeUndefined();
    expect(b.truncated).toBeUndefined();
  });
});

describe("validateDataModel (type=data-model)", () => {
  const validEntity = {
    id: "e1",
    name: "User",
    fields: [{ name: "id", type: "uuid" }],
  };

  it("accepts a valid data-model block", () => {
    const result = parseVisualBlocks([{ type: "data-model", id: "dm1", entities: [validEntity] }]);
    expect(result).toHaveLength(1);
    const block = asBlock(result[0], "data-model");
    expect(block.entities).toHaveLength(1);
    expect(block.entities[0]!.name).toBe("User");
  });

  it("drops data-model with no entities", () => {
    const result = parseVisualBlocks([{ type: "data-model", id: "dm1", entities: [] }]);
    expect(result).toEqual([]);
  });

  it("drops entity missing fields", () => {
    const result = parseVisualBlocks([
      { type: "data-model", id: "dm1", entities: [{ id: "e1", name: "User" }] },
    ]);
    expect(result).toEqual([]);
  });

  it("drops entity with no valid fields", () => {
    const result = parseVisualBlocks([
      {
        type: "data-model",
        id: "dm1",
        entities: [{ id: "e1", name: "User", fields: [{ name: 123, type: "uuid" }] }],
      },
    ]);
    expect(result).toEqual([]);
  });

  it("strips incoming inferred field (server forces it)", () => {
    const result = parseVisualBlocks([
      { type: "data-model", id: "dm1", entities: [validEntity], inferred: false },
    ]);
    const block = asBlock(result[0], "data-model");
    expect((block as unknown as Record<string, unknown>).inferred).toBeUndefined();
  });

  it("accepts optional relations array", () => {
    const result = parseVisualBlocks([
      {
        type: "data-model",
        id: "dm1",
        entities: [validEntity],
        relations: [{ from: "User", to: "Post", kind: "has-many" }],
      },
    ]);
    const block = asBlock(result[0], "data-model");
    expect(block.relations).toHaveLength(1);
  });

  it("accepts field with pk, fk, nullable, change, was", () => {
    const result = parseVisualBlocks([
      {
        type: "data-model",
        id: "dm1",
        entities: [
          {
            id: "e1",
            name: "User",
            fields: [
              {
                name: "id",
                type: "uuid",
                pk: true,
                fk: "other.id",
                nullable: false,
                change: "added",
                was: "text",
              },
            ],
          },
        ],
      },
    ]);
    const block = asBlock(result[0], "data-model");
    const field = block.entities[0]!.fields[0]!;
    expect(field.pk).toBe(true);
    expect(field.fk).toBe("other.id");
    expect(field.change).toBe("added");
    expect(field.was).toBe("text");
  });
});

describe("validateApiEndpoint (type=api-endpoint)", () => {
  it("accepts a valid api-endpoint block", () => {
    const result = parseVisualBlocks([
      { type: "api-endpoint", id: "ae1", method: "GET", path: "/users" },
    ]);
    expect(result).toHaveLength(1);
    const block = asBlock(result[0], "api-endpoint");
    expect(block.method).toBe("GET");
    expect(block.path).toBe("/users");
  });

  it("drops api-endpoint missing method", () => {
    const result = parseVisualBlocks([{ type: "api-endpoint", id: "ae1", path: "/users" }]);
    expect(result).toEqual([]);
  });

  it("drops api-endpoint missing path", () => {
    const result = parseVisualBlocks([{ type: "api-endpoint", id: "ae1", method: "GET" }]);
    expect(result).toEqual([]);
  });

  it("strips incoming inferred field", () => {
    const result = parseVisualBlocks([
      { type: "api-endpoint", id: "ae1", method: "POST", path: "/items", inferred: true },
    ]);
    const block = asBlock(result[0], "api-endpoint");
    expect((block as unknown as Record<string, unknown>).inferred).toBeUndefined();
  });

  it("coerces params array; drops param with non-string name or in or type", () => {
    const result = parseVisualBlocks([
      {
        type: "api-endpoint",
        id: "ae1",
        method: "GET",
        path: "/items",
        params: [
          { name: "id", in: "path", type: "string" },
          { name: 42, in: "query", type: "string" }, // bad name
          { name: "q", in: "query", type: "string", required: true, note: "filter" },
        ],
      },
    ]);
    const block = asBlock(result[0], "api-endpoint");
    expect(block.params).toHaveLength(2);
    expect(block.params![1]!.note).toBe("filter");
  });

  it("coerces responses array; drops response with non-number status", () => {
    const result = parseVisualBlocks([
      {
        type: "api-endpoint",
        id: "ae1",
        method: "GET",
        path: "/items",
        responses: [
          { status: 200, description: "OK" },
          { status: "201", description: "Created" }, // string status → drop
        ],
      },
    ]);
    const block = asBlock(result[0], "api-endpoint");
    expect(block.responses).toHaveLength(1);
    expect(block.responses![0]!.status).toBe(200);
  });
});

describe("validateTable (type=table)", () => {
  it("accepts a valid table block", () => {
    const result = parseVisualBlocks([
      {
        type: "table",
        id: "t1",
        columns: ["Name", "Type"],
        rows: [
          ["id", "uuid"],
          ["name", "text"],
        ],
      },
    ]);
    expect(result).toHaveLength(1);
    const block = asBlock(result[0], "table");
    expect(block.columns).toHaveLength(2);
    expect(block.rows).toHaveLength(2);
  });

  it("drops table with no columns", () => {
    const result = parseVisualBlocks([{ type: "table", id: "t1", columns: [], rows: [] }]);
    expect(result).toEqual([]);
  });

  it("drops table with non-array columns", () => {
    const result = parseVisualBlocks([{ type: "table", id: "t1", columns: "Name,Type", rows: [] }]);
    expect(result).toEqual([]);
  });

  it("pads short rows to column count", () => {
    const result = parseVisualBlocks([
      {
        type: "table",
        id: "t1",
        columns: ["A", "B", "C"],
        rows: [["x", "y"]], // only 2 elements for 3 columns → pad
      },
    ]);
    const block = asBlock(result[0], "table");
    expect(block.rows[0]).toHaveLength(3);
    expect(block.rows[0]![2]).toBe("");
  });

  it("truncates long rows to column count", () => {
    const result = parseVisualBlocks([
      {
        type: "table",
        id: "t1",
        columns: ["A", "B"],
        rows: [["x", "y", "z"]], // 3 for 2 columns → truncate
      },
    ]);
    const block = asBlock(result[0], "table");
    expect(block.rows[0]).toHaveLength(2);
  });

  it("drops rows that are not arrays", () => {
    const result = parseVisualBlocks([
      {
        type: "table",
        id: "t1",
        columns: ["A"],
        rows: [["valid"], "not-array"],
      },
    ]);
    const block = asBlock(result[0], "table");
    expect(block.rows).toHaveLength(1);
  });
});

describe("validateChecklist (type=checklist)", () => {
  it("accepts a valid checklist block", () => {
    const result = parseVisualBlocks([
      {
        type: "checklist",
        id: "cl1",
        items: [
          { id: "i1", label: "Write tests" },
          { id: "i2", label: "Implement", checked: true, note: "done" },
        ],
      },
    ]);
    expect(result).toHaveLength(1);
    const block = asBlock(result[0], "checklist");
    expect(block.items).toHaveLength(2);
    expect(block.items[1]!.checked).toBe(true);
    expect(block.items[1]!.note).toBe("done");
  });

  it("drops checklist with no items", () => {
    const result = parseVisualBlocks([{ type: "checklist", id: "cl1", items: [] }]);
    expect(result).toEqual([]);
  });

  it("drops item missing label", () => {
    const result = parseVisualBlocks([
      {
        type: "checklist",
        id: "cl1",
        items: [{ id: "i1" }, { id: "i2", label: "valid" }],
      },
    ]);
    const block = asBlock(result[0], "checklist");
    expect(block.items).toHaveLength(1);
    expect(block.items[0]!.label).toBe("valid");
  });

  it("drops item missing id", () => {
    const result = parseVisualBlocks([
      {
        type: "checklist",
        id: "cl1",
        items: [{ label: "no-id" }, { id: "i2", label: "valid" }],
      },
    ]);
    const block = asBlock(result[0], "checklist");
    expect(block.items).toHaveLength(1);
  });

  it("drops checklist with no valid items", () => {
    const result = parseVisualBlocks([{ type: "checklist", id: "cl1", items: [{ id: "i1" }] }]);
    expect(result).toEqual([]);
  });
});

// ── joinCodeBlocks ────────────────────────────────────────────────────────────

/** Build a real added-file DiffFile from a list of line strings. */
function makeAddedFile(path: string, lines: string[]): DiffFile {
  const hunk: DiffHunk = {
    header: `@@ -0,0 +1,${lines.length} @@`,
    lines: lines.map((content, i) => ({ kind: "add" as const, content, newNo: i + 1 })),
  };
  return {
    path,
    status: "added",
    additions: lines.length,
    deletions: 0,
    binary: false,
    hunks: [hunk],
  };
}

describe("joinCodeBlocks", () => {
  it("reconstructs code from added-file DiffFile hunks", () => {
    const diff = makeAddedFile("src/new.ts", ["const x = 1;", "export default x;"]);
    const blocks = parseVisualBlocks([{ type: "code", id: "c1", filename: "src/new.ts" }]);
    const result = joinCodeBlocks(blocks, [diff]);
    expect(result).toHaveLength(1);
    const block = asBlock(result[0], "code");
    expect(block.code).toBe("const x = 1;\nexport default x;");
    expect(block.truncated).toBeUndefined();
  });

  it("skips del lines and includes ctx lines in reconstruction", () => {
    // for an added file hunks should only have add lines, but verify ctx lines too
    const file: DiffFile = {
      path: "src/new.ts",
      status: "added",
      additions: 2,
      deletions: 0,
      binary: false,
      hunks: [
        {
          header: "@@ -0,0 +1,2 @@",
          lines: [
            { kind: "add", content: "line a", newNo: 1 },
            { kind: "ctx", content: "line b", oldNo: 2, newNo: 2 },
            { kind: "del", content: "deleted", oldNo: 1 },
          ],
        },
      ],
    };
    const blocks = parseVisualBlocks([{ type: "code", id: "c1", filename: "src/new.ts" }]);
    const result = joinCodeBlocks(blocks, [file]);
    const block = asBlock(result[0], "code");
    expect(block.code).toBe("line a\nline b");
  });

  it("drops block when path is not in diffFiles", () => {
    const diff = makeAddedFile("src/other.ts", ["x"]);
    const blocks = parseVisualBlocks([{ type: "code", id: "c1", filename: "src/missing.ts" }]);
    const result = joinCodeBlocks(blocks, [diff]);
    expect(result).toHaveLength(0);
  });

  it("drops block when file status is modified (not added)", () => {
    const diff: DiffFile = {
      path: "src/existing.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      binary: false,
      hunks: [{ header: "@@ -1,1 +1,1 @@", lines: [{ kind: "add", content: "x", newNo: 1 }] }],
    };
    const blocks = parseVisualBlocks([{ type: "code", id: "c1", filename: "src/existing.ts" }]);
    const result = joinCodeBlocks(blocks, [diff]);
    expect(result).toHaveLength(0);
  });

  it("drops block when file status is deleted", () => {
    const diff: DiffFile = {
      path: "src/gone.ts",
      status: "deleted",
      additions: 0,
      deletions: 5,
      binary: false,
      hunks: [],
    };
    const blocks = parseVisualBlocks([{ type: "code", id: "c1", filename: "src/gone.ts" }]);
    const result = joinCodeBlocks(blocks, [diff]);
    expect(result).toHaveLength(0);
  });

  it("added file with truncated:true and hunks:[] → empty body + truncated:true", () => {
    const diff: DiffFile = {
      path: "src/big.ts",
      status: "added",
      additions: 1000,
      deletions: 0,
      binary: false,
      truncated: true,
      hunks: [],
    };
    const blocks = parseVisualBlocks([{ type: "code", id: "c1", filename: "src/big.ts" }]);
    const result = joinCodeBlocks(blocks, [diff]);
    expect(result).toHaveLength(1);
    const block = asBlock(result[0], "code");
    expect(block.code).toBeUndefined();
    expect(block.truncated).toBe(true);
  });

  it("binary added file (binary:true, hunks:[]) → empty body + truncated:true", () => {
    const diff: DiffFile = {
      path: "assets/logo.png",
      status: "added",
      additions: 0,
      deletions: 0,
      binary: true,
      hunks: [],
    };
    const blocks = parseVisualBlocks([{ type: "code", id: "c1", filename: "assets/logo.png" }]);
    const result = joinCodeBlocks(blocks, [diff]);
    expect(result).toHaveLength(1);
    const block = asBlock(result[0], "code");
    expect(block.code).toBeUndefined();
    expect(block.truncated).toBe(true);
  });

  it("over-600-line added file → truncated:true + no code", () => {
    const lines = Array.from({ length: DIFF_BLOCK_MAX_LINES + 1 }, (_, i) => `line ${i}`);
    const diff = makeAddedFile("src/huge.ts", lines);
    const blocks = parseVisualBlocks([{ type: "code", id: "c1", filename: "src/huge.ts" }]);
    const result = joinCodeBlocks(blocks, [diff]);
    const block = asBlock(result[0], "code");
    expect(block.truncated).toBe(true);
    expect(block.code).toBeUndefined();
  });

  it("passes non-code/annotated-code blocks through", () => {
    const blocks = parseVisualBlocks([{ type: "rich-text", id: "r1", markdown: "hello" }]);
    const result = joinCodeBlocks(blocks, []);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(blocks[0]);
  });

  it("works the same for annotated-code blocks", () => {
    const diff = makeAddedFile("src/new.ts", ["const x = 1;"]);
    const blocks = parseVisualBlocks([
      {
        type: "annotated-code",
        id: "ac1",
        filename: "src/new.ts",
        annotations: [{ note: "entry point" }],
      },
    ]);
    const result = joinCodeBlocks(blocks, [diff]);
    expect(result).toHaveLength(1);
    const block = asBlock(result[0], "annotated-code");
    expect(block.code).toBe("const x = 1;");
    expect(block.annotations![0]!.note).toBe("entry point");
  });
});

// ── markInferred ──────────────────────────────────────────────────────────────

describe("markInferred", () => {
  it("sets inferred:true on data-model blocks", () => {
    const blocks = parseVisualBlocks([
      {
        type: "data-model",
        id: "dm1",
        entities: [{ id: "e1", name: "User", fields: [{ name: "id", type: "uuid" }] }],
      },
    ]);
    const result = markInferred(blocks);
    const block = asBlock(result[0], "data-model");
    expect(block.inferred).toBe(true);
  });

  it("sets inferred:true on api-endpoint blocks", () => {
    const blocks = parseVisualBlocks([
      { type: "api-endpoint", id: "ae1", method: "GET", path: "/users" },
    ]);
    const result = markInferred(blocks);
    const block = asBlock(result[0], "api-endpoint");
    expect(block.inferred).toBe(true);
  });

  it("does not set inferred on other block types", () => {
    const blocks = parseVisualBlocks([
      { type: "rich-text", id: "r1", markdown: "hello" },
      { type: "table", id: "t1", columns: ["A"], rows: [["x"]] },
    ]);
    const result = markInferred(blocks);
    for (const blk of result) {
      expect((blk as unknown as Record<string, unknown>).inferred).toBeUndefined();
    }
  });

  it("does not mutate input", () => {
    const blocks = parseVisualBlocks([
      { type: "api-endpoint", id: "ae1", method: "POST", path: "/items" },
    ]);
    const original = blocks[0] as unknown as Record<string, unknown>;
    expect(original.inferred).toBeUndefined();
    markInferred(blocks);
    expect(original.inferred).toBeUndefined(); // not mutated
  });
});

// ── groundBlocks Phase-2 extensions ──────────────────────────────────────────

describe("groundBlocks Phase-2", () => {
  const addedFile = makeAddedFile("src/new.ts", ["const x = 1;"]);
  const modifiedFile: DiffFile = {
    path: "src/existing.ts",
    status: "modified",
    additions: 1,
    deletions: 0,
    binary: false,
    hunks: [{ header: "@@ -1,1 +1,1 @@", lines: [{ kind: "add", content: "y", newNo: 1 }] }],
  };

  describe("carrier present", () => {
    it("code block for added file gets code attached", () => {
      const blocks = parseVisualBlocks([{ type: "code", id: "c1", filename: "src/new.ts" }]);
      const result = groundBlocks(blocks, [addedFile, modifiedFile], ["src/new.ts"]);
      const block = asBlock(result[0], "code");
      expect(block.code).toBe("const x = 1;");
    });

    it("code block for modified file is dropped", () => {
      const blocks = parseVisualBlocks([{ type: "code", id: "c1", filename: "src/existing.ts" }]);
      const result = groundBlocks(blocks, [addedFile, modifiedFile], ["src/existing.ts"]);
      expect(result).toHaveLength(0);
    });

    it("data-model block gets inferred:true in carrier-present path", () => {
      const blocks = parseVisualBlocks([
        {
          type: "data-model",
          id: "dm1",
          entities: [{ id: "e1", name: "User", fields: [{ name: "id", type: "uuid" }] }],
        },
      ]);
      const result = groundBlocks(blocks, [addedFile], ["src/new.ts"]);
      const block = asBlock(result[0], "data-model");
      expect(block.inferred).toBe(true);
    });

    it("api-endpoint block gets inferred:true in carrier-present path", () => {
      const blocks = parseVisualBlocks([
        { type: "api-endpoint", id: "ae1", method: "GET", path: "/users" },
      ]);
      const result = groundBlocks(blocks, [addedFile], ["src/new.ts"]);
      const block = asBlock(result[0], "api-endpoint");
      expect(block.inferred).toBe(true);
    });
  });

  describe("carrier miss", () => {
    it("code blocks are dropped in carrier-miss path", () => {
      const blocks = parseVisualBlocks([
        { type: "code", id: "c1", filename: "src/new.ts" },
        { type: "rich-text", id: "r1", markdown: "hello" },
      ]);
      const result = groundBlocks(blocks, [], ["src/new.ts"]);
      expect(result).toHaveLength(1);
      expect(result[0]?.type).toBe("rich-text");
    });

    it("annotated-code blocks are dropped in carrier-miss path", () => {
      const blocks = parseVisualBlocks([
        { type: "annotated-code", id: "ac1", filename: "src/new.ts" },
        { type: "callout", id: "cl1", tone: "info", markdown: "note" },
      ]);
      const result = groundBlocks(blocks, [], ["src/new.ts"]);
      expect(result).toHaveLength(1);
      expect(result[0]?.type).toBe("callout");
    });

    it("data-model kept and gets inferred:true in carrier-miss path", () => {
      const blocks = parseVisualBlocks([
        {
          type: "data-model",
          id: "dm1",
          entities: [{ id: "e1", name: "User", fields: [{ name: "id", type: "uuid" }] }],
        },
      ]);
      const result = groundBlocks(blocks, [], []);
      expect(result).toHaveLength(1);
      const block = asBlock(result[0], "data-model");
      expect(block.inferred).toBe(true);
    });

    it("table and checklist pass through in carrier-miss path", () => {
      const blocks = parseVisualBlocks([
        { type: "table", id: "t1", columns: ["A"], rows: [["x"]] },
        { type: "checklist", id: "cl1", items: [{ id: "i1", label: "do it" }] },
      ]);
      const result = groundBlocks(blocks, [], []);
      expect(result).toHaveLength(2);
    });

    it("api-endpoint gets inferred:true in carrier-miss path", () => {
      const blocks = parseVisualBlocks([
        { type: "api-endpoint", id: "ae1", method: "POST", path: "/items" },
      ]);
      const result = groundBlocks(blocks, [], []);
      const block = asBlock(result[0], "api-endpoint");
      expect(block.inferred).toBe(true);
    });
  });
});
