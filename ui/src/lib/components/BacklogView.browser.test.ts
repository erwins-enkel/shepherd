import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { cdp, page } from "vitest/browser";
import "../../app.css";
import { overwriteGetLocale } from "$lib/paraglide/runtime";
import { m } from "$lib/paraglide/messages";
import { listIssues, getEpics, getEpic } from "$lib/api";
import type { BacklogPayload, Issue } from "$lib/types";
import BacklogView from "./BacklogView.svelte";
import BacklogOverlay from "./BacklogOverlay.svelte";

vi.mock("$lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/api")>()),
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

beforeEach(async () => {
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true });
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
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
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
      await expect.poll(() => document.querySelectorAll(".issue-row").length).toBe(50);
      await expect.element(page.getByText("Epic child 7", { exact: true })).toBeInTheDocument();

      const detail = document.querySelector<HTMLElement>(".mobile-detail-overlay")!;
      const list = document.querySelector<HTMLElement>(".issues-list")!;
      const filter = document.querySelector<HTMLElement>(".issues-list .filter-bar")!;
      const search = page.getByRole("searchbox", { name: m.issuespanel_filter_placeholder() });
      await search.fill("Issue 50 ");
      await expect.poll(() => document.querySelectorAll(".issue-row").length).toBe(1);
      await search.fill("");
      await expect.poll(() => document.querySelectorAll(".issue-row").length).toBe(50);
      const header = document.querySelector<HTMLElement>(".issues-header")!;
      expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth + 1);
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
      const last = document.querySelector<HTMLElement>("#epic-issue-row-50")!;
      expect(last.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        list.getBoundingClientRect().bottom + 1,
      );
      expect(filter.getBoundingClientRect().top).toBeCloseTo(filterTop, 0);
      const action = last.querySelector<HTMLElement>(".task-btn")!;
      await page.elementLocator(action).click();
      expect(input.onissue).toHaveBeenCalledWith(
        "/repo-0",
        expect.objectContaining({ number: 50 }),
      );
      await page.elementLocator(detail.querySelector<HTMLElement>(".overlay-close")!).click();
      await expect.poll(() => document.querySelector(".mobile-detail-overlay")).toBeNull();
      expect(window.scrollY).toBe(pageScroll);
      host.remove();
    },
  );
});
