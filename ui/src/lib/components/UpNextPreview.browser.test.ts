import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../app.css";
import type { Steer, UpNextItem, UpNextSnapshot } from "$lib/types";
import { m } from "$lib/paraglide/messages";
import { upNext } from "$lib/up-next.svelte";
import { upNextUi } from "$lib/up-next-ui.svelte";
import type { UpNextLaunchContext } from "$lib/up-next-start.svelte";
import { steers } from "$lib/steers.svelte";
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

describe("UpNextPreview — issue steers", () => {
  const steer = (id: string, label: string, opts: Partial<Steer> = {}): Steer => ({
    id,
    label,
    text: `run ${label}`,
    inSteerBar: false,
    onIssues: true,
    ...opts,
  });
  const ctx = (): UpNextLaunchContext => ({
    store: { diagnostics: null, usageLimits: null } as UpNextLaunchContext["store"],
    defaultAgentProvider: "claude",
    fableAvailable: true,
    upnextSkipCliPicker: true,
    usageHoldEnabled: false,
    usageHoldPct: 80,
    nowMs: 0,
    onquick: vi.fn(async () => "created" as const),
    onmanagesteers: vi.fn(),
  });
  const steerButton = (label: string) =>
    page.getByRole("button", { name: m.issuespanel_action_aria({ label }) });
  const shownSteers = () =>
    Array.from(document.querySelectorAll<HTMLElement>(".unp-steer"))
      .filter((b) => getComputedStyle(b).visibility !== "hidden")
      .map((b) => b.lastElementChild?.textContent);
  const renderAt = async (width: number, launchContext: UpNextLaunchContext | null = ctx()) => {
    const screen = await render(UpNextPreview, { launchContext });
    (screen.container as HTMLElement).style.width = `${width}px`;
    return launchContext;
  };

  beforeEach(() => {
    upNextUi.previewKey = key(7);
    steers.list = [
      steer("a", "tldr-status"),
      steer("b", "bar-only", { onIssues: false }),
      steer("c", "elsewhere", { repos: ["some-other-repo"] }),
    ];
  });
  afterEach(() => {
    steers.list = [];
  });

  it("puts this repo's issue steers beside Start and starts one with the issue attached", async () => {
    const launch = (await renderAt(1200))!;
    await steerButton("tldr-status").click();
    await expect.poll(() => vi.mocked(launch.onquick!).mock.calls.length).toBe(1);
    expect(vi.mocked(launch.onquick!).mock.calls[0]).toEqual([
      REPO,
      expect.objectContaining({ number: 7, title: "Plan Gate before Build Queue" }),
      expect.objectContaining({ id: "a" }),
    ]);
    expect(shownSteers()).toEqual(["tldr-status"]);
    expect(page.getByRole("button", { name: m.upnext_preview_more() }).query()).toBeNull();
  });

  it("shows no steers without the page's quick-launch", async () => {
    await renderAt(1200, null);
    await expect.element(page.getByRole("button", { name: m.upnext_start() })).toBeVisible();
    expect(document.querySelector(".unp-steers")).toBeNull();
  });

  it("shows no steers on an epic parent (a manual task collides with the Epic Runner)", async () => {
    upNext.snapshot = snapshot([item(7, { kind: "epic" })]);
    await renderAt(1200);
    await expect.element(page.getByRole("heading", { name: "issue 7" })).toBeVisible();
    expect(document.querySelector(".unp-steers")).toBeNull();
  });

  it("folds the steers that don't fit into a ▾ beside Start, whose menu offers all of them", async () => {
    steers.list = ["one", "two", "three", "four"].map((n) => steer(n, `steer-number-${n}`));
    const launch = (await renderAt(560))!;
    const more = page.getByRole("button", { name: m.upnext_preview_more() });
    await expect.element(more).toBeVisible();
    expect(shownSteers().length).toBeLessThan(4);

    await more.click();
    const menu = page.getByRole("menu", { name: m.upnext_preview_menu_aria({ number: 7 }) });
    await expect.element(menu).toBeVisible();
    // Start, every steer, Manage steers
    expect(menu.getByRole("menuitem").elements()).toHaveLength(6);

    await menu
      .getByRole("menuitem", { name: m.issuespanel_action_aria({ label: "steer-number-four" }) })
      .click();
    await expect.poll(() => vi.mocked(launch.onquick!).mock.calls.length).toBe(1);
    expect(vi.mocked(launch.onquick!).mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ id: "four" }),
    );
    expect(menu.query()).toBeNull();
  });

  it("keeps only whole steer buttons inline, in Settings order", async () => {
    steers.list = ["one", "two", "three", "four"].map((n) => steer(n, `steer-number-${n}`));
    await renderAt(860);
    await expect.element(page.getByRole("button", { name: m.upnext_preview_more() })).toBeVisible();
    // Re-measured on the next frame after the width change.
    await expect.poll(() => shownSteers().length).toBeGreaterThan(0);
    const shown = shownSteers();
    expect(shown.length).toBeLessThan(4);
    expect(shown).toEqual(
      ["one", "two", "three", "four"].slice(0, shown.length).map((n) => `steer-number-${n}`),
    );
    const row = document.querySelector<HTMLElement>(".unp-steers")!.getBoundingClientRect();
    for (const b of document.querySelectorAll<HTMLElement>(".unp-steer")) {
      if (getComputedStyle(b).visibility === "hidden") continue;
      expect(b.getBoundingClientRect().right).toBeLessThanOrEqual(row.right + 0.5);
    }
  });

  it("starts without a steer, or opens the steers editor, from the ▾ menu", async () => {
    steers.list = ["one", "two", "three", "four"].map((n) => steer(n, `steer-number-${n}`));
    const launch = (await renderAt(560))!;
    await page.getByRole("button", { name: m.upnext_preview_more() }).click();
    await page.getByRole("menuitem", { name: m.upnext_preview_menu_start_hint() }).click();
    await expect.poll(() => vi.mocked(startUpNext).mock.calls.length).toBe(1);

    await page.getByRole("button", { name: m.upnext_preview_more() }).click();
    await page.getByRole("menuitem", { name: m.upnext_preview_manage_steers() }).click();
    expect(launch.onmanagesteers).toHaveBeenCalledOnce();
  });

  it("closes the ▾ menu with Esc and keeps the preview open", async () => {
    steers.list = ["one", "two", "three", "four"].map((n) => steer(n, `steer-number-${n}`));
    await renderAt(560);
    await page.getByRole("button", { name: m.upnext_preview_more() }).click();
    await expect.element(page.getByRole("menu")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(page.getByRole("menu").query()).toBeNull();
    expect(upNextUi.previewKey).toBe(key(7));
  });
});
