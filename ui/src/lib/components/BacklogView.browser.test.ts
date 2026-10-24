import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import { overwriteGetLocale } from "#lib/paraglide/runtime.js";
import { m } from "#lib/paraglide/messages.js";
import { listIssues, getEpics, getEpic } from "#lib/api.js";
import type { BacklogPayload, Issue } from "#lib/types.js";
import BacklogView from "./BacklogView.svelte";
import BacklogOverlay from "./BacklogOverlay.svelte";

vi.mock("#lib/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#lib/api.js")>()),
  listIssues: vi.fn(),
  getEpics: vi.fn(),
  getEpic: vi.fn(),
}));

const noop = () => {};
const issues: Issue[] = Array.from({ length: 50 }, (_, i) => ({
  number: i + 1,
  title: `Issue ${i + 1} with a long title that must not push actions off screen`,
  body: "A body preview that contributes to the row's natural height.",
  url: `https://example.com/issues/${i + 1}`,
  labels: [],
  assignees: [],
  createdAt: 0,
}));

function props(count: number) {
  const payload: BacklogPayload = {
    pinnedPath: null,
    totals: { openIssues: 50, openPRs: 0 },
    projects: Array.from({ length: count }, (_, i) => ({
      path: `/repo-${i}`,
      display: `repo-${i}`,
      slug: `org/repo-${i}`,
      kind: "github",
      openIssues: 50,
      openPRs: 0,
      prKinds: null,
      workflows: null,
      ciStatus: null,
      hidden: false,
      pinned: false,
      defaultBranch: "main",
    })),
  };
  return {
    payload,
    mobile: true,
    onissue: vi.fn(),
    onpr: noop,
    onadopt: noop,
    onlaunchtrain: noop,
    onaddclone: noop,
    onaddfork: noop,
    onaddnewproject: noop,
  };
}

beforeEach(() => {
  expect(window.matchMedia("(pointer: coarse)").matches).toBe(true);
  overwriteGetLocale(() => "de");
  vi.mocked(listIssues).mockResolvedValue({
    slug: "organization-with-a-long-name/repository-with-a-long-name",
    webUrl: null,
    issues,
    viewer: null,
  });
  vi.mocked(getEpics).mockResolvedValue({
    epics: [
      {
        parentIssueNumber: 1,
        parentTitle: "Epic",
        total: 8,
        merged: 0,
        status: "idle",
        source: "native",
      },
    ],
    subIssues: [],
  });
  vi.mocked(getEpic).mockResolvedValue({
    repoPath: "/repo-0",
    parentIssueNumber: 1,
    parentTitle: "Epic",
    source: "native",
    children: Array.from({ length: 8 }, (_, i) => ({
      number: 100 + i,
      title: `Epic child ${i}`,
      url: `https://example.com/issues/${100 + i}`,
      order: i,
      body: "",
      blockedBy: [],
      state: "ready",
      sessionId: null,
      prNumber: null,
      issueClosed: false,
      claimed: false,
    })),
    warnings: [],
    run: { repoPath: "/repo-0", parentIssueNumber: 1, mode: "auto", status: "idle" },
  });
});

afterEach(async () => {
  overwriteGetLocale(() => "en");
  document.body.innerHTML = "";
  await page.viewport(1280, 900);
});

