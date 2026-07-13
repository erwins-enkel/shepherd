import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../app.css";
import type { EpicDraft } from "$lib/types";
import { epicDrafts } from "$lib/epic-draft.svelte";
import EpicDraftPanel from "./EpicDraftPanel.svelte";

function longDraft(sessionId: string): EpicDraft {
  return {
    sessionId,
    parent: {
      title: "Keep long epic drafts reviewable",
      body: Array.from(
        { length: 80 },
        (_, i) =>
          `Section ${i + 1}\nDetailed research finding that must remain readable before approval.`,
      ).join("\n\n"),
      acceptanceCriteria: ["The complete draft can be reviewed."],
      nonGoals: ["Collapsible sections"],
    },
    children: Array.from({ length: 6 }, (_, i) => ({
      key: `child-${i + 1}`,
      title: `Child issue ${i + 1}`,
      body: "A concrete vertical slice with enough detail to wrap on a narrow screen.",
      acceptanceCriteria: ["The slice is independently verifiable."],
      blockedBy: i === 0 ? [] : [`child-${i}`],
    })),
    status: "draft",
    materializedChildren: {},
    parentNumber: null,
    parentUrl: null,
  };
}

describe.each([
  ["desktop", 1000],
  ["narrow", 390],
])("EpicDraftPanel long-draft layout — %s", (label, width) => {
  it("scrolls the draft content while keeping review actions visible", async () => {
    const sessionId = `epic-draft-scroll-${label}`;
    epicDrafts.upsert(longDraft(sessionId));

    const { container, unmount } = await render(EpicDraftPanel, {
      sessionId,
      epicAuthoring: true,
      sessionLive: true,
    });
    container.style.width = `${width}px`;

    const panel = container.querySelector<HTMLElement>(".edp");
    const scroller = container.querySelector<HTMLElement>(".edp-scroll");
    const actions = container.querySelector<HTMLElement>(".edp-actions");
    const childList = container.querySelector<HTMLElement>(".edp-list");

    expect(panel, "draft panel should render").not.toBeNull();
    expect(scroller, "draft content should own the vertical scroll").not.toBeNull();
    expect(actions, "review actions should have a fixed region").not.toBeNull();
    expect(childList, "child issue list should render").not.toBeNull();

    if (!panel || !scroller || !actions || !childList) {
      unmount();
      return;
    }

    expect(getComputedStyle(scroller).overflowY).toBe("auto");
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
    expect(getComputedStyle(childList).overflowY).not.toBe("auto");

    const panelRect = panel.getBoundingClientRect();
    const actionsRect = actions.getBoundingClientRect();
    expect(actionsRect.height).toBeGreaterThan(0);
    expect(actionsRect.top).toBeGreaterThanOrEqual(panelRect.top);
    expect(actionsRect.bottom).toBeLessThanOrEqual(panelRect.bottom + 1);
    expect(panelRect.height).toBeLessThanOrEqual(window.innerHeight * 0.6 + 1);

    unmount();
  });
});
