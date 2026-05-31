import { describe, it, expect } from "vitest";
import { langFromPath, diffTotals } from "./diff";
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
