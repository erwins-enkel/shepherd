import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import RedrawMenu from "./RedrawMenu.svelte";
import { m } from "$lib/paraglide/messages";

// A real, connected trigger button: the menu measures its rect for positioning
// and restores focus to it on close.
let anchor: HTMLButtonElement;
beforeEach(() => {
  anchor = document.createElement("button");
  anchor.textContent = "anchor";
  document.body.appendChild(anchor);
});
afterEach(() => {
  anchor.remove();
});

function handlers() {
  return {
    onnudge: vi.fn(),
    onreattach: vi.fn(),
    onfullscreen: vi.fn(),
    onresume: vi.fn(),
    onclose: vi.fn(),
  };
}

// document.activeElement, polled: the menu focuses its first item from the
// measuring $effect, which lands a microtask after render returns.
function activeText() {
  return document.activeElement?.textContent ?? "";
}

describe("RedrawMenu", () => {
  it("focuses the first item when live", async () => {
    render(RedrawMenu, { props: { anchor, live: true, resuming: false, ...handlers() } });

    await expect.poll(activeText).toContain(m.redrawmenu_nudge());
  });

  it("disables the connection-bound items when !live and focuses the first enabled one", async () => {
    render(RedrawMenu, { props: { anchor, live: false, resuming: false, ...handlers() } });

    await expect.element(page.getByRole("menuitem", { name: m.redrawmenu_nudge() })).toBeDisabled();
    await expect
      .element(page.getByRole("menuitem", { name: m.redrawmenu_fullscreen() }))
      .toBeDisabled();
    // first *focusable* item: nudge is disabled, so initial focus lands on re-attach
    await expect.poll(activeText).toContain(m.redrawmenu_reattach());
  });

  it("disables force resume while a resume is in flight", async () => {
    render(RedrawMenu, { props: { anchor, live: true, resuming: true, ...handlers() } });

    await expect
      .element(page.getByRole("menuitem", { name: m.redrawmenu_resume() }))
      .toBeDisabled();
  });

  it("dismisses on Escape", async () => {
    const h = handlers();
    render(RedrawMenu, { props: { anchor, live: true, resuming: false, ...h } });
    await expect.poll(activeText).toContain(m.redrawmenu_nudge());

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(h.onclose).toHaveBeenCalledTimes(1);
  });

  it("dismisses on outside pointerdown, but not on one inside the menu or on the anchor", async () => {
    const h = handlers();
    render(RedrawMenu, { props: { anchor, live: true, resuming: false, ...h } });
    await expect.poll(activeText).toContain(m.redrawmenu_nudge());

    // inside the menu → stays open
    document.activeElement!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(h.onclose).not.toHaveBeenCalled();
    // on the anchor → the trigger's own toggle handles it, not the menu
    anchor.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(h.onclose).not.toHaveBeenCalled();
    // anywhere else → dismiss
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(h.onclose).toHaveBeenCalledTimes(1);
  });

  it("dismisses on scroll (the anchor moves out from under the popover)", async () => {
    const h = handlers();
    render(RedrawMenu, { props: { anchor, live: true, resuming: false, ...h } });
    await expect.poll(activeText).toContain(m.redrawmenu_nudge());

    window.dispatchEvent(new Event("scroll"));

    expect(h.onclose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to the trigger when the menu closes", async () => {
    const screen = await render(RedrawMenu, {
      props: { anchor, live: true, resuming: false, ...handlers() },
    });
    await expect.poll(activeText).toContain(m.redrawmenu_nudge());

    // closing unmounts the menu; the focused item vanishes (focus falls to
    // <body>) and the teardown hands it back to the trigger
    await screen.unmount();

    await expect.poll(() => document.activeElement).toBe(anchor);
  });

  // ---- experimental font-size stepper ----

  it("steps the font size down / up via A− / A+", async () => {
    const onfontstep = vi.fn();
    render(RedrawMenu, {
      props: {
        anchor,
        live: true,
        resuming: false,
        ...handlers(),
        fontSize: 13,
        fontAtMin: false,
        fontAtMax: false,
        onfontstep,
      },
    });

    await page.getByRole("menuitem", { name: m.redrawmenu_textsize_decrease() }).click();
    await page.getByRole("menuitem", { name: m.redrawmenu_textsize_increase() }).click();

    expect(onfontstep).toHaveBeenNthCalledWith(1, -1);
    expect(onfontstep).toHaveBeenNthCalledWith(2, 1);
  });

  it("shows the current size and disables the bound-hitting button", async () => {
    render(RedrawMenu, {
      props: {
        anchor,
        live: true,
        resuming: false,
        ...handlers(),
        fontSize: 24,
        fontAtMin: false,
        fontAtMax: true,
        onfontstep: vi.fn(),
      },
    });

    await expect.element(page.getByText("24")).toBeVisible();
    await expect
      .element(page.getByRole("menuitem", { name: m.redrawmenu_textsize_increase() }))
      .toBeDisabled();
    await expect
      .element(page.getByRole("menuitem", { name: m.redrawmenu_textsize_decrease() }))
      .not.toBeDisabled();
  });

  it("redirects focus to the enabled sibling when a step disables the clicked button", async () => {
    const h = handlers();
    const onfontstep = vi.fn(() => {
      // simulate the parent (Viewport) clamping at FONT_MAX after this step:
      // A+ becomes disabled, so step()'s post-tick focus redirect must fire.
      // (runs on click, after `screen` is initialized)
      void screen.rerender({
        anchor,
        live: true,
        resuming: false,
        ...h,
        fontSize: 24,
        fontAtMin: false,
        fontAtMax: true,
        onfontstep,
      });
    });
    const screen = await render(RedrawMenu, {
      props: {
        anchor,
        live: true,
        resuming: false,
        ...h,
        fontSize: 23,
        fontAtMin: false,
        fontAtMax: false,
        onfontstep,
      },
    });
    await expect.poll(activeText).toContain(m.redrawmenu_nudge());

    await page.getByRole("menuitem", { name: m.redrawmenu_textsize_increase() }).click();

    // A+ just disabled → focus must land on the still-enabled A−, never <body>
    await expect
      .poll(() => document.activeElement?.getAttribute("aria-label"))
      .toBe(m.redrawmenu_textsize_decrease());
  });
});
