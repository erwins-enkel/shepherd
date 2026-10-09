import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import "../../app.css";
import { statusTip } from "./statusTip.svelte";
import type { TooltipExplanation } from "./content";
import StatusTipHarness from "./StatusTipHarness.test.svelte";
import { page } from "vitest/browser";

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

// Hover opens after a rest delay; wait it out and return the open panel.
async function hoverOpen(node: HTMLElement) {
  node.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
  await expect.poll(() => document.querySelector(".status-tip:popover-open")).not.toBeNull();
  return document.querySelector<HTMLElement>(".status-tip")!;
}

describe("structured statusTip", () => {
  it("does not open from programmatic focus", async () => {
    const node = document.createElement("button");
    const outside = document.createElement("button");
    outside.textContent = "Outside";
    document.body.append(node);
    document.body.append(outside);
    const action = statusTip(node, { text: "Details" });
    cleanup = () => {
      action?.destroy?.();
      node.remove();
      outside.remove();
    };
    await page.getByRole("button", { name: "Outside" }).click();
    node.focus();
    expect(document.querySelector(".status-tip")).toBeNull();
  });

  it("updates visible content and accessible text, escapes markup, and dismisses an unfocused hover with Escape", async () => {
    const node = document.createElement("span");
    document.body.append(node);
    const content: TooltipExplanation = {
      title: "Cache expired",
      summary: "<img src=x onerror=alert(1)>",
      sections: [{ label: "Next turn", text: "1.2 units" }],
    };
    const action = statusTip(node, { text: content });
    cleanup = () => {
      action?.destroy?.();
      node.remove();
    };
    expect(node.getAttribute("aria-description")).toContain("Next turn: 1.2 units");
    const panel = await hoverOpen(node);
    expect(panel.querySelector("img")).toBeNull();
    expect(panel.textContent).toContain(content.summary);
    expect(panel.querySelector(".tooltip-title")?.textContent).toBe(content.title);
    action?.update?.({
      text: { ...content, sections: [{ label: "Next turn", text: "2.4 units" }] },
    });
    flushSync();
    expect(panel.textContent).toContain("2.4 units");
    expect(node.getAttribute("aria-description")).toContain("Next turn: 2.4 units");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel.matches(":popover-open")).toBe(false);
    action?.update?.(null);
    expect(document.querySelector(".status-tip")).toBeNull();
    expect(node.hasAttribute("aria-description")).toBe(false);
  });
});

describe("statusTip via use:", () => {
  // Regression: once the panel existed, update() (run inside Svelte's tracked action effect)
  // wrote bodyProps.content and read it back → effect_update_depth_exceeded froze the page.
  it("updates a shown structured tip without looping", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    const harness = mount(StatusTipHarness, { target }) as unknown as {
      setUnits(next: string): void;
    };
    cleanup = () => {
      void unmount(harness);
      target.remove();
    };
    flushSync();
    const trigger = target.querySelector<HTMLElement>("[data-testid=tip-trigger]")!;
    const panel = await hoverOpen(trigger);
    expect(panel.textContent).toContain("1.2 units");
    expect(() => {
      harness.setUnits("2.4");
      flushSync();
    }).not.toThrow();
    expect(panel.textContent).toContain("2.4 units");
    expect(trigger.getAttribute("aria-description")).toContain("Next turn: 2.4 units");
  });
});

