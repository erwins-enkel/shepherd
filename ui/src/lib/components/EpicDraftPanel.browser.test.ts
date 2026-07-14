import { describe, it, expect, vi } from "vitest";
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
    children: Array.from({ length: 12 }, (_, i) => ({
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

// The bar is a SUMMARY, not the review surface: a 12-child draft used to grow the panel to 60dvh
// and squeeze the terminal to a single line. The draft now lives in EpicDraftModal, so whatever the
// draft's size, this stays one row and the terminal keeps the column.
describe.each([
  ["desktop", 1000],
  ["narrow", 390],
])("EpicDraftPanel bar — %s", (label, width) => {
  it("stays a compact single row and owns no draft body, however long the draft", async () => {
    const sessionId = `epic-draft-bar-${label}`;
    epicDrafts.upsert(longDraft(sessionId));

    const { container, unmount } = await render(EpicDraftPanel, {
      sessionId,
      epicAuthoring: true,
      onreview: () => {},
    });
    container.style.width = `${width}px`;

    const bar = container.querySelector<HTMLElement>(".edp");
    expect(bar, "draft bar should render").not.toBeNull();
    if (!bar) {
      unmount();
      return;
    }

    // The whole point of the change: no draft body, no scroller, no 60dvh squeeze.
    expect(container.querySelector(".edp-scroll"), "bar must not own a scroller").toBeNull();
    expect(container.querySelector(".edp-list"), "bar must not render the child list").toBeNull();
    expect(bar.textContent).not.toContain("Section 1");
    expect(bar.getBoundingClientRect().height).toBeLessThanOrEqual(window.innerHeight * 0.15);

    unmount();
  });
});

describe("EpicDraftPanel bar — behavior", () => {
  it("opens the review dialog through onreview", async () => {
    const sessionId = "epic-draft-bar-cta";
    epicDrafts.upsert(longDraft(sessionId));
    const onreview = vi.fn();

    const { container, unmount } = await render(EpicDraftPanel, {
      sessionId,
      epicAuthoring: true,
      onreview,
    });

    const cta = container.querySelector<HTMLButtonElement>(".edp-cta");
    expect(cta, "awaiting draft should offer a review CTA").not.toBeNull();
    // a11y sizing floor — this is the only way into the review surface.
    expect(cta!.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);

    cta!.click();
    expect(onreview).toHaveBeenCalledTimes(1);

    unmount();
  });

  // headerCollapsed is persisted in localStorage, so a phone operator who folded the header once
  // would have NO path to approve or abort if the bar folded away with the rest of the chrome.
  it("survives the header fold while a draft awaits review", async () => {
    const sessionId = "epic-draft-bar-folded";
    epicDrafts.upsert(longDraft(sessionId));

    const { container, unmount } = await render(EpicDraftPanel, {
      sessionId,
      epicAuthoring: true,
      folded: true,
      onreview: () => {},
    });

    expect(container.querySelector(".edp"), "awaiting bar must survive the fold").not.toBeNull();
    expect(container.querySelector(".edp-cta")).not.toBeNull();

    unmount();
  });

  it("folds away when the draft is no longer awaiting review", async () => {
    const sessionId = "epic-draft-bar-folded-quiet";
    epicDrafts.upsert({ ...longDraft(sessionId), status: "approved" });

    const { container, unmount } = await render(EpicDraftPanel, {
      sessionId,
      epicAuthoring: true,
      folded: true,
      onreview: () => {},
    });

    expect(container.querySelector(".edp"), "quiet bar folds with the other chrome").toBeNull();

    unmount();
  });
});
