import { describe, it, expect, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import DiagnoseRows from "./DiagnoseRows.svelte";
import { m } from "$lib/paraglide/messages";
import type { DiagnosticCheck } from "$lib/types";

const check = (over: Partial<DiagnosticCheck> = {}): DiagnosticCheck => ({
  id: "git",
  state: "error",
  hintKey: "diagnostics_hint_gh_missing",
  ...over,
});

describe("DiagnoseRows fix button gating", () => {
  it("shows Fix only on a non-ok check WITH remediation", async () => {
    render(DiagnoseRows, {
      props: {
        onfix: vi.fn(),
        checks: [
          check({ id: "git", state: "error", remediation: "sudo apt-get install -y git" }),
          // non-ok but guidance-only (no remediation) → no button
          check({ id: "tailscale", state: "warning", remediation: undefined }),
          // ok rows never get a button
          check({ id: "bun", state: "ok", remediation: "ignored" }),
        ],
      },
    });

    const buttons = document.querySelectorAll<HTMLButtonElement>("button.fix");
    expect(buttons.length).toBe(1);
    expect(buttons[0].textContent?.trim()).toBe(m.diagnostics_fix());
  });

  it("renders NO Fix button when onfix is not provided", () => {
    render(DiagnoseRows, {
      props: {
        checks: [check({ state: "error", remediation: "sudo apt-get install -y git" })],
      },
    });
    expect(document.querySelector("button.fix")).toBeNull();
  });

  it("clicking Fix opens the confirm modal with the exact command", async () => {
    render(DiagnoseRows, {
      props: {
        onfix: vi.fn(),
        checks: [check({ state: "error", remediation: "sudo apt-get install -y git" })],
      },
    });

    await page.getByRole("button", { name: m.diagnostics_fix() }).click();

    const dlg = document.querySelector('[role="dialog"][aria-modal="true"]');
    expect(dlg).not.toBeNull();
    expect(dlg?.querySelector("code.cmd")?.textContent).toBe("sudo apt-get install -y git");
  });

  it("confirming Run calls onfix with the check id and shows busy", async () => {
    // onfix never resolves → row stays busy so we can assert the busy label
    let resolve!: () => void;
    const onfix = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(DiagnoseRows, {
      props: {
        onfix,
        checks: [check({ id: "git", state: "error", remediation: "sudo apt-get install -y git" })],
      },
    });

    await page.getByRole("button", { name: m.diagnostics_fix() }).click();
    await page.getByRole("button", { name: m.diagnostics_fix_confirm_run() }).click();

    expect(onfix).toHaveBeenCalledTimes(1);
    expect(onfix).toHaveBeenCalledWith("git");
    // modal closed, row now busy
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await expect
      .element(page.getByRole("button", { name: m.diagnostics_fix_running() }))
      .toBeInTheDocument();
    resolve();
  });

  it("leaves busy state (and shows no success) when onfix rejects", async () => {
    const onfix = vi.fn(() => Promise.reject(new Error("fix failed")));
    render(DiagnoseRows, {
      props: {
        onfix,
        checks: [check({ id: "git", state: "error", remediation: "sudo apt-get install -y git" })],
      },
    });

    await page.getByRole("button", { name: m.diagnostics_fix() }).click();
    await page.getByRole("button", { name: m.diagnostics_fix_confirm_run() }).click();

    // settles back to the idle Fix label (not stuck on Running), no success state
    await expect
      .element(page.getByRole("button", { name: m.diagnostics_fix() }))
      .toBeInTheDocument();
  });

  it("renders a doc-link on a non-ok guidance-only row with a known hintKey", () => {
    render(DiagnoseRows, {
      props: {
        onfix: vi.fn(),
        checks: [
          // non-ok, NO remediation, known hintKey → doc-link, no Fix button
          check({ id: "gh", state: "error", hintKey: "diagnostics_hint_gh_missing" }),
        ],
      },
    });

    const link = document.querySelector<HTMLAnchorElement>("a.doc-link");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("https://github.com/cli/cli#installation");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.textContent).toContain(m.diagnostics_doc_link());
    // mutually exclusive with the Fix button
    expect(document.querySelector("button.fix")).toBeNull();
  });

  it("renders the Fix button and NO doc-link on a fixable check (mutual exclusivity)", () => {
    render(DiagnoseRows, {
      props: {
        onfix: vi.fn(),
        checks: [
          check({
            id: "gh",
            state: "error",
            hintKey: "diagnostics_hint_gh_missing",
            remediation: "gh auth login",
          }),
        ],
      },
    });

    expect(document.querySelector("button.fix")).not.toBeNull();
    expect(document.querySelector("a.doc-link")).toBeNull();
  });

  it("renders neither Fix button nor doc-link on an ok check", () => {
    render(DiagnoseRows, {
      props: {
        onfix: vi.fn(),
        checks: [check({ id: "gh", state: "ok", hintKey: "diagnostics_hint_gh_missing" })],
      },
    });

    expect(document.querySelector("button.fix")).toBeNull();
    expect(document.querySelector("a.doc-link")).toBeNull();
  });

  it("Esc cancels the confirm modal without calling onfix", async () => {
    const onfix = vi.fn();
    render(DiagnoseRows, {
      props: {
        onfix,
        checks: [check({ state: "error", remediation: "sudo apt-get install -y git" })],
      },
    });

    await page.getByRole("button", { name: m.diagnostics_fix() }).click();
    const dlg = document.querySelector('[role="dialog"]');
    expect(dlg).not.toBeNull();

    dlg!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await expect.element(page.getByRole("button", { name: m.diagnostics_fix() })).toBeVisible();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(onfix).not.toHaveBeenCalled();
  });
});
