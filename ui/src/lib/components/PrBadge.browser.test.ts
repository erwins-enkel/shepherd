import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import PrBadge from "./PrBadge.svelte";
import { m } from "$lib/paraglide/messages";
import type { GitState } from "$lib/types";

function git(over: Partial<GitState> = {}): GitState {
  return {
    kind: "github",
    state: "open",
    number: 12,
    url: "https://example.test/pr/12",
    checks: "success",
    deployConfigured: false,
    isDraft: false,
    ...over,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PrBadge", () => {
  it("opens an action menu for open PR badges", async () => {
    render(PrBadge, { props: { git: git(), sessionId: "s1" } });

    await page.getByRole("button", { name: m.prbadge_button_title({ label: "PR #12" }) }).click();

    await expect
      .element(page.getByRole("menuitem", { name: m.prbadge_open_pr() }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("menuitem", { name: m.prbadge_mark_draft() }))
      .toBeInTheDocument();
  });

  it("opens the PR URL in a new tab from the menu", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(PrBadge, { props: { git: git(), sessionId: "s1" } });

    await page.getByRole("button", { name: m.prbadge_button_title({ label: "PR #12" }) }).click();
    await page.getByRole("menuitem", { name: m.prbadge_open_pr() }).click();

    expect(open).toHaveBeenCalledWith(
      "https://example.test/pr/12",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("sets a ready PR back to draft", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(git({ isDraft: true }))));
    vi.stubGlobal("fetch", fetch);
    render(PrBadge, { props: { git: git({ isDraft: false }), sessionId: "s1" } });

    await page.getByRole("button", { name: m.prbadge_button_title({ label: "PR #12" }) }).click();
    await page.getByRole("menuitem", { name: m.prbadge_mark_draft() }).click();

    expect(fetch).toHaveBeenCalledWith("/api/sessions/s1/git/draft", expect.any(Object));
  });

  it("sets a draft PR ready for review", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(git({ isDraft: false }))));
    vi.stubGlobal("fetch", fetch);
    render(PrBadge, { props: { git: git({ isDraft: true }), sessionId: "s1" } });

    await page.getByRole("button", { name: m.prbadge_button_title({ label: "PR #12" }) }).click();
    await page.getByRole("menuitem", { name: m.prbadge_mark_ready() }).click();

    expect(fetch).toHaveBeenCalledWith("/api/sessions/s1/git/ready", expect.any(Object));
  });
});
