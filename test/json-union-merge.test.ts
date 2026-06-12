import { describe, expect, test } from "bun:test";
import { mergeCatalogs } from "../scripts/json-union-merge.mjs";

// The merge driver's whole reason to exist: two branches that each only *add*
// keys to a flat i18n catalog must union cleanly with no conflict — that is the
// ~99% case behind the constantly-reoccurring catalog conflicts.
describe("mergeCatalogs — additive (the common case)", () => {
  const base = { a: "1", b: "2" };

  test("disjoint additions on both sides union with no conflict", () => {
    const ours = { a: "1", b: "2", ours_key: "o" };
    const theirs = { a: "1", b: "2", theirs_key: "t" };
    const { merged, conflicts } = mergeCatalogs(base, ours, theirs);
    expect(conflicts).toEqual([]);
    expect(merged).toEqual({ a: "1", b: "2", ours_key: "o", theirs_key: "t" });
  });

  test("the same key added identically on both sides is not a conflict", () => {
    const ours = { a: "1", b: "2", shared: "x" };
    const theirs = { a: "1", b: "2", shared: "x" };
    const { merged, conflicts } = mergeCatalogs(base, ours, theirs);
    expect(conflicts).toEqual([]);
    expect(merged).toEqual({ a: "1", b: "2", shared: "x" });
  });

  test("ours order is preserved and theirs-only keys are appended", () => {
    const ours = { a: "1", b: "2", o: "o" };
    const theirs = { a: "1", b: "2", t1: "t1", t2: "t2" };
    const { merged } = mergeCatalogs(base, ours, theirs);
    expect(Object.keys(merged)).toEqual(["a", "b", "o", "t1", "t2"]);
  });
});

describe("mergeCatalogs — one-sided edits (auto-resolvable)", () => {
  const base = { a: "1", b: "2" };

  test("only theirs changed an existing key ⇒ take theirs", () => {
    const ours = { a: "1", b: "2" };
    const theirs = { a: "1", b: "CHANGED" };
    const { merged, conflicts } = mergeCatalogs(base, ours, theirs);
    expect(conflicts).toEqual([]);
    expect(merged.b).toBe("CHANGED");
  });

  test("only ours changed an existing key ⇒ keep ours", () => {
    const ours = { a: "1", b: "CHANGED" };
    const theirs = { a: "1", b: "2" };
    const { merged, conflicts } = mergeCatalogs(base, ours, theirs);
    expect(conflicts).toEqual([]);
    expect(merged.b).toBe("CHANGED");
  });

  test("theirs deleted a key ours left untouched ⇒ stays deleted, no resurrection", () => {
    const ours = { a: "1", b: "2" };
    const theirs = { a: "1" };
    const { merged, conflicts } = mergeCatalogs(base, ours, theirs);
    expect(conflicts).toEqual([]);
    expect(merged).toEqual({ a: "1" });
  });

  test("ours deleted a key theirs left untouched ⇒ stays deleted", () => {
    const ours = { a: "1" };
    const theirs = { a: "1", b: "2" };
    const { merged, conflicts } = mergeCatalogs(base, ours, theirs);
    expect(conflicts).toEqual([]);
    expect(merged).toEqual({ a: "1" });
  });
});

describe("mergeCatalogs — genuine conflicts (must fail loud)", () => {
  const base = { a: "1", b: "2" };

  test("same existing key changed to different values on each side", () => {
    const ours = { a: "1", b: "OURS" };
    const theirs = { a: "1", b: "THEIRS" };
    const { conflicts } = mergeCatalogs(base, ours, theirs);
    expect(conflicts).toEqual(["b"]);
  });

  test("same new key added with different values on each side", () => {
    const ours = { a: "1", b: "2", k: "OURS" };
    const theirs = { a: "1", b: "2", k: "THEIRS" };
    const { conflicts } = mergeCatalogs(base, ours, theirs);
    expect(conflicts).toEqual(["k"]);
  });

  test("ours changed a key theirs deleted ⇒ conflict (don't silently drop the edit)", () => {
    const ours = { a: "1", b: "OURS" };
    const theirs = { a: "1" };
    const { conflicts } = mergeCatalogs(base, ours, theirs);
    expect(conflicts).toEqual(["b"]);
  });

  test("clean additions still merge alongside a conflicting key", () => {
    const ours = { a: "1", b: "OURS", o: "o" };
    const theirs = { a: "1", b: "THEIRS", t: "t" };
    const { merged, conflicts } = mergeCatalogs(base, ours, theirs);
    expect(conflicts).toEqual(["b"]);
    // the additive keys are preserved even though `b` conflicts
    expect(merged.o).toBe("o");
    expect(merged.t).toBe("t");
  });
});