describe("mobile backlog issue scrolling", () => {
  it.each([
    ["flow", 1, 320, 568],
    ["flow", 40, 375, 667],
    ["overlay", 1, 430, 932],
    ["overlay", 40, 375, 667],
    ["flow", 1, 852, 393],
    ["overlay", 40, 852, 393],
  ] as const)(
    "reaches the last issue in %s with %i repositories at %i×%i",
    async (mode, count, width, height) => {
      await page.viewport(width, height);
      const input = props(count);
      const host = document.createElement("div");
      // A page-scrolling host with content before the embedded backlog, as on the start page.
      host.style.paddingTop = "800px";
      document.body.append(host);
      if (mode === "flow") {
        await render(BacklogView, { target: host, props: { ...input, flow: true } });
        window.scrollTo(0, 300);
      } else await render(BacklogOverlay, { target: host, props: { ...input, onclose: noop } });
      const first = page.getByText("repo-0", { exact: true });
      await first.click();
      const pageScroll = window.scrollY;
      if (mode === "flow") expect(pageScroll).toBeGreaterThan(0);
      // Issue #1 is the (auto-expanded) epic; the other 49 are single issues.
      await expect.poll(() => document.querySelectorAll(".single-row").length).toBe(49);
      await expect.element(page.getByText("Epic child 7", { exact: true })).toBeInTheDocument();

      const detail = document.querySelector<HTMLElement>(".mobile-detail-overlay")!;
      const list = document.querySelector<HTMLElement>(".issues-list")!;
      const filter = document.querySelector<HTMLElement>(".issues-list .filter-bar")!;
      const search = page.getByRole("searchbox", { name: m.issuespanel_filter_placeholder() });
      await search.fill("Issue 50 ");
      await expect.poll(() => document.querySelectorAll(".single-row").length).toBe(1);
      await search.fill("");
      await expect.poll(() => document.querySelectorAll(".single-row").length).toBe(49);
      // No ISSUES · repo line above the search (#2639): the dialog header names the repo.
      expect(document.querySelector(".issues-header")).toBeNull();
      for (const control of filter.querySelectorAll<HTMLElement>(".issue-filter, .filter-chip")) {
        expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      }
      expect(detail.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
      expect(detail.getBoundingClientRect().bottom).toBeLessThanOrEqual(height + 1);
      expect(list.clientHeight).toBeGreaterThan(44);
      expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      const filterTop = filter.getBoundingClientRect().top;
      list.scrollTop = list.scrollHeight;
      await expect.poll(() => list.scrollTop).toBeGreaterThan(0);
      const last = document.getElementById("issue-opt-s:50")!;
      expect(last.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        list.getBoundingClientRect().bottom + 1,
      );
      expect(filter.getBoundingClientRect().top).toBeCloseTo(filterTop, 0);
      // List → issue detail (second level) → start the task from its task box.
      await page.elementLocator(last).click();
      const issueDetail = document.querySelector<HTMLElement>(".detail-col.overlay")!;
      expect(issueDetail.getBoundingClientRect().bottom).toBeLessThanOrEqual(height + 1);
      await page.elementLocator(issueDetail.querySelector<HTMLElement>(".task-btn")!).click();
      expect(input.onissue).toHaveBeenCalledWith(
        "/repo-0",
        expect.objectContaining({ number: 50 }),
        {},
      );
      // Back returns to the list, then the repo overlay closes as before.
      await page.elementLocator(issueDetail.querySelector<HTMLElement>(".back-btn")!).click();
      await expect.poll(() => document.querySelector(".detail-col.overlay")).toBeNull();
      await page.elementLocator(detail.querySelector<HTMLElement>(".overlay-close")!).click();
      await expect.poll(() => document.querySelector(".mobile-detail-overlay")).toBeNull();
      expect(window.scrollY).toBe(pageScroll);
      host.remove();
    },
  );
});

describe("mobile repo detail — swipe right back to the list", () => {
  // Synthetic touches: the attachment reads only clientX/clientY from `touches`. Each one lands
  // 500ms after the last, so back-to-back dispatches never read as a flick.
  let clock = 0;
  function fakeTouch(type: string, x: number, y: number): Event {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, "touches", {
      value: type === "touchend" ? [] : [{ clientX: x, clientY: y }],
      configurable: true,
    });
    Object.defineProperty(e, "timeStamp", { value: (clock += 500), configurable: true });
    return e;
  }
  function drag(el: Element, from: [number, number], to: [number, number]) {
    el.dispatchEvent(fakeTouch("touchstart", ...from));
    el.dispatchEvent(fakeTouch("touchmove", ...to));
    el.dispatchEvent(fakeTouch("touchend", ...to));
  }
  const overlay = () => document.querySelector<HTMLElement>(".mobile-detail-overlay");
  async function open() {
    await page.viewport(390, 844);
    await render(BacklogView, props(1));
    await page.getByText("repo-0", { exact: true }).click();
    await expect.poll(overlay).not.toBeNull();
    return overlay()!;
  }

  it.each(["issues", "readiness", "automation"] as const)(
    "a rightward drag on the %s tab closes the detail",
    async (tab) => {
      const detail = await open();
      const label = {
        issues: m.backlog_tab_issues,
        readiness: m.backlog_tab_readiness,
        automation: m.backlog_tab_automation,
      }[tab]();
      if (tab !== "issues") await page.getByText(label, { exact: true }).click();
      drag(detail, [10, 300], [300, 300]);
      await expect.poll(overlay).toBeNull();
    },
  );

  it("follows the finger mid-drag; short, leftward and vertical drags stay", async () => {
    const detail = await open();
    detail.dispatchEvent(fakeTouch("touchstart", 10, 300));
    detail.dispatchEvent(fakeTouch("touchmove", 60, 300));
    await expect.poll(() => detail.style.transform).toBe("translateX(50px)");
    detail.dispatchEvent(fakeTouch("touchend", 60, 300));
    await expect.poll(() => detail.style.transform).toBe("");
    drag(detail, [10, 300], [40, 300]);
    drag(detail, [300, 300], [10, 300]);
    drag(detail, [100, 100], [110, 500]);
    expect(overlay()).not.toBeNull();
  });

  it("an open issue detail goes back first, then the repo detail closes", async () => {
    await open();
    await expect.poll(() => document.getElementById("issue-opt-s:50")).not.toBeNull();
    await page.elementLocator(document.getElementById("issue-opt-s:50")!).click();
    const issueDetail = document.querySelector<HTMLElement>(".detail-col.overlay")!;
    drag(issueDetail, [10, 300], [300, 300]);
    await expect.poll(() => document.querySelector(".detail-col.overlay")).toBeNull();
    expect(overlay()).not.toBeNull();
    drag(document.querySelector(".issues-list")!, [10, 300], [300, 300]);
    await expect.poll(overlay).toBeNull();
  });
});

