import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../app.css";
import type {
  AgentProvider,
  DiagnosticsSnapshot,
  IssueFilterSettings,
  UpNextFilterStats,
  UpNextItem,
  UpNextPr,
  UpNextSnapshot,
  UsageLimits,
} from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";
import { upNext } from "#lib/up-next.svelte.js";
import { upNextUi } from "#lib/up-next-ui.svelte.js";
import { expectMinPx } from "#lib/test-support/geometry.js";
import {
  getUpNext,
  mergeBacklogPr,
  putIssueFilter,
  startUpNext,
  startUpNextPrFix,
} from "#lib/api.js";
import { upNextPrKey } from "#lib/up-next-ui.svelte.js";
import { issueFilterSettings } from "#lib/issue-filter-settings.svelte.js";

// Mock the API so mounting the demand-driven lens makes no real network call.
vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return {
    ...actual,
    getUpNext: vi.fn(async () => ({
      modified: true as const,
      snapshot: upNext.snapshot,
      etag: null,
    })),
    refreshUpNext: vi.fn(async () => {}),
    startUpNext: vi.fn(async () => ({ created: [], held: [], errors: [] })),
    mergeBacklogPr: vi.fn(async () => {}),
    startUpNextPrFix: vi.fn(async () => ({ session: { id: "fix" } })),
    requestDependabotRebase: vi.fn(async () => {}),
    getUpNextPrBody: vi.fn(async () => ({ body: "PR body" })),
    // No issueFilter: the filter UI stays hidden unless a test seeds the store.
    getSettings: vi.fn(async () => ({})),
    putIssueFilter: vi.fn(async (patch: Partial<IssueFilterSettings>) => ({
      issueFilter: { ...issueFilterSettings.value!, ...patch },
    })),
  };
});

const { default: UpNextPanel } = await import("./UpNextPanel.svelte");

const item = (
  repoPath: string,
  number: number,
  priority = false,
  opts: {
    title?: string;
    createdAt?: number;
    labels?: string[];
    labelColors?: Record<string, string>;
    kind?: UpNextItem["kind"];
    fromFork?: boolean;
    mine?: boolean;
  } = {},
): UpNextItem => ({
  repoPath,
  repoSlug: null,
  repoLabel: repoPath.split("/").at(-1) ?? repoPath,
  number,
  title: opts.title ?? `issue ${number}`,
  url: `https://example.test/${number}`,
  kind: opts.kind ?? "feature",
  priority,
  createdAt: opts.createdAt ?? 0,
  labels: opts.labels ?? [],
  labelColors: opts.labelColors,
  fromFork: opts.fromFork,
  mine: opts.mine,
  issueRef: {
    number,
    url: `https://example.test/${number}`,
    title: opts.title ?? `issue ${number}`,
  },
});

const SNAPSHOT: UpNextSnapshot = {
  generatedAt: 1,
  repoCount: 2,
  fallback: null,
  failedRepoCount: 0,
  sections: [
    {
      kind: "priority",
      repoPath: null,
      repoSlug: null,
      repoLabel: null,
      totalCount: 2,
      items: [
        item("~/projects/homeassistant", 1, true),
        item("~/projects/car-gas-tracker", 5, true),
      ],
    },
    {
      kind: "repo",
      repoPath: "~/projects/homeassistant",
      repoSlug: null,
      repoLabel: "homeassistant",
      totalCount: 1,
      items: [item("~/projects/homeassistant", 2)],
    },
    {
      kind: "repo",
      repoPath: "~/projects/car-gas-tracker",
      repoSlug: null,
      repoLabel: "car-gas-tracker",
      totalCount: 1,
      items: [item("~/projects/car-gas-tracker", 6)],
    },
  ],
};

function diagnostics(states: Partial<Record<AgentProvider, "ok" | "optional" | "error">>) {
  return {
    checks: [
      { id: "claude", state: states.claude ?? "error", hintKey: "x" },
      { id: "codex", state: states.codex ?? "error", hintKey: "x" },
    ],
    generatedAt: 0,
    overall: "ok",
  } satisfies DiagnosticsSnapshot;
}

function limits(session5hPct: number, weekPct: number): UsageLimits {
  return {
    session5h: { pct: session5hPct, resetAt: Date.now() + 60_000 },
    week: { pct: weekPct, resetAt: Date.now() + 120_000 },
    perModelWeek: [],
    credits: null,
    stale: false,
    calibratedAt: 0,
    subscriptionOnly: false,
    providers: [
      {
        provider: "claude",
        kind: "limits",
        session5h: { pct: session5hPct, resetAt: Date.now() + 60_000 },
        week: { pct: weekPct, resetAt: Date.now() + 120_000 },
        perModelWeek: [],
        credits: null,
        stale: false,
        calibratedAt: 0,
        subscriptionOnly: false,
      },
      {
        provider: "codex",
        kind: "tokens",
        totalTokens: 1000,
        session5hTokens: 100,
        weekTokens: 500,
        updatedAt: Date.now(),
        stale: false,
        session5h: { pct: 10, resetAt: Date.now() + 60_000 },
        week: { pct: 20, resetAt: Date.now() + 120_000 },
      },
    ],
  };
}

function launchContext(opts?: {
  diagnostics?: DiagnosticsSnapshot;
  usageLimits?: UsageLimits;
  defaultAgentProvider?: AgentProvider;
  skipCliPicker?: boolean;
  usageHoldEnabled?: boolean;
  usageHoldPct?: number;
}) {
  return {
    store: {
      diagnostics: opts?.diagnostics ?? diagnostics({ claude: "ok", codex: "ok" }),
      usageLimits: opts?.usageLimits ?? limits(10, 20),
    },
    defaultAgentProvider: opts?.defaultAgentProvider ?? ("claude" as AgentProvider),
    fableAvailable: true,
    upnextSkipCliPicker: opts?.skipCliPicker ?? false,
    usageHoldEnabled: opts?.usageHoldEnabled ?? false,
    usageHoldPct: opts?.usageHoldPct ?? 80,
    nowMs: Date.now(),
  };
}

// Starting is batch-only: tick the first row, then press the bar's "Start selected (1)".
const startFirst = async () => {
  document.querySelector<HTMLInputElement>(".un-check input")!.click();
  await page.getByRole("button", { name: m.upnext_start_selected({ count: 1 }) }).click();
};
const providerSelect = () => document.querySelector<HTMLSelectElement>("#mcp-provider")!;
const pickerConfirm = () => document.querySelector<HTMLButtonElement>(".mcp-actions .primary")!;
const rowNumbers = () =>
  Array.from(document.querySelectorAll(".un-row .un-num")).map((el) => el.textContent ?? "");
// Sort now lives behind a ⇅ icon that opens a listbox menu; open it, then pick the mode.
const pickSort = async (name: string) => {
  document.querySelector<HTMLButtonElement>(".un-sortbtn")!.click();
  await page.getByRole("option", { name }).click();
};

let fontStyle: HTMLStyleElement;
beforeEach(() => {
  localStorage.removeItem("shepherd.upnext.sort");
  localStorage.removeItem("shepherd.upnext.collapsed");
  upNextUi.reset();
  upNext.reset();
  issueFilterSettings.clear();
  upNext.snapshot = SNAPSHOT;
  fontStyle = document.createElement("style");
  fontStyle.textContent = `:root {
    --color-panel:#1a1a1a;--color-line:#333;--color-line-bright:#555;--color-inset:#111;
    --color-bg:#000;--color-ink:#ccc;--color-ink-bright:#fff;--color-muted:#666;--color-faint:#444;
    --color-amber:#f5a623;--color-green:#4caf50;--color-red:#f44336;
    --fs-lg:16px;--fs-meta:12px;--fs-micro:10px;
  }`;
  document.head.appendChild(fontStyle);
});
afterEach(async () => {
  upNext.snapshot = null;
  upNext.loadError = false;
  upNextUi.reset();
  localStorage.removeItem("shepherd.upnext.sort");
  localStorage.removeItem("shepherd.upnext.collapsed");
  vi.clearAllMocks();
  fontStyle.remove();
  await page.viewport(1024, 768);
});

