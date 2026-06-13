import { test, expect } from "bun:test";
import { epicIntegrationBranch } from "../src/epic-branch";

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
