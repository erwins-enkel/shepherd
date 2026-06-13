import { describe, expect, it } from "bun:test";
import { SCENARIOS } from "../../ci/onboarding-harness/scenarios";

const CHECK_IDS = new Set(["bun", "node", "claude", "gh", "git", "herdr", "tailscale"]);

describe("scenario catalog", () => {
  it("has unique kebab-case ids", () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("only expects known check ids", () => {
    for (const s of SCENARIOS) {
      for (const e of s.expect) expect(CHECK_IDS.has(e.id)).toBe(true);
    }
  });

  it("every scenario seeds at least one command and expects at least one flag", () => {
    for (const s of SCENARIOS) {
      expect(s.seed.length).toBeGreaterThan(0);
      expect(s.expect.length).toBeGreaterThan(0);
    }
  });

  it("covers each non-bun check id at least once", () => {
    const covered = new Set(SCENARIOS.flatMap((s) => s.expect.map((e) => e.id)));
    for (const id of ["node", "claude", "gh", "git", "herdr", "tailscale"]) {
      expect(covered.has(id)).toBe(true);
    }
  });
});
