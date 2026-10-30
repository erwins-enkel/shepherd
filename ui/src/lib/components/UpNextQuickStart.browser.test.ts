import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type {
  AgentProvider,
  DiagnosticsSnapshot,
  Steer,
  UpNextItem,
  UpNextSnapshot,
  UsageLimits,
} from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";
import { upNext } from "#lib/up-next.svelte.js";
import { upNextUi } from "#lib/up-next-ui.svelte.js";
import type { UpNextLaunchContext } from "#lib/up-next-start.svelte.js";
import { steers } from "#lib/steers.svelte.js";
import { startUpNext } from "#lib/api.js";

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return {
    ...actual,
    getUpNextBody: vi.fn(async () => ({ body: "body" })),
    startUpNext: vi.fn(async () => ({ created: [], held: [], errors: [] })),
  };
});

const { default: UpNextPreview } = await import("./UpNextPreview.svelte");

const REPO = "~/projects/shepherd";
const item = (number: number): UpNextItem => ({
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
  issueRef: { number, url: `https://example.test/${number}`, title: `issue ${number}` },
});
const snapshot = (items: UpNextItem[]): UpNextSnapshot => ({
  generatedAt: 1,
  repoCount: 1,
  fallback: null,
  failedRepoCount: 0,
  sections: [
    { kind: "repo", repoPath: REPO, repoSlug: null, repoLabel: "shepherd", totalCount: 1, items },
  ],
});

const diagnostics = (ok: AgentProvider[]): DiagnosticsSnapshot => ({
  checks: (["claude", "codex"] as const).map((id) => ({
    id,
    state: ok.includes(id) ? "ok" : "error",
    hintKey: "x",
  })),
  generatedAt: 0,
  overall: "ok",
});
const limits = (pct5h: number): UsageLimits => ({
  session5h: { pct: pct5h, resetAt: Date.now() + 3 * 3_600_000 },
  week: { pct: 10, resetAt: Date.now() + 86_400_000 },
  perModelWeek: [],
  credits: null,
  stale: false,
  calibratedAt: 0,
  subscriptionOnly: false,
});

const ctx = (over: Partial<UpNextLaunchContext> = {}): UpNextLaunchContext => ({
  store: {
    diagnostics: diagnostics(["claude", "codex"]),
    usageLimits: limits(30),
  } as UpNextLaunchContext["store"],
  defaultAgentProvider: "claude",
  fableAvailable: true,
  upnextSkipCliPicker: false,
  upnextQuickStarts: {
    claude: { enabled: true, model: "opus", effort: "high" },
    codex: { enabled: true, model: null, effort: "medium" },
  },
  usageHoldEnabled: true,
  usageHoldPct: 80,
  nowMs: Date.now(),
  onquick: vi.fn(async () => "created" as const),
  onmanagesteers: vi.fn(),
  onmanagequickstarts: vi.fn(),
  ...over,
});

const renderAt = async (width: number, launchContext: UpNextLaunchContext) => {
  const screen = await render(UpNextPreview, { launchContext });
  (screen.container as HTMLElement).style.width = `${width}px`;
  return launchContext;
};
const chip = (cli: string) =>
  page.getByRole("button", {
    name: new RegExp(`^Quick start with ${cli}|^Schnellstart mit ${cli}`),
  });
const shownChips = () =>
  Array.from(document.querySelectorAll<HTMLElement>(".unp-chip")).filter(
    (b) => getComputedStyle(b).visibility !== "hidden",
  );

beforeEach(() => {
  vi.mocked(startUpNext).mockClear();
  upNextUi.reset();
  upNext.snapshot = snapshot([item(7)]);
  upNextUi.previewKey = `${REPO}#7`;
});
afterEach(() => {
  steers.list = [];
});

