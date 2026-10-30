import { describe, expect, it } from "vitest";
import type { GitState } from "#lib/types.js";
import {
  agentLive,
  ciFixSteer,
  failingChecksText,
  logsHref,
  nextStepSteer,
  prNextStep,
  rebaseSteer,
} from "./pr-next-step";

function git(over: Partial<GitState> = {}): GitState {
  return {
    kind: "github",
    state: "open",
    checks: "failure",
    deployConfigured: false,
    number: 12,
    headSha: "abcdef1234567",
    url: "https://github.com/o/r/pull/12/",
    ...over,
  };
}
const job = (name: string, state: "failure" | "success" | "pending" = "failure", url?: string) => ({
  name,
  state,
  url,
});

describe("failingChecksText", () => {
  it("names the failing jobs only, flattened", () => {
    const g = git({ jobs: [job("lint"), job("test\n(1/2)"), job("ok", "success")] });
    expect(failingChecksText(g)).toBe("lint, test (1/2)");
  });
  it("collapses past five and clips long names", () => {
    const g = git({ jobs: ["a", "b", "c", "d", "e", "f", "g"].map((n) => job(n)) });
    expect(failingChecksText(g)).toBe("a, b, c, d, e +2 more");
    expect(failingChecksText(git({ jobs: [job("x".repeat(100))] }))).toBe(`${"x".repeat(79)}…`);
  });
  it("points at gh pr checks without job data", () => {
    expect(failingChecksText(git())).toBe("run `gh pr checks 12` once for the failing checks");
  });
});

describe("steer texts", () => {
  it("the CI fix names the PR, head and failing checks", () => {
    const t = ciFixSteer(git({ jobs: [job("lint")] }));
    expect(t).toContain("PR #12 (head abcdef1)");
    expect(t).toContain("failing on PR #12 (head abcdef1): lint.");
    expect(t).toContain("gh run view <run-id> --log-failed");
  });
  it("the rebase names the base and, on conflict, the conflicts", () => {
    expect(rebaseSteer("main", false)).toContain("behind main");
    expect(rebaseSteer("main", false)).not.toContain("conflicts");
    expect(rebaseSteer("epic/x", true)).toContain("origin/epic/x");
    expect(rebaseSteer("epic/x", true)).toContain("resolve the conflicts");
  });
  it("only fix-ci and rebase send anything", () => {
    expect(nextStepSteer("decommission", git(), "main")).toBeNull();
    expect(nextStepSteer("merge", git(), "main")).toBeNull();
    expect(nextStepSteer("rebase", git({ mergeStateStatus: "behind" }), "main")).toContain(
      "behind",
    );
  });
});

describe("agentLive", () => {
  const s = { terminal: false, shelved: false, status: "idle" as const };
  it("needs a live, steerable pane", () => {
    expect(agentLive(s)).toBe(true);
    expect(agentLive(s, "alive")).toBe(true);
    expect(agentLive(s, "husk")).toBe(false);
    expect(agentLive(s, "stranded")).toBe(false);
    expect(agentLive({ ...s, shelved: true })).toBe(false);
    expect(agentLive({ ...s, terminal: true })).toBe(false);
    expect(agentLive({ ...s, status: "done" })).toBe(false);
  });
});

describe("prNextStep", () => {
  const base = { autopilot: false, criticReviewing: false, live: true };
  it("red CI offers the fix; autopilot, a reviewing critic or a dead agent hold it", () => {
    expect(prNextStep({ ...base, kind: "ci_failed" })).toMatchObject({
      action: "fix-ci",
      mode: "button",
    });
    expect(prNextStep({ ...base, kind: "ci_failed", autopilot: true }).mode).toBe("passive");
    const critic = prNextStep({ ...base, kind: "ci_failed", criticReviewing: true });
    expect(critic.mode).toBe("locked");
    expect(critic.reason).toBeTruthy();
    expect(prNextStep({ ...base, kind: "ci_failed", live: false }).mode).toBe("locked");
  });
  it("behind and conflict offer the rebase; the critic does not hold it", () => {
    for (const kind of ["behind", "conflict"] as const) {
      expect(prNextStep({ ...base, kind })).toMatchObject({ action: "rebase", mode: "button" });
      expect(prNextStep({ ...base, kind, criticReviewing: true }).mode).toBe("button");
      expect(prNextStep({ ...base, kind, autopilot: true }).mode).toBe("passive");
      expect(prNextStep({ ...base, kind, live: false }).mode).toBe("locked");
    }
  });
  it("merged offers Stilllegen regardless of autopilot or the agent", () => {
    expect(
      prNextStep({ kind: "merged", autopilot: true, criticReviewing: true, live: false }),
    ).toEqual({ action: "decommission", mode: "button", reason: null });
  });
  it("every other state keeps Merge", () => {
    for (const kind of ["ready", "ci_running", "draft", "protected", "merging"] as const)
      expect(prNextStep({ ...base, kind, autopilot: true }).action).toBe("merge");
  });
});

describe("logsHref", () => {
  it("prefers the failing check's page, then the PR's checks tab", () => {
    const u = "https://github.com/o/r/actions/runs/1";
    expect(
      logsHref(git({ jobs: [job("a", "success", "https://x.test/ok"), job("b", "failure", u)] })),
    ).toBe(u);
    expect(logsHref(git())).toBe("https://github.com/o/r/pull/12/checks");
    expect(logsHref(git({ url: undefined }))).toBeNull();
    expect(logsHref(git({ jobs: [job("b", "failure", "javascript:alert(1)")] }))).toBe(
      "https://github.com/o/r/pull/12/checks",
    );
  });
});
