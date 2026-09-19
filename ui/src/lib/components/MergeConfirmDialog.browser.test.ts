import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import { userEvent } from "vitest/browser";
import "../../app.css";
import MergeConfirmDialog from "./MergeConfirmDialog.svelte";
import { CONFIRM_ARM_MS, type MergeConfirmContext } from "./merge-confirm";
import { m } from "$lib/paraglide/messages";

function ctx(over: Partial<MergeConfirmContext> = {}): MergeConfirmContext {
  return {
    repoLabel: "shepherd",
    number: 123,
    title: "fix: guard manual merges",
    baseBranch: "main",
    mergeMethod: "squash",
    headSha: "abc123",
    handoff: null,
    handoffWho: null,
    reviewBlockBy: null,
    ...over,
  };
}

/** The dialog's confirm control, under whichever of the two wordings is showing. */
function confirmEl(): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>("[role='dialog'] button.run");
  expect(el, "confirm button present").not.toBeNull();
  return el!;
}

const armed = () => vi.waitFor(() => expect(confirmEl().disabled).toBe(false));

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("MergeConfirmDialog", () => {
  it("states the repository, PR, real target branch, method and branch deletion", async () => {
    render(MergeConfirmDialog, { props: { ctx: ctx(), onclose: vi.fn(), onconfirm: vi.fn() } });

    await expect.element(page.getByText("shepherd", { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByText("#123 fix: guard manual merges", { exact: true }))
      .toBeInTheDocument();
    await expect.element(page.getByText("main", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("squash", { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByText(m.mergeconfirm_value_branch_deleted(), { exact: true }))
      .toBeInTheDocument();
  });

  it("uses the neutral wording and says nothing about responsibility when it is the operator's turn", async () => {
    render(MergeConfirmDialog, { props: { ctx: ctx(), onclose: vi.fn(), onconfirm: vi.fn() } });
    await expect.element(page.getByRole("note")).not.toBeInTheDocument();
    expect(confirmEl().textContent?.trim()).toBe(m.mergeconfirm_confirm());
  });

  it("names the responsible person and escalates the wording on a takeover", async () => {
    render(MergeConfirmDialog, {
      props: {
        ctx: ctx({ handoff: "merger", handoffWho: "scoop" }),
        onclose: vi.fn(),
        onconfirm: vi.fn(),
      },
    });

    await expect
      .element(page.getByText(m.mergeconfirm_handoff_merger({ who: "scoop" })))
      .toBeInTheDocument();
    expect(confirmEl().textContent?.trim()).toBe(m.mergeconfirm_confirm_takeover());
  });

  it("states an outstanding review block on its own line, alongside the handoff", async () => {
    render(MergeConfirmDialog, {
      props: {
        ctx: ctx({ handoff: "reviewer", handoffWho: "scoop", reviewBlockBy: "scoop" }),
        onclose: vi.fn(),
        onconfirm: vi.fn(),
      },
    });

    await expect
      .element(page.getByText(m.mergeconfirm_handoff_reviewer({ who: "scoop" })))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(m.mergeconfirm_review_block({ who: "scoop" })))
      .toBeInTheDocument();
  });

  // ── the double-click / held-Enter guard (#2299) ───────────────────────────────────────────
  it("ignores a confirm click that lands within the arm delay", async () => {
    const onconfirm = vi.fn();
    render(MergeConfirmDialog, { props: { ctx: ctx(), onclose: vi.fn(), onconfirm } });

    expect(confirmEl().disabled).toBe(true);
    confirmEl().click(); // a click that raced the disabled flag
    expect(onconfirm).not.toHaveBeenCalled();
  });

  it("fires exactly once for one deliberate confirmation", async () => {
    const onconfirm = vi.fn();
    render(MergeConfirmDialog, { props: { ctx: ctx(), onclose: vi.fn(), onconfirm } });

    await armed();
    await confirmEl().click();
    expect(onconfirm).toHaveBeenCalledTimes(1);
  });

  it("starts focused on Cancel, so a held Enter cancels instead of merging", async () => {
    const onclose = vi.fn();
    const onconfirm = vi.fn();
    render(MergeConfirmDialog, { props: { ctx: ctx(), onclose, onconfirm } });

    await vi.waitFor(() =>
      expect(document.activeElement?.textContent?.trim()).toBe(m.common_cancel()),
    );
    await userEvent.keyboard("{Enter}{Enter}{Enter}");
    expect(onconfirm).not.toHaveBeenCalled();
    expect(onclose).toHaveBeenCalled();
  });

  it("closes on Escape without merging", async () => {
    const onclose = vi.fn();
    const onconfirm = vi.fn();
    render(MergeConfirmDialog, { props: { ctx: ctx(), onclose, onconfirm } });

    await armed();
    await userEvent.keyboard("{Escape}");
    expect(onclose).toHaveBeenCalled();
    expect(onconfirm).not.toHaveBeenCalled();
  });

  it("locks both controls while the merge is in flight", async () => {
    const onconfirm = vi.fn();
    const onclose = vi.fn();
    render(MergeConfirmDialog, {
      props: { ctx: ctx(), busy: true, onclose, onconfirm },
    });

    // The busy lock does not expire — no arm delay can unlock it.
    await new Promise((r) => setTimeout(r, CONFIRM_ARM_MS + 50));
    expect(confirmEl().disabled).toBe(true);
    confirmEl().click();
    expect(onconfirm).not.toHaveBeenCalled();
  });

  it("re-arms when the dialog re-states itself after a refusal", async () => {
    const onconfirm = vi.fn();
    const { rerender } = await render(MergeConfirmDialog, {
      props: { ctx: ctx(), onclose: vi.fn(), onconfirm },
    });
    await armed();

    // A stale refusal hands back a fresh verdict — the new answer must be deliberate too.
    await rerender({
      ctx: ctx({ handoff: "merger", handoffWho: "scoop" }),
      error: m.mergeconfirm_stale(),
      onclose: vi.fn(),
      onconfirm,
    });

    await expect.element(page.getByText(m.mergeconfirm_stale())).toBeInTheDocument();
    expect(confirmEl().disabled).toBe(true);
    confirmEl().click();
    expect(onconfirm).not.toHaveBeenCalled();

    await armed();
    await confirmEl().click();
    expect(onconfirm).toHaveBeenCalledTimes(1);
  });
});
