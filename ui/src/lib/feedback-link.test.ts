import { describe, it, expect } from "vitest";
import { buildIssueUrl, buildEnvironment } from "./feedback-link";
import { version } from "./build-info";

describe("buildIssueUrl", () => {
  it("bug: sets template=bug.yml, title round-trips, description in what-happened", () => {
    const url = buildIssueUrl("bug", { title: "It broke", description: "Steps to reproduce" });
    const params = new URL(url).searchParams;
    expect(params.get("template")).toBe("bug.yml");
    expect(params.get("title")).toBe("It broke");
    expect(params.get("what-happened")).toBe("Steps to reproduce");
  });

  it("feature: template=feature.yml, description in problem (the required field)", () => {
    const url = buildIssueUrl("feature", { title: "My idea", description: "Add this" });
    const params = new URL(url).searchParams;
    expect(params.get("template")).toBe("feature.yml");
    expect(params.get("problem")).toBe("Add this");
  });

  it("feedback: template=feedback.yml, description in feedback", () => {
    const url = buildIssueUrl("feedback", { description: "Great tool!" });
    const params = new URL(url).searchParams;
    expect(params.get("template")).toBe("feedback.yml");
    expect(params.get("feedback")).toBe("Great tool!");
  });

  it("environment param is present, non-empty, and contains the version", () => {
    const url = buildIssueUrl("bug", {});
    const params = new URL(url).searchParams;
    const env = params.get("environment") ?? "";
    expect(env.length).toBeGreaterThan(0);
    expect(env).toContain(version);
  });

  it("truncation: >50 KB description yields URL <= 7000 chars ending with truncation marker", () => {
    const bigDesc = "A".repeat(60_000);
    const url = buildIssueUrl("bug", { description: bigDesc });
    expect(url.length).toBeLessThanOrEqual(7000);
    const params = new URL(url).searchParams;
    const decoded = params.get("what-happened") ?? "";
    expect(decoded.endsWith("\n…[truncated]")).toBe(true);
  });
});

describe("buildEnvironment", () => {
  it("always includes Shepherd version and commit lines", () => {
    const env = buildEnvironment();
    expect(env).toContain(`v${version}`);
    expect(env).toContain("- Commit:");
  });
});
