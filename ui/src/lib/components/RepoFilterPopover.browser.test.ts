import { describe, it, expect, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../app.css";
import { m } from "#lib/paraglide/messages.js";
import RepoFilterPopover from "./RepoFilterPopover.svelte";

const trigger = () => document.querySelector<HTMLButtonElement>(".repo-filter-trigger")!;
const panel = () => document.querySelector<HTMLElement>("[popover].filter-popover")!;
const box = (label: string) =>
  [...panel().querySelectorAll<HTMLLabelElement>(".filter-row")]
    .find((row) => row.textContent?.includes(label))!
    .querySelector<HTMLInputElement>("input[type=checkbox]")!;

function props(over: Partial<Record<string, unknown>> = {}) {
  return {
    hasIssues: false,
    hasPRs: false,
    ontoggleissues: () => {},
    ontoggleprs: () => {},
    ...over,
  };
}

describe("RepoFilterPopover", () => {
  it("opens from the icon trigger and closes on Escape, returning focus", async () => {
    render(RepoFilterPopover, props());
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().getAttribute("aria-controls")).toBe(panel().id);

    trigger().click();
    await expect.poll(() => panel().matches(":popover-open")).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    await expect.poll(() => document.activeElement).toBe(box(m.backlog_filter_has_issues()));

    // The Escape listener attaches one tick after opening.
    await new Promise((r) => setTimeout(r, 0));
    // Dispatched from inside the panel, as a real keystroke would be: marked handled so
    // the host dialog's Escape (a11yDialog skips defaultPrevented) doesn't also close it.
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    box(m.backlog_filter_has_issues()).dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    await expect.poll(() => trigger().getAttribute("aria-expanded")).toBe("false");
    await expect.poll(() => document.activeElement).toBe(trigger());
  });

  it("each checkbox toggles its filter", async () => {
    const ontoggleissues = vi.fn();
    const ontoggleprs = vi.fn();
    render(RepoFilterPopover, props({ ontoggleissues, ontoggleprs }));
    trigger().click();

    box(m.backlog_filter_has_prs()).click();
    expect(ontoggleprs).toHaveBeenCalledOnce();
    expect(ontoggleissues).not.toHaveBeenCalled();
    box(m.backlog_filter_has_issues()).click();
    expect(ontoggleissues).toHaveBeenCalledOnce();
  });

  it("shows the active-filter count as a badge and in the accessible name", () => {
    render(RepoFilterPopover, props({ hasIssues: true, hasPRs: true }));
    expect(trigger().querySelector(".badge")?.textContent?.trim()).toBe("2");
    expect(trigger().getAttribute("aria-label")).toBe(m.backlog_repo_filter_aria({ count: 2 }));
    expect(trigger().classList.contains("active")).toBe(true);
    expect(box(m.backlog_filter_has_issues()).checked).toBe(true);
  });

  it("no badge when no filter is active", () => {
    render(RepoFilterPopover, props());
    expect(trigger().querySelector(".badge")).toBeNull();
    expect(trigger().classList.contains("active")).toBe(false);
  });
});
