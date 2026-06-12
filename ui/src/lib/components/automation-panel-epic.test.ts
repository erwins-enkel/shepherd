import { describe, it, expect } from "vitest";
import type { DrainStatus } from "$lib/types";

// Pure helper mirroring the `epicActive` derived in AutomationPanel: true when
// drain.epicParent is set (non-null/non-undefined). Extracted here so it can be
// unit-tested without spinning up a Svelte component.
function isEpicActive(drain: DrainStatus | null | undefined): boolean {
  return drain?.epicParent != null;
}

function makeDrain(epicParent: number | null): DrainStatus {
  return {
    repoPath: "/repo",
    enabled: true,
    paused: false,
    reason: null,
    detail: null,
    queued: 0,
    inFlight: 0,
    max: 3,
    epicParent,
  };
}

describe("AutomationPanel epic-mode precedence indicator", () => {
  it("epicActive is true when epicParent is set", () => {
    expect(isEpicActive(makeDrain(42))).toBe(true);
  });

  it("epicActive is true for epicParent = 1 (lowest real issue number)", () => {
    expect(isEpicActive(makeDrain(1))).toBe(true);
  });

  it("epicActive is false when epicParent is null", () => {
    expect(isEpicActive(makeDrain(null))).toBe(false);
  });

  it("epicActive is false when drain is null (no drain data)", () => {
    expect(isEpicActive(null)).toBe(false);
  });

  it("epicActive is false when drain is undefined", () => {
    expect(isEpicActive(undefined)).toBe(false);
  });
});
