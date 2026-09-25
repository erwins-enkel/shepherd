import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import "../../app.css";
import { statusTip } from "./statusTip.svelte";
import type { TooltipExplanation } from "./content";
import StatusTipHarness from "./StatusTipHarness.test.svelte";
import { page } from "vitest/browser";

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

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
    node.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    const panel = document.querySelector<HTMLElement>(".status-tip")!;
    expect(panel.matches(":popover-open")).toBe(true);
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
  it("updates a shown structured tip without looping", () => {
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
    trigger.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    const panel = document.querySelector<HTMLElement>(".status-tip")!;
    expect(panel.textContent).toContain("1.2 units");
    expect(() => {
      harness.setUnits("2.4");
      flushSync();
    }).not.toThrow();
    expect(panel.textContent).toContain("2.4 units");
    expect(trigger.getAttribute("aria-description")).toContain("Next turn: 2.4 units");
  });
});
