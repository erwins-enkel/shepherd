import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import { m } from "#lib/paraglide/messages.js";
import { assistantLayout } from "#lib/assistant-layout.svelte.js";
import TopBarLayout from "./TopBarLayout.svelte";

afterEach(() => {
  assistantLayout.set("standard");
  document.body.innerHTML = "";
});

describe("TopBarLayout", () => {
  it("offers every layout in one labelled group, the current one pressed", async () => {
    render(TopBarLayout);
    await expect
      .element(page.getByRole("group", { name: m.assistant_layout_group() }))
      .toBeVisible();
    for (const name of [
      m.assistant_layout_standard(),
      m.assistant_layout_half(),
      m.assistant_layout_wide(),
      m.assistant_layout_talk(),
    ]) {
      await expect.element(page.getByRole("button", { name })).toBeVisible();
    }
    await expect
      .element(page.getByRole("button", { name: m.assistant_layout_standard() }))
      .toHaveAttribute("aria-pressed", "true");
  });

  it("picks a layout on click and remembers it", async () => {
    render(TopBarLayout);
    const wide = page.getByRole("button", { name: m.assistant_layout_wide() });
    await wide.click();
    expect(assistantLayout.layout).toBe("wide");
    expect(localStorage.getItem("shepherd:assistant-layout")).toBe("wide");
    await expect.element(wide).toHaveAttribute("aria-pressed", "true");
    await expect
      .element(page.getByRole("button", { name: m.assistant_layout_standard() }))
      .toHaveAttribute("aria-pressed", "false");
  });
});
