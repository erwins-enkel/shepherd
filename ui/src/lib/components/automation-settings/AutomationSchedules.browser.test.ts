import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../../app.css";
import AutomationSchedules from "./AutomationSchedules.svelte";
import { m } from "#lib/paraglide/messages.js";
import { HerdStore } from "#lib/store.svelte.js";
import { repoSettingsWindow } from "#lib/repo-settings-window.svelte.js";
import ScheduleDialog from "./ScheduleDialog.svelte";
import { SCHEDULE_USAGE, SCHEDULE_DIAGNOSTICS } from "#lib/schedules.svelte.js";
import { repoConfig } from "#lib/reviews.svelte.js";
import type { UsageLimits, Settings, RepoConfig } from "#lib/types.js";
import type { ScheduleRun, Schedule } from "#lib/types.js";

const store = new HerdStore();

const TRIAGE: Schedule = {
  id: "s1",
  repoPath: "/repo-a",
  name: "Triage",
  prompt: "/triage-feedback",
  days: 0b0011111,
  times: ["09:00", "18:00"],
  enabled: true,
  launch: {
    agentProvider: null,
    model: null,
    effort: null,
    autopilotEnabled: false,
    planGateEnabled: null,
    research: false,
    sandboxProfile: null,
    baseBranch: null,
  },
  createdAt: 1,
  updatedAt: 1,
  lastRun: null,
  nextAt: null,
};

const REPO: RepoConfig = {
  criticEnabled: true,
  criticAllPrs: false,
  criticSmellLensEnabled: false,
  autoAddressEnabled: false,
  autopilotEnabled: false,
  autoDrainEnabled: false,
  autoMergeEnabled: false,
  buildQueueEnabled: false,
  planGateEnabled: false,
  draftMode: false,
  signoffAuthority: "human",
  sandboxProfile: "inherit",
  agentProvider: "inherit",
  defaultModel: "inherit",
  defaultEffort: "inherit",
  defaultExecutionEffort: "inherit",
  maxAuto: 1,
  autoLabel: "shepherd:auto",
  usageCeilingPct: 80,
  repoMode: "forge",
  manualStepsIssueEnabled: false,
  preWarmEpicLandingCi: false,
  mergeWithoutCi: false,
  epicStacksEnabled: false,
  sharedBrowserEnabled: false,
  browserAllowedHosts: [],
  claudeAiConnectorsEnabled: false,
  hidden: false,
  pinned: false,
  previewOpenMode: "ask",
};

/** Fake the schedules API: GET answers `list`; writes are recorded and answer `{}`. */
function mockApi(
  list: Schedule[],
  history: () => Promise<Response> = async () => new Response(JSON.stringify({ runs: [] })),
) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (method === "GET" && String(input).endsWith("/runs")) return history();
    if (method === "POST" && String(input).endsWith("/run")) {
      return new Response(JSON.stringify({ ...RUN, outcome: "spawned" }));
    }
    const body =
      method === "GET"
        ? String(input).includes("/api/repo-config")
          ? REPO
          : { schedules: list }
        : {};
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return calls;
}

beforeEach(async () => {
  await page.viewport(1280, 900);
});

afterEach(() => {
  vi.restoreAllMocks();
  store.usageLimits = null;
  store.diagnostics = null;
  repoConfig.agentProvider = {};
  repoSettingsWindow.provide({ globals: () => null, drain: () => null });
});

describe("AutomationSchedules (#3469)", () => {
  it("lists a schedule with its cadence and toggles it off", async () => {
    const calls = mockApi([TRIAGE]);
    render(AutomationSchedules, { repoPath: "/repo-a" });
    await expect.element(page.getByText("Triage")).toBeVisible();
    await expect.element(page.getByText(/09:00, 18:00/)).toBeVisible();
    await page.getByRole("switch", { name: m.schedules_enabled_aria({ name: "Triage" }) }).click();
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ enabled: false });
  });

  it("adds a schedule through the dialog, attended by default", async () => {
    const calls = mockApi([]);
    render(AutomationSchedules, { repoPath: "/repo-a" });
    await page.getByRole("button", { name: m.schedules_add() }).click();
    await page.getByLabelText(m.schedules_field_name()).fill("Triage");
    await page.getByLabelText(m.schedules_field_prompt()).fill("/triage-feedback");
    await page.getByRole("button", { name: m.schedules_save() }).click();
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({
      repoPath: "/repo-a",
      name: "Triage",
      prompt: "/triage-feedback",
      days: 0b0011111,
      times: ["09:00"],
      launch: { autopilotEnabled: false, planGateEnabled: null, research: false },
    });
  });

  it("centers the dialog despite Tailwind preflight's margin reset", async () => {
    await page.viewport(1280, 900);
    mockApi([]);
    render(AutomationSchedules, { repoPath: "/repo-a" });
    await page.getByRole("button", { name: m.schedules_add() }).click();
    const dlg = document.querySelector("dialog")!;
    await vi.waitFor(() => expect(dlg.open).toBe(true));
    const r = dlg.getBoundingClientRect();
    expect(Math.abs(r.left - (innerWidth - r.right))).toBeLessThanOrEqual(2);
    expect(Math.abs(r.top - (innerHeight - r.bottom))).toBeLessThanOrEqual(2);
  });

  it("delete needs a second click", async () => {
    const calls = mockApi([TRIAGE]);
    render(AutomationSchedules, { repoPath: "/repo-a" });
    await page.getByRole("button", { name: m.schedules_delete() }).click();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await page.getByRole("button", { name: m.schedules_delete_confirm() }).click();
    await vi.waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  });
});

