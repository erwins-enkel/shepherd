import { describe, it, expect } from "vitest";
import { langFromPath, diffTotals, diffToFileTree } from "./diff";
import type { DiffFile } from "./types";

const file = (over: Partial<DiffFile>): DiffFile => ({
  path: "x.ts",
  status: "modified",
  additions: 0,
  deletions: 0,
  binary: false,
  hunks: [],
  ...over,
});

describe("langFromPath", () => {
  it("maps known extensions to shiki language ids", () => {
    expect(langFromPath("src/server.ts")).toBe("typescript");
    expect(langFromPath("a/b.svelte")).toBe("svelte");
    expect(langFromPath("style.css")).toBe("css");
    expect(langFromPath("data.json")).toBe("json");
    expect(langFromPath("run.py")).toBe("python");
  });
  it("falls back to text for unknown/extensionless paths", () => {
    expect(langFromPath("LICENSE")).toBe("text");
    expect(langFromPath("weird.xyz")).toBe("text");
  });
});

describe("diffTotals", () => {
  it("sums files and +/- across the file list", () => {
    const t = diffTotals([
      file({ additions: 3, deletions: 1 }),
      file({ additions: 10, deletions: 0 }),
    ]);
    expect(t).toEqual({ files: 2, additions: 13, deletions: 1 });
  });
});

describe("diffToFileTree", () => {
  it("maps deleted status to removed change", () => {
    const entries = diffToFileTree([
      file({ path: "src/old.ts", status: "deleted", additions: 0, deletions: 5 }),
    ]);
    expect(entries).toEqual([{ path: "src/old.ts", change: "removed", note: "+0 −5" }]);
  });

  it("passes through added, modified, renamed statuses unchanged", () => {
    const entries = diffToFileTree([
      file({ path: "src/new.ts", status: "added", additions: 10, deletions: 0 }),
      file({ path: "src/main.ts", status: "modified", additions: 5, deletions: 3 }),
      file({
        path: "src/renamed.ts",
        oldPath: "src/old.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
      }),
    ]);
    expect(entries).toEqual([
      { path: "src/new.ts", change: "added", note: "+10 −0" },
      { path: "src/main.ts", change: "modified", note: "+5 −3" },
      { path: "src/renamed.ts", change: "renamed" },
    ]);
  });

  it("uses unicode minus sign U+2212 in the note", () => {
    const entries = diffToFileTree([file({ path: "test.js", additions: 12, deletions: 3 })]);
    expect(entries[0].note).toBe("+12 −3");
    expect(entries[0].note?.charCodeAt(4)).toBe(0x2212); // verify the − character
  });

  it("omits note when both additions and deletions are zero", () => {
    const entries = diffToFileTree([
      file({ path: "binary.bin", binary: true, additions: 0, deletions: 0 }),
    ]);
    expect(entries).toEqual([{ path: "binary.bin", change: "modified" }]);
  });

  it("returns empty array for empty input", () => {
    expect(diffToFileTree([])).toEqual([]);
  });

  it("preserves input order across multiple files", () => {
    const entries = diffToFileTree([
      file({ path: "a.ts", additions: 1, deletions: 0 }),
      file({ path: "b.ts", additions: 2, deletions: 1 }),
      file({ path: "c.ts", additions: 0, deletions: 3 }),
    ]);
    expect(entries).toEqual([
      { path: "a.ts", change: "modified", note: "+1 −0" },
      { path: "b.ts", change: "modified", note: "+2 −1" },
      { path: "c.ts", change: "modified", note: "+0 −3" },
    ]);
  });
});
