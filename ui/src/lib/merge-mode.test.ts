import { describe, expect, it } from "vitest";
import { MERGE_MODES, effectiveMergeMode, mergeModeOf, mergeModePatch } from "./merge-mode";

describe("mergeModeOf", () => {
  it("reads each config shape", () => {
    expect(mergeModeOf({ draftMode: false, autoMergeEnabled: false })).toBe("manual");
    expect(mergeModeOf({ draftMode: true, autoMergeEnabled: false })).toBe("draft");
    expect(mergeModeOf({ draftMode: false, autoMergeEnabled: true })).toBe("auto");
  });

  it("lets draft win over an auto-merge beside it, as the server does", () => {
    expect(mergeModeOf({ draftMode: true, autoMergeEnabled: true })).toBe("draft");
  });
});

describe("mergeModePatch", () => {
  it("writes both fields for every mode", () => {
    expect(mergeModePatch("manual")).toEqual({ draftMode: false, autoMergeEnabled: false });
    expect(mergeModePatch("draft")).toEqual({ draftMode: true, autoMergeEnabled: false });
    expect(mergeModePatch("auto")).toEqual({ draftMode: false, autoMergeEnabled: true });
  });

  it("never turns draft and auto-merge on together, and reads back as the mode it set", () => {
    for (const mode of MERGE_MODES) {
      const patch = mergeModePatch(mode);
      expect(patch.draftMode && patch.autoMergeEnabled).toBe(false);
      expect(mergeModeOf(patch)).toBe(mode);
    }
  });
});

describe("effectiveMergeMode", () => {
  it("reads a local-only repo's stored draft as you merge, and keeps the other modes", () => {
    expect(effectiveMergeMode({ draftMode: true, autoMergeEnabled: false }, true)).toBe("manual");
    expect(effectiveMergeMode({ draftMode: false, autoMergeEnabled: true }, true)).toBe("auto");
    expect(effectiveMergeMode({ draftMode: true, autoMergeEnabled: false }, false)).toBe("draft");
  });
});
