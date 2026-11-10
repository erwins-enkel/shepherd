import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../../app.css";
import SettingsSchedulesPanel from "./SettingsSchedulesPanel.svelte";
import { m } from "#lib/paraglide/messages.js";
import { schedules } from "#lib/schedules.svelte.js";
import { repoSettingsWindow } from "#lib/repo-settings-window.svelte.js";
import type { RepoConfig, Settings } from "#lib/types.js";
import type { Schedule } from "#lib/types.js";

function sched(id: string, repoPath: string, name: string, nextAt: number | null): Schedule {
  return {
    id,
    repoPath,
    name,
    prompt: "/triage-feedback",
    days: 0b0011111,
    times: ["09:00"],
    enabled: nextAt !== null,
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
    nextAt,
  };
}

const NOW = Date.now();
const LIST = [
  sched("off", "/w/alpha", "Paused audit", null),
  sched("late", "/w/alpha", "Weekly digest", NOW + 7_200_000),
  sched("soon", "/w/beta", "Triage", NOW + 3_600_000),
];

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
function mockApi(list: Schedule[], agentProvider: "inherit" | "claude" | "codex" = "inherit") {
  const calls: { method: string; url: string; body: unknown }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (method === "GET" && String(input).endsWith("/runs")) {
      return new Response(
        JSON.stringify({
          runs: [
            {
              id: 1,
              scheduleId: "soon",
              slotKey: "manual:now",
              at: NOW,
              outcome: "spawned",
              sessionId: "settings-session",
              reason: null,
            },
          ],
        }),
      );
    }
    const body =
      method === "GET"
        ? String(input).includes("/api/repo-config")
          ? { ...REPO, agentProvider }
          : { schedules: list }
        : {};
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return calls;
}

const titles = () =>
  Array.from(document.querySelectorAll(".sc-title")).map((e) => e.textContent?.trim());

afterEach(() => {
  vi.restoreAllMocks();
  repoSettingsWindow.provide({ globals: () => null, drain: () => null });
  document.documentElement.removeAttribute("data-theme");
});

describe("SettingsSchedulesPanel (#3475)", () => {
  it("lists every repo's schedules, soonest first, paused last", async () => {
    const calls = mockApi(LIST);
    render(SettingsSchedulesPanel, {});
    await expect.element(page.getByText("Triage")).toBeVisible();
    expect(calls[0].url).toMatch(/\/api\/schedules$/);
    expect(titles()).toEqual(["beta Triage", "alpha Weekly digest", "alpha Paused audit"]);
  });

  it("filters to one repo", async () => {
    mockApi(LIST);
    render(SettingsSchedulesPanel, {});
    await page.getByRole("combobox").selectOptions("/w/beta");
    await vi.waitFor(() => expect(titles()).toEqual(["beta Triage"]));
  });

  it("falls back to all repos once the filtered repo has no schedules left", async () => {
    const list = [...LIST, sched("g", "/w/gamma", "Nightly", NOW + 9_000_000)];
    mockApi(list);
    render(SettingsSchedulesPanel, {});
    const select = page.getByRole("combobox");
    await select.selectOptions("/w/beta");
    await vi.waitFor(() => expect(titles()).toEqual(["beta Triage"]));
    list.splice(
      list.findIndex((s) => s.id === "soon"),
      1,
    );
    schedules.refresh("/w/beta");
    await expect.element(select).toHaveValue("");
    expect(titles()).toEqual(["alpha Weekly digest", "gamma Nightly", "alpha Paused audit"]);
    // beta's schedule coming back must not silently narrow the list again.
    list.push(sched("soon", "/w/beta", "Triage", NOW + 3_600_000));
    schedules.refresh("/w/beta");
    await vi.waitFor(() => expect(titles()).toHaveLength(4));
    await expect.element(select).toHaveValue("");
  });

  it("toggles a schedule and re-reads the global list", async () => {
    const calls = mockApi(LIST);
    render(SettingsSchedulesPanel, {});
    await page.getByRole("switch", { name: m.schedules_enabled_aria({ name: "Triage" }) }).click();
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toMatch(/\/api\/schedules\/soon$/);
    expect(patch.body).toEqual({ enabled: false });
    await vi.waitFor(() =>
      expect(calls.slice(calls.indexOf(patch)).some((c) => /\/api\/schedules$/.test(c.url))).toBe(
        true,
      ),
    );
  });

  it("edits in the schedule's own repo", async () => {
    mockApi(LIST);
    render(SettingsSchedulesPanel, {});
    await page.getByRole("button", { name: m.schedules_edit() }).first().click();
    await expect.element(page.getByLabelText(m.schedules_field_name())).toHaveValue("Triage");
  });

  it.each(["repo", "global"])(
    "resolves the %s default when editing from global schedules",
    async (source) => {
      await page.viewport(1280, 900);
      const schedule = sched(
        `default-${source}`,
        `/w/default-${source}`,
        "Inherited engine",
        NOW + 3_600_000,
      );
      const calls = mockApi([schedule], source === "repo" ? "codex" : "inherit");
      repoSettingsWindow.provide({
        globals: () =>
          ({ defaultAgentProvider: source === "global" ? "codex" : "claude" }) as Settings,
        drain: () => null,
      });
      render(SettingsSchedulesPanel, {});
      await page.getByRole("button", { name: m.schedules_edit(), exact: true }).click();
      await expect
        .element(page.getByRole("button", { name: /Codex/ }))
        .toHaveAttribute("aria-pressed", "true");
      await expect
        .element(page.getByRole("button", { name: /Codex/ }))
        .toMatchTextContent(/Default/);
      expect(
        calls.some((c) =>
          c.url.includes(`/api/repo-config?repo=${encodeURIComponent(schedule.repoPath)}`),
        ),
      ).toBe(true);
      await page.getByRole("button", { name: m.schedules_save(), exact: true }).click();
      await vi.waitFor(() =>
        expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({
          launch: { agentProvider: null },
        }),
      );
    },
  );

  it("Tab and Escape in the edit dialog never reach the Settings card", async () => {
    mockApi(LIST);
    render(SettingsSchedulesPanel, {});
    await expect.element(page.getByText("Triage")).toBeVisible();
    // a11yDialog's Escape/Tab listener on the Settings card is native, on an ancestor: here the
    // mount target, where Svelte's delegated `onkeydown` handlers also run (too late to stop it).
    const card = document.querySelector(".ssp-head")!.parentElement!;
    const cardKeys: string[] = [];
    card.addEventListener("keydown", (e) => cardKeys.push(e.key));
    await page.getByRole("button", { name: m.schedules_edit() }).first().click();
    await expect.element(page.getByLabelText(m.schedules_field_name())).toBeVisible();
    await userEvent.keyboard("{Tab}{Shift>}{Tab}{/Shift}");
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByLabelText(m.schedules_field_name())).not.toBeInTheDocument();
    expect(cardKeys.filter((k) => k === "Tab" || k === "Escape")).toEqual([]);
  });

  it("says so when no repo has schedules", async () => {
    mockApi([]);
    render(SettingsSchedulesPanel, {});
    await expect.element(page.getByText(m.settings_schedules_empty())).toBeVisible();
  });
});

