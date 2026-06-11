import { describe, it, expect } from "bun:test";
import { classifyPr } from "../src/forge/pr-kind";

describe("classifyPr — dependabot", () => {
  it("matches login 'dependabot'", () => {
    expect(classifyPr({ author: "dependabot", title: "bump x" })).toBe("dependabot");
  });

  it("matches login 'dependabot[bot]'", () => {
    expect(classifyPr({ author: "dependabot[bot]", title: "bump x" })).toBe("dependabot");
  });

  it("matches login 'app/dependabot' (gh --json author form)", () => {
    expect(classifyPr({ author: "app/dependabot", title: "bump x" })).toBe("dependabot");
  });

  it("matches case-insensitively (App/Dependabot[bot])", () => {
    expect(classifyPr({ author: "App/Dependabot[bot]", title: "bump x" })).toBe("dependabot");
  });

  it("does NOT match a vanity login like dependabot-fan", () => {
    expect(classifyPr({ author: "dependabot-fan", title: "bump x" })).toBe("regular");
  });
});

describe("classifyPr — release", () => {
  it("matches the 'autorelease: pending' label", () => {
    expect(
      classifyPr({ author: "alice", title: "anything", labels: ["autorelease: pending"] }),
    ).toBe("release");
  });

  it("matches the label case-insensitively (Autorelease: Pending)", () => {
    expect(
      classifyPr({ author: "alice", title: "anything", labels: ["Autorelease: Pending"] }),
    ).toBe("release");
  });

  it("matches a release-please-- head branch", () => {
    expect(
      classifyPr({
        author: "alice",
        title: "anything",
        headRefName: "release-please--branches--main",
      }),
    ).toBe("release");
  });

  it("matches a 'chore(main): release 1.25.0' title", () => {
    expect(classifyPr({ author: "alice", title: "chore(main): release 1.25.0" })).toBe("release");
  });

  it("matches a bare 'chore: release' title", () => {
    expect(classifyPr({ author: "alice", title: "chore: release" })).toBe("release");
  });

  it("does NOT match a title that merely contains 'release'", () => {
    expect(classifyPr({ author: "alice", title: "feat: add release notes link" })).toBe("regular");
  });
});

describe("classifyPr — regular", () => {
  it("classifies a plain human PR as regular", () => {
    expect(classifyPr({ author: "alice", title: "fix: typo in readme" })).toBe("regular");
  });
});

describe("classifyPr — precedence", () => {
  it("dependabot wins over a release-ish title", () => {
    expect(classifyPr({ author: "dependabot[bot]", title: "chore(main): release 1.0.0" })).toBe(
      "dependabot",
    );
  });
});
