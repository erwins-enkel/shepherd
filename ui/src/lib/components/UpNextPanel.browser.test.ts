import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type {
  AgentProvider,
  DiagnosticsSnapshot,
  UpNextItem,
  UpNextSnapshot,
  UsageLimits,
} from "$lib/types";
import { m } from "$lib/paraglide/messages";
import { upNext } from "$lib/up-next.svelte";
import { getUpNext, startUpNext } from "$lib/api";
import { issuesFilter } from "$lib/issues-filter.svelte";

// Mock the API so mounting (which kicks upNext.load()) makes no real network call.
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    getUpNext: vi.fn(async (): Promise<UpNextSnapshot | null> => upNext.snapshot),
    refreshUpNext: vi.fn(async () => {}),
    startUpNext: vi.fn(async () => ({ created: [], held: [], errors: [] })),
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
  issueRef: {
    number,
    url: `https://example.test/${number}`,
    title: opts.title ?? `issue ${number}`,
    body: "",
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

const startButtons = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".un-start"));
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
  localStorage.removeItem("shepherd.upnext.sort");
  issuesFilter.setBlocked(true); // restore the default so it never bleeds into other tests
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

describe("UpNextPanel compact issue rows", () => {
  it("renders bounded forge labels with colored and neutral fallbacks beside Start", async () => {
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
            item("~/projects/homeassistant", 42, false, {
              labels: ["enhancement", "operator UX", "feedback"],
              labelColors: { enhancement: "#a2eeef", feedback: "#d4c5f9" },
            }),
          ],
        },
      ],
    };

    render(UpNextPanel, {});

    await expect.poll(() => document.querySelector(".un-row")).toBeTruthy();
    const row = document.querySelector<HTMLElement>(".un-row")!;
    expect(row.classList).toContain("issue-list-row");
    const chips = row.querySelectorAll<HTMLElement>(".issue-label-chip:not(.issue-label-more)");
    expect(chips).toHaveLength(2);
    expect(chips[0]!.classList).toContain("hued");
    expect(chips[1]!.classList).not.toContain("hued");
    expect(row.querySelector(".issue-label-more")?.textContent).toContain("+1");
    expect(row.querySelector(".issue-list-actions .un-start")).not.toBeNull();
  });

  it("hides the per-row Start on mobile while checkbox and link stay touch-sized", async () => {
    await page.viewport(390, 800);
    render(UpNextPanel, {});

    await expect.poll(() => document.querySelector(".un-row")).toBeTruthy();
    const row = document.querySelector<HTMLElement>(".un-row")!;
    const hitSize = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--mobile-actionbar-hit"),
    );

    // Checkbox + link remain the 44px touch targets…
    for (const selector of [".un-check", ".un-link"]) {
      expect(
        row.querySelector<HTMLElement>(selector)!.getBoundingClientRect().height,
      ).toBeGreaterThanOrEqual(hitSize);
    }
    // …but the per-row Start is hidden entirely (out of the layout + a11y tree).
    // Starting one issue goes through the checkbox → sticky batch bar instead.
    const actions = row.querySelector<HTMLElement>(".un-actions")!;
    expect(getComputedStyle(actions).display).toBe("none");
    expect(row.querySelector<HTMLElement>(".un-start")!.getBoundingClientRect().height).toBe(0);
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
  });

  it("keeps a worst-case row single-line with Start inline and no overflow at 360px", async () => {
    // Widest row content: priority + epic pills and multiple label chips. On a
    // narrow desktop sidebar the mobile @media branch does not fire (wide viewport,
    // fine pointer), so this exercises the strict-nowrap + title-valve path.
    await page.viewport(1024, 900);
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
            item("~/projects/homeassistant", 1642, true, {
              kind: "epic",
              title: "herdr terminal transport rewrite with a deliberately long title",
              labels: ["enhancement", "operator UX", "feedback"],
              labelColors: { enhancement: "#a2eeef", feedback: "#d4c5f9" },
            }),
          ],
        },
      ],
    };

    render(UpNextPanel, {});
    await expect.poll(() => document.querySelector(".un-row")).toBeTruthy();
    const panel = document.querySelector<HTMLElement>(".upnext")!;
    const row = document.querySelector<HTMLElement>(".un-row")!;

    // Both pills render and Start stays inline (not hidden) on desktop.
    expect(row.querySelector(".un-pill-priority")).not.toBeNull();
    expect(row.querySelector(".un-pill-epic")).not.toBeNull();
    expect(getComputedStyle(row.querySelector<HTMLElement>(".un-actions")!).display).not.toBe(
      "none",
    );

    const measure = (w: number): number => {
      panel.style.width = `${w}px`;
      return row.offsetHeight; // forces reflow; integer px avoids subpixel noise
    };
    const wide = measure(600);
    // At the narrowest supported desktop width the row stays a single line (Start
    // never wraps → same height as wide) and its content does not overflow.
    expect(measure(360)).toBe(wide);
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
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
    await expect.element(page.getByText(m.upnext_normal_section())).toBeInTheDocument();
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
    startButtons()[0]!.click();
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
    startButtons()[0]!.click();
    await expect.element(page.getByText(m.upnext_picker_title())).toBeInTheDocument();
    await expect.poll(() => providerSelect().value).toBe("codex");
    await expect
      .element(page.getByText(m.newtask_agent_provider_codex_suggested_for_hold()))
      .toBeInTheDocument();
  });

  it("confirms a selected provider/model/effort choice", async () => {
    render(UpNextPanel, { launchContext: launchContext() });
    await expect.element(page.getByText("#1")).toBeInTheDocument();
    startButtons()[0]!.click();
    await expect.element(page.getByText(m.upnext_picker_title())).toBeInTheDocument();
    providerSelect().value = "codex";
    providerSelect().dispatchEvent(new Event("change", { bubbles: true }));
    const model = document.querySelector<HTMLSelectElement>("#mcp-model")!;
    await expect
      .poll(() =>
        Array.from(model.options)
          .map((o) => o.value)
          .slice(0, 5),
      )
      .toEqual(["default", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    await expect.poll(() => Array.from(model.options).map((o) => o.value)).toContain("gpt-5.4");
    model.value = "gpt-5.4";
    model.dispatchEvent(new Event("change", { bubbles: true }));
    const effort = document.querySelector<HTMLSelectElement>("#mcp-effort")!;
    effort.value = "high";
    effort.dispatchEvent(new Event("change", { bubbles: true }));
    pickerConfirm().click();
    await expect.poll(() => vi.mocked(startUpNext).mock.calls.length).toBe(1);
    expect(vi.mocked(startUpNext).mock.calls[0]?.[1]).toEqual({
      agentProvider: "codex",
      model: "gpt-5.4",
      effort: "high",
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
    startButtons()[0]!.click();
    startButtons()[1]!.click();
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
    startButtons()[0]!.click();
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
    startButtons()[0]!.click();
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

describe("UpNextPanel hide-blocked filter", () => {
  // A blocked item in the cross-repo priority section AND one in a per-repo section, across
  // two repos, so the repo-filtered branch (below) has something to prove independently of
  // the unfiltered/early-return branch.
  const blockedSnapshot = (): UpNextSnapshot => ({
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
          item("~/projects/homeassistant", 2, true, { labels: ["blocked-upstream"] }),
        ],
      },
      {
        kind: "repo",
        repoPath: "~/projects/homeassistant",
        repoSlug: null,
        repoLabel: "homeassistant",
        totalCount: 1,
        items: [item("~/projects/homeassistant", 3, false, { labels: ["blocked"] })],
      },
      {
        kind: "repo",
        repoPath: "~/projects/car-gas-tracker",
        repoSlug: null,
        repoLabel: "car-gas-tracker",
        totalCount: 1,
        items: [item("~/projects/car-gas-tracker", 4)],
      },
    ],
  });

  it("hides blocked items by default in the unfiltered (early-return) path", async () => {
    upNext.snapshot = blockedSnapshot();
    render(UpNextPanel, {});
    await expect.element(page.getByText("#1")).toBeInTheDocument();
    await expect.element(page.getByText("#4")).toBeInTheDocument();
    await expect.element(page.getByText("#2")).not.toBeInTheDocument();
    await expect.element(page.getByText("#3")).not.toBeInTheDocument();
  });

  it("also hides blocked items when a repo filter is active (repo-filtered path)", async () => {
    // Critical (review point): the blocked filter must apply on BOTH branches of the
    // `sections` derived, not just the unfiltered early return.
    upNext.snapshot = blockedSnapshot();
    render(UpNextPanel, { repoFilter: new Set(["~/projects/homeassistant"]) });
    await expect.element(page.getByText("#1")).toBeInTheDocument();
    await expect.element(page.getByText("#2")).not.toBeInTheDocument();
    await expect.element(page.getByText("#3")).not.toBeInTheDocument();
    // The other repo is filtered out entirely, independent of blocked-ness.
    await expect.element(page.getByText("#4")).not.toBeInTheDocument();
  });

  it("reveals blocked items when the header toggle is switched off", async () => {
    upNext.snapshot = blockedSnapshot();
    render(UpNextPanel, {});
    await expect.element(page.getByText("#1")).toBeInTheDocument();
    const btn = document.querySelector<HTMLButtonElement>(".un-blockedbtn")!;
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    btn.click();
    await expect.element(page.getByText("#2")).toBeInTheDocument();
    await expect.element(page.getByText("#3")).toBeInTheDocument();
    expect(btn.getAttribute("aria-pressed")).toBe("false");
  });

  it("shows the blocked-filter hint (not 'all caught up') when every queued item is blocked", async () => {
    // Whole queue hidden by the default-on toggle must read as "hidden by filter", not empty.
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
          items: [item("~/projects/homeassistant", 5, false, { labels: ["blocked-upstream"] })],
        },
      ],
    };
    render(UpNextPanel, {});
    await expect.element(page.getByText(m.issues_filter_all_blocked())).toBeInTheDocument();
    await expect.element(page.getByText(m.upnext_empty())).not.toBeInTheDocument();
    // Toggling off reveals the item and clears the hint.
    document.querySelector<HTMLButtonElement>(".un-blockedbtn")!.click();
    await expect.element(page.getByText("#5")).toBeInTheDocument();
    await expect.element(page.getByText(m.issues_filter_all_blocked())).not.toBeInTheDocument();
  });
});
