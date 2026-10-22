import { test, expect, describe } from "bun:test";
import { bodyWithIssueLink } from "../src/forge/issue-link";

describe("bodyWithIssueLink", () => {
  test("same repo: appends Closes #n, idempotent", () => {
    expect(bodyWithIssueLink("Body", 5, undefined, "org/B")).toBe("Body\n\nCloses #5");
    expect(bodyWithIssueLink("", 5, "org/B", "org/B")).toBe("Closes #5");
    expect(bodyWithIssueLink("Fixes #5", 5, undefined, "org/B")).toBeNull();
  });
  test("#3245 cross repo: appends Closes owner/name#n", () => {
    expect(bodyWithIssueLink("Body", 5, "org/A", "org/B")).toBe("Body\n\nCloses org/A#5");
  });
  test("cross repo: idempotent on short or URL form, case-insensitive", () => {
    expect(bodyWithIssueLink("closes ORG/a#5", 5, "org/A", "org/B")).toBeNull();
    expect(
      bodyWithIssueLink("Resolves https://github.com/org/A/issues/5", 5, "org/A", "org/B"),
    ).toBeNull();
  });
  test("cross repo: a same-repo #n or another repo's ref does not count", () => {
    expect(bodyWithIssueLink("Closes #5", 5, "org/A", "org/B")).toBe("Closes #5\n\nCloses org/A#5");
    expect(bodyWithIssueLink("Closes org/A#55", 5, "org/A", "org/B")).toBe(
      "Closes org/A#55\n\nCloses org/A#5",
    );
  });
  test("same repo: a cross-repo ref to the same number does not count", () => {
    expect(bodyWithIssueLink("Closes org/A#5", 5, undefined, "org/B")).toBe(
      "Closes org/A#5\n\nCloses #5",
    );
  });
});
