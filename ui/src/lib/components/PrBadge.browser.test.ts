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

/** The confirm control inside the open merge dialog. Queried by text rather than role+name so a
 *  test does not have to know which of the two wordings (neutral / takeover) is showing. */
function confirmButton(): HTMLButtonElement | null {
  const labels = [String(m.mergeconfirm_confirm()), String(m.mergeconfirm_confirm_takeover())];
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")];
  return buttons.find((b) => labels.includes(b.textContent?.trim() ?? "")) ?? null;
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

  it("opens the explicit review request popover without sending a request", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            prNumber: 12,
            repoSlug: "acme/upstream",
            isFork: true,
            logins: ["alice"],
            source: "collaborators",
            unavailable: false,
            requestedReviewers: [],
            authorLogin: "owner",
            defaultReviewer: null,
            isDraft: false,
          }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    render(PrBadge, { props: { git: git(), sessionId: "s1" } });

    await page.getByRole("button", { name: m.prbadge_button_title({ label: "PR #12" }) }).click();
    await page.getByRole("menuitem", { name: m.prreview_menu_action() }).click();

    expect(document.querySelector("[role='menu']")).toBeNull();
    await expect.element(page.getByRole("dialog", { name: m.prreview_title() })).toBeVisible();
    await expect
      .element(page.getByRole("combobox", { name: m.roles_reviewer_label() }))
      .toBeVisible();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("/api/sessions/s1/git/reviewers");
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

  it("merges only after confirming in the merge dialog", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(git({ state: "merged" }))));
    vi.stubGlobal("fetch", fetch);
    render(PrBadge, { props: { git: git(), sessionId: "s1" } });

    await page.getByRole("button", { name: m.prbadge_button_title({ label: "PR #12" }) }).click();
    await page.getByRole("menuitem", { name: m.prbadge_merge() }).click();

    // the menu item only opens the confirmation — no request yet
    expect(fetch).not.toHaveBeenCalled();
    await expect.element(page.getByRole("dialog")).toBeInTheDocument();
    await vi.waitFor(() => expect(confirmButton()).toBeEnabled());

    await confirmButton()!.click();
    expect(fetch).toHaveBeenCalledWith("/api/sessions/s1/git/merge", expect.any(Object));
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(document.querySelector("[role='dialog']")).toBeNull());
  });

  // ── #2299: a double-click must never answer the confirmation it opened ───────────────────
  //
  // The two reproducers from the issue, verbatim in intent: a green, otherwise-mergeable PR whose
  // repo roles put @scoop on the hook. Before the confirmation dialog these double-clicks each
  // issued a merge request.
  for (const handoff of ["reviewer", "merger"] as const) {
    it(`a double click issues no merge while waiting on scoop as ${handoff}`, async () => {
      const fetch = vi.fn(async () => new Response(JSON.stringify(git({ state: "merged" }))));
      vi.stubGlobal("fetch", fetch);
      render(PrBadge, {
        props: { git: git({ mergeGate: { handoff, handoffWho: "scoop" } }), sessionId: "s1" },
      });

      await page.getByRole("button", { name: m.prbadge_button_title({ label: "PR #12" }) }).click();
      await page.getByRole("menuitem", { name: m.prbadge_merge() }).dblClick();

      expect(fetch).not.toHaveBeenCalled();
      // …and the dialog that opened names who is responsible, in the escalated wording.
      await expect
        .element(page.getByText(m.mergeconfirm_confirm_takeover(), { exact: true }))
        .toBeInTheDocument();
    });
  }

  it("ignores the herd's handoff readout and merges on one confirmation", async () => {
    // `handoff` alone is the "waiting on" readout — inferred where no roles are configured. Only
    // a server-stamped mergeGate is a takeover; echoing the readout back came out as a 409.
    const fetch = vi.fn(async () => new Response(JSON.stringify(git({ state: "merged" }))));
    vi.stubGlobal("fetch", fetch);
    render(PrBadge, {
      props: {
        git: git({ handoff: "merger", handoffWho: "scoop" }),
        sessionId: "s1",
      },
    });

    await page.getByRole("button", { name: m.prbadge_button_title({ label: "PR #12" }) }).click();
    await page.getByRole("menuitem", { name: m.prbadge_merge() }).click();
    await vi.waitFor(() => expect(confirmButton()).toBeEnabled());
    expect(confirmButton()!.textContent?.trim()).toBe(String(m.mergeconfirm_confirm()));

    await confirmButton()!.click();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  });

  it("names the responsible person and sends the confirmation back with the merge", async () => {
    // Typed so the assertion below can read the request body off the recorded call.
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify(git({ state: "merged" }))),
    );
    vi.stubGlobal("fetch", fetch);
    render(PrBadge, {
      props: {
        git: git({
          mergeGate: { handoff: "merger", handoffWho: "scoop" },
          headSha: "abc123",
          baseRefName: "main",
        }),
        sessionId: "s1",
      },
    });

    await page.getByRole("button", { name: m.prbadge_button_title({ label: "PR #12" }) }).click();
    await page.getByRole("menuitem", { name: m.prbadge_merge() }).click();
    await expect
      .element(page.getByText(m.mergeconfirm_handoff_merger({ who: "scoop" })))
      .toBeInTheDocument();

    await vi.waitFor(() => expect(confirmButton()).toBeEnabled());
    await confirmButton()!.click();

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body ?? ""));
    expect(body.confirm).toEqual({
      headSha: "abc123",
      baseRefName: "main",
      handoff: "merger",
      handoffWho: "scoop",
      reviewBlockBy: null,
    });
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
    await vi.waitFor(() => expect(confirmButton()).toBeEnabled());
    await confirmButton()!.click();

    await vi.waitFor(() =>
      expect(info).toHaveBeenCalledWith(
        m.prbadge_merge_failed({ reason: "boom" }),
        expect.objectContaining({ alert: true, key: "pr-merge:s1" }),
      ),
    );
  });
  // ── merge-readiness marker (#1551) ──────────────────────────────────────────
  it("marks a green PR that is behind its base, and drops the Merge action", async () => {
    render(PrBadge, {
      props: { git: git({ mergeStateStatus: "behind", mergeable: true }), sessionId: "s1" },
    });

    await expect.element(page.getByLabelText(m.prbadge_behind_title())).toBeVisible();
    // The CI dot stays honest: the checks really did pass.
    expect(document.querySelector(".dot-success")).not.toBeNull();

    await page.getByRole("button", { name: m.prbadge_button_title({ label: "PR #12" }) }).click();
    expect(document.querySelector("[role='menu']")).not.toBeNull();
    expect(page.getByRole("menuitem", { name: m.prbadge_merge() }).elements()).toHaveLength(0);
  });

  it("marks a conflicting PR", async () => {
    render(PrBadge, { props: { git: git({ mergeStateStatus: "dirty" }), sessionId: "s1" } });

    await expect.element(page.getByLabelText(m.prbadge_conflict_title())).toBeVisible();
  });

  it("leaves branch-protection blocked and clean PRs unmarked", async () => {
    render(PrBadge, {
      props: { git: git({ mergeStateStatus: "blocked", mergeable: true }), sessionId: "s1" },
    });
    expect(document.querySelector(".stale-marker")).toBeNull();

    document.body.innerHTML = "";
    render(PrBadge, {
      props: { git: git({ mergeStateStatus: "clean", mergeable: true }), sessionId: "s2" },
    });
    expect(document.querySelector(".stale-marker")).toBeNull();
  });
});