describe("UpNextPreview — quick-start chips", () => {
  it("starts exactly one session with the preset, without the picker, with two CLIs ready", async () => {
    await renderAt(1200, ctx());
    await chip("Codex").click();
    await expect.poll(() => vi.mocked(startUpNext).mock.calls.length).toBe(1);
    expect(vi.mocked(startUpNext).mock.calls[0]![1]).toEqual({
      agentProvider: "codex",
      model: null,
      effort: "medium",
    });
    expect(page.getByRole("dialog").query()).toBeNull();
  });

  it("keeps Start… as before: it opens the CLI picker with two CLIs ready", async () => {
    await renderAt(1200, ctx());
    await page.getByRole("button", { name: m.upnext_start_ellipsis() }).click();
    expect(startUpNext).not.toHaveBeenCalled();
    await expect.element(page.getByText(m.upnext_picker_title())).toBeVisible();
  });

  it("shows no chip, and a plain Start, without an enabled preset", async () => {
    await renderAt(
      1200,
      ctx({ upnextQuickStarts: { claude: { enabled: false, model: null, effort: null } } }),
    );
    await expect.element(page.getByRole("button", { name: m.upnext_start() })).toBeVisible();
    expect(document.querySelector(".unp-chip")).toBeNull();
  });

  it("names when Claude's hold lifts, and still starts (the server holds it)", async () => {
    await renderAt(
      1200,
      ctx({
        store: {
          diagnostics: diagnostics(["claude", "codex"]),
          usageLimits: limits(90),
        } as UpNextLaunchContext["store"],
      }),
    );
    const claude = chip("Claude Code");
    await expect.poll(() => claude.element().textContent).toMatch(/\d\d:\d\d/);
    await claude.click();
    await expect.poll(() => vi.mocked(startUpNext).mock.calls.length).toBe(1);
    expect(vi.mocked(startUpNext).mock.calls[0]![1]).toMatchObject({ agentProvider: "claude" });
  });

  it("locks a chip whose CLI isn't ready, with the reason on hover", async () => {
    await renderAt(
      1200,
      ctx({
        store: {
          diagnostics: diagnostics(["claude"]),
          usageLimits: limits(30),
        } as UpNextLaunchContext["store"],
      }),
    );
    const codex = chip("Codex");
    await expect.element(codex).toHaveAttribute("aria-disabled", "true");
    await codex.click({ force: true });
    expect(startUpNext).not.toHaveBeenCalled();
    await codex.hover();
    await expect
      .element(page.getByText(m.upnext_quickstart_tip_blocked({ cli: "Codex" })))
      .toBeVisible();
  });

  it("locks every start button while a start is in flight", async () => {
    let release!: () => void;
    vi.mocked(startUpNext).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ created: [], held: [], errors: [] });
        }),
    );
    await renderAt(1200, ctx());
    await chip("Codex").click();
    await expect.element(page.getByText(m.upnext_quickstart_starting()).first()).toBeVisible();
    for (const b of document.querySelectorAll<HTMLButtonElement>(".unp-chip")) {
      expect(b.disabled).toBe(true);
    }
    await expect
      .element(page.getByRole("button", { name: m.upnext_start_ellipsis() }))
      .toBeDisabled();
    release();
  });

  it("folds chips and steers into a ▾ menu when they don't fit, starting from it too", async () => {
    steers.list = ["one", "two"].map((n): Steer => ({
      id: n,
      label: `steer-${n}`,
      text: "x",
      inSteerBar: false,
      onIssues: true,
    }));
    const launch = await renderAt(330, ctx());
    const more = page.getByRole("button", { name: m.upnext_preview_more() });
    await expect.element(more).toBeVisible();

    await more.click();
    const menu = page.getByRole("menu");
    // Start…, 2 quick starts, 2 steers, Manage quick starts, Manage steers
    expect(menu.getByRole("menuitem").elements()).toHaveLength(7);
    await menu.getByRole("menuitem", { name: /Codex/ }).click();
    await expect.poll(() => vi.mocked(startUpNext).mock.calls.length).toBe(1);
    expect(vi.mocked(startUpNext).mock.calls[0]![1]).toMatchObject({ agentProvider: "codex" });

    await more.click();
    await page.getByRole("menuitem", { name: m.upnext_quickstart_manage() }).click();
    expect(launch.onmanagequickstarts).toHaveBeenCalledOnce();
  });

  it("keeps every chip inline, and no ▾, when the row is wide", async () => {
    await renderAt(1200, ctx());
    expect(shownChips()).toHaveLength(2);
    expect(page.getByRole("button", { name: m.upnext_preview_more() }).query()).toBeNull();
  });
});
