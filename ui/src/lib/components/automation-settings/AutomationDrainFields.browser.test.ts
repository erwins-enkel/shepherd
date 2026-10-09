import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import AutomationDrainFields from "./AutomationDrainFields.svelte";
import { automationFocus } from "#lib/automation-focus.js";
import { m } from "#lib/paraglide/messages.js";

const cap = () => page.getByRole("spinbutton", { name: m.drain_cap_label() });

afterEach(() => {
  vi.restoreAllMocks();
  automationFocus.take("max-auto");
});

// The epic detail's "Allow N slots" (#2939) opens the Automation tab at the agent-slot cap.
describe("AutomationDrainFields — focus request", () => {
  it("focuses the cap when the tab mounts on a fresh request", async () => {
    automationFocus.request("max-auto");
    render(AutomationDrainFields, { repoPath: "/repo", active: true, epicActive: true });

    await expect.element(cap()).toHaveFocus();
    // One-shot: the request is spent.
    expect(automationFocus.take("max-auto")).toBe(false);
  });

  it("leaves focus alone without a request", async () => {
    render(AutomationDrainFields, { repoPath: "/repo", active: true, epicActive: true });

    await expect.element(cap()).toBeVisible();
    await expect.element(cap()).not.toHaveFocus();
  });

  it("ignores a request that lapsed", async () => {
    const t0 = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(t0);
    automationFocus.request("max-auto");
    vi.spyOn(Date, "now").mockReturnValue(t0 + 5_000);
    render(AutomationDrainFields, { repoPath: "/repo", active: true, epicActive: true });

    await expect.element(cap()).toBeVisible();
    await expect.element(cap()).not.toHaveFocus();
  });
});
