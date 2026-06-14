import { test, expect } from "bun:test";
import { epicIntegrationBranch, branchReferencesEpic } from "../src/epic-branch";

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