describe("UpNextPanel repo filter", () => {
  it("shows all repos when unfiltered", async () => {
    render(UpNextPanel, {});
    await expect.element(page.getByText("#2")).toBeInTheDocument();
    await expect.element(page.getByText("#6")).toBeInTheDocument();
  });

  it("scopes sections and priority items to the active repo filter", async () => {
    render(UpNextPanel, { repoFilter: new Set(["~/projects/homeassistant"]) });
    // homeassistant repo section + its priority item remain
    await expect.element(page.getByText("#2")).toBeInTheDocument();
    await expect.element(page.getByText("#1")).toBeInTheDocument();
    // the other repo's section row AND its cross-repo priority item are gone
    await expect.element(page.getByText("#6")).not.toBeInTheDocument();
    await expect.element(page.getByText("#5")).not.toBeInTheDocument();
  });

  it("shows a repo-scoped empty note when the filtered repo has nothing queued", async () => {
    render(UpNextPanel, {
      repoFilter: new Set(["~/projects/does-not-exist"]),
      filteredRepo: "does-not-exist",
    });
    await expect
      .element(page.getByText(m.upnext_repo_filter_empty({ repo: "does-not-exist" })))
      .toBeInTheDocument();
  });
});

describe("UpNextPanel label bands", () => {
  const bandSnapshot = (): UpNextSnapshot => ({
    generatedAt: 1,
    repoCount: 1,
    fallback: null,
    failedRepoCount: 0,
    sections: [
      {
        kind: "priority",
        repoPath: null,
        repoSlug: null,
        repoLabel: null,
        totalCount: 1,
        items: [item("~/projects/homeassistant", 1, true, { labels: ["enhancement"] })],
      },
      {
        kind: "repo",
        repoPath: "~/projects/homeassistant",
        repoSlug: null,
        repoLabel: "homeassistant",
        totalCount: 4,
        items: [
          item("~/projects/homeassistant", 2, false, { labels: ["test", "enhancement"] }),
          item("~/projects/homeassistant", 3),
          item("~/projects/homeassistant", 4, false, { labels: ["enhancement", "bug"] }),
          item("~/projects/homeassistant", 5, false, { labels: ["enhancement"] }),
        ],
      },
    ],
  });
  const bandTitles = () =>
    Array.from(document.querySelectorAll(".un-section-title")).map((el) => el.textContent);

  it("bands priority first, then bug, then labels by first appearance, unlabeled last", async () => {
    upNext.snapshot = bandSnapshot();
    render(UpNextPanel, {});
    await pickSort(m.upnext_sort_recommended());
    await expect
      .poll(bandTitles)
      .toEqual([
        m.upnext_priority_section(),
        "bug",
        "test",
        "enhancement",
        m.upnext_unlabeled_section(),
      ]);
    expect(rowNumbers()).toEqual(["#1", "#4", "#2", "#5", "#3"]);
  });

  it("omits the band's own label from its rows' chips, keeping every other label", async () => {
    upNext.snapshot = bandSnapshot();
    render(UpNextPanel, {});
    await expect.element(page.getByText("#4")).toBeInTheDocument();
    const chipsOf = (n: number) =>
      Array.from(
        Array.from(document.querySelectorAll<HTMLElement>(".un-row"))
          .find((row) => row.querySelector(".un-num")?.textContent === `#${n}`)!
          .querySelectorAll(".issue-label-chip"),
      ).map((el) => el.textContent?.trim());
    expect(chipsOf(4)).toEqual(["enhancement"]);
    expect(chipsOf(2)).toEqual(["enhancement"]);
    expect(chipsOf(5)).toEqual([]);
    expect(chipsOf(1)).toEqual(["enhancement"]);
    expect(chipsOf(3)).toEqual([]);
  });

  it("has no per-row Start: a ticked row starts from the batch bar", async () => {
    render(UpNextPanel, {
      launchContext: launchContext({ diagnostics: diagnostics({ claude: "ok", codex: "error" }) }),
    });
    await expect.element(page.getByText("#1")).toBeInTheDocument();
    expect(document.querySelector(".un-start")).toBeNull();
    expect(document.querySelector(".un-batch")).toBeNull();
    await startFirst();
    await expect.poll(() => vi.mocked(startUpNext).mock.calls.length).toBe(1);
    expect(vi.mocked(startUpNext).mock.calls[0]?.[0]).toHaveLength(1);
  });

  it("keeps checkbox and title link touch-sized on mobile", async () => {
    await page.viewport(390, 800);
    render(UpNextPanel, {});

    await expect.poll(() => document.querySelector(".un-row")).toBeTruthy();
    const row = document.querySelector<HTMLElement>(".un-row")!;
    const hitSize = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--mobile-actionbar-hit"),
    );
    for (const selector of [".un-check", ".un-link"]) {
      expectMinPx(
        row.querySelector<HTMLElement>(selector)!.getBoundingClientRect().height,
        hitSize,
        `${selector} tap-target`,
      );
    }
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
  });

  it("wraps a long title in a narrow sidebar instead of truncating it", async () => {
    await page.viewport(1024, 900);
    const title = "herdr terminal transport rewrite with a deliberately long title";
    upNext.snapshot = {
      generatedAt: 1,
      repoCount: 1,
      fallback: null,
      failedRepoCount: 0,
      sections: [
        {
          kind: "repo",
          repoPath: "~/projects/homeassistant",
          repoSlug: null,
          repoLabel: "homeassistant",
          totalCount: 1,
          items: [
            item("~/projects/homeassistant", 1642, false, {
              kind: "epic",
              title,
              labels: ["enhancement", "operator UX", "feedback"],
            }),
          ],
        },
      ],
    };

    render(UpNextPanel, {});
    await expect.poll(() => document.querySelector(".un-row")).toBeTruthy();
    const panel = document.querySelector<HTMLElement>(".upnext")!;
    const row = document.querySelector<HTMLElement>(".un-row")!;
    const link = row.querySelector<HTMLElement>(".un-link")!;

    expect(row.querySelector(".un-pill")).not.toBeNull();
    const measure = (w: number): number => {
      panel.style.width = `${w}px`;
      return link.offsetHeight;
    };
    const wide = measure(900);
    // Narrow: the title grows to more lines rather than clipping, and nothing overflows.
    expect(measure(300)).toBeGreaterThan(wide);
    expect(link.scrollWidth).toBeLessThanOrEqual(link.clientWidth);
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
    expect(link.textContent).toBe(title);
  });
});

