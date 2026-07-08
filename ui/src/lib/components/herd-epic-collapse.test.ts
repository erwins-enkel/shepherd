import { describe, expect, it } from "vitest";
import { normalizeEpicCollapse } from "./herd-epic-collapse";

describe("normalizeEpicCollapse", () => {
  it("opens the first rendered group and collapses non-first groups by default", () => {
    const next = normalizeEpicCollapse(["a", "b", "c"], new Set(), new Set());

    expect([...next.collapsed].sort()).toEqual(["b", "c"]);
    expect([...next.touched]).toEqual([]);
  });

  it("prunes stale collapsed and touched keys", () => {
    const next = normalizeEpicCollapse(
      ["a"],
      new Set(["gone-collapsed", "a"]),
      new Set(["gone-touched"]),
    );

    expect([...next.collapsed]).toEqual([]);
    expect([...next.touched]).toEqual([]);
  });

  it("collapses a previously auto-open group when a new group appears above it", () => {
    const first = normalizeEpicCollapse(["b"], new Set(), new Set());
    expect([...first.collapsed]).toEqual([]);

    const second = normalizeEpicCollapse(["a", "b"], first.collapsed, first.touched);

    expect([...second.collapsed]).toEqual(["b"]);
  });

  it("preserves a user-opened non-first group across later normalization", () => {
    const next = normalizeEpicCollapse(["a", "b", "c"], new Set(["c"]), new Set(["b"]));

    expect([...next.collapsed].sort()).toEqual(["c"]);
    expect([...next.touched]).toEqual(["b"]);
  });

  it("preserves a user-collapsed first group across later normalization", () => {
    const next = normalizeEpicCollapse(["a", "b"], new Set(["a"]), new Set(["a"]));

    expect([...next.collapsed].sort()).toEqual(["a", "b"]);
    expect([...next.touched]).toEqual(["a"]);
  });

  it("preserves an explicitly expanded needs-you group from default re-collapse", () => {
    const next = normalizeEpicCollapse(["a", "b"], new Set(), new Set(["b"]));

    expect([...next.collapsed]).toEqual([]);
    expect([...next.touched]).toEqual(["b"]);
  });
});
