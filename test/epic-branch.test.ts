import { test, expect } from "bun:test";
import { epicIntegrationBranch, branchReferencesEpic, isEpicChild } from "../src/epic-branch";

test("builds epic/<#>-<slug> from parent number + title", () => {
  expect(epicIntegrationBranch(327, "EFI / Value-Map cluster — sequencing")).toBe(
    "epic/327-efi-value-map-cluster-sequencing",
  );
});

test("lowercases, collapses non-alnum to single dashes, trims edge dashes", () => {
  expect(epicIntegrationBranch(5, "  Foo__Bar!! ")).toBe("epic/5-foo-bar");
});

test("bounds the slug length (<= 40 slug chars) and never trails a dash", () => {
  const b = epicIntegrationBranch(9, "x".repeat(100));
  expect(b.startsWith("epic/9-")).toBe(true);
  expect(b.length).toBeLessThanOrEqual("epic/9-".length + 40);
  expect(b.endsWith("-")).toBe(false);
});

test("empty/symbol-only title degrades to bare epic/<#>", () => {
  expect(epicIntegrationBranch(12, "!!!")).toBe("epic/12");
});

test("branchReferencesEpic: matches canonical suffix form epic/<#>-<slug>", () => {
  expect(branchReferencesEpic("epic/327-foo", 327)).toBe(true);
});

test("branchReferencesEpic: matches number-in-middle / number-as-suffix forms", () => {
  expect(branchReferencesEpic("epic/efi-valuemap-327", 327)).toBe(true);
  expect(branchReferencesEpic("epic/327", 327)).toBe(true);
});

test("branchReferencesEpic: rejects numeric superstrings (prefix + suffix digits)", () => {
  expect(branchReferencesEpic("epic/1327-x", 327)).toBe(false);
  expect(branchReferencesEpic("epic/3270", 327)).toBe(false);
  expect(branchReferencesEpic("epic/13270-x", 327)).toBe(false);
});

test("branchReferencesEpic: bounded both sides — exact token amid non-digits", () => {
  expect(branchReferencesEpic("epic/a327b", 327)).toBe(true); // letters bound it
  expect(branchReferencesEpic("327", 327)).toBe(true); // whole string
  expect(branchReferencesEpic("epic/0327", 327)).toBe(false); // leading digit
});

// ── isEpicChild: identity, with the base-branch name as the LEGACY fallback (#2067) ──

test("isEpicChild: legacy row (no stamp, epic/<#>-<slug> base) still reads as an epic child", () => {
  // Rows written before `epicParent` existed carry null — an epic mid-drain across the deploy
  // must keep retiring into its integration branch instead of hitting the merge train.
  expect(isEpicChild({ epicParent: null, baseBranch: "epic/12-foo" })).toBe(true);
  expect(isEpicChild({ baseBranch: "epic/12" })).toBe(true); // absent === null
});

test("isEpicChild: non-epic session (no stamp, default-branch base) is NOT an epic child", () => {
  expect(isEpicChild({ epicParent: null, baseBranch: "main" })).toBe(false);
  expect(isEpicChild({ baseBranch: "main" })).toBe(false);
});

test("isEpicChild: a stamped child is a child whatever its base is named", () => {
  // The whole point: once children stack, the base is a sibling's `shepherd/*` branch and the
  // name test answers "no". The stamp is what keeps every site correct.
  expect(isEpicChild({ epicParent: 12, baseBranch: "shepherd/task-1-predecessor" })).toBe(true);
  expect(isEpicChild({ epicParent: 12, baseBranch: "main" })).toBe(true);
  expect(isEpicChild({ epicParent: 12, baseBranch: "epic/12-foo" })).toBe(true);
});

test("isEpicChild: an epic-lookalike base is unchanged from the old name test", () => {
  expect(isEpicChild({ epicParent: null, baseBranch: "epic/no-number" })).toBe(false);
  expect(isEpicChild({ epicParent: null, baseBranch: "feature/epic/12-foo" })).toBe(false);
});
