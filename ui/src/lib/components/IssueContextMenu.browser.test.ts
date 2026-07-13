import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { Issue, Steer } from "$lib/types";
import { m } from "$lib/paraglide/messages";
import IssueContextMenu from "./IssueContextMenu.svelte";
import IssueDetailsPopover from "./IssueDetailsPopover.svelte";

// A real, connected opener: the menu/popover measure their rect for positioning and
// restore focus to it on close.
let opener: HTMLButtonElement;
beforeEach(() => {
  opener = document.createElement("button");
  opener.textContent = "opener";
  document.body.appendChild(opener);
});
afterEach(() => {
  opener.remove();
  document.body.innerHTML = "";
});

function steer(id: string, label: string): Steer {
  return { id, label, text: `run ${label}`, inSteerBar: false, onIssues: true };
}

function issue(n: number): Issue {
  return {
    number: n,
    title: `Issue ${n}`,
    body: "The full issue body text.",
    url: `https://example.com/issues/${n}`,
    labels: ["bug", "p2"],
    createdAt: 0,
    assignees: [],
    author: "alice",
  };
}

const menuBase = (extra: Record<string, unknown> = {}) => ({
  x: 10,
  y: 10,
  number: 42,
  steers: [] as Steer[],
  canSteer: true,
  opener,
  onopenissue: vi.fn(),
  ondetails: vi.fn(),
  onsteer: vi.fn(),
  onclose: vi.fn(),
  ...extra,
});

describe("IssueContextMenu", () => {
  it("always renders Open issue + Show details, and fires their callbacks", async () => {
    const onopenissue = vi.fn();
    const ondetails = vi.fn();
    render(IssueContextMenu, { props: menuBase({ onopenissue, ondetails }) });

    await page.getByRole("menuitem", { name: m.issuemenu_open() }).click();
    expect(onopenissue).toHaveBeenCalledTimes(1);

    await page.getByRole("menuitem", { name: m.issuemenu_details() }).click();
    expect(ondetails).toHaveBeenCalledTimes(1);
  });

  it("renders one item per steer (canSteer) and fires onsteer with that steer", async () => {
    const onsteer = vi.fn();
    const s = steer("s1", "Fix");
    render(IssueContextMenu, { props: menuBase({ steers: [s], canSteer: true, onsteer }) });

    await page.getByRole("menuitem", { name: m.issuemenu_inject_aria({ label: "Fix" }) }).click();
    expect(onsteer).toHaveBeenCalledExactlyOnceWith(s);
  });

  it("hides steer items when canSteer is false (epic-parent rows)", async () => {
    render(IssueContextMenu, {
      props: menuBase({ steers: [steer("s1", "Fix")], canSteer: false }),
    });
    // Open + Details still there, but no steer item.
    expect(page.getByRole("menuitem", { name: m.issuemenu_open() }).query()).not.toBeNull();
    expect(
      page.getByRole("menuitem", { name: m.issuemenu_inject_aria({ label: "Fix" }) }).query(),
    ).toBeNull();
  });

  it("Escape closes it AND preventDefaults, so a11yDialog (checks defaultPrevented) won't also close", async () => {
    const onclose = vi.fn();
    render(IssueContextMenu, { props: menuBase({ onclose }) });

    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    window.dispatchEvent(ev);

    expect(onclose).toHaveBeenCalledTimes(1);
    // preventDefault ran: a11yDialog's Escape handler returns early on defaultPrevented,
    // so the host New Task dialog / backlog overlay does NOT close.
    expect(ev.defaultPrevented).toBe(true);
  });
});

const popBase = (extra: Record<string, unknown> = {}) => ({
  x: 10,
  y: 10,
  issue: issue(42),
  opener,
  onclose: vi.fn(),
  ...extra,
});

describe("IssueDetailsPopover", () => {
  it("renders number, author, title, labels and body", async () => {
    render(IssueDetailsPopover, { props: popBase() });
    const pop = document.querySelector(".issue-details")!;
    expect(pop.textContent).toContain("#42");
    expect(pop.textContent).toContain("Issue 42");
    expect(pop.textContent).toContain("The full issue body text.");
    expect(pop.querySelectorAll(".id-chip").length).toBe(2);
  });

  it("shows a no-description note when the body is empty", async () => {
    render(IssueDetailsPopover, { props: popBase({ issue: { ...issue(7), body: "" } }) });
    expect(document.querySelector(".issue-details")!.textContent).toContain(
      m.issuedetails_no_body(),
    );
  });

  it("Escape closes it AND preventDefaults (a11yDialog-safe)", async () => {
    const onclose = vi.fn();
    render(IssueDetailsPopover, { props: popBase({ onclose }) });
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("scrolling its OWN body does not dismiss it; scrolling behind it does", async () => {
    const onclose = vi.fn();
    render(IssueDetailsPopover, { props: popBase({ onclose }) });
    const body = document.querySelector(".issue-details .id-body")!;

    // Scroll originating inside the popover body → guarded, stays open.
    body.dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(onclose).not.toHaveBeenCalled();

    // Scroll behind it (the list moving) → dismiss.
    document.body.dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(onclose).toHaveBeenCalledTimes(1);
  });
});
