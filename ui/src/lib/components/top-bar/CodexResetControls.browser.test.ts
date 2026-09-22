import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import CodexResetControls from "./CodexResetControls.svelte";
import { m } from "$lib/paraglide/messages";
import type { CodexResetStatus } from "$lib/types";
import { redeemCodexReset, setCodexResetAutomation } from "$lib/api";
vi.mock("$lib/api", () => ({ redeemCodexReset: vi.fn(), setCodexResetAutomation: vi.fn() }));
const status = (over: Partial<CodexResetStatus> = {}): CodexResetStatus => ({
  autoEnabled: false,
  state: "ready",
  checkedAt: Date.now(),
  availableCount: 3,
  nextExpiryAt: Date.now() + 1_800_000,
  reason: null,
  lastOutcome: null,
  waitingCount: 0,
  ...over,
});
beforeEach(() => vi.resetAllMocks());
it("unknown reset availability is not shown as zero and cannot be redeemed", async () => {
  render(CodexResetControls, { status: status({ availableCount: null }) });
  await expect.element(page.getByText(m.topbar_codex_reset_unknown())).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: m.topbar_codex_reset_redeem() }))
    .toBeDisabled();
});
it.each(["redeeming", "verifying", "account_changed", "unavailable"] as const)(
  "%s prevents additional manual spending",
  async (state) => {
    render(CodexResetControls, { status: status({ state }) });
    await expect
      .element(page.getByRole("button", { name: m.topbar_codex_reset_redeem() }))
      .toBeDisabled();
  },
);
it("a failed request retries the same UUID and pending verification disables repeated clicks", async () => {
  vi.mocked(redeemCodexReset)
    .mockRejectedValueOnce(new Error("lost response"))
    .mockResolvedValueOnce(status({ state: "verifying" }));
  render(CodexResetControls, { status: status() });
  const button = page.getByRole("button", { name: m.topbar_codex_reset_redeem() });
  await button.click();
  await expect.element(page.getByRole("alert")).toBeVisible();
  await button.click();
  await expect.element(button).toBeDisabled();
  expect(vi.mocked(redeemCodexReset).mock.calls[1][0]).toBe(
    vi.mocked(redeemCodexReset).mock.calls[0][0],
  );
});
it("automation opt-in changes only the switch without a manual redemption", async () => {
  vi.mocked(setCodexResetAutomation).mockResolvedValue(status({ autoEnabled: true }));
  render(CodexResetControls, { status: status() });
  const checkbox = page.getByRole("checkbox", { name: m.topbar_codex_reset_auto() });
  await checkbox.click();
  await expect.element(checkbox).toBeChecked();
  expect(setCodexResetAutomation).toHaveBeenCalledWith(true);
  expect(redeemCodexReset).not.toHaveBeenCalled();
});
it("a completed asynchronous reset uses a new UUID for the next deliberate click", async () => {
  vi.mocked(redeemCodexReset).mockResolvedValue(status({ state: "verifying" }));
  const view = await render(CodexResetControls, { status: status() });
  const button = page.getByRole("button", { name: m.topbar_codex_reset_redeem() });
  await button.click();
  await expect.element(button).toBeDisabled();
  await view.rerender({ status: status({ availableCount: 2 }) });
  await expect.element(button).toBeEnabled();
  await button.click();
  expect(vi.mocked(redeemCodexReset).mock.calls[1][0]).not.toBe(
    vi.mocked(redeemCodexReset).mock.calls[0][0],
  );
});
