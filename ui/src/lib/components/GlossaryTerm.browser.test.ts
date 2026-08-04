import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../app.css";
import GlossaryTerm from "./GlossaryTerm.svelte";
import GlossaryText from "./GlossaryText.svelte";
import { infoTips } from "$lib/info-tips.svelte";
import { m } from "$lib/paraglide/messages";

describe("GlossaryTerm — activation-only inline disclosure", () => {
  it("click → inline panel opens, no floating tooltip", async () => {
    render(GlossaryTerm, { id: "epic", label: "epic" });

    const btn = page.getByRole("button", { name: "epic" });
    await btn.click();

    // inline panel present with correct role and body text
    await expect.element(page.getByRole("note")).toBeVisible();
    await expect.element(page.getByRole("note")).toHaveTextContent(m.gloss_epic_def());

    // no floating tooltip open
    const tooltips = document.querySelectorAll(".gloss-tooltip:popover-open");
    expect(tooltips).toHaveLength(0);
  });

  it("bare Tab-focus is inert — nothing opens", async () => {
    render(GlossaryTerm, { id: "epic", label: "epic" });

    const btn = page.getByRole("button", { name: "epic" });
    await btn.element().focus();

    // no inline panel
    const inlines = document.querySelectorAll(".gloss-inline");
    expect(inlines).toHaveLength(0);

    // no floating tooltip open
    const tooltips = document.querySelectorAll(".gloss-tooltip:popover-open");
    expect(tooltips).toHaveLength(0);
  });

  it("keyboard Enter → inline panel opens", async () => {
    render(GlossaryTerm, { id: "epic", label: "epic" });

    const btn = page.getByRole("button", { name: "epic" });
    await btn.element().focus();

    // confirm nothing open after focus
    expect(document.querySelectorAll(".gloss-inline")).toHaveLength(0);

    // pressing Enter on a focused button fires a native click
    await userEvent.keyboard("{Enter}");

    await expect.element(page.getByRole("note")).toBeVisible();
  });

  it("hover → floating tooltip opens, no inline panel", async () => {
    render(GlossaryTerm, { id: "epic", label: "epic" });

    const btn = page.getByRole("button", { name: "epic" });
    btn
      .element()
      .dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse", bubbles: true }));

    // floating tooltip should become open
    await expect
      .poll(() => {
        return document.querySelectorAll(".gloss-tooltip:popover-open").length;
      })
      .toBe(1);

    // no inline panel
    expect(document.querySelectorAll(".gloss-inline")).toHaveLength(0);
  });

  it("pinned inline survives mouse-leave", async () => {
    render(GlossaryTerm, { id: "epic", label: "epic" });

    const btn = page.getByRole("button", { name: "epic" });
    await btn.click();

    // verify inline open
    await expect.element(page.getByRole("note")).toBeVisible();

    // dispatch mouse pointerleave
    btn
      .element()
      .dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse", bubbles: true }));

    // inline still present
    await expect.element(page.getByRole("note")).toBeVisible();
  });

  it("external term → inline panel has role=dialog and Wikipedia link", async () => {
    render(GlossaryTerm, { id: "pr", label: "PR" });

    const btn = page.getByRole("button", { name: "PR" });
    await btn.click();

    const dialog = page.getByRole("dialog");
    await expect.element(dialog).toBeVisible();

    // Wikipedia link href contains expected slug
    const link = dialog.getByRole("link");
    await expect.element(link).toBeVisible();
    const href = await link.element().getAttribute("href");
    expect(href).toContain("/wiki/Distributed_version_control#Pull_requests");
  });

  // Regression: the floating popover is always mounted, so its closed state must be
  // display:none. A base display:flex used to override the UA closed-popover rule,
  // leaving the definition visibly pinned over content with no interaction (it
  // "auto-opened" and "wouldn't close"). The :popover-open assertions above pass even
  // with that bug, so these test rendered VISIBILITY rather than popover-open state.
  it("closed floating tooltip is display:none — no auto-open / stuck overlay", () => {
    render(GlossaryTerm, { id: "epic", label: "epic" });

    const tip = document.querySelector<HTMLElement>(".gloss-tooltip");
    expect(tip).not.toBeNull();
    expect(getComputedStyle(tip!).display).toBe("none");
  });

  it("floating tooltip display tracks :popover-open (open shows, closed hides)", async () => {
    render(GlossaryTerm, { id: "epic", label: "epic" });

    const btn = page.getByRole("button", { name: "epic" });
    const tip = document.querySelector<HTMLElement>(".gloss-tooltip");
    expect(tip).not.toBeNull();

    // hover opens it → :popover-open → visible
    btn
      .element()
      .dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse", bubbles: true }));
    await expect.poll(() => tip!.matches(":popover-open")).toBe(true);
    expect(getComputedStyle(tip!).display).not.toBe("none");

    // Once no longer open it must hide again — the "won't close" half. Drive the
    // popover-open state directly so the assertion tests the CSS contract itself,
    // not the event/timer-driven close path (that path is covered live + by the
    // mouse-leave/Escape dismiss handlers; synthetic-event timing is racy here).
    tip!.hidePopover();
    expect(getComputedStyle(tip!).display).toBe("none");
  });
});

