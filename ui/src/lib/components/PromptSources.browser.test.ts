import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { Issue, SlashCommand } from "$lib/types";
import { m } from "$lib/paraglide/messages";
import { getTodo, listIssues, getCommands } from "$lib/api";
import { issuesFilter } from "$lib/issues-filter.svelte";

// Mock the API so no network fires; each test seeds the data it needs.
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    getTodo: vi.fn(),
    listIssues: vi.fn(),
    getCommands: vi.fn(),
  };
});

const { default: PromptSources } = await import("./PromptSources.svelte");

const mockGetTodo = vi.mocked(getTodo);
const mockListIssues = vi.mocked(listIssues);
const mockGetCommands = vi.mocked(getCommands);

const noop = () => {};

beforeEach(() => {
  mockGetTodo.mockReset();
  mockListIssues.mockReset();
  mockGetCommands.mockReset();
  // No TODO.md → the panel auto-switches off the To-Do tab to Issues.
  mockGetTodo.mockResolvedValue({ exists: false, content: "" });
});

afterEach(() => {
  document.body.innerHTML = "";
});

function issue(n: number): Issue {
  return {
    number: n,
    title: `Issue number ${n} with a reasonably long title`,
    body: "",
    url: `https://example.com/issues/${n}`,
    labels: [],
    createdAt: 0,
    assignees: [], // unassigned → always visible regardless of the "mine" filter
  };
}

function command(n: number): SlashCommand {
  return { name: `command-${n}`, description: `Description for command ${n}`, scope: "project" };
}

// Asserts the sticky .ps-filter-bar cleanly covers the rows scrolling behind it:
// pinned to the scrollport top (no band above it) and spanning the full row width
// (no transparent side strips). Both fail on the pre-fix CSS — see the bug repro.
function assertStickyCovers() {
  const body = document.querySelector(".ps-body") as HTMLElement;
  const bar = document.querySelector(".ps-body .ps-filter-bar") as HTMLElement;
  const row = document.querySelector(".ps-body .row") as HTMLElement;
  expect(body).not.toBeNull();
  expect(bar).not.toBeNull();
  expect(row).not.toBeNull();

  // The list must actually overflow, else "sticky while scrolling" is untested.
  expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
  body.scrollTop = 60;
  expect(body.scrollTop).toBeGreaterThan(0);

  const bodyRect = body.getBoundingClientRect();
  const barRect = bar.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();

  // Top coverage: the bar is pinned to the scrollport top (pre-fix the 4px
  // .ps-body top padding pinned it at bodyTop+4, leaving a bleed band above).
  expect(barRect.top).toBeLessThanOrEqual(bodyRect.top + 1);
  // Horizontal coverage: the bar spans the full row width (pre-fix the 8px side
  // margins left it narrower than the rows, so text bled around it).
  expect(barRect.left).toBeLessThanOrEqual(rowRect.left + 1);
  expect(barRect.right + 1).toBeGreaterThanOrEqual(rowRect.right);
}

