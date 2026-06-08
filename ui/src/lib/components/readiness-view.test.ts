import { describe, it, expect } from "vitest";
import { scoreBand, adoptList, haveList, buildAdoptPrompt } from "./readiness-view";
import type { GuardrailCheck, ReadinessReport } from "$lib/types";

function check(id: GuardrailCheck["id"], present: boolean, weight: number): GuardrailCheck {
  return { id, present, weight, evidence: present ? ["marker"] : [] };
}

function report(checks: GuardrailCheck[]): ReadinessReport {
  return { applicable: true, score: 0, checks, hasAgentInstructions: false, claudeMd: "# rules" };
}

describe("scoreBand", () => {
  it("maps score to band boundaries", () => {
    expect(scoreBand(0)).toBe("low");
    expect(scoreBand(39)).toBe("low");
    expect(scoreBand(40)).toBe("fair");
    expect(scoreBand(69)).toBe("fair");
    expect(scoreBand(70)).toBe("good");
    expect(scoreBand(89)).toBe("good");
    expect(scoreBand(90)).toBe("strong");
    expect(scoreBand(100)).toBe("strong");
  });
});

describe("adoptList / haveList", () => {
  const r = report([
    check("pre_push_ci", false, 10),
    check("linter", true, 8),
    check("commit_lint", false, 4),
    check("type_checker", false, 9),
  ]);
  it("adoptList returns absent guardrails sorted by leverage desc", () => {
    expect(adoptList(r).map((c) => c.id)).toEqual(["pre_push_ci", "type_checker", "commit_lint"]);
  });
  it("haveList returns present guardrails", () => {
    expect(haveList(r).map((c) => c.id)).toEqual(["linter"]);
  });
});

describe("buildAdoptPrompt", () => {
  it("joins the i18n intro with the verbatim snippet", () => {
    expect(buildAdoptPrompt("Make this repo AI-ready.", "# House rules")).toBe(
      "Make this repo AI-ready.\n\n# House rules",
    );
  });
});