// Regression: a definition is prose and must wrap regardless of where the marker sits.
// The new-task dialog's Guards toggles put their label under `white-space: nowrap`, which
// DOM-inherits into the top-layer popover — so the definition ran on a single line ~1470px
// wide inside the 260px popover, and the UA's `[popover] { overflow: auto }` rendered that
// as a horizontal scrollbar: one clipped line above a full-width bar.
describe("GlossaryTerm — definition wraps inside a nowrap host", () => {
  afterEach(() => {
    document.body.style.whiteSpace = "";
  });

  async function openFloating(id: string, label: string): Promise<HTMLElement> {
    document.body.style.whiteSpace = "nowrap";
    render(GlossaryTerm, { id, label });

    page
      .getByRole("button", { name: label })
      .element()
      .dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse", bubbles: true }));

    const tip = document.querySelector<HTMLElement>(".gloss-tooltip");
    expect(tip).not.toBeNull();
    await expect.poll(() => tip!.matches(":popover-open")).toBe(true);
    return tip!;
  }

  it("internal term: body resets white-space, so the popover never scrolls sideways", async () => {
    const tip = await openFloating("plan-gate", "Plan gate");

    const body = document.querySelector<HTMLElement>(".gt-body");
    expect(body).not.toBeNull();
    expect(getComputedStyle(body!).whiteSpace).toBe("normal");

    // The bar itself: overflow beyond the fixed width is what draws it.
    expect(tip.scrollWidth).toBeLessThanOrEqual(tip.clientWidth);
    // ...and the definition reads as a multi-line block. Measured against the computed
    // line-height rather than a pixel constant so editing the definition can't flip it.
    const lineHeight = Number.parseFloat(getComputedStyle(body!).lineHeight);
    expect(body!.getBoundingClientRect().height).toBeGreaterThan(lineHeight * 1.5);
  });

  it("external term: the Wikipedia link line does not overflow either", async () => {
    const tip = await openFloating("pr", "PR");

    await expect.element(page.getByRole("link")).toBeVisible();
    expect(tip.scrollWidth).toBeLessThanOrEqual(tip.clientWidth);
  });
});

describe("GlossaryTerm — hide-info-tips preference", () => {
  afterEach(() => infoTips.set(false));

  it("degrades to plain text: the word stays, the affordance goes", async () => {
    infoTips.set(true);
    render(GlossaryTerm, { id: "epic", label: "epic" });

    // The label is inline prose — dropping it would leave a hole in the sentence.
    await expect.element(page.getByText("epic")).toBeInTheDocument();

    // ...but nothing about it is interactive or decorated any more.
    expect(page.getByRole("button", { name: "epic" }).query()).toBeNull();
    expect(document.querySelectorAll(".gloss-term")).toHaveLength(0);
    expect(document.querySelectorAll(".gloss-tooltip")).toHaveLength(0);
  });

  it("external terms lose their Wikipedia link too (accepted consequence)", async () => {
    infoTips.set(true);
    render(GlossaryTerm, { id: "ci", label: "CI" });

    expect(document.querySelectorAll("a[href*='wikipedia.org']")).toHaveLength(0);
    expect(page.getByRole("button", { name: "CI" }).query()).toBeNull();
  });

  it("GlossaryText markers degrade too — this is what covers Coachmark / What's-New", async () => {
    infoTips.set(true);
    render(GlossaryText, { text: "Shepherd groups sessions under an [[epic|epic]]." });

    // Same prose, no markers left behind, no affordance.
    await expect
      .element(page.getByText("Shepherd groups sessions under an epic."))
      .toBeInTheDocument();
    expect(document.querySelectorAll(".gloss-term")).toHaveLength(0);
  });

  it("renders the affordance normally when the preference is off", async () => {
    render(GlossaryTerm, { id: "epic", label: "epic" });

    await expect.element(page.getByRole("button", { name: "epic" })).toBeInTheDocument();
  });
});
