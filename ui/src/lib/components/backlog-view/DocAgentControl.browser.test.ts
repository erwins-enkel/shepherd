import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../../app.css";
import { m } from "$lib/paraglide/messages";
import type { DocAgentRun } from "$lib/types";

const { default: DocAgentControl } = await import("./DocAgentControl.svelte");

afterEach(() => {
  document.body.innerHTML = "";
});

// Helpers
const triggerBtn = () =>
  [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(m.docagent_button_label()),
  ) as HTMLButtonElement | null;

const badgeBtn = () =>
  document.querySelector("button[aria-haspopup='dialog']") as HTMLButtonElement | null;

const isPopoverOpen = () => badgeBtn()?.getAttribute("aria-expanded") === "true";

const popoverEl = () => document.querySelector("[popover].da-popover") as HTMLElement | null;

const defaultProps = {
  act: true,
  running: false,
  runs: [] as DocAgentRun[],
  disabled: false,
  coach: false,
  ontrigger: () => {},
};

describe("DocAgentControl", () => {
  it("renders the trigger button", async () => {
    render(DocAgentControl, { ...defaultProps });
    await expect.poll(() => triggerBtn()).toBeTruthy();
    expect(triggerBtn()!.textContent).toContain(m.docagent_button_label());
  });

  it("fires ontrigger when trigger button is clicked", async () => {
    let fired = false;
    render(DocAgentControl, {
      ...defaultProps,
      ontrigger: () => {
        fired = true;
      },
    });
    await expect.poll(() => triggerBtn()).toBeTruthy();
    triggerBtn()!.click();
    await expect.poll(() => fired).toBe(true);
  });

  it("trigger is disabled when disabled=true", async () => {
    render(DocAgentControl, { ...defaultProps, disabled: true });
    await expect.poll(() => triggerBtn()).toBeTruthy();
    expect(triggerBtn()!.disabled).toBe(true);
  });

  it("trigger is disabled when running=true", async () => {
    render(DocAgentControl, { ...defaultProps, running: true });
    await expect.poll(() => triggerBtn()).toBeTruthy();
    expect(triggerBtn()!.disabled).toBe(true);
  });

  it("badge is absent when running=false and runs is empty", async () => {
    render(DocAgentControl, { ...defaultProps });
    await expect.poll(() => triggerBtn()).toBeTruthy();
    expect(badgeBtn()).toBeNull();
  });

  it("badge appears with 'running' label when running=true", async () => {
    render(DocAgentControl, { ...defaultProps, running: true });
    await expect.poll(() => badgeBtn()).toBeTruthy();
    expect(badgeBtn()!.textContent?.trim()).toBe(m.docagent_status_running());
  });

  it("badge shows 'PR opened' label for a pr outcome run", async () => {
    const runs: DocAgentRun[] = [
      {
        at: Date.now() - 60000,
        url: "https://github.com/foo/bar/pull/42",
        outcome: "pr",
      },
    ];
    render(DocAgentControl, { ...defaultProps, runs });
    await expect.poll(() => badgeBtn()).toBeTruthy();
    expect(badgeBtn()!.textContent?.trim()).toBe(m.docagent_status_pr());
  });

  it("badge shows 'observe' label for an observe outcome run", async () => {
    const runs: DocAgentRun[] = [{ at: Date.now() - 60000, url: null, outcome: "observe" }];
    render(DocAgentControl, { ...defaultProps, runs });
    await expect.poll(() => badgeBtn()).toBeTruthy();
    expect(badgeBtn()!.textContent?.trim()).toBe(m.docagent_status_observe());
  });

  it("badge shows 'no changes' label for a nochange outcome run", async () => {
    const runs: DocAgentRun[] = [{ at: Date.now() - 60000, url: null, outcome: "nochange" }];
    render(DocAgentControl, { ...defaultProps, runs });
    await expect.poll(() => badgeBtn()).toBeTruthy();
    expect(badgeBtn()!.textContent?.trim()).toBe(m.docagent_status_nochange());
  });

  it("badge shows 'format failed' label and error class for an error outcome run", async () => {
    const runs: DocAgentRun[] = [{ at: Date.now() - 60000, url: null, outcome: "error" }];
    render(DocAgentControl, { ...defaultProps, runs });
    await expect.poll(() => badgeBtn()).toBeTruthy();
    expect(badgeBtn()!.textContent?.trim()).toBe(m.docagent_status_error());
    expect(badgeBtn()!.classList.contains("error")).toBe(true);
  });

  it("clicking badge opens history popover", async () => {
    const runs: DocAgentRun[] = [
      {
        at: Date.now() - 60000,
        url: "https://github.com/foo/bar/pull/42",
        outcome: "pr",
      },
    ];
    render(DocAgentControl, { ...defaultProps, runs });
    await expect.poll(() => badgeBtn()).toBeTruthy();
    expect(isPopoverOpen()).toBe(false);
    badgeBtn()!.click();
    await expect.poll(() => isPopoverOpen()).toBe(true);
  });

  it("popover shows PR link for a pr outcome run with url", async () => {
    const runs: DocAgentRun[] = [
      {
        at: Date.now() - 60000,
        url: "https://github.com/foo/bar/pull/42",
        outcome: "pr",
      },
    ];
    render(DocAgentControl, { ...defaultProps, runs });
    await expect.poll(() => badgeBtn()).toBeTruthy();
    badgeBtn()!.click();
    await expect.poll(() => isPopoverOpen()).toBe(true);
    const link = popoverEl()?.querySelector("a.run-link") as HTMLAnchorElement | null;
    expect(link).toBeTruthy();
    expect(link!.textContent?.trim()).toBe("#42");
    expect(link!.href).toContain("/pull/42");
  });

  it("popover shows heading and empty state when no runs", async () => {
    // Open with running=true so badge exists; runs is empty
    render(DocAgentControl, { ...defaultProps, running: true });
    await expect.poll(() => badgeBtn()).toBeTruthy();
    badgeBtn()!.click();
    await expect.poll(() => isPopoverOpen()).toBe(true);
    expect(popoverEl()?.textContent).toContain(m.docagent_history_heading());
    expect(popoverEl()?.textContent).toContain(m.docagent_history_empty());
  });

  it("Esc closes the popover", async () => {
    const runs: DocAgentRun[] = [{ at: Date.now() - 60000, url: null, outcome: "observe" }];
    render(DocAgentControl, { ...defaultProps, runs });
    await expect.poll(() => badgeBtn()).toBeTruthy();
    badgeBtn()!.click();
    await expect.poll(() => isPopoverOpen()).toBe(true);
    // Wait for dismiss listener to register (setTimeout(0) in effect)
    await new Promise((r) => setTimeout(r, 50));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await expect.poll(() => isPopoverOpen()).toBe(false);
  });

  it("outside pointerdown closes the popover", async () => {
    const runs: DocAgentRun[] = [{ at: Date.now() - 60000, url: null, outcome: "nochange" }];
    render(DocAgentControl, { ...defaultProps, runs });
    await expect.poll(() => badgeBtn()).toBeTruthy();
    badgeBtn()!.click();
    await expect.poll(() => isPopoverOpen()).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await expect.poll(() => isPopoverOpen()).toBe(false);
  });

  it("observe note shown when act=false and popover open", async () => {
    const runs: DocAgentRun[] = [{ at: Date.now() - 60000, url: null, outcome: "observe" }];
    render(DocAgentControl, { ...defaultProps, act: false, runs });
    await expect.poll(() => badgeBtn()).toBeTruthy();
    badgeBtn()!.click();
    await expect.poll(() => isPopoverOpen()).toBe(true);
    expect(popoverEl()?.textContent).toContain(m.docagent_observe_note());
  });

  it("observe note NOT shown when act=true", async () => {
    const runs: DocAgentRun[] = [{ at: Date.now() - 60000, url: null, outcome: "pr" }];
    render(DocAgentControl, { ...defaultProps, act: true, runs });
    await expect.poll(() => badgeBtn()).toBeTruthy();
    badgeBtn()!.click();
    await expect.poll(() => isPopoverOpen()).toBe(true);
    expect(popoverEl()?.textContent).not.toContain(m.docagent_observe_note());
  });
});
