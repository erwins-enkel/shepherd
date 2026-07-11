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

  it("does not open the action menu on mouse hover", async () => {
    render(PrBadge, { props: { git: git(), sessionId: "s1" } });

    document
      .querySelector<HTMLButtonElement>(".pr-badge.as-button")!
      .dispatchEvent(new MouseEvent("mouseenter"));

    expect(document.querySelector("[role='menu']")).toBeNull();
  });

  it("closes the action menu when the pointer moves away", async () => {
    render(PrBadge, { props: { git: git(), sessionId: "s1" } });

    await page.getByRole("button", { name: m.prbadge_button_title({ label: "PR #12" }) }).click();
    await expect
      .element(page.getByRole("menuitem", { name: m.prbadge_open_pr() }))
      .toBeInTheDocument();

    window.dispatchEvent(new PointerEvent("pointermove", { clientX: -100, clientY: -100 }));

    await vi.waitFor(() => expect(document.querySelector("[role='menu']")).toBeNull());
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

  it("disables draft changes for unsupported forge kinds", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(PrBadge, { props: { git: git({ kind: "local" }), sessionId: "s1" } });

    await page.getByRole("button", { name: m.prbadge_button_title({ label: "PR #12" }) }).click();
    const draftAction = page.getByRole("menuitem", { name: m.prbadge_mark_draft() });

    await expect.element(draftAction).toBeDisabled();
    await draftAction.click({ force: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows the Merge action when merge is available", async () => {
    render(PrBadge, { props: { git: git(), sessionId: "s1" } });

    await page.getByRole("button", { name: m.prbadge_button_title({ label: "PR #12" }) }).click();

    await expect
      .element(page.getByRole("menuitem", { name: m.prbadge_merge() }))
      .toBeInTheDocument();
  });

  it("hides the Merge action when merge is not available", async () => {
    for (const over of [
      { isDraft: true },
      { mergeable: false },
      { mergeStateStatus: "blocked" },
      { checks: "failure" },
      { kind: "local" },
    ] satisfies Partial<GitState>[]) {
      render(PrBadge, { props: { git: git(over), sessionId: "s1" } });

      await page.getByRole("button", { name: m.prbadge_button_title({ label: "PR #12" }) }).click();
      await expect
        .element(page.getByRole("menuitem", { name: m.prbadge_open_pr() }))
        .toBeInTheDocument();
      expect(document.querySelector(".pm-item.armed"), JSON.stringify(over)).toBeNull();
      for (const item of document.querySelectorAll<HTMLButtonElement>(".pm-item")) {
        expect(item.textContent, JSON.stringify(over)).not.toContain(m.prbadge_merge());
      }
      document.body.innerHTML = "";
    }
  });

  it("merges only after a two-tap confirm", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(git({ state: "merged" }))));
    vi.stubGlobal("fetch", fetch);
    render(PrBadge, { props: { git: git(), sessionId: "s1" } });

    await page.getByRole("button", { name: m.prbadge_button_title({ label: "PR #12" }) }).click();
    await page.getByRole("menuitem", { name: m.prbadge_merge() }).click();

    // first tap arms only — no request yet, label flips to the confirm prompt
    expect(fetch).not.toHaveBeenCalled();
    const confirm = page.getByRole("menuitem", { name: m.prbadge_confirm_merge() });
    await expect.element(confirm).toBeInTheDocument();

    await confirm.click();
    expect(fetch).toHaveBeenCalledWith("/api/sessions/s1/git/merge", expect.any(Object));
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(document.querySelector("[role='menu']")).toBeNull());
  });

  it("surfaces a merge failure as an alert toast", async () => {
    const { toasts } = await import("$lib/toasts.svelte");
    const info = vi.spyOn(toasts, "info");
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
    );
    vi.stubGlobal("fetch", fetch);
    render(PrBadge, { props: { git: git(), sessionId: "s1" } });

    await page.getByRole("button", { name: m.prbadge_button_title({ label: "PR #12" }) }).click();
    await page.getByRole("menuitem", { name: m.prbadge_merge() }).click();
    await page.getByRole("menuitem", { name: m.prbadge_confirm_merge() }).click();

    await vi.waitFor(() =>
      expect(info).toHaveBeenCalledWith(
        m.prbadge_merge_failed({ reason: "boom" }),
        expect.objectContaining({ alert: true, key: "pr-merge:s1" }),
      ),
    );
  });
});
