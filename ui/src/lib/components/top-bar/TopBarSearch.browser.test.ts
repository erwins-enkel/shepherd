import { describe, it, expect, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import TopBarSearch from "./TopBarSearch.svelte";
import { m } from "$lib/paraglide/messages";

describe("TopBarSearch", () => {
  it("renders a button named by the search aria-label", async () => {
    render(TopBarSearch, { props: { compact: false, oncommandbar: vi.fn() } });
    await expect
      .element(page.getByRole("button", { name: m.topbar_search_aria() }))
      .toBeInTheDocument();
  });

  it("clicking it calls oncommandbar", async () => {
    const oncommandbar = vi.fn();
    render(TopBarSearch, { props: { compact: false, oncommandbar } });
    await page.getByRole("button", { name: m.topbar_search_aria() }).click();
    expect(oncommandbar).toHaveBeenCalledTimes(1);
  });

  it("non-compact: shows the search label and a keyboard-hint chip (⌘K or Ctrl K)", async () => {
    render(TopBarSearch, { props: { compact: false, oncommandbar: vi.fn() } });
    await expect.element(page.getByText(m.topbar_search())).toBeVisible();
    const kbd = document.querySelector<HTMLElement>(".kbd");
    expect(kbd, "kbd hint rendered").not.toBeNull();
    expect(kbd!.textContent, "hint reads ⌘K or Ctrl K").toMatch(/^(⌘K|Ctrl K)$/);
  });

  it("compact: hides the label and the kbd hint (icon-only)", async () => {
    render(TopBarSearch, { props: { compact: true, oncommandbar: vi.fn() } });
    expect(document.querySelector(".search-label"), "label hidden when compact").toBeNull();
    expect(document.querySelector(".kbd"), "kbd hidden when compact").toBeNull();
    // The button itself stays reachable, still named by the aria-label.
    await expect
      .element(page.getByRole("button", { name: m.topbar_search_aria() }))
      .toBeInTheDocument();
  });
});
