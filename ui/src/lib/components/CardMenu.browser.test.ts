import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import CardMenu from "./CardMenu.svelte";
import { m } from "$lib/paraglide/messages";

// A real, connected opener: the menu measures its rect for positioning and
// restores focus to it on close.
let opener: HTMLButtonElement;
beforeEach(() => {
  opener = document.createElement("button");
  opener.textContent = "opener";
  document.body.appendChild(opener);
});
afterEach(() => {
  opener.remove();
  document.body.innerHTML = "";
});

const base = (extra: Record<string, unknown> = {}) => ({
  x: 10,
  y: 10,
  resumable: false,
  opener,
  onclose: vi.fn(),
  ...extra,
});

describe("CardMenu relaunch action", () => {
  it("renders the Relaunch item only when onrelaunch is provided", async () => {
    const { rerender } = render(CardMenu, { props: base() });
    expect(document.querySelector(".card-menu")).not.toBeNull();
    // no onrelaunch → no Relaunch item
    expect(page.getByRole("menuitem", { name: m.cardmenu_relaunch() }).query()).toBeNull();

    await rerender(base({ onrelaunch: vi.fn() }));
    await expect
      .element(page.getByRole("menuitem", { name: m.cardmenu_relaunch() }))
      .toBeInTheDocument();
  });

  it("a single click arms (does NOT fire onrelaunch) and a second click fires it once", async () => {
    const onrelaunch = vi.fn();
    render(CardMenu, { props: base({ onrelaunch }) });

    const item = page.getByRole("menuitem", { name: m.cardmenu_relaunch() });
    await item.click();

    // armed: label switched to the confirm text, callback NOT yet fired
    expect(onrelaunch).not.toHaveBeenCalled();
    const confirm = page.getByRole("menuitem", { name: m.cardmenu_relaunch_confirm() });
    await expect.element(confirm).toBeInTheDocument();
    // the armed item gains the danger-wash class so the second click is obviously hot
    await expect.element(confirm).toHaveClass(/\barmed\b/);

    // second click within the window fires it exactly once
    await confirm.click();
    expect(onrelaunch).toHaveBeenCalledTimes(1);
  });

  it("auto-disarms after the arm window without firing onrelaunch", async () => {
    vi.useFakeTimers();
    try {
      const onrelaunch = vi.fn();
      render(CardMenu, { props: base({ onrelaunch }) });

      const item = page.getByRole("menuitem", { name: m.cardmenu_relaunch() });
      await item.click();
      await expect
        .element(page.getByRole("menuitem", { name: m.cardmenu_relaunch_confirm() }))
        .toBeInTheDocument();

      // past the ~3s arm window → disarms back to the idle label (and drops the
      // armed danger-wash), no fire
      vi.advanceTimersByTime(3500);
      const idle = page.getByRole("menuitem", { name: m.cardmenu_relaunch() });
      await expect.element(idle).toBeInTheDocument();
      await expect.element(idle).not.toHaveClass(/\barmed\b/);
      expect(onrelaunch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
