import { describe, it, expect, vi } from "vitest";
import { tick } from "svelte";
import { render } from "vitest-browser-svelte";
import { userEvent } from "vitest/browser";
import "../../app.css";
import type { EpicDraft } from "$lib/types";
import { epicDrafts } from "$lib/epic-draft.svelte";
import EpicDraftModal from "./EpicDraftModal.svelte";

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

/** Is the element the one that would actually receive a click at its own center? */
function hitTestable(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return el.contains(top) || el === top;
}

describe.each([
  ["desktop", 1000],
  ["narrow", 390],
])("EpicDraftModal long-draft layout — %s", (label, width) => {
  it("scrolls the draft while the review actions stay pinned and clickable", async () => {
    const sessionId = `epic-draft-modal-${label}`;
    epicDrafts.upsert(longDraft(sessionId));

    const { container, unmount } = await render(EpicDraftModal, {
      sessionId,
      sessionLive: true,
      onclose: () => {},
    });
    const card = container.querySelector<HTMLElement>(".card");
    if (card) card.style.width = `${width}px`;

    const body = container.querySelector<HTMLElement>(".body");
    const approve = container.querySelector<HTMLElement>(".approve");
    const abort = container.querySelector<HTMLElement>(".abort");
    const list = container.querySelector<HTMLElement>(".list");

    expect(body, "the body owns the only scroll").not.toBeNull();
    expect(approve, "approve must render while awaiting").not.toBeNull();
    expect(abort, "abort must render while awaiting").not.toBeNull();
    expect(list, "child list should render").not.toBeNull();
    if (!body || !approve || !abort || !list) {
      unmount();
      return;
    }

    expect(getComputedStyle(body).overflowY).toBe("auto");
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
    expect(getComputedStyle(list).overflowY).not.toBe("auto");

    // a11y sizing floor on the actions that commit or discard a whole epic.
    expect(approve.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(abort.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);

    // Pinned means pinned: reachable at the top of the draft AND at the very bottom of it.
    expect(hitTestable(approve), "approve clickable at scroll-top").toBe(true);
    expect(hitTestable(abort), "abort clickable at scroll-top").toBe(true);

    body.scrollTop = body.scrollHeight;
    await tick();

    expect(body.scrollTop).toBeGreaterThan(0);
    expect(hitTestable(approve), "approve clickable at scroll-bottom").toBe(true);
    expect(hitTestable(abort), "abort clickable at scroll-bottom").toBe(true);

    unmount();
  });

  it("uses readable text measures and standard-sized review controls", async () => {
    const sessionId = `epic-draft-modal-readability-${label}`;
    epicDrafts.upsert(longDraft(sessionId));

    const { container, unmount } = await render(EpicDraftModal, {
      sessionId,
      sessionLive: true,
      onclose: () => {},
    });
    const card = container.querySelector<HTMLElement>(".card");
    if (card) card.style.width = `${width}px`;

    const parentBody = container.querySelector<HTMLElement>(".parent-body")!;
    const criteria = container.querySelector<HTMLElement>(".crit")!;
    const childTitle = container.querySelector<HTMLElement>(".edp-child-title")!;
    const childBody = container.querySelector<HTMLElement>(".edp-child-body")!;
    const input = container.querySelector<HTMLInputElement>(".amend-input")!;
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".btn")];
    const bodyFontSize = parseFloat(getComputedStyle(document.body).fontSize);

    for (const element of [parentBody, criteria, childTitle, childBody]) {
      expect(parseFloat(getComputedStyle(element).fontSize)).toBe(bodyFontSize);
    }
    for (const element of [parentBody, criteria, childBody]) {
      const style = getComputedStyle(element);
      expect(parseFloat(style.lineHeight) / parseFloat(style.fontSize)).toBeGreaterThanOrEqual(1.45);
      expect(style.maxWidth).not.toBe("none");
    }

    expect(parseFloat(getComputedStyle(input).fontSize)).toBeGreaterThanOrEqual(bodyFontSize);
    expect(input.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(parseFloat(getComputedStyle(button).fontSize)).toBe(bodyFontSize);
      expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }

    unmount();
  });
});

describe("EpicDraftModal — dialog behavior", () => {
  it("closes on Escape", async () => {
    const sessionId = "epic-draft-modal-esc";
    epicDrafts.upsert(longDraft(sessionId));
    const onclose = vi.fn();

    const { unmount } = await render(EpicDraftModal, {
      sessionId,
      sessionLive: true,
      onclose,
    });

    await userEvent.keyboard("{Escape}");
    expect(onclose).toHaveBeenCalledTimes(1);

    unmount();
  });

  // After Approve the draft walks draft → materializing → approved under the dialog. It must STAY
  // OPEN: auto-closing would yank the just-created parent link away the instant it appears.
  it("stays open across materializing → approved and surfaces the parent link", async () => {
    const sessionId = "epic-draft-modal-approve";
    const base = longDraft(sessionId);
    epicDrafts.upsert(base);

    const { container, unmount } = await render(EpicDraftModal, {
      sessionId,
      sessionLive: true,
      onclose: () => {},
    });

    expect(container.querySelector(".approve")).not.toBeNull();

    epicDrafts.upsert({ ...base, status: "materializing" });
    await tick();

    expect(container.querySelector(".card"), "dialog stays open while creating").not.toBeNull();
    expect(container.querySelector(".approve"), "actions retire once approved").toBeNull();
    expect(container.querySelector(".note")).not.toBeNull();

    epicDrafts.upsert({
      ...base,
      status: "approved",
      parentNumber: 4242,
      parentUrl: "https://example.invalid/issues/4242",
    });
    await tick();

    const link = container.querySelector<HTMLAnchorElement>(".link");
    expect(container.querySelector(".card"), "dialog stays open once created").not.toBeNull();
    expect(link, "the created epic's parent link must be reachable").not.toBeNull();
    expect(link!.href).toBe("https://example.invalid/issues/4242");

    unmount();
  });
});
