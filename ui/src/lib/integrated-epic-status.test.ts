import { describe, it, expect } from "vitest";
import { deriveFooterSituation } from "./integrated-epic-status";
import type { CompletedEpic, CompletedEpicChild } from "./types";

type LandingState = CompletedEpic["landingState"];

function child(number: number, integrated: boolean): CompletedEpicChild {
  return {
    number,
    title: `#${number}`,
    url: `https://example.test/issues/${number}`,
    prNumber: integrated ? number + 100 : null,
    prUrl: integrated ? `https://example.test/pull/${number + 100}` : null,
    mergedAt: integrated ? 1_700_000_000_000 : null,
    integrated,
  };
}

function epic(
  landingState: LandingState,
  children: CompletedEpicChild[],
): Pick<CompletedEpic, "landingState" | "children"> {
  return { landingState, children };
}

const someMerged = [child(1, true), child(2, true), child(3, false)]; // merged = 2
const noneMerged = [child(1, false), child(2, false)]; // merged = 0

describe("deriveFooterSituation", () => {
  // Active / non-footer states — returned for totality, rendered by their own dedicated UI.
  it("open → 'open' regardless of merged count", () => {
    expect(deriveFooterSituation(epic("open", someMerged))).toBe("open");
    expect(deriveFooterSituation(epic("open", noneMerged))).toBe("open");
  });

  it("merged → 'landed'", () => {
    expect(deriveFooterSituation(epic("merged", someMerged))).toBe("landed");
    expect(deriveFooterSituation(epic("merged", noneMerged))).toBe("landed");
  });

  it("error → 'error'", () => {
    expect(deriveFooterSituation(epic("error", someMerged))).toBe("error");
    expect(deriveFooterSituation(epic("error", noneMerged))).toBe("error");
  });

  // Footer states — the ones the band actually renders as a plain-language line.
  it("pending → 'opening' regardless of merged count", () => {
    expect(deriveFooterSituation(epic("pending", someMerged))).toBe("opening");
    expect(deriveFooterSituation(epic("pending", noneMerged))).toBe("opening");
  });

  it("none + merged===0 → 'nothing-merged' (screenshot case: all sub-issues closed, no Shepherd merge)", () => {
    expect(deriveFooterSituation(epic("none", noneMerged))).toBe("nothing-merged");
  });

  it("none + merged>0 → 'nothing-to-land' (reason-free)", () => {
    expect(deriveFooterSituation(epic("none", someMerged))).toBe("nothing-to-land");
  });

  it("none + no children at all → 'nothing-merged' (merged count is 0)", () => {
    expect(deriveFooterSituation(epic("none", []))).toBe("nothing-merged");
  });
});
