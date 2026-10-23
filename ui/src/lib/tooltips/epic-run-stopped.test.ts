import { describe, it, expect } from "vitest";
import { m } from "#lib/paraglide/messages.js";
import { epicRunStoppedExplanation, mergeIntoEpicExplanation } from "./explanations";

describe("epicRunStoppedExplanation (#2735)", () => {
  it("own epic stopped: summary names it, State carries the tally when known", () => {
    const e = epicRunStoppedExplanation({
      pr: 68,
      epic: 67,
      leadEpic: null,
      integrated: 2,
      total: 5,
    });
    expect(e.title).toBe(m.tooltip_epic_stopped_title());
    expect(e.summary).toBe(m.tooltip_epic_stopped_summary({ pr: 68, epic: 67 }));
    expect(e.sections.map((s) => s.label)).toEqual([
      m.tooltip_epic_stopped_state(),
      m.tooltip_epic_stopped_next(),
      m.tooltip_epic_stopped_cost(),
    ]);
    expect(e.sections[0].text).toContain("2");
    expect(e.sections[1].text).toBe(m.tooltip_epic_stopped_next_start());
  });

  it("paused leader: summary and Next name the leader; tally omitted when unknown", () => {
    const e = epicRunStoppedExplanation({ pr: 68, epic: 67, leadEpic: 80 });
    expect(e.summary).toBe(m.tooltip_epic_stopped_summary_lead({ pr: 68, lead: 80 }));
    expect(e.sections[1].text).toBe(m.tooltip_epic_stopped_next_resume({ lead: 80 }));
    expect(e.sections[0].text).toBe(
      m.tooltip_epic_stopped_state_body({
        epic: 67,
        status: m.tooltip_epic_stopped_status_stopped(),
      }),
    );
  });
});

describe("mergeIntoEpicExplanation (#2735)", () => {
  it("names the branch; the Run section only while the run is stopped", () => {
    const stopped = mergeIntoEpicExplanation({ branch: "epic/67-x", stopped: true });
    expect(stopped.summary).toContain("epic/67-x");
    expect(stopped.sections).toHaveLength(2);
    expect(mergeIntoEpicExplanation({ branch: "epic/67-x", stopped: false }).sections).toHaveLength(
      1,
    );
  });
});