describe("schedule dialog layout", () => {
  it("saves research and an explicit engine", async () => {
    await page.viewport(1280, 900);
    const calls = mockApi([]);
    render(AutomationSchedules, { repoPath: "/repo-a" });
    await page.getByRole("button", { name: m.schedules_add() }).click();
    await page.getByLabelText(m.schedules_field_name()).fill("Research");
    await page.getByLabelText(m.schedules_field_prompt()).fill("Find evidence");
    await page.getByRole("button", { name: "Research", exact: true }).click();
    await page.getByRole("button", { name: /Codex/ }).click();
    await page.getByRole("button", { name: m.schedules_save() }).click();
    await vi.waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
        launch: { research: true, agentProvider: "codex", model: null, effort: null },
      }),
    );
  });

  it("shows section tabs on mobile and keeps save visible", async () => {
    await page.viewport(390, 700);
    mockApi([]);
    render(AutomationSchedules, { repoPath: "/repo-a" });
    await page.getByRole("button", { name: m.schedules_add() }).click();
    await expect.element(page.getByRole("tab", { name: "What", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "When", exact: true }).click();
    await expect.element(page.getByLabelText(m.schedules_field_name())).not.toBeVisible();
    await expect.element(page.getByRole("button", { name: m.schedules_save() })).toBeVisible();
  });
});

function globals(overrides: Partial<Settings> = {}) {
  const settings = {
    defaultAgentProvider: "claude",
    usageHoldEnabled: true,
    usageHoldPct: 80,
    ...overrides,
  } as Settings;
  repoSettingsWindow.provide({ globals: () => settings, drain: () => null });
}

function usage(claude: number | null = 62, codex: number | null = 43): UsageLimits {
  const window = (pct: number) => ({ pct, resetAt: Date.now() + 86_400_000 });
  return {
    session5h: claude === null ? null : window(18),
    week: claude === null ? null : window(claude),
    stale: false,
    calibratedAt: null,
    subscriptionOnly: false,
    perModelWeek: [],
    credits: null,
    providers: [
      {
        provider: "codex",
        kind: "tokens",
        totalTokens: 100,
        session5hTokens: 20,
        weekTokens: 80,
        updatedAt: Date.now(),
        stale: false,
        session5h: codex === null ? null : window(12),
        week: codex === null ? null : window(codex),
      },
    ],
  };
}

async function edit(schedule: Schedule = TRIAGE) {
  const calls = mockApi([schedule]);
  await render(ScheduleDialog, {
    props: { repoPath: schedule.repoPath, schedule, onclose: vi.fn() },
    context: new Map<symbol, () => unknown>([
      [SCHEDULE_USAGE, () => store.usageLimits],
      [SCHEDULE_DIAGNOSTICS, () => store.diagnostics],
    ]),
  });
  return calls;
}

const footer = () => document.querySelector(".next-run")!;

const ownLaunch = {
  agentProvider: "codex",
  model: "custom-codex-model",
  effort: "high",
  autopilotEnabled: null,
  planGateEnabled: false,
  research: true,
  sandboxProfile: "trusted",
  baseBranch: "release/next",
} as const;

describe("schedule launch compatibility", () => {
  it.each([TRIAGE.launch, ownLaunch])(
    "preserves every launch value when saved unchanged: %j",
    async (launch) => {
      const schedule = { ...TRIAGE, launch };
      const calls = await edit(schedule);
      await page.getByRole("button", { name: m.schedules_save(), exact: true }).click();
      await vi.waitFor(() =>
        expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
          name: "Triage",
          prompt: "/triage-feedback",
          days: 31,
          times: ["09:00", "18:00"],
          interval: null,
          usageLimit: null,
          launch,
        }),
      );
    },
  );

  it("clears model and effort when returning to an inherited provider", async () => {
    globals({ defaultAgentProvider: "codex" });
    const calls = await edit({ ...TRIAGE, launch: ownLaunch });
    await page.getByRole("button", { name: m.schedules_use_default(), exact: true }).click();
    await page.getByRole("button", { name: m.schedules_save(), exact: true }).click();
    await vi.waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({
        launch: { agentProvider: null, model: null, effort: null, research: true },
      }),
    );
  });

  it("preserves model and effort on a repeated engine click", async () => {
    await edit({ ...TRIAGE, launch: { ...ownLaunch, model: "gpt-5.4" } });
    await page.getByRole("button", { name: /Codex/ }).click();
    await expect.element(page.getByLabelText(m.schedules_field_model())).toHaveValue("gpt-5.4");
    await expect.element(page.getByLabelText(m.schedules_field_effort())).toHaveValue("high");
    await page.getByRole("button", { name: /Claude Code/ }).click();
    await expect.element(page.getByLabelText(m.schedules_field_model())).toHaveValue("");
    await expect.element(page.getByLabelText(m.schedules_field_effort())).toHaveValue("");
  });

  it.each(["global", "repo"])("resolves the %s default without pinning it", async (source) => {
    globals({ defaultAgentProvider: source === "global" ? "codex" : "claude" });
    await edit();
    if (source === "repo") repoConfig.agentProvider = { "/repo-a": "codex" };
    await expect
      .element(page.getByRole("button", { name: /Codex/ }))
      .toHaveAttribute("aria-pressed", "true");
    await expect.element(page.getByRole("button", { name: /Codex/ })).toMatchTextContent(/Default/);
  });
});

