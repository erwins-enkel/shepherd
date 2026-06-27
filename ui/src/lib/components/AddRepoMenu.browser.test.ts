import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import AddRepoMenu from "./AddRepoMenu.svelte";
import { m } from "$lib/paraglide/messages";

// A real, connected trigger button: the menu measures its rect for positioning
// and restores focus to it on close (mirrors RedrawMenu's test harness).
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
    onnewproject: vi.fn(),
    onclone: vi.fn(),
    onfork: vi.fn(),
    onclose: vi.fn(),
  };
}

function activeText() {
  return document.activeElement?.textContent ?? "";
}

describe("AddRepoMenu", () => {
  it("renders the three acquisition actions in issue order (New project · Clone · Fork)", async () => {
    render(AddRepoMenu, { props: { anchor, ...handlers() } });
    await expect
      .element(page.getByRole("menuitem", { name: m.newproject_trigger() }))
      .toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: m.clonerepo_trigger() })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: m.forkrepo_trigger() })).toBeVisible();
  });

  it("focuses the first item on open", async () => {
    render(AddRepoMenu, { props: { anchor, ...handlers() } });
    await expect.poll(activeText).toContain(m.newproject_trigger());
  });

  it("fires the matching callback when an item is clicked", async () => {
    const h = handlers();
    render(AddRepoMenu, { props: { anchor, ...h } });
    await page.getByRole("menuitem", { name: m.clonerepo_trigger() }).click();
    expect(h.onclone).toHaveBeenCalledOnce();
    expect(h.onnewproject).not.toHaveBeenCalled();
    expect(h.onfork).not.toHaveBeenCalled();
  });

  it("dismisses on Escape", async () => {
    const h = handlers();
    render(AddRepoMenu, { props: { anchor, ...h } });
    await expect.poll(activeText).toContain(m.newproject_trigger());

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(h.onclose).toHaveBeenCalledTimes(1);
  });

  it("dismisses on outside pointerdown, but not inside the menu or on the anchor", async () => {
    const h = handlers();
    render(AddRepoMenu, { props: { anchor, ...h } });
    await expect.poll(activeText).toContain(m.newproject_trigger());

    document.activeElement!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(h.onclose).not.toHaveBeenCalled();
    anchor.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(h.onclose).not.toHaveBeenCalled();
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(h.onclose).toHaveBeenCalledTimes(1);
  });
});
