import { describe, expect, it } from "vitest";
import type { GreenfieldReport } from "#lib/types.js";
import {
  bootstrapMissingLabel,
  greenfieldByOperator,
  greenfieldGroups,
  greenfieldHint,
  greenfieldShort,
  greenfieldTitle,
  READINESS_PENDING,
  redFirst,
} from "./readiness-greenfield-view";
import { bootstrapMissingText } from "./queue-strip";

const report: GreenfieldReport = {
  ecosystem: null,
  score: 10,
  items: [
    { id: "stack_pinned", tier: "must", present: false, evidence: [] },
    { id: "prd", tier: "nice", present: true, evidence: ["docs/prd/"] },
    { id: "ci_on_main", tier: "must", present: true, evidence: ["ci.yml"] },
  ],
  mustHavesMissing: ["stack_pinned"],
  checkedAt: 1,
};

describe("readiness greenfield view", () => {
  it("splits must-haves from nice-to-haves, keeping server order", () => {
    const g = greenfieldGroups(report);
    expect(g.must.map((i) => i.id)).toEqual(["stack_pinned", "ci_on_main"]);
    expect(g.nice.map((i) => i.id)).toEqual(["prd"]);
  });

  it("puts red items first, keeping order within each half", () => {
    expect(redFirst(report.items).map((i) => i.id)).toEqual(["stack_pinned", "prd", "ci_on_main"]);
  });

  it("the operator supplies the inputs and the forge settings; a session the rest", () => {
    expect(greenfieldByOperator("forge_settings")).toBe(true);
    expect(greenfieldByOperator("prd")).toBe(true);
    expect(greenfieldByOperator("design_export")).toBe(true);
    expect(greenfieldByOperator("ci_on_main")).toBe(false);
    expect(greenfieldByOperator("env_schema")).toBe(false);
  });

  it("must-haves have a short gate label; others fall back to the title", () => {
    expect(greenfieldShort("ci_on_main")).not.toBe(greenfieldTitle("ci_on_main"));
    expect(greenfieldShort("prd")).toBe(greenfieldTitle("prd"));
  });

  it("every item id has a title and a hint", () => {
    for (const it of report.items) {
      expect(greenfieldTitle(it.id)).toBeTruthy();
      expect(greenfieldHint(it.id)).toBeTruthy();
    }
  });

  it("localizes must-haves and the pending placeholder; phases pass through", () => {
    expect(bootstrapMissingLabel("P2")).toBe("P2");
    expect(bootstrapMissingLabel("ci_on_main")).toBe(greenfieldTitle("ci_on_main"));
    expect(bootstrapMissingLabel(READINESS_PENDING)).not.toBe(READINESS_PENDING);
    expect(bootstrapMissingText("P4,stack_pinned")).toBe(`P4, ${greenfieldTitle("stack_pinned")}`);
  });
});
