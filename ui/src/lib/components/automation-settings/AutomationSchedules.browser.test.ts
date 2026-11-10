import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../../app.css";
import AutomationSchedules from "./AutomationSchedules.svelte";
import { m } from "#lib/paraglide/messages.js";
import { HerdStore } from "#lib/store.svelte.js";
import { repoSettingsWindow } from "#lib/repo-settings-window.svelte.js";
import ScheduleDialog from "./ScheduleDialog.svelte";
import { SCHEDULE_USAGE } from "#lib/schedules.svelte.js";
import { repoConfig } from "#lib/reviews.svelte.js";
import type { UsageLimits, Settings, RepoConfig } from "#lib/types.js";
import type { Schedule } from "#lib/types.js";

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
function mockApi(list: Schedule[]) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
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
    context: new Map([[SCHEDULE_USAGE, () => store.usageLimits]]),
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
