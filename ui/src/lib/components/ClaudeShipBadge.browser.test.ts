import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { GitState } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";

const { default: ClaudeShipBadge } = await import("./ClaudeShipBadge.svelte");

const git = (o: Partial<GitState> = {}): GitState => ({
  kind: "github",
  state: "open",
  number: 9,
  checks: "success",
  deployConfigured: false,
  ...o,
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ClaudeShipBadge (#4145)", () => {
  it("renders nothing without a Claude Ship signal or on a closed PR", () => {
    render(ClaudeShipBadge, { git: git() });
    expect(document.querySelector(".cs-badge")).toBeNull();
    render(ClaudeShipBadge, {
      git: git({ state: "merged", claudeShip: { stewardWatching: true } }),
    });
    expect(document.querySelector(".cs-badge")).toBeNull();
  });

  it("shows Claude Ship and explains Steward + Code Review", async () => {
    render(ClaudeShipBadge, {
      git: git({ claudeShip: { stewardWatching: true, codeReview: "success" } }),
    });
    const badge = page.getByRole("img", { name: m.claude_ship_badge() });
    await expect.element(badge).toHaveTextContent(m.claude_ship_badge());
    expect(badge.element().classList.contains("waiting")).toBe(false);
    const desc = badge.element().getAttribute("aria-description") ?? "";
    expect(desc).toContain(m.tooltip_claude_ship_steward_watching());
    expect(desc).toContain(m.tooltip_claude_ship_review_passed());
    expect(desc).toContain(m.tooltip_claude_ship_shepherd_body());
    expect(desc).not.toContain(m.tooltip_claude_ship_deferring());
  });

  it("reads 'awaiting approval' in amber while Claude Approvals waits", async () => {
    render(ClaudeShipBadge, {
      git: git({ claudeShip: { stewardWatching: false, approvals: "failure" } }),
      variant: "rail",
    });
    const badge = page.getByRole("img", { name: m.claude_ship_badge_waiting() });
    await expect.element(badge).toBeVisible();
    expect(badge.element().classList.contains("cs-chip")).toBe(true);
    expect(badge.element().classList.contains("waiting")).toBe(true);
    const desc = badge.element().getAttribute("aria-description") ?? "";
    expect(desc).toContain(m.tooltip_claude_ship_approvals_waiting());
    expect(desc).toContain(m.tooltip_claude_ship_steward_idle());
  });

  it("reads 'Steward fixes' and explains the paused steers while deferring (#4146)", async () => {
    render(ClaudeShipBadge, {
      git: git({ claudeShip: { stewardWatching: true } }),
      deferring: true,
    });
    const badge = page.getByRole("img", { name: m.claude_ship_badge_deferring() });
    await expect.element(badge).toHaveTextContent(m.claude_ship_badge_deferring());
    expect(badge.element().classList.contains("waiting")).toBe(false);
    const desc = badge.element().getAttribute("aria-description") ?? "";
    expect(desc).toContain(m.tooltip_claude_ship_deferring());
    expect(desc).toContain(m.tooltip_claude_ship_deferring_body());
    expect(desc).toContain(m.tooltip_claude_ship_shepherd_body());
  });

  it("keeps 'awaiting approval' ahead of deferring", async () => {
    render(ClaudeShipBadge, {
      git: git({ claudeShip: { stewardWatching: true, approvals: "pending" } }),
      deferring: true,
    });
    const badge = page.getByRole("img", { name: m.claude_ship_badge_waiting() });
    await expect.element(badge).toBeVisible();
    expect(badge.element().classList.contains("waiting")).toBe(true);
    const desc = badge.element().getAttribute("aria-description") ?? "";
    expect(desc).toContain(m.tooltip_claude_ship_deferring());
  });
});
