import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../app.css";
import type { GhGrant } from "#lib/types.js";

const revokeGhGrant = vi.fn().mockResolvedValue(undefined);
vi.mock("#lib/api.js", async (orig) => ({
  ...(await orig<typeof import("#lib/api.js")>()),
  revokeGhGrant: (...a: unknown[]) => revokeGhGrant(...a),
}));

const { ApiError } = await import("#lib/api.js");
const { default: GhGrantBadge } = await import("./GhGrantBadge.svelte");

const GRANT: GhGrant = { permission: "workflows", grantedAt: Date.now(), grantedBy: "operator" };

afterEach(() => {
  document.body.innerHTML = "";
  revokeGhGrant.mockReset().mockResolvedValue(undefined);
});

describe("GhGrantBadge (#4119)", () => {
  it("renders nothing without grants", async () => {
    render(GhGrantBadge, { session: { id: "s1", ghGrants: [] } });
    expect(document.querySelector(".gh-grant-chip")).toBeNull();
    render(GhGrantBadge, { session: { id: "s1" } });
    expect(document.querySelector(".gh-grant-chip")).toBeNull();
  });

  it("shows a workflows chip whose description explains the grant", async () => {
    render(GhGrantBadge, { session: { id: "s1", ghGrants: [GRANT] } });
    const chip = page.getByRole("button", { name: /GitHub workflows permission granted/ });
    await expect.element(chip).toHaveTextContent("workflows");
    const desc = chip.element().getAttribute("aria-description") ?? "";
    expect(desc).toContain("What it allows");
    expect(desc).toContain(".github/workflows/*");
    expect(desc).toContain("Revoke");
  });

  it("Revoke (keyboard) calls the API and closes the popover", async () => {
    render(GhGrantBadge, { session: { id: "s1", ghGrants: [GRANT] } });
    const chip = page.getByRole("button", { name: /GitHub workflows permission granted/ });
    (chip.element() as HTMLButtonElement).focus();
    await userEvent.keyboard("{Enter}");
    const revoke = page.getByRole("button", { name: "Revoke workflows permission" });
    await expect.element(revoke).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(revokeGhGrant).toHaveBeenCalledWith("s1", "workflows");
    await expect.poll(() => document.querySelector(".ggb-pop")).toBeNull();
  });

  it("a failed revoke shows the error and keeps the popover", async () => {
    revokeGhGrant.mockRejectedValueOnce(
      new ApiError(502, "GitHub unreachable", "mint-failed", true),
    );
    render(GhGrantBadge, { session: { id: "s1", ghGrants: [GRANT] } });
    (
      page
        .getByRole("button", { name: /GitHub workflows permission granted/ })
        .element() as HTMLElement
    ).click();
    await page.getByRole("button", { name: "Revoke workflows permission" }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("GitHub unreachable");
    await expect
      .element(page.getByRole("button", { name: "Revoke workflows permission" }))
      .toBeVisible();
  });

  it("Escape closes the popover", async () => {
    render(GhGrantBadge, { session: { id: "s1", ghGrants: [GRANT] } });
    (
      page
        .getByRole("button", { name: /GitHub workflows permission granted/ })
        .element() as HTMLElement
    ).click();
    await expect
      .element(page.getByRole("button", { name: "Revoke workflows permission" }))
      .toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => document.querySelector(".ggb-pop")).toBeNull();
  });
});