describe("UpNextPanel sorting", () => {
  const sortSnapshot = (): UpNextSnapshot => ({
    generatedAt: 1,
    repoCount: 2,
    fallback: null,
    failedRepoCount: 0,
    sections: [
      {
        kind: "priority",
        repoPath: null,
        repoSlug: null,
        repoLabel: null,
        totalCount: 2,
        items: [
          item("~/projects/zeta", 10, true, { title: "Zulu priority", createdAt: 100 }),
          item("~/projects/alpha", 11, true, { title: "Alpha priority", createdAt: 300 }),
        ],
      },
      {
        kind: "repo",
        repoPath: "~/projects/zeta",
        repoSlug: null,
        repoLabel: "zeta",
        totalCount: 2,
        items: [
          item("~/projects/zeta", 20, false, { title: "Charlie normal", createdAt: 200 }),
          item("~/projects/zeta", 21, false, { title: "Bravo normal", createdAt: 400 }),
        ],
      },
      {
        kind: "repo",
        repoPath: "~/projects/alpha",
        repoSlug: null,
        repoLabel: "alpha",
        totalCount: 2,
        items: [
          item("~/projects/alpha", 30, false, { title: "Echo normal", createdAt: 50 }),
          item("~/projects/alpha", 31, false, { title: "Delta normal", createdAt: 500 }),
        ],
      },
    ],
  });

  it("defaults to newest first while keeping priority above normal work", async () => {
    upNext.snapshot = sortSnapshot();
    render(UpNextPanel, {});
    await expect.element(page.getByText("#11")).toBeInTheDocument();
    expect(rowNumbers()).toEqual(["#11", "#10", "#31", "#21", "#20", "#30"]);
  });

  it("keeps the server-ranked sections available as Recommended", async () => {
    upNext.snapshot = sortSnapshot();
    render(UpNextPanel, {});
    await pickSort(m.upnext_sort_recommended());
    await expect.poll(rowNumbers).toEqual(["#10", "#11", "#20", "#21", "#30", "#31"]);
  });

  it("sorts oldest and title modes within the priority and normal tiers", async () => {
    upNext.snapshot = sortSnapshot();
    render(UpNextPanel, {});
    await pickSort(m.upnext_sort_oldest());
    await expect.poll(rowNumbers).toEqual(["#10", "#11", "#30", "#20", "#21", "#31"]);
    await pickSort(m.upnext_sort_title_asc());
    await expect.poll(rowNumbers).toEqual(["#11", "#10", "#21", "#20", "#31", "#30"]);
    await pickSort(m.upnext_sort_title_desc());
    await expect.poll(rowNumbers).toEqual(["#10", "#11", "#30", "#31", "#20", "#21"]);
  });

  it("sorts before applying the flattened normal cap", async () => {
    upNext.snapshot = {
      generatedAt: 1,
      repoCount: 1,
      fallback: null,
      failedRepoCount: 0,
      sections: [
        {
          kind: "repo",
          repoPath: "~/projects/zeta",
          repoSlug: null,
          repoLabel: "zeta",
          totalCount: 6,
          items: [
            item("~/projects/zeta", 1, false, { title: "one", createdAt: 1 }),
            item("~/projects/zeta", 2, false, { title: "two", createdAt: 2 }),
            item("~/projects/zeta", 3, false, { title: "three", createdAt: 3 }),
            item("~/projects/zeta", 4, false, { title: "four", createdAt: 4 }),
            item("~/projects/zeta", 5, false, { title: "five", createdAt: 5 }),
            item("~/projects/zeta", 6, false, { title: "six", createdAt: 600 }),
          ],
        },
      ],
    };
    render(UpNextPanel, {});
    await expect.element(page.getByText(m.upnext_unlabeled_section())).toBeInTheDocument();
    expect(rowNumbers()).toEqual(["#6", "#5", "#4", "#3", "#2"]);
    await expect.element(page.getByText("#1")).not.toBeInTheDocument();
    await expect.element(page.getByText(m.upnext_show_all({ count: 6 }))).toBeInTheDocument();
  });

  it("uses stable synthetic group expansion across sorted modes", async () => {
    const snapshot = sortSnapshot();
    snapshot.sections[1]!.items.push(
      item("~/projects/zeta", 22, false, { title: "Foxtrot normal", createdAt: 25 }),
      item("~/projects/zeta", 23, false, { title: "Golf normal", createdAt: 75 }),
    );
    upNext.snapshot = snapshot;
    render(UpNextPanel, {});
    await page.getByRole("button", { name: m.upnext_show_all({ count: 6 }) }).click();
    await pickSort(m.upnext_sort_oldest());
    await expect.element(page.getByText(m.upnext_show_less())).toBeInTheDocument();
  });

  it("does not mutate the cached snapshot when switching sort modes", async () => {
    const snapshot = sortSnapshot();
    upNext.snapshot = snapshot;
    const original = snapshot.sections.map((s) => s.items.map((it) => it.number));
    render(UpNextPanel, {});
    await pickSort(m.upnext_sort_title_desc());
    await expect.poll(rowNumbers).toEqual(["#10", "#11", "#30", "#31", "#20", "#21"]);
    expect(snapshot.sections.map((s) => s.items.map((it) => it.number))).toEqual(original);
  });

  it("restores a valid stored sort mode and falls back from invalid values", async () => {
    localStorage.setItem("shepherd.upnext.sort", "oldest");
    upNext.snapshot = sortSnapshot();
    const first = await render(UpNextPanel, {});
    await expect.poll(rowNumbers).toEqual(["#10", "#11", "#30", "#20", "#21", "#31"]);
    first.unmount();

    localStorage.setItem("shepherd.upnext.sort", "bogus");
    render(UpNextPanel, {});
    await expect.poll(rowNumbers).toEqual(["#11", "#10", "#31", "#21", "#20", "#30"]);
  });

  it("submits selected batch starts in the current sorted render order", async () => {
    upNext.snapshot = sortSnapshot();
    render(UpNextPanel, {
      launchContext: launchContext({ diagnostics: diagnostics({ claude: "ok", codex: "error" }) }),
    });
    await expect.element(page.getByText("#31")).toBeInTheDocument();
    for (const box of Array.from(document.querySelectorAll<HTMLInputElement>(".un-check input"))) {
      box.click();
    }
    await page.getByRole("button", { name: m.upnext_start_selected({ count: 6 }) }).click();
    await page.getByRole("button", { name: m.upnext_confirm_yes() }).click();
    await expect.poll(() => vi.mocked(startUpNext).mock.calls.length).toBe(1);
    expect(vi.mocked(startUpNext).mock.calls[0]?.[0].map((it) => it.issueRef.number)).toEqual([
      11, 10, 31, 21, 20, 30,
    ]);
  });
});