describe("PromptSources filter bar (popover + sticky coverage)", () => {
  it("Issues tab: Filters trigger renders, opening it shows checkboxes, toggling hides in-progress issues", async () => {
    // Reset filter state so hide-in-progress is OFF (default) before this test.
    issuesFilter.setActive(false);

    const activeIssue = { ...issue(1), title: "Active issue", labels: ["shepherd:active"] };
    const plainIssue = { ...issue(2), title: "Plain issue" };
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      webUrl: null,
      issues: [activeIssue, plainIssue],
      viewer: "me",
    });

    render(PromptSources, { repoPath: "/repo", onpick: noop, onpickissue: noop });

    // Wait for the issues to load.
    await expect.poll(() => document.querySelectorAll(".ps-body .row").length).toBeGreaterThan(0);

    // The Filters trigger button renders inside .ps-filter-bar.
    const filterBar = document.querySelector(".ps-body .ps-filter-bar");
    expect(filterBar).not.toBeNull();
    const triggerBtn = filterBar!.querySelector<HTMLButtonElement>("button");
    expect(triggerBtn).not.toBeNull();
    expect(triggerBtn!.textContent).toContain(m.issue_filter_button());

    // Open the popover — the checkboxes become available.
    triggerBtn!.click();
    await expect
      .poll(() => document.querySelector("[popover] input[type=checkbox]"))
      .not.toBeNull();

    // Find and click the "hide in progress" checkbox row.
    const checkboxes = document.querySelectorAll<HTMLInputElement>(
      "[popover] input[type=checkbox]",
    );
    const activeLabel = m.issues_filter_active_label();
    const activeCheckbox = [...checkboxes].find((cb) => {
      const row = cb.closest("label");
      return row?.textContent?.includes(activeLabel);
    });
    expect(activeCheckbox).toBeTruthy();

    // Both issues visible before toggling.
    const titles = () =>
      [...document.querySelectorAll(".ps-body .row .row-text")].map((el) => el.textContent?.trim());
    expect(titles()).toContain("Active issue");
    expect(titles()).toContain("Plain issue");

    // Toggle hide-in-progress ON → shepherd:active issue disappears.
    activeCheckbox!.click();
    await expect.poll(() => titles()).not.toContain("Active issue");
    expect(titles()).toContain("Plain issue");

    // Clean up filter state.
    issuesFilter.setActive(false);
  });

  it("Issues tab: a flagged fetch error shows 'couldn't load', not 'no open issues'", async () => {
    // Empty list but error set (e.g. rate-limited forge) — must read as a
    // failure, not as the repo genuinely having zero open issues.
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      webUrl: null,
      issues: [],
      viewer: null,
      error: "fetch_failed",
    });

    render(PromptSources, { repoPath: "/repo", onpick: noop, onpickissue: noop });

    await expect
      .poll(() => document.querySelector(".ps-body")?.textContent)
      .toContain(m.common_issues_load_failed());
    expect(document.querySelector(".ps-body")?.textContent).not.toContain(
      m.common_no_open_issues(),
    );
  });

  it("Commands tab: search-input bar covers the rows behind it", async () => {
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      webUrl: null,
      issues: [],
      viewer: null,
    });
    mockGetCommands.mockResolvedValue({
      commands: Array.from({ length: 20 }, (_, i) => command(i)),
    });

    render(PromptSources, { repoPath: "/repo", onpick: noop, onpickissue: noop });

    // Switch to the Commands tab.
    const commandsTab = [...document.querySelectorAll<HTMLButtonElement>(".tabs .tab")].find(
      (b) => b.textContent?.trim() === m.promptsources_commands_tab(),
    );
    expect(commandsTab).toBeTruthy();
    commandsTab!.click();

    await expect.poll(() => document.querySelectorAll(".ps-body .row").length).toBeGreaterThan(10);
    await expect.poll(() => document.querySelector(".ps-body .ps-filter-bar")).toBeTruthy();
    // The search input lives inside the sticky bar wrapper.
    expect(document.querySelector(".ps-body .ps-filter-bar .cmd-filter")).not.toBeNull();

    assertStickyCovers();
  });
});

describe("PromptSources label chips (responsive 1↔2 cap)", () => {
  // Issue with 3 labels → wide shows 2 chips + "+1", narrow shows 1 chip + "+2".
  const threeLabelIssue = () => ({
    ...issue(1),
    title: "Three label issue",
    labels: ["enhancement", "reliability", "perf"],
  });

  const shown = (el: Element | null) =>
    !!el && getComputedStyle(el as HTMLElement).display !== "none";
  // Real label chips (excludes the "+N" more-counters).
  const visibleChips = () =>
    [...document.querySelectorAll(".ps-body .row .chip:not(.chip-more)")].filter(shown);
  const moreWide = () => document.querySelector<HTMLElement>(".ps-body .row .more-wide");
  const moreNarrow = () => document.querySelector<HTMLElement>(".ps-body .row .more-narrow");

  afterEach(async () => {
    // Restore a wide viewport so a leaked narrow width can't perturb the layout
    // assertions in the sticky-cover suite (which measures element rects).
    await page.viewport(1024, 768);
  });

  it("wide pane (≥520px): 2 chips + '+1', narrow counter hidden", async () => {
    await page.viewport(900, 800);
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      webUrl: null,
      issues: [threeLabelIssue()],
      viewer: null,
    });

    render(PromptSources, { repoPath: "/repo", onpick: noop, onpickissue: noop });
    await expect.poll(() => document.querySelectorAll(".ps-body .row").length).toBeGreaterThan(0);

    // Two visible label chips (default/wide regime).
    await expect.poll(() => visibleChips().length).toBe(2);
    // Wide "+N" counts the labels beyond the 2 shown (len - 2 = 1); narrow one hidden.
    expect(shown(moreWide())).toBe(true);
    expect(moreWide()!.textContent).toContain(m.promptsources_more_labels({ count: 1 }));
    expect(shown(moreNarrow())).toBe(false);
  });

  it("narrow pane (<520px): 1 chip + '+2', 2nd chip + wide counter hidden", async () => {
    await page.viewport(400, 800);
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      webUrl: null,
      issues: [threeLabelIssue()],
      viewer: null,
    });

    render(PromptSources, { repoPath: "/repo", onpick: noop, onpickissue: noop });
    await expect.poll(() => document.querySelectorAll(".ps-body .row").length).toBeGreaterThan(0);

    // The media-query fallback: only 1 chip visible; the 2nd chip is in the DOM but hidden.
    await expect.poll(() => visibleChips().length).toBe(1);
    const chip2 = document.querySelector(".ps-body .row .chip-2");
    expect(chip2).not.toBeNull();
    expect(shown(chip2)).toBe(false);
    // Narrow "+N" counts labels beyond the 1 shown (len - 1 = 2); wide one hidden.
    expect(shown(moreWide())).toBe(false);
    expect(shown(moreNarrow())).toBe(true);
    expect(moreNarrow()!.textContent).toContain(m.promptsources_more_labels({ count: 2 }));
  });
});
