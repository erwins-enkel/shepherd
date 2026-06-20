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
      // installE2E scenarios intentionally seed NO defect (bare host → install.sh).
      if (!s.installE2E) expect(s.seed.length).toBeGreaterThan(0);
      expect(s.expect.length).toBeGreaterThan(0);
    }
  });

  it("covers each non-bun check id at least once", () => {
    const covered = new Set(SCENARIOS.flatMap((s) => s.expect.map((e) => e.id)));
    for (const id of ["node", "claude", "gh", "git", "herdr", "tailscale"]) {
      expect(covered.has(id)).toBe(true);
    }
  });

  // Cheap canary (subordinate to the behavioral test in test/diagnostics.test.ts):
  // since #819 the gh probe only reports `error` when a forge-mode repo is
  // configured, so any scenario asserting gh:error MUST seed a repo dir under
  // repoRoot ($HOME) — else the probe downgrades to `warning` and the gap reopens.
  // This guards against the `mkdir`-seed being silently deleted; it does NOT prove
  // the mechanism (that is the diagnostics behavioral test).
  it("every scenario expecting gh:error seeds a repo dir under repoRoot", () => {
    const ghErrorScenarios = SCENARIOS.filter((s) =>
      s.expect.some((e) => e.id === "gh" && e.state === "error"),
    );
    expect(ghErrorScenarios.length).toBeGreaterThan(0); // catalog still has them
    for (const s of ghErrorScenarios) {
      // a `mkdir` of a NON-dot dir directly under the home/repoRoot (~/… or /root/…).
      // The negative lookahead `(?!\.)` rejects a dot final segment (e.g. ~/.config/gh),
      // which listRepos() filters out (`!name.startsWith(".")`) — so the guard can't
      // pass on a seed that creates no enumerable forge repo.
      const seedsRepoDir = s.seed.some((cmd) =>
        /mkdir\s+(-p\s+)?(~|\/root)\/(?!\.)[^/\s]+/.test(cmd),
      );
      expect(seedsRepoDir).toBe(true);
    }
  });
});
