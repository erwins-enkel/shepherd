import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../app.css";
import type { UpNextItem, UpNextSnapshot } from "$lib/types";
import { m } from "$lib/paraglide/messages";
import { upNext } from "$lib/up-next.svelte";
import { upNextUi } from "$lib/up-next-ui.svelte";
import { startUpNext } from "$lib/api";

vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    startUpNext: vi.fn(async () => ({ created: [], held: [], errors: [] })),
  };
});

const { default: UpNextPreview } = await import("./UpNextPreview.svelte");

const REPO = "~/projects/shepherd";
const item = (number: number, opts: Partial<UpNextItem> = {}): UpNextItem => ({
  repoPath: REPO,
  repoSlug: null,
  repoLabel: "shepherd",
  number,
  title: `issue ${number}`,
  url: `https://example.test/${number}`,
  kind: "feature",
  priority: false,
  createdAt: 0,
  labels: [],
  issueRef: { number, url: `https://example.test/${number}`, title: `issue ${number}`, body: "" },
  ...opts,
});

const snapshot = (items: UpNextItem[]): UpNextSnapshot => ({
  generatedAt: 1,
  repoCount: 1,
  fallback: null,
  failedRepoCount: 0,
  sections: [
    {
      kind: "repo",
      repoPath: REPO,
      repoSlug: null,
      repoLabel: "shepherd",
      totalCount: items.length,
      items,
    },
  ],
});

const key = (n: number) => `${REPO}#${n}`;

beforeEach(() => {
  upNextUi.reset();
  upNext.snapshot = snapshot([
    item(7, {
      title: "Plan Gate before Build Queue",
      labels: ["bug", "shaped"],
      labelColors: { bug: "#d73a4a" },
      issueRef: {
        number: 7,
        url: "https://example.test/7",
        title: "Plan Gate before Build Queue",
        body: "## TL;DR\n\nMake the **lifecycle** explicit.",
      },
    }),
    item(8),
    item(9),
  ]);
  upNextUi.order = [key(7), key(8), key(9)];
});
afterEach(async () => {
  // These tests click with the real pointer; park it back at the viewport origin, where
  // hover-sensitive suites sharing this browser page (UnitRow, ProjectRow tooltips) expect it.
  await userEvent.hover(page.elementLocator(document.documentElement), {
    position: { x: 0, y: 0 },
  });
  upNextUi.reset();
  upNext.snapshot = null;
  vi.clearAllMocks();
});

describe("UpNextPreview", () => {
  it("points at the list while nothing is open", async () => {
    render(UpNextPreview, {});
    await expect.element(page.getByText(m.upnext_preview_empty())).toBeVisible();
    expect(document.querySelector(".gbtn")).toBeNull();
  });

  it("reads the open issue: head, labels and rendered description", async () => {
    upNextUi.previewKey = key(7);
    render(UpNextPreview, {});
    await expect
      .element(page.getByRole("heading", { name: "Plan Gate before Build Queue" }))
      .toBeVisible();
    await expect.element(page.getByRole("heading", { name: "TL;DR" })).toBeVisible();
    expect(document.querySelector(".md-body strong")?.textContent).toBe("lifecycle");
    const chips = Array.from(document.querySelectorAll(".issue-label-chip")).map((el) =>
      el.textContent?.trim(),
    );
    expect(chips).toContain("bug");
    expect(
      page.getByText(m.upnext_preview_position({ index: 1, total: 3 })).element(),
    ).toBeTruthy();
  });

  it("starts just this issue", async () => {
    upNextUi.previewKey = key(7);
    render(UpNextPreview, {});
    await page.getByRole("button", { name: m.upnext_start(), exact: true }).click();
    await expect.poll(() => vi.mocked(startUpNext).mock.calls.length).toBe(1);
    expect(vi.mocked(startUpNext).mock.calls[0]?.[0]).toEqual([
      { repoPath: REPO, issueRef: expect.objectContaining({ number: 7 }) },
    ]);
  });

  it("ticks the same batch selection as the list", async () => {
    upNextUi.previewKey = key(7);
    render(UpNextPreview, {});
    await page.getByRole("checkbox", { name: m.upnext_preview_select() }).click();
    expect(upNextUi.selected.has(key(7))).toBe(true);
    await page.getByRole("checkbox", { name: m.upnext_preview_select() }).click();
    expect(upNextUi.selected.has(key(7))).toBe(false);
  });

  it("steps through the list order with ‹ › and wraps", async () => {
    upNextUi.previewKey = key(7);
    render(UpNextPreview, {});
    await page.getByRole("button", { name: m.upnext_preview_next() }).click();
    expect(upNextUi.previewKey).toBe(key(8));
    await page.getByRole("button", { name: m.upnext_preview_prev() }).click();
    await page.getByRole("button", { name: m.upnext_preview_prev() }).click();
    expect(upNextUi.previewKey).toBe(key(9));
  });

  it("closes with × and with Esc", async () => {
    upNextUi.previewKey = key(7);
    render(UpNextPreview, {});
    await page.getByRole("button", { name: m.common_close() }).click();
    expect(upNextUi.previewKey).toBeNull();

    upNextUi.previewKey = key(8);
    await page.getByRole("button", { name: m.upnext_preview_next() }).click();
    await userEvent.keyboard("{Escape}");
    expect(upNextUi.previewKey).toBeNull();
  });

  it("falls back to the pointer once the open issue leaves the queue", async () => {
    upNextUi.previewKey = key(7);
    render(UpNextPreview, {});
    await expect.element(page.getByText("#7")).toBeVisible();
    upNext.snapshot = snapshot([item(8), item(9)]);
    await expect.element(page.getByText(m.upnext_preview_empty())).toBeVisible();
  });
});
