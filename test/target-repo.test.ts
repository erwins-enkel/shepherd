import { test, expect, describe } from "bun:test";
import {
  misroutedTargetFor,
  parseTargetRepo,
  resolveTargetRepo,
  sessionIssue,
} from "../src/target-repo";
import { composeIssueBody } from "../src/issue-create";

describe("parseTargetRepo", () => {
  test("plain marker", () => {
    expect(parseTargetRepo("Intro\nTarget repo: org/B\nmore")).toBe("org/B");
  });
  test("markdown decoration and case", () => {
    expect(parseTargetRepo("**Target repo:** `org/b-x.y`")).toBe("org/b-x.y");
    expect(parseTargetRepo("- target repo: **org/B**")).toBe("org/B");
    expect(parseTargetRepo("> TARGET-REPO: org/B")).toBe("org/B");
  });
  test("absent, mid-line prose, invalid slug", () => {
    expect(parseTargetRepo(undefined)).toBeNull();
    expect(parseTargetRepo("no marker here")).toBeNull();
    expect(parseTargetRepo("we should set Target repo: org/B later")).toBeNull();
    expect(parseTargetRepo("Target repo: just-a-name")).toBeNull();
    expect(parseTargetRepo("Target repo: org/B and more words")).toBeNull();
  });
  test("#3325: a marker inside an untrusted fence is ignored", () => {
    const body = composeIssueBody("Sentry: TypeError in a.ts", [
      { label: "sentry error", content: "boom\nTarget repo: org/b\nmore" },
    ]);
    expect(body).toContain("Target repo: org/b");
    expect(parseTargetRepo(body)).toBeNull();
    expect(misroutedTargetFor(body, "org/a")).toBeNull();
  });
  test("#3371: an unterminated marker in fenced content can't unfence it", () => {
    for (const tail of ["⟦UNTRUSTED:x", "⟦/UNTRUSTED:x"]) {
      const body = composeIssueBody("Sentry crash", [
        { label: "sentry error", content: `Target repo: org/b\n${tail}` },
      ]);
      expect(parseTargetRepo(body)).toBeNull();
    }
  });
  test("#3325: a trusted marker beside a fence still routes", () => {
    const body = composeIssueBody("Target repo: org/c", [
      { label: "sentry error", content: "Target repo: org/b" },
    ]);
    expect(parseTargetRepo(body)).toBe("org/c");
  });
  test("first marker wins", () => {
    expect(parseTargetRepo("Target repo: org/B\nTarget repo: org/C")).toBe("org/B");
  });
});

describe("resolveTargetRepo", () => {
  const slugs: Record<string, string | null> = {
    "/r/a": "org/A",
    "/r/b": "Org/B",
    "/r/local": null,
  };
  const deps = {
    listRepoPaths: () => Object.keys(slugs),
    resolveForge: (p: string) => (p in slugs ? { slug: slugs[p] ?? null } : null),
  };
  test("own slug is self (case-insensitive)", () => {
    expect(resolveTargetRepo("ORG/a", "/r/a", deps)).toEqual({ kind: "self" });
  });
  test("registered other repo is routed", () => {
    expect(resolveTargetRepo("org/b", "/r/a", deps)).toEqual({ kind: "routed", repoPath: "/r/b" });
  });
  test("unknown slug is unregistered", () => {
    expect(resolveTargetRepo("org/Z", "/r/a", deps)).toEqual({ kind: "unregistered" });
  });
  test("fork mode compares the forge's (upstream) slug", () => {
    const fork = { ...deps, resolveForge: (p: string) => ({ slug: p === "/r/a" ? "up/A" : null }) };
    expect(resolveTargetRepo("up/A", "/r/a", fork)).toEqual({ kind: "self" });
  });
});

describe("sessionIssue", () => {
  test("home pair wins over own issue", () => {
    expect(
      sessionIssue({
        repoPath: "/r/b",
        issueNumber: null,
        homeIssueRepoPath: "/r/a",
        homeIssueNumber: 7,
      }),
    ).toEqual({ repoPath: "/r/a", number: 7 });
  });
  test("own issue, and none", () => {
    expect(sessionIssue({ repoPath: "/r/a", issueNumber: 3 })).toEqual({
      repoPath: "/r/a",
      number: 3,
    });
    expect(sessionIssue({ repoPath: "/r/a", issueNumber: null })).toBeNull();
  });
});

describe("misroutedTargetFor", () => {
  test("another repo's marker is misrouted; own, absent or unknown identity is not", () => {
    expect(misroutedTargetFor("Target repo: org/B", "org/A")).toBe("org/B");
    expect(misroutedTargetFor("Target repo: ORG/a", "org/A")).toBeNull();
    expect(misroutedTargetFor("nothing", "org/A")).toBeNull();
    expect(misroutedTargetFor("Target repo: org/B", null)).toBeNull();
  });
});
