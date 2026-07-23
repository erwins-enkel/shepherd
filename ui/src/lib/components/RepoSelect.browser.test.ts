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
    {
      name: "alpha",
      path: "/repos/alpha",
      display: "~/repos/alpha",
      realPath: "/repos/alpha",
      recentAgentCount: 5,
    },
    {
      name: "beta",
      path: "/repos/beta",
      display: "~/repos/beta",
      realPath: "/repos/beta",
      recentAgentCount: 3,
    },
    // The selected repo has NO recentAgentCount — it is main-list-only, so it
    // never appears in the pinned group. Rows 0+1 are alpha+beta; gamma is later.
    { name: "gamma", path: "/repos/gamma", display: "~/repos/gamma", realPath: "/repos/gamma" },
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

describe("RepoSelect — hideHidden", () => {
  // "secret" has the highest recentAgentCount, so without hiding it would lead the pinned
  // recents group; it must be absent from BOTH the recents and the main list by default.
  function makeReposWithHidden(): RepoEntry[] {
    return [
      {
        name: "alpha",
        path: "/repos/alpha",
        display: "~/repos/alpha",
        realPath: "/repos/alpha",
        recentAgentCount: 5,
      },
      {
        name: "beta",
        path: "/repos/beta",
        display: "~/repos/beta",
        realPath: "/repos/beta",
        recentAgentCount: 3,
      },
      {
        name: "secret",
        path: "/repos/secret",
        display: "~/repos/secret",
        realPath: "/repos/secret",
        recentAgentCount: 9,
        hidden: true,
      },
    ];
  }

  it("omits hidden repos from the default list and recents when hideHidden is on", async () => {
    render(RepoSelect, {
      repos: makeReposWithHidden(),
      value: "/repos/alpha",
      onchange: noop,
      windowDays: 7,
      hideHidden: true,
    });

    await page.getByRole("button", { name: /alpha/ }).click();
    // Wait for the dropdown to render before asserting absence.
    await expect.element(page.getByRole("option").first()).toBeVisible();
    expect(page.getByRole("option", { name: /secret/ }).elements()).toHaveLength(0);
  });

  it("reveals a hidden repo once its name is searched", async () => {
    render(RepoSelect, {
      repos: makeReposWithHidden(),
      value: "/repos/alpha",
      onchange: noop,
      windowDays: 7,
      hideHidden: true,
    });

    await page.getByRole("button", { name: /alpha/ }).click();
    await page.getByPlaceholder(m.reposelect_filter_placeholder()).fill("secret");

    const revealed = page.getByRole("option", { name: /secret/ });
    await expect.element(revealed).toBeVisible();
  });

  it("keeps hidden repos visible when hideHidden is off (other consumers unaffected)", async () => {
    render(RepoSelect, {
      repos: makeReposWithHidden(),
      value: "/repos/alpha",
      onchange: noop,
      windowDays: 7,
    });

    await page.getByRole("button", { name: /alpha/ }).click();
    await expect.element(page.getByRole("option", { name: /secret/ }).first()).toBeVisible();
  });
});

describe("RepoSelect — remote identity", () => {
  const ownerRepos: RepoEntry[] = [
    {
      name: "api",
      remoteSlug: "acme/api",
      path: "/repos/acme-api",
      display: "~/repos/acme-api",
      realPath: "/repos/acme-api",
    },
    {
      name: "api",
      remoteSlug: "sibling/api",
      path: "/repos/sibling-api",
      display: "~/repos/sibling-api",
      realPath: "/repos/sibling-api",
    },
  ];

  it("shows owner-qualified slugs for duplicate local repo names", async () => {
    render(RepoSelect, {
      repos: ownerRepos,
      value: "/repos/acme-api",
      onchange: noop,
      windowDays: 7,
    });

    await page.getByRole("button", { name: /acme\/api/ }).click();

    await expect.element(page.getByRole("option", { name: /acme\/api/ })).toBeVisible();
    await expect.element(page.getByRole("option", { name: /sibling\/api/ })).toBeVisible();
  });

  it("matches repositories by remote owner", async () => {
    render(RepoSelect, {
      repos: ownerRepos,
      value: "/repos/acme-api",
      onchange: noop,
      windowDays: 7,
    });

    await page.getByRole("button", { name: /acme\/api/ }).click();
    await page.getByPlaceholder(m.reposelect_filter_placeholder()).fill("sibling");

    await expect.element(page.getByRole("option", { name: /sibling\/api/ })).toBeVisible();
    expect(page.getByRole("option", { name: /acme\/api/ }).elements()).toHaveLength(0);
  });

  it("keeps the selected owner's identity in the closed trigger", async () => {
    render(RepoSelect, {
      repos: ownerRepos,
      value: "/repos/sibling-api",
      onchange: noop,
      windowDays: 7,
    });

    await expect.element(page.getByRole("button", { name: /sibling\/api/ })).toBeVisible();
  });

  it("falls back to the local name when a remote slug is unavailable", async () => {
    render(RepoSelect, {
      repos: [
        {
          name: "local-api",
          path: "/repos/local-api",
          display: "~/repos/local-api",
          realPath: "/repos/local-api",
        },
      ],
      value: "/repos/local-api",
      onchange: noop,
      windowDays: 7,
    });

    const trigger = page.getByRole("button", { name: /local-api/ });
    await expect.element(trigger).toBeVisible();
    await trigger.click();
    await expect.element(page.getByRole("option", { name: /local-api/ })).toBeVisible();
  });
});
