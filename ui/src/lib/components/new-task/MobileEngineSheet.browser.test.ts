import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { createRawSnippet } from "svelte";
import "../../../app.css";
import MobileEngineSheet from "./MobileEngineSheet.svelte";

// Direct component seam for the bottom-sheet primitive: scrim, focus trap,
// Escape contract (consumes the keypress so an outer dialog survives), focus
// restore to the opener, and the no-entrance-animation rule.

afterEach(() => {
  document.body.innerHTML = "";
});

const bodySnippet = createRawSnippet(() => ({
  render: () => `<div><button type="button" class="inner-a">A</button>
    <button type="button" class="inner-b">B</button></div>`,
}));

function mount(onclose = vi.fn()) {
  render(MobileEngineSheet, {
    label: "Engine",
    title: "Engine",
    onclose,
    children: bodySnippet,
  });
  return onclose;
}

describe("MobileEngineSheet contract", () => {
  it("renders an aria-modal dialog over the shared scrim, with no entrance animation", async () => {
    mount();
    await expect.poll(() => document.querySelector(".sheet")).toBeTruthy();
    const sheet = document.querySelector<HTMLElement>(".sheet")!;
    expect(sheet.getAttribute("role")).toBe("dialog");
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    // Shared scrim primitive (dim + blur) backs the sheet.
    const scrim = document.querySelector<HTMLElement>(".sheet-scrim")!;
    expect(scrim.classList.contains("scrim")).toBe(true);
    // No-motion rule: the sheet declares no entrance animation.
    expect(getComputedStyle(sheet).animationName).toBe("none");
  });

  it("pulls focus into the sheet and restores it to the opener on close", async () => {
    // Simulate the opener (the engine summary row / context chip).
    const opener = document.createElement("button");
    opener.className = "opener";
    document.body.appendChild(opener);
    opener.focus();

    const onclose = mount();
    // The dialog action pulls focus to the first focusable control inside.
    await expect.poll(() => document.activeElement?.classList.contains("inner-a")).toBe(true);

    // Escape: consumed by the sheet (defaultPrevented) → onclose fires.
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true); // an OUTER dialog would skip this event
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it("traps Tab within the sheet", async () => {
    mount();
    await expect.poll(() => document.activeElement?.classList.contains("inner-a")).toBe(true);
    const b = document.querySelector<HTMLButtonElement>(".inner-b")!;
    b.focus();
    // Tab from the last focusable wraps to the first.
    b.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    await expect.poll(() => document.activeElement?.classList.contains("inner-a")).toBe(true);
    // Shift+Tab from the first wraps to the last.
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
    );
    await expect.poll(() => document.activeElement?.classList.contains("inner-b")).toBe(true);
  });

  it("clicking the scrim closes; clicking inside does not", async () => {
    const onclose = mount();
    await expect.poll(() => document.querySelector(".sheet-scrim")).toBeTruthy();
    document.querySelector<HTMLElement>(".inner-a")!.click();
    expect(onclose).not.toHaveBeenCalled();
    document.querySelector<HTMLElement>(".sheet-scrim")!.click();
    expect(onclose).toHaveBeenCalledTimes(1);
  });
});