describe("UpNextPanel provider picker", () => {
  it("direct-starts with the only ready provider when exactly one CLI is available", async () => {
    render(UpNextPanel, {
      launchContext: launchContext({ diagnostics: diagnostics({ claude: "ok", codex: "error" }) }),
    });
    await expect.element(page.getByText("#1")).toBeInTheDocument();
    await startFirst();
    await expect.poll(() => vi.mocked(startUpNext).mock.calls.length).toBe(1);
    expect(vi.mocked(startUpNext).mock.calls[0]?.[1]).toEqual({
      agentProvider: "claude",
    });
    await expect.element(page.getByText(m.upnext_picker_title())).not.toBeInTheDocument();
  });

  it("opens seeded to Codex and shows the hold warning when Claude is held", async () => {
    render(UpNextPanel, {
      launchContext: launchContext({
        usageLimits: limits(91, 20),
        usageHoldEnabled: true,
        usageHoldPct: 80,
      }),
    });
    await expect.element(page.getByText("#1")).toBeInTheDocument();
    await startFirst();
    await expect.element(page.getByText(m.upnext_picker_title())).toBeInTheDocument();
    await expect.poll(() => providerSelect().value).toBe("codex");
    await expect
      .element(page.getByText(m.newtask_agent_provider_codex_suggested_for_hold()))
      .toBeInTheDocument();
  });

  it("confirms a selected provider/model/effort choice", async () => {
    render(UpNextPanel, { launchContext: launchContext() });
    await expect.element(page.getByText("#1")).toBeInTheDocument();
    await startFirst();
    await expect.element(page.getByText(m.upnext_picker_title())).toBeInTheDocument();
    providerSelect().value = "codex";
    providerSelect().dispatchEvent(new Event("change", { bubbles: true }));
    const model = document.querySelector<HTMLSelectElement>("#mcp-model")!;
    await expect
      .poll(() =>
        Array.from(model.options)
          .map((o) => o.value)
          .slice(0, 9),
      )
      .toEqual([
        "default",
        "gpt-6.1-sol",
        "gpt-6.1-terra",
        "gpt-5.6-sol",
        "gpt-6-astra",
        "gpt-6-sol",
        "gpt-6-luna",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
      ]);
    await expect.poll(() => Array.from(model.options).map((o) => o.value)).toContain("gpt-6-astra");
    model.value = "gpt-6-astra";
    model.dispatchEvent(new Event("change", { bubbles: true }));
    const effort = document.querySelector<HTMLSelectElement>("#mcp-effort")!;
    effort.value = "ultra";
    effort.dispatchEvent(new Event("change", { bubbles: true }));
    pickerConfirm().click();
    await expect.poll(() => vi.mocked(startUpNext).mock.calls.length).toBe(1);
    expect(vi.mocked(startUpNext).mock.calls[0]?.[1]).toEqual({
      agentProvider: "codex",
      model: "gpt-6-astra",
      effort: "ultra",
    });
  });

  it("opens the batch picker from the over-threshold confirmation button", async () => {
    render(UpNextPanel, { launchContext: launchContext() });
    await expect.element(page.getByText("#6")).toBeInTheDocument();
    for (const box of Array.from(document.querySelectorAll<HTMLInputElement>(".un-check input"))) {
      box.click();
    }
    await page.getByRole("button", { name: m.upnext_start_selected({ count: 4 }) }).click();
    await expect.element(page.getByText(m.upnext_confirm({ count: 4 }))).toBeInTheDocument();
    await page.getByRole("button", { name: m.upnext_confirm_yes() }).click();
    await expect.element(page.getByText(m.upnext_picker_title())).toBeInTheDocument();
    pickerConfirm().click();
    await expect.poll(() => vi.mocked(startUpNext).mock.calls.length).toBe(1);
    expect(vi.mocked(startUpNext).mock.calls[0]?.[0]).toHaveLength(4);
  });

  it("does not open a second picker while one is already open", async () => {
    render(UpNextPanel, { launchContext: launchContext() });
    await expect.element(page.getByText("#1")).toBeInTheDocument();
    await startFirst();
    // The bar stays under the open picker; a second press must not stack another one.
    document.querySelector<HTMLButtonElement>(".un-batch-go")!.click();
    await expect.element(page.getByText(m.upnext_picker_title())).toBeInTheDocument();
    expect(document.querySelectorAll(".mcp").length).toBe(1);
    expect(vi.mocked(startUpNext)).not.toHaveBeenCalled();
  });

  it("skips the picker and direct-starts with the default provider when both are ready and the skip setting is on", async () => {
    render(UpNextPanel, {
      launchContext: launchContext({
        diagnostics: diagnostics({ claude: "ok", codex: "ok" }),
        defaultAgentProvider: "claude",
        skipCliPicker: true,
      }),
    });
    await expect.element(page.getByText("#1")).toBeInTheDocument();
    await startFirst();
    await expect.poll(() => vi.mocked(startUpNext).mock.calls.length).toBe(1);
    expect(vi.mocked(startUpNext).mock.calls[0]?.[1]).toEqual({
      agentProvider: "claude",
    });
    await expect.element(page.getByText(m.upnext_picker_title())).not.toBeInTheDocument();
  });

  it("starts the single ready provider, not the unready default, when only one CLI is ready and the skip setting is on", async () => {
    render(UpNextPanel, {
      launchContext: launchContext({
        diagnostics: diagnostics({ claude: "ok", codex: "error" }),
        defaultAgentProvider: "codex",
        skipCliPicker: true,
      }),
    });
    await expect.element(page.getByText("#1")).toBeInTheDocument();
    await startFirst();
    await expect.poll(() => vi.mocked(startUpNext).mock.calls.length).toBe(1);
    expect(vi.mocked(startUpNext).mock.calls[0]?.[1]).toEqual({
      agentProvider: "claude",
    });
    await expect.element(page.getByText(m.upnext_picker_title())).not.toBeInTheDocument();
  });
});

describe("UpNextPanel header layout", () => {
  const headEl = () => document.querySelector<HTMLElement>(".un-head")!;
  const panelEl = () => document.querySelector<HTMLElement>(".upnext")!;
  // Force a reflow at a given panel width so offsetHeight reflects the new layout.
  const setWidth = (w: number) => {
    panelEl().style.width = `${w}px`;
    void headEl().offsetHeight;
  };

  // Font-agnostic guards: the header must never wrap a control to a second line.
  // We assert the mechanism (flex-wrap: nowrap) directly, then prove behaviorally that
  // the header keeps a single row's height even when the panel is forced narrower than
  // its content — a wrap would add a row and grow the height. No px thresholds or
  // monospace-metric assumptions, so it trips on the wrap regardless of the CI font.
  it("keeps the header on a single row when the panel is narrow (with a snapshot)", async () => {
    render(UpNextPanel, {});
    await expect.element(page.getByText(m.upnext_title())).toBeInTheDocument();
    expect(getComputedStyle(headEl()).flexWrap).toBe("nowrap");
    setWidth(600);
    const wide = headEl().offsetHeight;
    setWidth(140);
    expect(headEl().offsetHeight).toBe(wide);
  });

  it("keeps the header single-row in the loading state (no updated-time span)", async () => {
    upNext.snapshot = null;
    render(UpNextPanel, {});
    await expect.element(page.getByText(m.common_loading())).toBeInTheDocument();
    // The shrink valve must still exist without .un-updated present.
    expect(document.querySelector(".un-updated")).toBeNull();
    setWidth(600);
    const wide = headEl().offsetHeight;
    setWidth(140);
    expect(headEl().offsetHeight).toBe(wide);
  });
});

describe("UpNextPanel load failure", () => {
  it("surfaces a load error when every repo's issue fetch failed (empty queue, failures > 0)", async () => {
    upNext.snapshot = {
      generatedAt: 1,
      repoCount: 0,
      fallback: null,
      failedRepoCount: 2,
      sections: [],
    };
    render(UpNextPanel, {});
    // The failure must win over the "all caught up" empty state.
    await expect.element(page.getByText(m.common_issues_load_failed())).toBeInTheDocument();
    await expect.element(page.getByText(m.upnext_empty())).not.toBeInTheDocument();
  });

  it("surfaces a load error when the snapshot fetch itself throws", async () => {
    upNext.snapshot = null;
    vi.mocked(getUpNext).mockRejectedValueOnce(new Error("network down"));
    render(UpNextPanel, {});
    await expect.element(page.getByText(m.common_issues_load_failed())).toBeInTheDocument();
  });

  it("shows the all-caught-up empty state (not an error) when the queue is genuinely empty", async () => {
    upNext.snapshot = {
      generatedAt: 1,
      repoCount: 3,
      fallback: null,
      failedRepoCount: 0,
      sections: [],
    };
    render(UpNextPanel, {});
    await expect.element(page.getByText(m.upnext_empty())).toBeInTheDocument();
    await expect.element(page.getByText(m.common_issues_load_failed())).not.toBeInTheDocument();
  });

  it("renders the queue (no error) when some repos failed but work remains", async () => {
    upNext.snapshot = { ...SNAPSHOT, failedRepoCount: 1 };
    render(UpNextPanel, {});
    await expect.element(page.getByText("#2")).toBeInTheDocument();
    await expect.element(page.getByText(m.common_issues_load_failed())).not.toBeInTheDocument();
  });

  it("keeps painting cached work when a lens-open fetch throws (does not blank to error)", async () => {
    // A successful app-load peek left a usable snapshot; the lens-open GET then fails.
    upNext.snapshot = SNAPSHOT;
    vi.mocked(getUpNext).mockRejectedValueOnce(new Error("network down"));
    render(UpNextPanel, {});
    await expect.element(page.getByText("#2")).toBeInTheDocument();
    await expect.element(page.getByText(m.common_issues_load_failed())).not.toBeInTheDocument();
  });
});

