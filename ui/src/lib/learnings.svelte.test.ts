import { test, expect } from "vitest";
import { learnings } from "./learnings.svelte";
import type { Learning } from "./types";

function L(id: string): Learning {
  return {
    id,
    repoPath: "/r",
    rule: "r",
    rationale: "",
    evidence: [],
    status: "proposed",
    evidenceCount: 0,
    ineffectiveCount: 0,
    helpfulCount: 0,
    injectedCount: 0,
    lastUsedAt: null,
    retiredAt: null,
    retiredReason: null,
    scopeGlobs: [],
    createdAt: 0,
    updatedAt: 0,
    lastEvidenceAt: null,
    promotedPrUrl: null,
  };
}

test("set populates items and pending reflects count", () => {
  learnings.set([L("1"), L("2")]);
  expect(learnings.items.length).toBe(2);
  expect(learnings.pending).toBe(2);
  learnings.set([]);
  expect(learnings.pending).toBe(0);
});
