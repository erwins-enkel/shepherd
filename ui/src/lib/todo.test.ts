import { describe, it, expect } from "vitest";
import { toggleItem } from "./todo";

const DOC = `# Shepherd — Roadmap / TODO

## Done

- [x] already done

## In progress

- [ ] alpha
- [ ] beta
`;

function lines(s: string) {
  return s.split("\n");
}

describe("toggleItem — checking off", () => {
  it("moves a checked item into the ## Done section", () => {
    const out = toggleItem(DOC, lines(DOC).indexOf("- [ ] alpha"));
    const ls = lines(out);
    const doneAt = ls.indexOf("## Done");
    const alphaAt = ls.indexOf("- [x] alpha");
    const inProgAt = ls.indexOf("## In progress");
    // alpha is now checked, sits under Done, before the In progress heading
    expect(alphaAt).toBeGreaterThan(doneAt);
    expect(alphaAt).toBeLessThan(inProgAt);
    // no longer present as unchecked
    expect(ls).not.toContain("- [ ] alpha");
    // beta untouched and still under In progress
    expect(ls.indexOf("- [ ] beta")).toBeGreaterThan(inProgAt);
  });

  it("creates a ## Done section when none exists", () => {
    const doc = `# Title\n\n- [ ] solo\n`;
    const out = toggleItem(doc, lines(doc).indexOf("- [ ] solo"));
    const ls = lines(out);
    expect(ls.some((l) => /^#{1,6}\s+done/i.test(l))).toBe(true);
    expect(ls).toContain("- [x] solo");
    // Done heading comes before the item
    const doneAt = ls.findIndex((l) => /^#{1,6}\s+done/i.test(l));
    expect(ls.indexOf("- [x] solo")).toBeGreaterThan(doneAt);
  });
});

describe("toggleItem — unchecking", () => {
  it("moves an unchecked item to the top of the list (after the H1 title)", () => {
    const out = toggleItem(DOC, lines(DOC).indexOf("- [x] already done"));
    const ls = lines(out);
    // first non-empty, non-title line is the reactivated item
    const firstContent = ls.find(
      (l, idx) => idx > 0 && l.trim() !== "" && !/^#/.test(l),
    );
    expect(firstContent).toBe("- [ ] already done");
    // it sits above the Done heading now
    expect(ls.indexOf("- [ ] already done")).toBeLessThan(ls.indexOf("## Done"));
    expect(ls).not.toContain("- [x] already done");
  });
});

describe("toggleItem — guards", () => {
  it("returns content unchanged when index is not an item line", () => {
    const headingIdx = lines(DOC).indexOf("## Done");
    expect(toggleItem(DOC, headingIdx)).toBe(DOC);
  });

  it("preserves indented sub-item indentation when checking", () => {
    const doc = `## Done\n\n- [ ] top\n  - [ ] nested\n`;
    const out = toggleItem(doc, lines(doc).indexOf("  - [ ] nested"));
    expect(out).toContain("  - [x] nested");
  });
});
