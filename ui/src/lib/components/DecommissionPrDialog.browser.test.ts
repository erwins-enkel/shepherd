import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../app.css";
import type { GitState } from "$lib/types";
import DecommissionPrDialog from "./DecommissionPrDialog.svelte";
import { m } from "$lib/paraglide/messages";

function git(overrides: Partial<GitState> = {}): GitState {
  return {
    kind: "github",
    state: "open",
    number: 42,
    checks: "success",
    mergeable: true,
    mergeStateStatus: "clean",
    deployConfigured: false,
    ...overrides,
  };
}

describe("DecommissionPrDialog", () => {
  it("offers keep, merge, and close for a mergeable open PR", async () => {
    const onselect = vi.fn();
    render(DecommissionPrDialog, {
      name: "task one",
      git: git(),
      onselect,
      onclose: vi.fn(),
    });

    await expect.element(page.getByRole("dialog", { name: /Open PR #42/ })).toBeVisible();
    await page.getByRole("button", { name: "Keep PR open & decommission" }).click();
    await page.getByRole("button", { name: "Merge PR & decommission" }).click();
    await page.getByRole("button", { name: "Close PR & decommission" }).click();

    expect(onselect.mock.calls).toEqual([["keep"], ["merge"], ["close"]]);
  });

  it("names the responsible person and escalates the merge wording on a takeover", async () => {
    // This dialog is itself the merge's confirmation, so the responsibility has to be visible
    // here rather than behind a second dialog (#2299).
    const onselect = vi.fn();
    render(DecommissionPrDialog, {
      name: "task one",
      git: git({ handoff: "merger", handoffWho: "scoop" }),
      onselect,
      onclose: vi.fn(),
    });

    await expect
      .element(page.getByText(m.mergeconfirm_handoff_merger({ who: "scoop" })))
      .toBeVisible();
    await page.getByRole("button", { name: m.decommission_pr_merge_takeover() }).click();
    expect(onselect).toHaveBeenCalledWith("merge");
  });

  it("hides merge when the open PR is not mergeable", () => {
    render(DecommissionPrDialog, {
      name: "task one",
      git: git({ isDraft: true }),
      onselect: vi.fn(),
      onclose: vi.fn(),
    });

    expect(page.getByRole("button", { name: "Merge PR & decommission" }).elements()).toHaveLength(
      0,
    );
  });

  it("cancels through the button, Escape, and backdrop", async () => {
    const onclose = vi.fn();
    render(DecommissionPrDialog, {
      name: "task one",
      git: git(),
      onselect: vi.fn(),
      onclose,
    });

    await page.getByRole("button", { name: "Cancel" }).click();
    await userEvent.keyboard("{Escape}");
    (document.querySelector(".overlay") as HTMLElement).click();

    expect(onclose).toHaveBeenCalledTimes(3);
  });
});
