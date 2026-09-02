import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import { m } from "$lib/paraglide/messages";
import { statusLabel } from "$lib/format";

const { default: StatusPip } = await import("./StatusPip.svelte");
const runningAria = m.statuspip_status_aria({ status: statusLabel("running") });

afterEach(() => {
  document.body.innerHTML = "";
});

function pipEl(): HTMLElement {
  return page.getByRole("img").element() as HTMLElement;
}
const enter = () =>
  pipEl().dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse", bubbles: true }));
const leave = () =>
  pipEl().dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse", bubbles: true }));
const click = (detail: number) =>
  pipEl().dispatchEvent(new MouseEvent("click", { detail, bubbles: true, cancelable: true }));
const tooltipOpen = () => !!document.querySelector(".status-tip:popover-open");

describe("StatusPip tip mode (statusTip action)", () => {
  it("exposes the status via aria-description and drops the native title", async () => {
    render(StatusPip, { status: "running", tip: true });
    const pip = pipEl();
    await vi.waitFor(() => expect(pip.getAttribute("aria-description")).toBe(runningAria));
    expect(pip.hasAttribute("title")).toBe(false);
  });

  it("uses the merging / ready overrides, not the base status word", async () => {
    render(StatusPip, { status: "running", merging: true, tip: true });
    await vi.waitFor(() =>
      expect(pipEl().getAttribute("aria-description")).toBe(m.status_merging_tip()),
    );
    document.body.innerHTML = "";
    render(StatusPip, { status: "done", ready: true, tip: true });
    const ready = pipEl();
    await vi.waitFor(() =>
      expect(ready.getAttribute("aria-description")).toBe(m.status_ready_tip()),
    );
    // ready ✓ is labelled (not aria-hidden) in tip mode
    expect(ready.hasAttribute("aria-hidden")).toBe(false);
  });

  it("hover reveals a role=tooltip popover; leaving (unpinned) closes it", async () => {
    render(StatusPip, { status: "running", tip: true });
    enter();
    await vi.waitFor(() => expect(tooltipOpen()).toBe(true));
    expect(document.querySelector(".status-tip")?.getAttribute("role")).toBe("tooltip");
    // Most specs in this suite drive *real* clicks, and the cursor they leave behind
    // persists across files sharing a worker's page — so a real pointer can be resting
    // over this component. The panel is body-appended and only positioned after show()
    // (floating-anchor's computePosition is async, and .status-tip is inset:auto), so as
    // it settles the browser re-hit-tests and delivers a **trusted** pointerenter — to
    // the chip (show() → cancelClose) or to the panel, its own larger target (a bare
    // cancelClose). Either cancels the pending close with nothing left to re-schedule
    // it, which is right for a pointer that genuinely is there but strands the synthetic
    // leave below forever, since no real pointer ever leaves again.
    //
    // Release both by re-issuing the leave, so the assertion measures the close path
    // rather than the harness's stray cursor. Synthetic events never re-enter this.
    const releaseTrusted = (el: Element) =>
      el.addEventListener("pointerenter", (e) => {
        if (!e.isTrusted) return;
        el.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse", bubbles: true }));
      });
    releaseTrusted(pipEl());
    releaseTrusted(document.querySelector(".status-tip")!);
    leave();
    await vi.waitFor(() => expect(tooltipOpen()).toBe(false));
  });

  it("a genuine pointer click PINS: the tooltip survives pointerleave until outside/Esc", async () => {
    render(StatusPip, { status: "running", tip: true });
    enter();
    click(1); // detail > 0 → pins
    await vi.waitFor(() => expect(tooltipOpen()).toBe(true));
    leave(); // pinned → stays open (a real affordance, not a fleeting hover)
    await new Promise((r) => setTimeout(r, 30));
    expect(tooltipOpen()).toBe(true);
    // Esc dismisses the pinned tooltip.
    pipEl().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(tooltipOpen()).toBe(false));
  });

  it("detail (tip off) keeps the native title and does not add aria-description", async () => {
    render(StatusPip, { status: "running", tip: false });
    const pip = pipEl();
    await vi.waitFor(() => expect(pip.getAttribute("title")).toBe(runningAria));
    expect(pip.hasAttribute("aria-description")).toBe(false);
  });
});
