import { afterEach, describe, expect, it } from "vitest";
import { flushSync } from "svelte";
import "../../app.css";
import { statusTip } from "./statusTip.svelte";
import type { TooltipExplanation } from "./content";

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

describe("structured statusTip", () => {
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
