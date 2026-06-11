import { describe, it, expect, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import RepoSelect from "./RepoSelect.svelte";
import { m } from "$lib/paraglide/messages";
import type { RepoEntry } from "$lib/types";

const noop = vi.fn();

function makeRepos(): RepoEntry[] {
  return [
    // Two pinned repos (recentAgentCount > 0); they will occupy rows 0 and 1.
    { name: "alpha", path: "/repos/alpha", display: "~/repos/alpha", recentAgentCount: 5 },
    { name: "beta", path: "/repos/beta", display: "~/repos/beta", recentAgentCount: 3 },
    // The selected repo has NO recentAgentCount — it is main-list-only, so it
    // never appears in the pinned group. Rows 0+1 are alpha+beta; gamma is later.
    { name: "gamma", path: "/repos/gamma", display: "~/repos/gamma" },
  ];
}

describe("RepoSelect — keyboard cursor on open", () => {
  it("puts the cursor on the selected repo, not on the first pinned row", async () => {
    const repos = makeRepos();
    // gamma is selected; it is NOT pinned, so row 0 = alpha (pinned).
    render(RepoSelect, {
      repos,
      value: "/repos/gamma",
      onchange: noop,
      windowDays: 7,
    });

    // Open the dropdown.
    await page.getByRole("button", { name: /gamma/ }).click();

    // The row with aria-selected="true" is the keyboard cursor.
    const selected = page.getByRole("option", { selected: true });
    await expect.element(selected).toBeVisible();

    // The cursor row must contain "gamma", not "alpha" (which is row 0 / pinned).
    await expect.element(selected).toHaveTextContent("gamma");
    // And confirm row 0 (alpha) is NOT the cursor.
    const alphaRow = page.getByRole("option", { name: /alpha/ }).first();
    await expect.element(alphaRow).toHaveAttribute("aria-selected", "false");
  });

  it("resets the cursor to the first result when the user types in the filter", async () => {
    const repos = makeRepos();
    // Start with gamma selected (not row 0).
    render(RepoSelect, {
      repos,
      value: "/repos/gamma",
      onchange: noop,
      windowDays: 7,
    });

    // Open the dropdown.
    await page.getByRole("button", { name: /gamma/ }).click();

    // Type "al" — only alpha matches; filter collapses the pinned group (filter
    // not empty), so the shown list is just [alpha]. Row 0 should get the cursor.
    const filterInput = page.getByPlaceholder(m.reposelect_filter_placeholder());
    await filterInput.fill("al");

    // The first (and only) option should now have aria-selected="true".
    const firstOption = page.getByRole("option").first();
    await expect.element(firstOption).toHaveAttribute("aria-selected", "true");
    await expect.element(firstOption).toHaveTextContent("alpha");
  });

  it("falls back to the first row when value matches no repo in the list", async () => {
    const repos = makeRepos();
    // value points at a repo that isn't in `shown` at all → findIndex returns -1,
    // so the `idx >= 0 ? idx : 0` fallback must park the cursor on row 0.
    render(RepoSelect, {
      repos,
      value: "/repos/does-not-exist",
      onchange: noop,
      windowDays: 7,
    });

    // Nothing is selected, so the trigger shows the placeholder; open via it.
    // (Accessible name also picks up the chevron glyph, hence the regex.)
    await page.getByRole("button", { name: new RegExp(m.reposelect_placeholder()) }).click();

    // Row 0 (alpha, the first pinned repo) must be the keyboard cursor.
    const firstOption = page.getByRole("option").first();
    await expect.element(firstOption).toHaveAttribute("aria-selected", "true");
    await expect.element(firstOption).toHaveTextContent("alpha");
  });
});
