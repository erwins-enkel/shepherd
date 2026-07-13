import { describe, it, expect } from "vitest";
import { fileSignature, estimateHeight } from "./pierre-diff";
import type { DiffFile } from "./types";

// NODE project: pure helpers only. This file must NOT trigger any @pierre/diffs
// runtime import (which needs a DOM) — see pierre-diff.browser.test.ts for that.

function diffFile(overrides: Partial<DiffFile> = {}): DiffFile {
  return {
    path: "src/foo.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    binary: false,
    ...overrides,
  };
}

describe("fileSignature", () => {
  it("identical files produce identical signatures", () => {
    const a = diffFile({ patch: "@@ -1 +1 @@\n-a\n+b\n" });
    const b = diffFile({ patch: "@@ -1 +1 @@\n-a\n+b\n" });
    expect(fileSignature(a)).toBe(fileSignature(b));
  });

  it("a changed patch changes the signature", () => {
    const a = diffFile({ patch: "@@ -1 +1 @@\n-a\n+b\n" });
    const b = diffFile({ patch: "@@ -1 +1 @@\n-a\n+c\n" });
    expect(fileSignature(a)).not.toBe(fileSignature(b));
  });

  it("changed additions/deletions on a binary (no-patch) file changes the signature", () => {
    const a = diffFile({ binary: true, additions: 0, deletions: 0, patch: undefined });
    const b = diffFile({ binary: true, additions: 3, deletions: 2, patch: undefined });
    expect(fileSignature(a)).not.toBe(fileSignature(b));
  });

  it("is stable across repeated calls", () => {
    const file = diffFile({ patch: "@@ -1 +1 @@\n-a\n+b\n" });
    expect(fileSignature(file)).toBe(fileSignature(file));
  });
});

describe("estimateHeight", () => {
  it("returns a positive integer", () => {
    const height = estimateHeight(diffFile({ patch: "@@ -1 +1 @@\n-a\n+b\n" }));
    expect(Number.isInteger(height)).toBe(true);
    expect(height).toBeGreaterThan(0);
  });

  it("a file with more patch lines estimates taller than one with fewer", () => {
    const short = estimateHeight(diffFile({ patch: "@@ -1 +1 @@\n-a\n+b\n" }));
    const long = estimateHeight(
      diffFile({ patch: "@@ -1,5 +1,5 @@\n-a\n-b\n-c\n-d\n-e\n+a\n+b\n+c\n+d\n+f\n" }),
    );
    expect(long).toBeGreaterThan(short);
  });

  it("falls back to additions+deletions for a no-patch (binary) file", () => {
    const height = estimateHeight(
      diffFile({ binary: true, additions: 4, deletions: 6, patch: undefined }),
    );
    expect(Number.isInteger(height)).toBe(true);
    expect(height).toBeGreaterThan(0);
  });
});
