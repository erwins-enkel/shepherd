import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../app.css";
import GlossaryTerm from "./GlossaryTerm.svelte";
import { m } from "$lib/paraglide/messages";

describe("GlossaryTerm — activation-only inline disclosure", () => {
  it("click → inline panel opens, no floating tooltip", async () => {
    render(GlossaryTerm, { id: "epic", label: "epic" });

    const btn = page.getByRole("button", { name: "epic" });
    await btn.click();

    // inline panel present with correct role and body text
    await expect.element(page.getByRole("note")).toBeVisible();
    await expect.element(page.getByRole("note")).toHaveTextContent(m.gloss_epic_def());

    // no floating tooltip open
    const tooltips = document.querySelectorAll(".gloss-tooltip:popover-open");
    expect(tooltips).toHaveLength(0);
  });

  it("bare Tab-focus is inert — nothing opens", async () => {
    render(GlossaryTerm, { id: "epic", label: "epic" });

    const btn = page.getByRole("button", { name: "epic" });
    await btn.element().focus();

    // no inline panel
    const inlines = document.querySelectorAll(".gloss-inline");
    expect(inlines).toHaveLength(0);

    // no floating tooltip open
    const tooltips = document.querySelectorAll(".gloss-tooltip:popover-open");
    expect(tooltips).toHaveLength(0);
  });

  it("keyboard Enter → inline panel opens", async () => {
    render(GlossaryTerm, { id: "epic", label: "epic" });

    const btn = page.getByRole("button", { name: "epic" });
    await btn.element().focus();

    // confirm nothing open after focus
    expect(document.querySelectorAll(".gloss-inline")).toHaveLength(0);

    // pressing Enter on a focused button fires a native click
    await userEvent.keyboard("{Enter}");

    await expect.element(page.getByRole("note")).toBeVisible();
  });

  it("hover → floating tooltip opens, no inline panel", async () => {
    render(GlossaryTerm, { id: "epic", label: "epic" });

    const btn = page.getByRole("button", { name: "epic" });
    btn
      .element()
      .dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse", bubbles: true }));

    // floating tooltip should become open
    await expect
      .poll(() => {
        return document.querySelectorAll(".gloss-tooltip:popover-open").length;
      })
      .toBe(1);

    // no inline panel
    expect(document.querySelectorAll(".gloss-inline")).toHaveLength(0);
  });

  it("pinned inline survives mouse-leave", async () => {
    render(GlossaryTerm, { id: "epic", label: "epic" });

    const btn = page.getByRole("button", { name: "epic" });
    await btn.click();

    // verify inline open
    await expect.element(page.getByRole("note")).toBeVisible();

    // dispatch mouse pointerleave
    btn
      .element()
      .dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse", bubbles: true }));

    // inline still present
    await expect.element(page.getByRole("note")).toBeVisible();
  });

  it("external term → inline panel has role=dialog and Wikipedia link", async () => {
    render(GlossaryTerm, { id: "pr", label: "PR" });

    const btn = page.getByRole("button", { name: "PR" });
    await btn.click();

    const dialog = page.getByRole("dialog");
    await expect.element(dialog).toBeVisible();

    // Wikipedia link href contains expected slug
    const link = dialog.getByRole("link");
    await expect.element(link).toBeVisible();
    const href = await link.element().getAttribute("href");
    expect(href).toContain("/wiki/Distributed_version_control#Pull_requests");
  });
});