describe("UpNextPanel preview and folding", () => {
  const rowTitle = (n: number) =>
    Array.from(document.querySelectorAll<HTMLElement>(".un-row"))
      .find((row) => row.querySelector(".un-num")?.textContent === `#${n}`)!
      .querySelector<HTMLButtonElement>(".un-link")!;
  const bandHead = (title: string) =>
    Array.from(document.querySelectorAll<HTMLButtonElement>(".un-section-head")).find(
      (el) => el.querySelector(".un-section-title")?.textContent === title,
    )!;

  it("opens a clicked title in the preview instead of linking to the forge", async () => {
    render(UpNextPanel, {});
    await expect.element(page.getByText("#2")).toBeInTheDocument();
    const title = rowTitle(2);
    expect(title.tagName).toBe("BUTTON");
    title.click();
    expect(upNextUi.previewKey).toBe("~/projects/homeassistant#2");
    await expect.poll(() => rowTitle(2).getAttribute("aria-current")).toBe("true");
    expect(upNextUi.order).toContain("~/projects/homeassistant#2");
  });

  it("swaps the preview in for the list on the phone (flow) and back", async () => {
    render(UpNextPanel, { flow: true });
    await expect.element(page.getByText("#2")).toBeInTheDocument();
    rowTitle(2).click();
    await expect.element(page.getByRole("region", { name: m.upnext_preview_aria() })).toBeVisible();
    expect(document.querySelector(".un-row")).toBeNull();
    await page.getByRole("button", { name: `← ${m.issuedetail_back()}` }).click();
    await expect.poll(() => document.querySelector(".un-row")).toBeTruthy();
    expect(upNextUi.previewKey).toBeNull();
  });

  it("folds a band from its heading, remembers it, and counts ticked rows it hides", async () => {
    const { unmount } = await render(UpNextPanel, {});
    await expect.element(page.getByText("#1")).toBeInTheDocument();
    const priority = m.upnext_priority_section();
    expect(bandHead(priority).getAttribute("aria-expanded")).toBe("true");
    document.querySelector<HTMLInputElement>(".un-check input")!.click(); // ticks #1 (priority)
    bandHead(priority).click();
    await expect.poll(() => bandHead(priority).getAttribute("aria-expanded")).toBe("false");
    expect(rowNumbers()).not.toContain("#1");
    expect(bandHead(priority).querySelector(".un-section-hidden")?.textContent).toBe(
      m.upnext_selected_count({ count: 1 }),
    );
    // The batch bar still offers the hidden tick.
    await expect
      .element(page.getByRole("button", { name: m.upnext_start_selected({ count: 1 }) }))
      .toBeVisible();

    unmount();
    render(UpNextPanel, {});
    await expect.poll(() => document.querySelector(".un-section-head")).toBeTruthy();
    expect(bandHead(priority).getAttribute("aria-expanded")).toBe("false");
    bandHead(priority).click();
    await expect.poll(() => rowNumbers()).toContain("#1");
  });

  it("keeps the batch bar on screen in a list taller than its scroll container", async () => {
    // Stand-in for the Herd's .units scroller.
    const { container } = await render(UpNextPanel, {});
    container.style.height = "160px";
    container.style.overflow = "auto";
    await expect.element(page.getByText("#6")).toBeInTheDocument();
    document.querySelector<HTMLInputElement>(".un-check input")!.click();
    await expect.poll(() => document.querySelector(".un-batch")).toBeTruthy();
    expect(container.scrollHeight).toBeGreaterThan(container.clientHeight);
    const bar = document.querySelector<HTMLElement>(".un-batch")!.getBoundingClientRect();
    const box = container.getBoundingClientRect();
    expect(bar.bottom).toBeLessThanOrEqual(box.bottom + 1);
    expect(bar.top).toBeGreaterThanOrEqual(box.top);
  });

  it("pins the current band's heading to the top while its rows scroll under it", async () => {
    // Stand-in for the Herd's .units scroller; padding leaves room to scroll the last band up.
    const { container } = await render(UpNextPanel, {});
    container.style.height = "120px";
    container.style.overflow = "auto";
    container.style.paddingBottom = "400px";
    await expect.element(page.getByText("#6")).toBeInTheDocument();
    const top = () => container.getBoundingClientRect().top;
    // Scroll a band's top 20px above the scrollport: its rows go under, its heading stays.
    const scrollInto = (head: HTMLElement) => {
      container.scrollTop += head.parentElement!.getBoundingClientRect().top - top() + 20;
    };
    const priority = bandHead(m.upnext_priority_section());
    const unlabeled = bandHead(m.upnext_unlabeled_section());
    scrollInto(priority);
    await expect.poll(() => Math.abs(priority.getBoundingClientRect().top - top())).toBeLessThan(1);
    scrollInto(unlabeled);
    await expect
      .poll(() => Math.abs(unlabeled.getBoundingClientRect().top - top()))
      .toBeLessThan(1);
    // The previous band has scrolled past, taking its heading with it.
    expect(priority.getBoundingClientRect().bottom).toBeLessThanOrEqual(top() + 1);
  });
});

it("unmount releases demand and remount revalidates changes missed while closed", async () => {
  const first = await render(UpNextPanel, {});
  await expect.poll(() => vi.mocked(getUpNext).mock.calls.length).toBe(1);
  await first.unmount();
  upNext.changed();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(getUpNext).toHaveBeenCalledTimes(1);
  const second = await render(UpNextPanel, {});
  await expect.poll(() => vi.mocked(getUpNext).mock.calls.length).toBe(2);
  await second.unmount();
});