describe("schedule history in settings", () => {
  it("opens the shared history alongside repo names and default/code chips", async () => {
    mockApi([LIST[2]]);
    render(SettingsSchedulesPanel, {});
    await expect.element(page.getByText("Triage")).toBeVisible();
    await expect.element(page.getByText("Default engine", { exact: true })).toBeVisible();
    await expect.element(page.getByText(m.schedules_mode_code(), { exact: true })).toBeVisible();
    const repo = document.querySelector<HTMLElement>(".sc-repo")!;
    expect(repo.textContent).toBe("beta");
    expect(repo.title).toBe("/w/beta");
    await page.getByRole("button", { name: "History", exact: true }).click();
    await expect
      .element(page.getByRole("link", { name: "settings-session", exact: true }))
      .toHaveAttribute("href", "/?session=settings-session");
    await expect
      .element(page.getByText(m.schedules_outcome_spawned(), { exact: true }))
      .toBeVisible();
  });
});

describe("schedule list themes", () => {
  it.each(["dark", "light"])(
    "keeps long paths and controls within a narrow %s list",
    async (theme) => {
      document.documentElement.dataset.theme = theme;
      await page.viewport(320, 900);
      mockApi([
        {
          ...LIST[2],
          repoPath: "/very/long/" + "repository".repeat(20),
          name: "Scheduled work ".repeat(12),
        },
      ]);
      render(SettingsSchedulesPanel, {});
      await page.getByRole("button", { name: "History", exact: true }).click();
      await expect
        .element(page.getByRole("link", { name: "settings-session", exact: true }))
        .toBeVisible();
      const row = document.querySelector<HTMLElement>(".sc-row")!;
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
      expect(getComputedStyle(row.querySelector(".sc-repo")!).fontFamily).toContain("Mono");
      for (const button of row.querySelectorAll<HTMLButtonElement>(".icon-btn")) {
        const rect = button.getBoundingClientRect();
        expect(rect.width).toBeGreaterThanOrEqual(44);
        expect(rect.height).toBeGreaterThanOrEqual(44);
        expect(rect.right).toBeLessThanOrEqual(320);
      }
    },
  );
});