describe("schedule capacity preview", () => {
  it("shows both providers' windows and reflects telemetry changes", async () => {
    globals();
    store.usageLimits = usage();
    await edit();
    await expect
      .element(page.getByRole("button", { name: /Claude Code/ }))
      .toMatchTextContent(/Week 62 % · 5 h 18 %/);
    await expect
      .element(page.getByRole("button", { name: /Codex/ }))
      .toMatchTextContent(/Week 43 % · 5 h 12 %/);
    await expect.poll(() => footer().textContent).toContain(m.schedules_would_start());
    store.usageLimits = usage(84);
    await expect
      .poll(() => footer().textContent)
      .toContain(m.schedules_would_hold({ pct: 84, hold: 80 }));
    store.usageLimits = null;
    store.diagnostics = null;
    await expect
      .element(page.getByRole("button", { name: /Claude Code/ }))
      .toMatchTextContent(/Usage unknown/);
    expect(footer().textContent).not.toContain(m.schedules_would_start());
    expect(footer().textContent).not.toContain("would be held");
  });

  it("does not apply the Claude threshold to Codex", async () => {
    globals();
    store.usageLimits = usage(84, 99);
    await edit();
    await page.getByRole("button", { name: /Codex/ }).click();
    await expect.poll(() => footer().textContent).toContain(m.schedules_would_start());
    store.usageLimits = usage(84, 100);
    await expect
      .poll(() => footer().textContent)
      .toContain(m.schedules_would_hold({ pct: 100, hold: 100 }));
  });

  it("honors disabled Claude holding and shows partial and stale data honestly", async () => {
    globals({ usageHoldEnabled: false });
    const data = usage(84, null);
    data.session5h = null;
    data.stale = true;
    store.usageLimits = data;
    await edit();
    await expect
      .element(page.getByRole("button", { name: /Claude Code/ }))
      .toMatchTextContent(/Week 84 % · 5 h — %/);
    expect(document.querySelector(".engine.stale")).not.toBeNull();
    await expect.poll(() => footer().textContent).toContain(m.schedules_would_start());
    await page.getByRole("button", { name: /Codex/ }).click();
    await expect
      .element(page.getByRole("button", { name: /Codex/ }))
      .toMatchTextContent(/Usage unknown/);
    expect(footer().textContent).not.toContain(m.schedules_would_start());
  });

  it("updates upcoming slots and clears the verdict when all days are deselected", async () => {
    globals();
    store.usageLimits = usage();
    await edit();
    const preview = () => document.querySelector(".preview p")!.textContent;
    const before = preview();
    const field = page.getByLabelText(m.schedules_field_time_n({ n: 1 }));
    await field.fill("07:15");
    // time inputs commit on change, the same event as the existing dialog.
    (field.element() as HTMLInputElement).dispatchEvent(new Event("change", { bubbles: true }));
    await expect.poll(preview).not.toBe(before);
    for (const day of Array.from(
      document.querySelectorAll<HTMLButtonElement>(".days [aria-pressed=true]"),
    )) {
      await userEvent.click(day);
    }
    await expect.poll(preview).toBe(m.schedules_upcoming_empty());
    expect(footer().textContent?.trim()).toBe(m.schedules_upcoming_empty());
    await expect
      .element(page.getByRole("button", { name: m.schedules_save(), exact: true }))
      .toBeDisabled();
  });
});