describe("UpNextPanel default issue filter", () => {
  const FILTER: IssueFilterSettings = {
    scope: "mine_unassigned",
    forks: "all",
    hiddenLabels: [],
    hideActive: false,
    hideSubIssues: true,
    hideBlocked: true,
  };
  const STATS: UpNextFilterStats = {
    hiddenCount: 5,
    hiddenBy: { scope: 3, forks: 0, labels: 2 },
    hiddenByRepo: { "~/projects/homeassistant": 2, "~/projects/car-gas-tracker": 3 },
    optionCounts: {
      scope: { all: 9, mine_unassigned: 4, mine: 2 },
      forks: { all: 4, own: 3, hide: 1 },
    },
  };
  const filterBtn = () => document.querySelector<HTMLButtonElement>(".un-filterbtn")!;
  const flyout = () => page.getByRole("dialog", { name: m.upnext_filter_title() });

  beforeEach(() => {
    issueFilterSettings.apply(FILTER);
    upNext.snapshot = { ...SNAPSHOT, filter: STATS };
  });

  it("badges the active rule count and names it in the aria-label", async () => {
    render(UpNextPanel, {});
    await expect
      .element(page.getByRole("button", { name: m.upnext_filter_button_aria({ count: 1 }) }))
      .toBeInTheDocument();
    expect(filterBtn().querySelector(".badge")?.textContent).toBe("1");
    expect(filterBtn().getAttribute("aria-haspopup")).toBe("dialog");
    expect(filterBtn().getAttribute("aria-expanded")).toBe("false");
    issueFilterSettings.apply({ ...FILTER, scope: "mine", forks: "own", hiddenLabels: ["a", "b"] });
    await expect.poll(() => filterBtn().querySelector(".badge")?.textContent).toBe("4");
    issueFilterSettings.apply({ ...FILTER, scope: "all" });
    await expect.poll(() => filterBtn().querySelector(".badge")).toBeNull();
  });

  it("hides the filter button on a server without the setting", async () => {
    issueFilterSettings.clear();
    render(UpNextPanel, {});
    await expect.element(page.getByText("#2")).toBeInTheDocument();
    expect(filterBtn()).toBeNull();
  });

  it("lists active rules in the chips row with the hidden count, scoped to the repo chips", async () => {
    issueFilterSettings.apply({
      ...FILTER,
      scope: "mine",
      forks: "own",
      hiddenLabels: ["documentation"],
    });
    render(UpNextPanel, {});
    const row = () => document.querySelector<HTMLButtonElement>(".un-chips")!;
    await expect.poll(() => row()?.textContent ?? "").toContain(m.upnext_filter_chip_scope_mine());
    expect(row().textContent).toContain(m.upnext_filter_standard());
    expect(row().textContent).toContain(m.upnext_filter_chip_forks_own());
    expect(row().textContent).toContain(m.upnext_filter_chip_label({ label: "documentation" }));
    expect(row().textContent).toContain(m.upnext_filter_hidden_count({ count: 5 }));
    row().click();
    await expect.element(flyout()).toBeVisible();
  });

  it("sums the hidden count over the active repo chips", async () => {
    render(UpNextPanel, { repoFilter: new Set(["~/projects/homeassistant"]) });
    await expect
      .poll(() => document.querySelector(".un-chips")?.textContent ?? "")
      .toContain(m.upnext_filter_hidden_count({ count: 2 }));
  });

  it("omits the chips row when no rule is active", async () => {
    issueFilterSettings.apply({ ...FILTER, scope: "all" });
    render(UpNextPanel, {});
    await expect.element(page.getByText("#2")).toBeInTheDocument();
    expect(document.querySelector(".un-chips")).toBeNull();
  });

  it("writes a picked option immediately and the list follows the pushed snapshot", async () => {
    render(UpNextPanel, {});
    filterBtn().click();
    await expect.element(flyout()).toBeVisible();
    expect(filterBtn().getAttribute("aria-expanded")).toBe("true");
    // The option counts sit beside each choice.
    await expect.element(flyout().getByText("9")).toBeInTheDocument();
    await page.getByRole("radio", { name: m.upnext_filter_scope_mine() }).click();
    expect(putIssueFilter).toHaveBeenCalledWith({ scope: "mine" });
    await expect.poll(() => issueFilterSettings.value?.scope).toBe("mine");
    // The server refilters and pushes: the row it now hides leaves the list.
    upNext.apply({
      snapshot: {
        ...SNAPSHOT,
        sections: SNAPSHOT.sections.filter((s) => s.kind === "priority"),
        filter: STATS,
      },
    });
    await expect.element(page.getByText("#2")).not.toBeInTheDocument();
    // The flyout stays open for the next change.
    await expect.element(flyout()).toBeVisible();
  });

  it("toggles a queue label into the hidden set", async () => {
    upNext.snapshot = {
      ...SNAPSHOT,
      sections: [
        {
          ...SNAPSHOT.sections[1]!,
          items: [item("~/projects/homeassistant", 2, false, { labels: ["docs"] })],
        },
      ],
      filter: STATS,
    };
    render(UpNextPanel, {});
    filterBtn().click();
    await page
      .getByRole("button", { name: m.upnext_filter_label_toggle_aria({ label: "docs" }) })
      .click();
    expect(putIssueFilter).toHaveBeenCalledWith({ hiddenLabels: ["docs"] });
  });

  it("resets to the defaults", async () => {
    issueFilterSettings.apply({ ...FILTER, scope: "all", forks: "hide", hiddenLabels: ["docs"] });
    render(UpNextPanel, {});
    filterBtn().click();
    await page.getByRole("button", { name: m.upnext_filter_reset() }).click();
    expect(putIssueFilter).toHaveBeenCalledWith({
      scope: "mine_unassigned",
      forks: "all",
      hiddenLabels: [],
    });
    await expect.poll(() => issueFilterSettings.value?.forks).toBe("all");
  });

  it("links to the full filter in Settings and closes the flyout", async () => {
    const onsettings = vi.fn();
    render(UpNextPanel, { onsettings });
    filterBtn().click();
    await page.getByRole("button", { name: m.upnext_filter_all_settings() }).click();
    expect(onsettings).toHaveBeenCalledTimes(1);
    await expect.poll(() => filterBtn().getAttribute("aria-expanded")).toBe("false");
  });

  it("links to the per-repo exceptions in Settings (#3020)", async () => {
    const onsettings = vi.fn();
    render(UpNextPanel, { onsettings });
    filterBtn().click();
    await page.getByRole("button", { name: m.upnext_filter_repo_overrides() }).click();
    expect(onsettings).toHaveBeenCalledWith("repo-overrides");
    await expect.poll(() => filterBtn().getAttribute("aria-expanded")).toBe("false");
  });

  it("reverts a failed write", async () => {
    vi.mocked(putIssueFilter).mockRejectedValueOnce(new Error("down"));
    render(UpNextPanel, {});
    filterBtn().click();
    await page.getByRole("radio", { name: m.upnext_filter_scope_all(), exact: true }).click();
    await expect.poll(() => issueFilterSettings.value?.scope).toBe("mine_unassigned");
    await expect
      .element(page.getByRole("radio", { name: m.upnext_filter_scope_mine_unassigned() }))
      .toBeChecked();
  });

  it("explains a fully filtered queue instead of claiming all caught up", async () => {
    const onbacklog = vi.fn();
    upNext.snapshot = { ...SNAPSHOT, sections: [], filter: STATS };
    render(UpNextPanel, { onbacklog });
    await expect.element(page.getByText(m.upnext_filter_empty_title())).toBeInTheDocument();
    await expect
      .element(page.getByText(m.upnext_filter_empty_body({ count: 5 })))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(m.upnext_filter_empty_by_scope({ count: 3 })))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(m.upnext_filter_empty_by_labels({ count: 2 })))
      .toBeInTheDocument();
    await expect.element(page.getByText(m.upnext_empty())).not.toBeInTheDocument();
    await page.getByRole("button", { name: m.upnext_open_backlog() }).click();
    expect(onbacklog).toHaveBeenCalled();
    await page.getByRole("button", { name: m.upnext_filter_adjust(), exact: true }).click();
    await expect.element(flyout()).toBeVisible();
  });

  it("keeps the all-caught-up state when the filter hides nothing", async () => {
    upNext.snapshot = {
      ...SNAPSHOT,
      sections: [],
      filter: { ...STATS, hiddenCount: 0, hiddenByRepo: {} },
    };
    render(UpNextPanel, {});
    await expect.element(page.getByText(m.upnext_empty())).toBeInTheDocument();
    await expect.element(page.getByText(m.upnext_filter_empty_title())).not.toBeInTheDocument();
  });

  it("tags fork rows FORK when mine, UPSTREAM otherwise", async () => {
    upNext.snapshot = {
      ...SNAPSHOT,
      sections: [
        {
          ...SNAPSHOT.sections[1]!,
          items: [
            item("~/projects/homeassistant", 2, false, { fromFork: true, mine: true }),
            item("~/projects/homeassistant", 3, false, { fromFork: true, mine: false }),
            item("~/projects/homeassistant", 4),
          ],
        },
      ],
      filter: STATS,
    };
    render(UpNextPanel, {});
    await expect.element(page.getByText("#4")).toBeInTheDocument();
    const tagOf = (n: number) =>
      Array.from(document.querySelectorAll(".un-row"))
        .find((r) => r.querySelector(".un-num")?.textContent === `#${n}`)
        ?.querySelector(".un-fork")?.textContent ?? null;
    expect(tagOf(2)).toBe(m.upnext_filter_tag_fork());
    expect(tagOf(3)).toBe(m.upnext_filter_tag_upstream());
    expect(tagOf(4)).toBeNull();
  });

  it("is keyboard operable: open, arrow between radios, Escape returns focus", async () => {
    render(UpNextPanel, {});
    await expect.element(page.getByText("#2")).toBeInTheDocument();
    filterBtn().focus();
    await userEvent.keyboard("{Enter}");
    const checked = page.getByRole("radio", { name: m.upnext_filter_scope_mine_unassigned() });
    await expect.element(checked).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    await expect
      .element(page.getByRole("radio", { name: m.upnext_filter_scope_mine() }))
      .toHaveFocus();
    expect(putIssueFilter).toHaveBeenCalledWith({ scope: "mine" });
    await userEvent.keyboard("{Escape}");
    await expect.element(flyout()).not.toBeInTheDocument();
    expect(document.activeElement).toBe(filterBtn());
  });

  it("closes on an outside click and from the close button", async () => {
    render(UpNextPanel, {});
    filterBtn().click();
    await expect.element(flyout()).toBeVisible();
    // Dismiss listeners attach a tick after opening, so the opening click can't close it.
    await new Promise((r) => setTimeout(r, 10));
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await expect.element(flyout()).not.toBeInTheDocument();
    filterBtn().click();
    await page.getByRole("button", { name: m.upnext_filter_close() }).click();
    await expect.element(flyout()).not.toBeInTheDocument();
    expect(document.activeElement).toBe(filterBtn());
  });
});

