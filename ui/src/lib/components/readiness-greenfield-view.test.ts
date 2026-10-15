import { describe, expect, it } from "vitest";
import type { GreenfieldReport } from "#lib/types.js";
import {
  bootstrapMissingLabel,
  greenfieldGroups,
  greenfieldHint,
  greenfieldTitle,
  READINESS_PENDING,
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