describe("schedule responsive behavior", () => {
  it("places advanced on the left and engine on the right at desktop widths", async () => {
    await edit();
    const name = document.querySelector(".what")!.getBoundingClientRect();
    const engine = document.querySelector(".engine-fields")!.getBoundingClientRect();
    const advanced = document.querySelector(".advanced")!.getBoundingClientRect();
    expect(name.right).toBeLessThan(engine.left);
    expect(Math.abs(advanced.left - name.left)).toBeLessThan(1);
    expect((document.querySelector(".advanced") as HTMLDetailsElement).open).toBe(false);
    await page.getByRole("button", { name: m.common_close(), exact: true }).click();
    await expect
      .poll(() => (document.querySelector("dialog") as HTMLDialogElement).open)
      .toBe(false);
  });

  it.each([320, 390, 768])(
    "keeps controls touchable and footer visible at %i px",
    async (width) => {
      await page.viewport(width, 700);
      await edit();
      await page.getByRole("tab", { name: m.schedules_tab_when(), exact: true }).click();
      const dlg = document.querySelector("dialog")!.getBoundingClientRect();
      expect(dlg.height).toBe(700);
      const save = page
        .getByRole("button", { name: m.schedules_save(), exact: true })
        .element()
        .getBoundingClientRect();
      expect(save.bottom).toBeLessThanOrEqual(700);
      for (const control of document.querySelectorAll<HTMLElement>(
        "dialog button, dialog input, dialog select, dialog summary",
      )) {
        const r = control.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        expect(r.width, control.outerHTML).toBeGreaterThanOrEqual(44);
        expect(r.height, control.outerHTML).toBeGreaterThanOrEqual(44);
      }
    },
  );

  it("marks hidden invalid tabs, reveals invalid fields, and keeps field state across layouts", async () => {
    await page.viewport(390, 700);
    await edit();
    await page.getByLabelText(m.schedules_field_name()).fill("");
    await page.getByRole("tab", { name: m.schedules_tab_when(), exact: true }).click();
    await expect
      .element(
        page.getByRole("tab", {
          name: m.schedules_tab_invalid({ tab: m.schedules_tab_what() }),
          exact: true,
        }),
      )
      .toBeVisible();
    document.querySelector("form")!.reportValidity();
    await expect.element(page.getByLabelText(m.schedules_field_name())).toBeVisible();
    await expect
      .poll(() => document.activeElement)
      .toBe(page.getByLabelText(m.schedules_field_name()).element());
    await page.getByLabelText(m.schedules_field_name()).fill("Kept draft");
    await page.getByRole("tab", { name: m.schedules_tab_with(), exact: true }).click();
    await page.getByRole("button", { name: m.schedules_mode_research(), exact: true }).click();
    await page.viewport(1280, 900);
    await expect.element(page.getByLabelText(m.schedules_field_name())).toHaveValue("Kept draft");
    await expect
      .element(page.getByRole("button", { name: m.schedules_mode_research(), exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    await page.viewport(390, 700);
    const tab = page.getByRole("tab", { name: m.schedules_tab_with(), exact: true });
    await userEvent.click(tab);
    await userEvent.keyboard("{Home}");
    await expect
      .element(page.getByRole("tab", { name: m.schedules_tab_what(), exact: true }))
      .toHaveAttribute("aria-selected", "true");
    await expect.element(page.getByLabelText(m.schedules_field_name())).toHaveValue("Kept draft");
  });

  it("grows the prompt, caps it near twelve lines, and keeps the footer outside scrolling content", async () => {
    await edit();
    const field = page.getByLabelText(m.schedules_field_prompt());
    const textarea = field.element() as HTMLTextAreaElement;
    const initial = textarea.clientHeight;
    await field.fill(Array(8).fill("A line of prompt").join("\n"));
    await expect.poll(() => textarea.clientHeight).toBeGreaterThan(initial);
    await field.fill(Array(40).fill("A line of prompt").join("\n"));
    await expect.poll(() => textarea.scrollHeight).toBeGreaterThan(textarea.clientHeight);
    expect(textarea.clientHeight).toBeLessThan(320);
    const save = page
      .getByRole("button", { name: m.schedules_save(), exact: true })
      .element()
      .getBoundingClientRect();
    expect(save.bottom).toBeLessThanOrEqual(900);
    await page.viewport(390, 700);
    await page.getByRole("tab", { name: m.schedules_tab_with(), exact: true }).click();
    await page.getByText(m.schedules_advanced(), { exact: true }).click();
    await page.getByRole("tab", { name: m.schedules_tab_when(), exact: true }).click();
    for (let i = 0; i < 10; i++)
      await page.getByRole("button", { name: m.schedules_time_add(), exact: true }).click();
    const body = document.querySelector(".sched-body")!;
    body.scrollTop = body.scrollHeight;
    const mobileSave = page
      .getByRole("button", { name: m.schedules_save(), exact: true })
      .element()
      .getBoundingClientRect();
    expect(mobileSave.bottom).toBeLessThanOrEqual(700);
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
  });
});

const RUN: ScheduleRun = {
  id: 1,
  scheduleId: "s1",
  slotKey: "manual:now",
  at: Date.UTC(2026, 10, 9, 7),
  outcome: "noop",
  sessionId: "session/a ?",
  reason: "Keine Änderungen <script> & evidence",
};
const response = (runs: ScheduleRun[]) => new Response(JSON.stringify({ runs }));
const historyButton = () => page.getByRole("button", { name: "History", exact: true });
const historyList = () => document.querySelector(".sc-history");

describe("schedule row history", () => {
  it("loads lazily, shows an empty history, and uses both disclosure buttons", async () => {
    const calls = mockApi([{ ...TRIAGE, lastRun: RUN }]);
    render(AutomationSchedules, { repoPath: TRIAGE.repoPath });
    await expect.element(page.getByText("Triage", { exact: true })).toBeVisible();
    expect(calls.some((c) => c.url.endsWith("/runs"))).toBe(false);
    const last = page.getByRole("button", { name: /Last: nothing to do ·/ });
    await last.click();
    await expect.element(page.getByText("No runs yet.", { exact: true })).toBeVisible();
    await expect.element(historyButton()).toHaveAttribute("aria-expanded", "true");
    expect(last.element().getAttribute("aria-controls")).toBe(
      historyButton().element().getAttribute("aria-controls"),
    );
    await historyButton().click();
    expect(historyList()).toBeNull();
    await expect.element(last).toHaveAttribute("aria-expanded", "false");
  });

  it("shows failures and recovers on reopening", async () => {
    let fail = true;
    mockApi([TRIAGE], async () => (fail ? new Response("oops", { status: 500 }) : response([])));
    render(AutomationSchedules, { repoPath: TRIAGE.repoPath });
    await historyButton().click();
    await expect
      .element(page.getByText("Couldn't load the history.", { exact: true }))
      .toBeVisible();
    expect(historyList()?.textContent).not.toContain("No runs yet.");
    await historyButton().click();
    fail = false;
    await historyButton().click();
    await expect.element(page.getByText("No runs yet.", { exact: true })).toBeVisible();
  });

  it("shows the newest twenty runs with local time, escaped summaries and session links", async () => {
    const runs = Array.from({ length: 50 }, (_, i) => ({
      ...RUN,
      id: 50 - i,
      at: RUN.at - i * 60_000,
      reason: `Summary ${i} <script>`,
      sessionId: i === 0 ? RUN.sessionId : null,
    }));
    mockApi([TRIAGE], async () => response(runs));
    render(AutomationSchedules, { repoPath: TRIAGE.repoPath });
    await historyButton().click();
    await expect.poll(() => historyList()?.querySelectorAll("li").length).toBe(20);
    const items = historyList()!.querySelectorAll("li");
    expect(items[0].textContent).toContain("Summary 0 <script>");
    expect(items[19].textContent).toContain("Summary 19 <script>");
    expect(historyList()!.querySelector("script")).toBeNull();
    const time = items[0].querySelector("time")!;
    expect(time.textContent).toBe(
      new Intl.DateTimeFormat("en", { dateStyle: "short", timeStyle: "short" }).format(RUN.at),
    );
    expect(time.dateTime).toBe(new Date(RUN.at).toISOString());
    const link = page.getByRole("link", { name: RUN.sessionId!, exact: true });
    await expect.element(link).toHaveAttribute("href", "/?session=session%2Fa%20%3F");
    // The app reads ?session on mount, so same-route SPA navigation must be bypassed.
    await expect.element(link).toHaveAttribute("data-sveltekit-reload");
  });

  it("uses each historical stale reason even after changing cadence", async () => {
    const run: ScheduleRun = {
      ...RUN,
      outcome: "skipped:stale",
      reason: "missed by more than one interval",
    };
    mockApi([{ ...TRIAGE, lastRun: run }], async () =>
      response([run, { ...run, id: run.id + 1, reason: "missed slot older than 12h" }]),
    );
    render(AutomationSchedules, { repoPath: TRIAGE.repoPath });
    await page
      .getByRole("button", { name: /Last: skipped, missed by more than one interval/ })
      .click();
    await expect
      .element(page.getByText(m.schedules_outcome_interval_stale(), { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByText(m.schedules_outcome_stale(), { exact: true }))
      .toBeVisible();
  });

  it("keeps future outcomes neutral in both the row and history", async () => {
    const run = { ...RUN, outcome: "future:result" } as unknown as ScheduleRun;
    mockApi([{ ...TRIAGE, lastRun: run }], async () => response([run]));
    render(AutomationSchedules, { repoPath: TRIAGE.repoPath });
    const last = page.getByRole("button", { name: /Last: future:result ·/ });
    await last.click();
    await expect.element(page.getByText("future:result", { exact: true })).toBeVisible();
    expect(last.element().classList.contains("neutral")).toBe(true);
    expect(historyList()!.querySelector(".sc-outcome")!.classList.contains("neutral")).toBe(true);
  });

  it.each([
    ["error", "red"],
    ["claimed", "red"],
    ["held", "amber"],
    ["skipped:overlap", "amber"],
    ["skipped:stale", "amber"],
    ["spawned", "neutral"],
  ] as const)(
    "uses the same outcome color for %s in the row and history",
    async (outcome, tone) => {
      const run = { ...RUN, outcome };
      mockApi([{ ...TRIAGE, lastRun: run }], async () => response([run]));
      render(AutomationSchedules, { repoPath: TRIAGE.repoPath });
      const last = page.getByRole("button", { name: /Last:/ });
      await last.click();
      await expect
        .poll(() => historyList()?.querySelector(".sc-outcome")?.classList.contains(tone))
        .toBe(true);
      expect(last.element().classList.contains(tone)).toBe(true);
    },
  );

  it("reloads an open history through real events and local run-now, but ignores other repos and closed histories", async () => {
    let runs: ScheduleRun[] = [];
    const calls = mockApi([TRIAGE], async () => response(runs));
    render(AutomationSchedules, { repoPath: TRIAGE.repoPath });
    await historyButton().click();
    await expect.element(page.getByText("No runs yet.", { exact: true })).toBeVisible();
    const count = () => calls.filter((c) => c.url.endsWith("/runs")).length;
    store.apply({ event: "schedules:changed", data: { repoPath: "/another" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(count()).toBe(1);
    runs = [RUN];
    store.apply({ event: "schedules:changed", data: { repoPath: TRIAGE.repoPath } });
    await expect.element(page.getByRole("link", { name: RUN.sessionId! })).toBeVisible();
    expect(count()).toBe(2);
    runs = [];
    await page.getByRole("button", { name: m.schedules_run_now(), exact: true }).click();
    await expect.element(page.getByText("No runs yet.", { exact: true })).toBeVisible();
    expect(count()).toBe(3);
    await historyButton().click();
    store.apply({ event: "schedules:changed", data: { repoPath: TRIAGE.repoPath } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(count()).toBe(3);
  });

  it("recovers from an event reload failure on the next event", async () => {
    let fail = false;
    mockApi([TRIAGE], async () => (fail ? new Response("oops", { status: 500 }) : response([RUN])));
    render(AutomationSchedules, { repoPath: TRIAGE.repoPath });
    await historyButton().click();
    await expect.element(page.getByRole("link", { name: RUN.sessionId! })).toBeVisible();
    fail = true;
    store.apply({ event: "schedules:changed", data: { repoPath: TRIAGE.repoPath } });
    await expect
      .element(page.getByText("Couldn't load the history.", { exact: true }))
      .toBeVisible();
    fail = false;
    store.apply({ event: "schedules:changed", data: { repoPath: TRIAGE.repoPath } });
    await expect.element(page.getByRole("link", { name: RUN.sessionId! })).toBeVisible();
    expect(historyList()!.textContent).not.toContain("Couldn't load");
  });

  it("discards a slow older response after a newer event response", async () => {
    let finish!: (r: Response) => void;
    let first = true;
    mockApi([TRIAGE], async () => {
      if (!first) return response([RUN]);
      first = false;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    render(AutomationSchedules, { repoPath: TRIAGE.repoPath });
    await historyButton().click();
    await expect.element(page.getByText(m.common_loading(), { exact: true })).toBeVisible();
    store.apply({ event: "schedules:changed", data: { repoPath: TRIAGE.repoPath } });
    await expect.element(page.getByRole("link", { name: RUN.sessionId! })).toBeVisible();
    finish(response([]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect.element(page.getByRole("link", { name: RUN.sessionId! })).toBeVisible();
  });
});

describe("schedule history lifecycle", () => {
  it("invalidates a pending response when closed and reloads on reopening", async () => {
    let finish!: (r: Response) => void;
    let first = true;
    mockApi([TRIAGE], async () => {
      if (!first) return response([RUN]);
      first = false;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const view = await render(AutomationSchedules, { repoPath: TRIAGE.repoPath });
    await historyButton().click();
    await expect.element(page.getByText(m.common_loading(), { exact: true })).toBeVisible();
    await historyButton().click();
    await historyButton().click();
    await expect.element(page.getByRole("link", { name: RUN.sessionId! })).toBeVisible();
    finish(response([]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect.element(page.getByRole("link", { name: RUN.sessionId! })).toBeVisible();
    await view.unmount();
    expect(historyList()).toBeNull();
  });

  it("renders a local next time and a clock-driven age", async () => {
    const { clock } = await import("#lib/now.svelte.js");
    const previous = clock.current;
    clock.current = RUN.at + 2 * 3_600_000;
    try {
      mockApi([
        {
          ...TRIAGE,
          nextAt: RUN.at + 86_400_000,
          lastRun: RUN,
          launch: { ...TRIAGE.launch, agentProvider: "claude" },
        },
      ]);
      render(AutomationSchedules, { repoPath: TRIAGE.repoPath });
      await expect.element(page.getByText("Claude Code", { exact: true })).toBeVisible();
      await expect
        .element(
          page.getByRole("button", { name: "Last: nothing to do · 2 hours ago", exact: true }),
        )
        .toBeVisible();
      const next = new Intl.DateTimeFormat("en", {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      }).format(RUN.at + 86_400_000);
      await expect.element(page.getByText(`Next: ${next}`, { exact: true })).toBeVisible();
      clock.current += 3_600_000;
      await expect
        .element(
          page.getByRole("button", { name: "Last: nothing to do · 3 hours ago", exact: true }),
        )
        .toBeVisible();
    } finally {
      clock.current = previous;
    }
  });
});

describe("schedule row controls", () => {
  it("uses named SVG actions and shows engine and mode chips", async () => {
    mockApi([{ ...TRIAGE, launch: { ...TRIAGE.launch, agentProvider: "codex", research: true } }]);
    render(AutomationSchedules, { repoPath: TRIAGE.repoPath });
    await expect.element(page.getByText("Triage", { exact: true })).toBeVisible();
    for (const name of [m.schedules_run_now(), m.schedules_edit(), m.schedules_delete()]) {
      expect(
        page.getByRole("button", { name, exact: true }).element().querySelector("svg"),
      ).not.toBeNull();
    }
    expect(document.querySelector(".rs-glyph svg")).not.toBeNull();
    expect(document.querySelector(".rs-glyph")!.textContent).not.toContain("⏱");
    await expect.element(page.getByText("Codex", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText(m.schedules_mode_research(), { exact: true }))
      .toBeVisible();
    expect(getComputedStyle(document.querySelector(".sc-cadence")!).fontFamily).toBe(
      getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim(),
    );
  });

  it("resets delete confirmation after four seconds", async () => {
    const nativeTimeout = globalThis.setTimeout;
    let expire!: () => void;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      if (ms === 4000) expire = fn;
      return nativeTimeout(fn, ms, ...args);
    }) as typeof setTimeout);
    const calls = mockApi([TRIAGE]);
    render(AutomationSchedules, { repoPath: TRIAGE.repoPath });
    await page.getByRole("button", { name: m.schedules_delete(), exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: m.schedules_delete_confirm(), exact: true }))
      .toBeVisible();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expire();
    await page.getByRole("button", { name: m.schedules_delete(), exact: true }).click();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await page.getByRole("button", { name: m.schedules_delete_confirm(), exact: true }).click();
    await vi.waitFor(() => expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1));
  });

  it.each([320, 390, 768, 1280])("keeps long content and actions within %i px", async (width) => {
    await page.viewport(width, 900);
    mockApi([{ ...TRIAGE, name: "LongName".repeat(35), lastRun: RUN }]);
    render(AutomationSchedules, { repoPath: TRIAGE.repoPath });
    await historyButton().click();
    await expect.element(page.getByText("No runs yet.", { exact: true })).toBeVisible();
    const row = document.querySelector<HTMLElement>(".sc-row")!;
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
    for (const button of row.querySelectorAll<HTMLButtonElement>(".icon-btn")) {
      const rect = button.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(width);
      if (width <= 768) {
        expect(rect.width).toBeGreaterThanOrEqual(44);
        expect(rect.height).toBeGreaterThanOrEqual(44);
      }
    }
    expect(getComputedStyle(row.querySelector(".sc-chips")!).flexWrap).toBe("wrap");
  });
});

describe("schedule interval editor", () => {
  it("retains both drafts, validates the end and saves only interval cadence", async () => {
    const calls = await edit();
    await page.getByRole("button", { name: m.schedules_cadence_interval(), exact: true }).click();
    await expect
      .element(
        page.getByText(m.schedules_interval_stats({ perDay: 40, perWeek: 200, last: "17:45" })),
      )
      .toBeVisible();
    await expect.element(page.getByText(m.schedules_interval_overlap())).toBeVisible();
    await page.getByLabelText(m.schedules_interval_from(), { exact: true }).fill("10:00");
    await page.getByLabelText(m.schedules_interval_until(), { exact: true }).fill("09:00");
    await expect.element(page.getByText(m.schedules_interval_end_error())).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: m.schedules_save(), exact: true }))
      .toBeDisabled();
    await page.getByRole("button", { name: m.schedules_cadence_fixed(), exact: true }).click();
    await expect
      .element(page.getByLabelText(m.schedules_field_time_n({ n: 1 })))
      .toHaveValue("09:00");
    await page.getByRole("button", { name: m.schedules_cadence_interval(), exact: true }).click();
    await expect
      .element(page.getByLabelText(m.schedules_interval_from(), { exact: true }))
      .toHaveValue("10:00");
    await page.getByLabelText(m.schedules_interval_all_day()).click();
    await page.getByLabelText(m.schedules_interval_all_day()).click();
    await expect
      .element(page.getByLabelText(m.schedules_interval_until(), { exact: true }))
      .toHaveValue("09:00");
    await page.getByLabelText(m.schedules_interval_all_day()).click();
    await page.getByRole("button", { name: m.schedules_save(), exact: true }).click();
    await vi.waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({
        times: [],
        interval: { everyMinutes: 15, from: null, until: null },
      }),
    );
  });
  it("saves a bounded interval and updates counts with cadence and weekdays", async () => {
    const calls = await edit();
    await page.getByRole("button", { name: m.schedules_cadence_interval(), exact: true }).click();
    await page
      .getByRole("combobox", { name: m.schedules_cadence_interval(), exact: true })
      .selectOptions("30");
    await page.getByRole("button", { name: m.schedules_preset_daily(), exact: true }).click();
    await expect
      .element(
        page.getByText(m.schedules_interval_stats({ perDay: 20, perWeek: 140, last: "17:30" })),
      )
      .toBeVisible();
    await page.getByRole("button", { name: m.schedules_save(), exact: true }).click();
    await vi.waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({
        days: 127,
        times: [],
        interval: { everyMinutes: 30, from: "08:00", until: "18:00" },
      }),
    );
  });
  it("edits an existing interval on mobile and can save fixed times", async () => {
    await page.viewport(390, 700);
    const calls = await edit({
      ...TRIAGE,
      times: [],
      interval: { everyMinutes: 30, from: "08:00", until: "18:00" },
    });
    await page.getByRole("tab", { name: m.schedules_tab_when(), exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: m.schedules_cadence_interval(), exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: m.schedules_cadence_fixed(), exact: true }).click();
    await page.getByRole("button", { name: m.schedules_save(), exact: true }).click();
    await vi.waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({
        times: ["09:00"],
        interval: null,
      }),
    );
  });
});

describe("schedule usage limit editor", () => {
  it("sets a from limit, shows its allowed range and verdict, and persists it", async () => {
    store.usageLimits = usage(85, 40);
    const calls = await edit();
    await page.getByRole("button", { name: m.schedules_limit_from(), exact: true }).click();
    const meter = page.getByRole("meter", { name: m.schedules_limit_section(), exact: true });
    await expect.element(meter).toHaveAttribute("aria-valuenow", "85");
    expect((document.querySelector(".allowed") as HTMLElement).style.left).toBe("80%");
    expect((document.querySelector(".allowed") as HTMLElement).style.width).toBe("15%");
    expect(getComputedStyle(document.querySelector(".stop-zone")!).backgroundImage).toContain(
      "repeating-linear-gradient",
    );
    await expect
      .element(page.getByText(m.schedules_limit_verdict_ok({ pct: 85 }), { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByText(m.schedules_limit_replaces({ hold: 80 }), { exact: true }))
      .toBeVisible();
    expect(footer().textContent).toContain(m.schedules_limit_footer_ok());
    expect(document.querySelector(".limits")!.textContent).toContain("resets");
    await page.getByRole("button", { name: m.schedules_save(), exact: true }).click();
    await vi.waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({
        usageLimit: { kind: "from", startPct: 80, startWindow: "week", stopPct: 95 },
      }),
    );
  });

  it("re-evaluates live data and distinguishes unknown usage from zero", async () => {
    store.usageLimits = usage(79, 40);
    await edit({
      ...TRIAGE,
      usageLimit: { kind: "from", startPct: 80, startWindow: "week", stopPct: 95 },
    });
    await expect
      .element(
        page.getByText(m.schedules_limit_verdict_below({ pct: 79, start: 80 }), { exact: true }),
      )
      .toBeVisible();
    store.usageLimits = usage(95, 40);
    await expect
      .element(
        page.getByText(m.schedules_limit_verdict_stop({ pct: 95, stop: 95 }), { exact: true }),
      )
      .toBeVisible();
    store.usageLimits = usage(null, 40);
    await expect
      .element(
        page.getByText(m.schedules_limit_unknown_skip({ provider: "Claude Code" }), {
          exact: true,
        }),
      )
      .toBeVisible();
    expect(document.querySelector(".marker")).toBeNull();
    expect(document.querySelector(".usage-meter")?.getAttribute("role")).toBe("group");
    expect(document.querySelector(".usage-meter")?.getAttribute("aria-valuenow")).toBeNull();
    await page.getByRole("button", { name: m.schedules_limit_up(), exact: true }).click();
    await expect
      .element(
        page.getByText(m.schedules_limit_unknown_start({ provider: "Claude Code" }), {
          exact: true,
        }),
      )
      .toBeVisible();
  });

  it("keeps limit drafts across mobile tabs and rejects start at stop", async () => {
    await page.viewport(390, 700);
    await edit();
    await page.getByRole("tab", { name: m.schedules_limit_tab(), exact: true }).click();
    await page.getByRole("button", { name: m.schedules_limit_from(), exact: true }).click();
    await page.getByRole("spinbutton", { name: /Stop at/ }).fill("80");
    await expect
      .element(page.getByRole("button", { name: m.schedules_save(), exact: true }))
      .toBeDisabled();
    await expect
      .element(page.getByText(m.schedules_limit_invalid(), { exact: true }))
      .toBeVisible();
    await page.getByRole("tab", { name: m.schedules_tab_what(), exact: true }).click();
    await expect
      .element(
        page.getByRole("tab", {
          name: m.schedules_tab_invalid({ tab: m.schedules_limit_tab() }),
          exact: true,
        }),
      )
      .toBeVisible();
    await page
      .getByRole("tab", {
        name: m.schedules_tab_invalid({ tab: m.schedules_limit_tab() }),
        exact: true,
      })
      .click();
    await page.getByRole("spinbutton", { name: /Stop at/ }).fill("90");
    await page.getByRole("button", { name: m.schedules_limit_5h(), exact: true }).click();
    await page.getByRole("tab", { name: m.schedules_tab_what(), exact: true }).click();
    await page.getByRole("tab", { name: m.schedules_limit_tab(), exact: true }).click();
    await expect.element(page.getByRole("spinbutton", { name: /Stop at/ })).toHaveValue(90);
    await expect
      .element(page.getByRole("button", { name: m.schedules_limit_5h(), exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    await page.viewport(1280, 900);
    await expect.element(page.getByRole("spinbutton", { name: /Stop at/ })).toHaveValue(90);
  });

  it("shows the current limit chip and the captured historic threshold", async () => {
    mockApi([
      {
        ...TRIAGE,
        usageLimit: { kind: "upTo", stopPct: 50 },
        lastRun: {
          ...RUN,
          outcome: "skipped:limit",
          reason: "below-start",
          usage: { provider: "claude", window: "week", usedPct: 79, thresholdPct: 80 },
        },
      },
    ]);
    render(AutomationSchedules, { repoPath: TRIAGE.repoPath });
    await expect
      .element(page.getByText(m.schedules_limit_chip_up({ stop: 50 }), { exact: true }))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: /still below 80 %/ })).toBeVisible();
  });
});

describe("schedule mismatch actions", () => {
  it.each([
    ["waiting:limit", "held – waiting for the usage limit"],
    ["skipped:limit-expired", "expired – limit not met in time"],
    ["spawned:failover", "started with Codex"],
  ] as const)("shows %s in last run and history", async (outcome, label) => {
    const run: ScheduleRun = {
      ...RUN,
      outcome,
      usage: { provider: "codex", window: "max", usedPct: 40, thresholdPct: 70 },
    };
    mockApi([{ ...TRIAGE, lastRun: run }], async () => response([run]));
    render(AutomationSchedules, { repoPath: TRIAGE.repoPath });
    const last = page.getByRole("button", { name: new RegExp(`Last: ${label}`) });
    await expect.element(last).toBeVisible();
    await last.click();
    await vi.waitFor(() => expect(historyList()?.textContent).toContain(label));
  });

  it("keeps the action group keyboard-accessible and within the mobile panel", async () => {
    await page.viewport(390, 700);
    await edit({ ...TRIAGE, usageLimit: { kind: "upTo", stopPct: 70 } });
    await page.getByRole("tab", { name: m.schedules_limit_tab(), exact: true }).click();
    const skip = page.getByRole("radio", { name: m.schedules_limit_action_skip(), exact: true });
    await skip.click();
    await userEvent.keyboard("{ArrowDown}");
    await expect
      .element(page.getByRole("radio", { name: m.schedules_limit_action_wait(), exact: true }))
      .toBeChecked();
    const group = document.querySelector(".mismatch-actions")!;
    expect(group.scrollWidth).toBeLessThanOrEqual(group.clientWidth);
  });

  it("names the opposite provider after an engine change", async () => {
    store.diagnostics = {
      checks: [
        { id: "claude", state: "ok" },
        { id: "codex", state: "ok" },
      ],
    } as any;
    await edit({
      ...TRIAGE,
      usageLimit: { kind: "upTo", stopPct: 70, onMismatch: "otherProvider" },
    });
    await page.getByRole("button", { name: /Codex/ }).click();
    await expect
      .element(
        page.getByRole("radio", {
          name: m.schedules_limit_action_other({ other: "Claude Code" }),
          exact: true,
        }),
      )
      .toBeChecked();
  });
  it("shows no actions without a limit and preserves wait through limit-kind changes", async () => {
    store.usageLimits = usage(95, 40);
    const calls = await edit({
      ...TRIAGE,
      times: [],
      interval: { everyMinutes: 15, from: null, until: null },
    });
    expect(document.querySelector('input[value="wait"]')).toBeNull();
    await page.getByRole("button", { name: m.schedules_limit_up(), exact: true }).click();
    await page.getByRole("radio", { name: m.schedules_limit_action_wait(), exact: true }).click();
    await expect
      .element(page.getByText(m.schedules_limit_interval_wait(), { exact: true }))
      .toBeVisible();
    expect(footer().textContent).toContain(m.schedules_limit_would_wait());
    await page.getByRole("button", { name: m.schedules_limit_from(), exact: true }).click();
    await expect
      .element(page.getByRole("radio", { name: m.schedules_limit_action_wait(), exact: true }))
      .toBeChecked();
    await page.getByRole("button", { name: m.schedules_save(), exact: true }).click();
    await vi.waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({
        usageLimit: { onMismatch: "wait" },
      }),
    );
  });

  it("disables an unready counterpart without silently changing an existing selection", async () => {
    store.diagnostics = null;
    const calls = await edit({
      ...TRIAGE,
      usageLimit: { kind: "upTo", stopPct: 70, onMismatch: "otherProvider" },
    });
    const radio = page.getByRole("radio", {
      name: m.schedules_limit_action_other({ other: "Codex" }),
      exact: true,
    });
    await expect.element(radio).toBeDisabled();
    await expect.element(radio).toBeChecked();
    await expect
      .element(page.getByText(m.schedules_limit_other_unready({ other: "Codex" }), { exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: m.schedules_save(), exact: true }).click();
    await vi.waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({
        usageLimit: { onMismatch: "otherProvider" },
      }),
    );
  });

  it("predicts and persists a ready counterpart and reacts to readiness changes", async () => {
    store.usageLimits = usage(95, 40);
    store.diagnostics = {
      checks: [
        { id: "claude", state: "ok" },
        { id: "codex", state: "ok" },
      ],
    } as any;
    const calls = await edit({ ...TRIAGE, usageLimit: { kind: "upTo", stopPct: 70 } });
    await expect
      .element(page.getByRole("radio", { name: m.schedules_limit_action_skip(), exact: true }))
      .toBeChecked();
    await page
      .getByRole("radio", { name: m.schedules_limit_action_other({ other: "Codex" }), exact: true })
      .click();
    expect(footer().textContent).toContain(m.schedules_limit_would_other({ other: "Codex" }));
    await expect
      .element(page.getByText(m.schedules_limit_would_other({ other: "Codex" }), { exact: true }))
      .toBeVisible();
    store.diagnostics = null;
    await expect
      .element(
        page.getByRole("radio", {
          name: m.schedules_limit_action_other({ other: "Codex" }),
          exact: true,
        }),
      )
      .toBeDisabled();
    await vi.waitFor(() =>
      expect(footer().textContent).toContain(m.schedules_limit_footer_stop({ stop: 70 })),
    );
    await page.getByRole("button", { name: m.schedules_save(), exact: true }).click();
    await vi.waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({
        usageLimit: { onMismatch: "otherProvider" },
      }),
    );
  });
});