describe("statusTip list-row options", () => {
  function mountTrigger(params: Parameters<typeof statusTip>[1]) {
    const node = document.createElement("div");
    node.textContent = "row";
    node.style.cssText = "position:absolute;left:40px;top:120px;width:120px;height:30px";
    document.body.append(node);
    const action = statusTip(node, params);
    cleanup = () => {
      action?.destroy?.();
      node.remove();
    };
    return node;
  }

  it("pinOnClick:false — a click neither opens nor pins; leaving closes a hovered tip", async () => {
    const node = mountTrigger({ text: "Details", pinOnClick: false, stopClickPropagation: false });
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(document.querySelector(".status-tip")).toBeNull();

    const panel = await hoverOpen(node);
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(panel.matches(":popover-open")).toBe(true);
    node.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
    await expect.poll(() => panel.matches(":popover-open")).toBe(false);
  });

  it("hover opens only after the pointer rests; a pass-through never opens", async () => {
    const node = mountTrigger({ text: "Details" });
    node.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    node.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 650));
    expect(document.querySelector(".status-tip")).toBeNull();

    node.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 200));
    expect(document.querySelector(".status-tip")).toBeNull();
    await expect
      .poll(() => document.querySelector(".status-tip")?.matches(":popover-open"))
      .toBe(true);
  });

  it("a click opens at once, without the hover delay", () => {
    const node = mountTrigger({ text: "Details" });
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(document.querySelector(".status-tip")?.matches(":popover-open")).toBe(true);
  });

  it("destroy during a pending hover open creates no panel", async () => {
    const node = mountTrigger({ text: "Details" });
    node.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    cleanup?.();
    cleanup = undefined;
    await new Promise((r) => setTimeout(r, 650));
    expect(document.querySelector(".status-tip")).toBeNull();
  });

  it("placement:right — the panel sits to the right of the trigger", async () => {
    const node = mountTrigger({ text: "Details", placement: "right" });
    const panel = await hoverOpen(node);
    await expect
      .poll(() => panel.getBoundingClientRect().left)
      .toBeGreaterThanOrEqual(node.getBoundingClientRect().right);
  });
});

describe("statusTip panel and navigates", () => {
  const explanation: TooltipExplanation = {
    title: "Epic #158 running for 2 h 22 min",
    summary: "1 of 5 steps merged.",
    sections: [
      { label: "Time", text: "", rows: [{ text: "Started", aside: "10:21" }] },
      { label: "Steps", text: "", rows: [{ text: "#160 Baseline", tone: "ok" }], full: true },
    ],
    footer: ["Click opens the epic in Repos."],
  };

  // Svelte delegates `onclick` to the root, so the trigger's own action reaches a listener
  // above it — a click stopped on the node never gets there.
  function mountNavigating() {
    const node = document.createElement("button");
    node.textContent = "EPIC 1/5";
    document.body.append(node);
    const acted: number[] = [];
    const onDocClick = () => acted.push(1);
    document.addEventListener("click", onDocClick);
    const action = statusTip(node, { text: explanation, panel: true, navigates: true });
    cleanup = () => {
      action?.destroy?.();
      document.removeEventListener("click", onDocClick);
      node.remove();
    };
    return { node, acted };
  }
  const tap = (node: HTMLElement) => {
    node.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true }));
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  };

  it("panel: the status-panel surface, with sections in columns and a full-width section", async () => {
    const { node } = mountNavigating();
    const panel = await hoverOpen(node);
    expect(panel.classList.contains("status-tip-panel")).toBe(true);
    expect(panel.querySelector(".tooltip-body.wide")).not.toBeNull();
    expect(panel.querySelector(".tooltip-section.full")?.textContent).toContain("#160 Baseline");
    expect(panel.querySelector(".tooltip-footer")?.textContent).toContain("Click opens");
  });

  it("navigates: a mouse click reaches the action and closes the hovered tip", async () => {
    const { node, acted } = mountNavigating();
    const panel = await hoverOpen(node);
    node.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse", bubbles: true }));
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(acted).toHaveLength(1);
    expect(panel.matches(":popover-open")).toBe(false);
  });

  it("navigates: the first touch tap previews the tip, the second acts", () => {
    const { node, acted } = mountNavigating();
    tap(node);
    expect(acted).toHaveLength(0);
    const panel = document.querySelector<HTMLElement>(".status-tip")!;
    expect(panel.matches(":popover-open")).toBe(true);
    tap(node);
    expect(acted).toHaveLength(1);
    expect(panel.matches(":popover-open")).toBe(false);
  });

  it("navigates: a keyboard click acts at once, even after an earlier touch", () => {
    const { node, acted } = mountNavigating();
    node.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true }));
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    expect(acted).toHaveLength(1);
    expect(document.querySelector(".status-tip")).toBeNull();
  });
});