describe("UpNextPanel pull requests", () => {
  const pr = (number: number, over: Partial<UpNextPr> = {}): UpNextPr => ({
    repoPath: "~/projects/homeassistant",
    repoSlug: "o/homeassistant",
    repoLabel: "homeassistant",
    number,
    title: `pr ${number}`,
    url: `https://example.test/pull/${number}`,
    author: "me",
    kind: "regular",
    createdAt: 0,
    checks: "success",
    mergeable: true,
    baseRefName: "main",
    headSha: `sha${number}`,
    band: "ready",
    action: "merge",
    ...over,
  });
  const PRS: UpNextPr[] = [
    pr(911),
    pr(912, { checks: "pending", action: null }),
    pr(967, { author: "other", band: "review", action: "review" }),
    pr(985, {
      mergeable: false,
      mergeStateStatus: "dirty",
      band: "blocked",
      action: "fix",
      blockReason: "conflict",
    }),
    pr(990, { author: "app/dependabot", kind: "dependabot", band: "dependabot" }),
  ];
  const withPrs = (prs = PRS): UpNextSnapshot => ({ ...SNAPSHOT, pullRequests: prs });
  const prRow = (n: number) =>
    Array.from(document.querySelectorAll<HTMLElement>(".un-row")).find(
      (row) => row.querySelector(".un-num")?.textContent === `#${n}`,
    )!;
  const tick = (n: number) => prRow(n).querySelector<HTMLInputElement>(".un-check input")!.click();

  it("leads with the PR block above the issues, bands in order with their tones", async () => {
    upNext.snapshot = withPrs();
    render(UpNextPanel, {});
    await expect.element(page.getByText("#911")).toBeInTheDocument();
    const kinds = Array.from(document.querySelectorAll(".un-kind")).map((el) => el.textContent);
    expect(kinds[0]).toContain(m.upnext_pr_kind_title());
    expect(kinds[0]).toContain("5");
    expect(kinds[1]).toContain(m.upnext_issue_kind_title());
    const bands = Array.from(document.querySelectorAll<HTMLElement>(".un-section"));
    expect(bands.slice(0, 4).map((b) => b.querySelector(".un-section-title")?.textContent)).toEqual(
      [
        m.upnext_pr_band_ready(),
        m.upnext_pr_band_review(),
        m.upnext_pr_band_blocked(),
        m.upnext_pr_band_dependabot(),
      ],
    );
    expect(bands.slice(0, 4).map((b) => b.style.getPropertyValue("--band"))).toEqual([
      "var(--color-green)",
      "var(--color-data-2)",
      "var(--color-warn)",
      "var(--color-blue)",
    ]);
    expect(bands[4]!.querySelector(".un-section-title")?.textContent).toBe(
      m.upnext_priority_section(),
    );
  });

  it("pulls every PR row's action flush right under #num on mobile and desktop", async () => {
    const rect = (n: number, selector: string) =>
      prRow(n).querySelector<HTMLElement>(selector)!.getBoundingClientRect();
    upNext.snapshot = withPrs();

    await page.viewport(390, 800);
    render(UpNextPanel, {});
    await expect.element(page.getByText("#990")).toBeInTheDocument();
    for (const [width, height] of [
      [390, 800],
      [1280, 900],
    ]) {
      await page.viewport(width, height);
      for (const n of [911, 912, 967, 985, 990]) {
        expect(Math.abs(rect(n, ".unpr-act").right - rect(n, ".un-meta").right)).toBeLessThan(1);
        expect(prRow(n).scrollWidth).toBeLessThanOrEqual(prRow(n).clientWidth);
      }
    }
  });

  it("gives every PR row exactly one action; a CI-running row's button is locked", async () => {
    upNext.snapshot = withPrs();
    render(UpNextPanel, {});
    await expect.element(page.getByText("#990")).toBeInTheDocument();
    for (const n of [911, 912, 967, 985, 990]) {
      expect(prRow(n).querySelectorAll(".unpr-act")).toHaveLength(1);
    }
    const act = (n: number) => prRow(n).querySelector<HTMLElement>(".unpr-act")!;
    expect(act(911).textContent).toBe(m.prspanel_merge_button());
    expect(act(911).getAttribute("aria-disabled")).toBeNull();
    expect(act(912).textContent).toBe(m.prspanel_merge_button());
    expect(act(912).getAttribute("aria-disabled")).toBe("true");
    expect(act(967).textContent).toBe(m.prspanel_review_button());
    expect(act(985).textContent).toBe(m.upnext_pr_action_fix());
    expect(prRow(985).textContent).toContain(m.prspanel_conflicts());
    // The Dependabot band names neither the bot nor a tag.
    expect(prRow(990).textContent).not.toContain("dependabot");
    expect(prRow(911).textContent).toContain("@me");
  });

  it("merges through the confirmation and hides the merged row", async () => {
    upNext.snapshot = withPrs();
    render(UpNextPanel, {});
    await expect.element(page.getByText("#911")).toBeInTheDocument();
    prRow(911).querySelector<HTMLElement>(".unpr-act")!.click();
    const confirm = page.getByRole("button", { name: m.mergeconfirm_confirm() });
    await expect.element(confirm).toBeEnabled();
    await confirm.click();
    await expect.poll(() => vi.mocked(mergeBacklogPr).mock.calls.length).toBe(1);
    expect(vi.mocked(mergeBacklogPr).mock.calls[0]).toMatchObject([
      "~/projects/homeassistant",
      911,
      { deleteBranch: true, confirm: { headSha: "sha911", baseRefName: "main" } },
    ]);
    await expect.poll(() => prRow(911)).toBeUndefined();
  });

  it("merges a row with the method picked from its Merge ▾", async () => {
    upNext.snapshot = withPrs([
      pr(916, { mergeMethod: "squash", allowedMergeMethods: ["squash", "merge"] }),
    ]);
    render(UpNextPanel, {});
    await expect.element(page.getByText("#916")).toBeInTheDocument();
    prRow(916).querySelector<HTMLElement>(".unpr-more")!.click();
    await page.getByRole("menuitem", { name: /^merge/ }).click();
    const confirm = page.getByRole("button", {
      name: m.mergeconfirm_confirm_method({ method: "merge" }),
    });
    await expect.element(confirm).toBeEnabled();
    await confirm.click();
    await expect.poll(() => vi.mocked(mergeBacklogPr).mock.calls.length).toBe(1);
    expect(vi.mocked(mergeBacklogPr).mock.calls[0]).toMatchObject([
      "~/projects/homeassistant",
      916,
      { method: "merge", deleteBranch: true },
    ]);
  });

  it("starts a fix session from a blocked row and hides it", async () => {
    upNext.snapshot = withPrs();
    render(UpNextPanel, {});
    await expect.element(page.getByText("#985")).toBeInTheDocument();
    prRow(985).querySelector<HTMLElement>(".unpr-act")!.click();
    await expect.poll(() => vi.mocked(startUpNextPrFix).mock.calls.length).toBe(1);
    expect(vi.mocked(startUpNextPrFix).mock.calls[0]).toEqual([
      "~/projects/homeassistant",
      985,
      undefined,
    ]);
    await expect.poll(() => prRow(985)).toBeUndefined();
  });

  it("does nothing for a locked button", async () => {
    upNext.snapshot = withPrs();
    render(UpNextPanel, {});
    await expect.element(page.getByText("#912")).toBeInTheDocument();
    prRow(912).querySelector<HTMLElement>(".unpr-act")!.click();
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector("[role='dialog']")).toBeNull();
  });

  it("offers the merge train for picked PRs only, and two buttons for a mixed pick", async () => {
    upNext.snapshot = withPrs();
    const onlaunchtrain = vi.fn();
    render(UpNextPanel, {
      launchContext: { ...launchContext({ skipCliPicker: true }), onlaunchtrain },
    });
    await expect.element(page.getByText("#911")).toBeInTheDocument();
    tick(911);
    await expect
      .element(page.getByText(m.upnext_pr_selected_count({ count: 1 })))
      .toBeInTheDocument();
    const train = page.getByRole("button", { name: m.prspanel_launch_train() });
    await expect.element(train).toBeDisabled();
    tick(985);
    await expect.element(train).toBeEnabled();
    await train.click();
    expect(onlaunchtrain.mock.calls[0]![0].map((p: UpNextPr) => p.number)).toEqual([911, 985]);
    expect(startUpNext).not.toHaveBeenCalled();

    // A mixed pick: each button takes only its own kind.
    tick(2);
    await expect
      .element(page.getByText(m.upnext_batch_mixed_count({ issues: 1, prs: 2 })))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: m.upnext_batch_train({ count: 2 }) }))
      .toBeEnabled();
    await page.getByRole("button", { name: m.upnext_batch_start_issues({ count: 1 }) }).click();
    await expect.poll(() => vi.mocked(startUpNext).mock.calls.length).toBe(1);
    expect(vi.mocked(startUpNext).mock.calls[0]![0].map((it) => it.issueRef.number)).toEqual([2]);
  });

  it("opens a PR title in the PR preview", async () => {
    upNext.snapshot = withPrs();
    render(UpNextPanel, {});
    await expect.element(page.getByText("#967")).toBeInTheDocument();
    prRow(967).querySelector<HTMLButtonElement>(".un-link")!.click();
    expect(upNextUi.previewKey).toBe(upNextPrKey(PRS[2]!));
    expect(upNextUi.prOrder).toEqual([911, 912, 967, 985, 990].map((n) => upNextPrKey(pr(n))));
  });

  it("swaps the PR preview in for the list on the phone", async () => {
    upNext.snapshot = withPrs();
    render(UpNextPanel, { flow: true });
    await expect.element(page.getByText("#967")).toBeInTheDocument();
    prRow(967).querySelector<HTMLButtonElement>(".un-link")!.click();
    await expect
      .element(page.getByRole("region", { name: m.upnext_pr_preview_aria() }))
      .toBeVisible();
    expect(document.querySelector(".un-row")).toBeNull();
  });

  it("keeps PR actions, checkboxes and header icons touch-sized on the phone", async () => {
    await page.viewport(390, 800);
    upNext.snapshot = withPrs();
    issueFilterSettings.apply({
      scope: "all",
      forks: "all",
      hiddenLabels: [],
      hideActive: false,
      hideSubIssues: true,
      hideBlocked: true,
    });
    render(UpNextPanel, { flow: true });
    await expect.element(page.getByText("#911")).toBeInTheDocument();
    const hit = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--mobile-actionbar-hit"),
    );
    for (const el of [
      prRow(911).querySelector<HTMLElement>(".unpr-act")!,
      prRow(911).querySelector<HTMLElement>(".un-check")!,
      document.querySelector<HTMLElement>(".un-refresh")!,
      document.querySelector<HTMLElement>(".un-sortbtn")!,
      document.querySelector<HTMLElement>(".un-filterbtn")!,
    ]) {
      const box = el.getBoundingClientRect();
      expectMinPx(box.height, hit, `${el.className} height`);
      expectMinPx(box.width, hit, `${el.className} width`);
    }
  });

  it("folds the whole PR block from its header, remembers it, and counts hidden ticks", async () => {
    upNext.snapshot = withPrs();
    const { unmount } = await render(UpNextPanel, {});
    await expect.element(page.getByText("#911")).toBeInTheDocument();
    const kinds = () => Array.from(document.querySelectorAll<HTMLElement>(".un-kind"));
    const prHead = () => kinds()[0]!;
    expect(prHead().tagName).toBe("BUTTON");
    expect(prHead().getAttribute("aria-expanded")).toBe("true");
    // The issues header stays a plain heading.
    expect(kinds()[1]!.tagName).not.toBe("BUTTON");
    expect(kinds()[1]!.hasAttribute("aria-expanded")).toBe(false);

    tick(911);
    prHead().click();
    await expect.poll(() => prHead().getAttribute("aria-expanded")).toBe("false");
    expect(rowNumbers()).not.toContain("#911");
    expect(document.querySelectorAll(".un-section-title")[0]?.textContent).toBe(
      m.upnext_priority_section(),
    );
    expect(prHead().querySelector(".un-section-hidden")?.textContent).toBe(
      m.upnext_selected_count({ count: 1 }),
    );
    // The batch bar still offers the hidden tick.
    await expect
      .element(page.getByText(m.upnext_pr_selected_count({ count: 1 })))
      .toBeInTheDocument();

    unmount();
    render(UpNextPanel, {});
    await expect.element(page.getByText("#2")).toBeInTheDocument();
    expect(prHead().getAttribute("aria-expanded")).toBe("false");
    expect(rowNumbers()).not.toContain("#911");
    prHead().click();
    await expect.poll(() => rowNumbers()).toContain("#911");
  });

  it("looks as before when no PR waits", async () => {
    upNext.snapshot = withPrs([]);
    render(UpNextPanel, {});
    await expect.element(page.getByText("#2")).toBeInTheDocument();
    expect(document.querySelector(".un-kind")).toBeNull();
  });
});