// ── desktop entry: the dashboard filter decides between a repo and the grid ──
describe("desktop entry", () => {
  const desktop = (over: Record<string, unknown> = {}) => ({
    ...props(3),
    mobile: false,
    ...over,
  });
  const triggerName = () =>
    document.querySelector(".rs-trigger .rs-name")?.textContent?.trim() ?? null;

  it("no filter: the repo grid, with nothing selected and the page's focus left alone", async () => {
    await page.viewport(1280, 900);
    await render(BacklogView, desktop());
    expect(document.querySelectorAll(".rg-tile")).toHaveLength(3);
    expect(document.querySelector(".tab-bar")).toBeNull();
    expect(triggerName()).toBe(m.repos_switcher_choose());
    // Standalone (the empty-herd panel) there is no dialog: the search must not grab focus.
    expect(document.activeElement).not.toBe(document.querySelector(".rg-search"));
  });

  it("exactly one filtered repo: opens in it with the dashboard-filter badge", async () => {
    await page.viewport(1280, 900);
    await render(BacklogView, desktop({ filterPaths: ["/repo-1"] }));
    expect(triggerName()).toBe("repo-1");
    expect(document.querySelector(".rg")).toBeNull();
    expect(document.querySelector(".rh-badge")?.textContent).toBe(m.repos_head_from_filter());
  });

  it("the pinned repo no longer preselects anything", async () => {
    await page.viewport(1280, 900);
    const input = desktop();
    await render(BacklogView, { ...input, payload: { ...input.payload, pinnedPath: "/repo-0" } });
    expect(triggerName()).toBe(m.repos_switcher_choose());
    expect(document.querySelector(".rg")).not.toBeNull();
  });
});
