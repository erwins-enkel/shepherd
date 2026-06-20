import { test, expect } from "bun:test";
import { buildIssueUrl } from "../../src/forge";

test("github-style webUrl + issueNumber → full issues URL", () => {
  expect(buildIssueUrl("https://github.com/owner/repo", 312)).toBe(
    "https://github.com/owner/repo/issues/312",
  );
});

test("gitea-style webUrl + issueNumber → full issues URL", () => {
  expect(buildIssueUrl("https://gitea.example.com/owner/repo", 7)).toBe(
    "https://gitea.example.com/owner/repo/issues/7",
  );
});

test("null webUrl → null", () => {
  expect(buildIssueUrl(null, 42)).toBeNull();
});

test("undefined webUrl → null", () => {
  expect(buildIssueUrl(undefined, 42)).toBeNull();
});

test("null issueNumber → null", () => {
  expect(buildIssueUrl("https://github.com/owner/repo", null)).toBeNull();
});

test("undefined issueNumber → null", () => {
  expect(buildIssueUrl("https://github.com/owner/repo", undefined)).toBeNull();
});
