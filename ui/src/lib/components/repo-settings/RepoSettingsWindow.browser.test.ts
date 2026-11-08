import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import { tick } from "svelte";
import "../../../app.css";
import RepoSettingsWindow from "./RepoSettingsWindow.svelte";
import { sectionLabel } from "./sections";
import { m } from "#lib/paraglide/messages.js";
import { repoConfig } from "#lib/reviews.svelte.js";
import type { DrainStatus, RepoConfig, Schedule, Settings } from "#lib/types.js";

// #3443: the repo settings window — sections, saves through /api/repo-config, hints and their
// marks, keyboard + phone reach.

const BASE: RepoConfig = {
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

const GLOBALS = {
  fableAvailable: true,
  defaultAgentProvider: "claude",
  defaultModel: "opus",
  defaultCodexModel: "default",
  defaultEffort: "high",
  defaultClaudeEffort: "inherit",
  defaultCodexEffort: "inherit",
  defaultExecutionEffort: "default",
} as Settings;

const SCHEDULE: Schedule = {
  id: "s1",
  repoPath: "",
  name: "Triage",
  prompt: "/triage",
  days: 0b0011111,
  times: ["09:00"],
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

interface Api {
  puts: Record<string, unknown>[];
  scheduleWrites: { method: string; body: unknown }[];
  autoFixPosts: unknown[];
}

/** Fake the server: the repo's config (with `over`), its schedules, roles and the epic auto-fix. */
function mockApi(over: Partial<RepoConfig & { noPrCi: boolean }> = {}, autoFix?: unknown): Api {
  const api: Api = { puts: [], scheduleWrites: [], autoFixPosts: [] };
  let config: Record<string, unknown> = { ...BASE, ...over };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.startsWith("/api/repo-config")) {
      if (method === "PUT") {
        api.puts.push(body);
        config = { ...config, ...body };
      }
      return Response.json(config);
    }
    if (url.startsWith("/api/schedules")) {
      if (method !== "GET") api.scheduleWrites.push({ method, body });
      return Response.json(method === "GET" ? { schedules: [SCHEDULE] } : {});
    }
    if (url.startsWith("/api/epic/auto-fix") && autoFix) {
      if (method === "POST") {
        api.autoFixPosts.push(body);
        return Response.json({ previous: {}, blockers: autoFix });
      }
      return Response.json(autoFix);
    }
    return new Response("{}", { status: 404 });
  });
  return api;
}

let n = 0;
let repo = "";
beforeEach(async () => {
  repo = `/work/rs-${++n}`;
  await page.viewport(1280, 900);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const tab = (label: string) => page.getByRole("tab", { name: new RegExp(`^${label}`) });
const sw = (name: string) => page.getByRole("switch", { name });

async function open(props: Partial<{ section: string; drain: DrainStatus; onclose: () => void }>) {
  const onclose = props.onclose ?? vi.fn();
  render(RepoSettingsWindow, {
    repoPath: repo,
    globals: GLOBALS,
    onclose,
    ...props,
  } as never);
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await vi.waitFor(() => expect(repoConfig.isConfigLoaded(repo)).toBe(true));
  return onclose;
}

describe("RepoSettingsWindow", () => {
  it("names the repo, lists every section with its status and opens on the agent's", async () => {
    mockApi();
    await open({});
    await expect
      .element(page.getByRole("dialog", { name: m.reposettings_dialog_label({ repo: `rs-${n}` }) }))
      .toBeVisible();
    const names = [...document.querySelectorAll('[role="tab"] .label')].map((t) =>
      t.textContent!.trim(),
    );
    expect(names).toEqual([
      m.reposettings_section_agent(),
      m.reposettings_section_start(),
      m.reposettings_section_schedules(),
      m.reposettings_section_review(),
      m.reposettings_section_merge(),
      m.reposettings_section_epics(),
      m.reposettings_section_display(),
    ]);
    await expect
      .element(tab(m.reposettings_section_agent()))
      .toHaveAttribute("aria-selected", "true");
    await expect.element(tab(m.reposettings_section_agent())).toHaveFocus();
    await expect
      .element(tab(m.reposettings_section_review()))
      .toMatchTextContent(m.reposettings_summary_on({ on: 1, total: 4 }));
  });

  it("opens at the asked section and moves between sections by arrow key", async () => {
    mockApi();
    await open({ section: "merge" });
    await expect.element(tab(m.reposettings_section_merge())).toHaveFocus();
    await expect.element(sw(m.automation_automerge_name())).toBeVisible();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(tab(m.reposettings_section_epics())).toHaveFocus();
    await expect.element(sw(m.automation_epic_stacks_name())).toBeVisible();
    expect(sw(m.automation_automerge_name()).query()).toBeNull();
  });

  it("closes on Escape and on ✕, and keeps Tab inside", async () => {
    mockApi();
    const onclose = await open({ section: "epics" });
    for (let i = 0; i < 12; i++) await userEvent.keyboard("{Tab}");
    const card = document.querySelector("[data-repo-settings]")!;
    expect(card.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(onclose).toHaveBeenCalledTimes(1);
    await page.getByRole("button", { name: m.common_close() }).click();
    expect(onclose).toHaveBeenCalledTimes(2);
  });
});

describe("RepoSettingsWindow — every section saves through /api/repo-config", () => {
  it("head: the repo mode", async () => {
    const api = mockApi();
    await open({});
    await page.getByRole("radio", { name: m.reposettings_mode_local() }).click();
    await vi.waitFor(() => expect(api.puts).toContainEqual({ repoMode: "lightweight" }));
  });

  it("agent environment: the sandbox", async () => {
    const api = mockApi();
    await open({ section: "agent" });
    await page
      .getByRole("combobox", { name: m.automation_sandbox_profile_label() })
      .selectOptions("autonomous");
    await vi.waitFor(() => expect(api.puts).toContainEqual({ sandboxProfile: "autonomous" }));
  });

  it("agent environment: the execution effort", async () => {
    const api = mockApi();
    await open({ section: "agent" });
    await page
      .getByRole("combobox", { name: m.automation_execution_effort_label() })
      .selectOptions("max");
    await vi.waitFor(() => expect(api.puts).toContainEqual({ defaultExecutionEffort: "max" }));
  });

  it("start & flow: the plan gate", async () => {
    const api = mockApi();
    await open({ section: "start" });
    await sw(m.automation_plan_gate_name()).click();
    await vi.waitFor(() => expect(api.puts).toContainEqual({ planGateEnabled: true }));
  });

  it("schedules: a schedule's switch writes through the schedules API", async () => {
    const api = mockApi();
    await open({ section: "schedules" });
    await sw(m.schedules_enabled_aria({ name: "Triage" })).click();
    await vi.waitFor(() =>
      expect(api.scheduleWrites).toContainEqual({ method: "PATCH", body: { enabled: false } }),
    );
    expect(api.puts).toEqual([]);
  });

  it("review: the critic", async () => {
    const api = mockApi();
    await open({ section: "review" });
    await sw(m.automation_critic_name()).click();
    await vi.waitFor(() => expect(api.puts).toContainEqual({ criticEnabled: false }));
  });

  it("merge: merge without CI", async () => {
    const api = mockApi();
    await open({ section: "merge" });
    await sw(m.automation_merge_without_ci_name()).click();
    await vi.waitFor(() => expect(api.puts).toContainEqual({ mergeWithoutCi: true }));
  });

  it("epics: stacked children", async () => {
    const api = mockApi();
    await open({ section: "epics" });
    await sw(m.automation_epic_stacks_name()).click();
    await vi.waitFor(() => expect(api.puts).toContainEqual({ epicStacksEnabled: true }));
  });

  it("display: pin to the Backlog's top", async () => {
    const api = mockApi();
    await open({ section: "display" });
    await sw(m.reposettings_pin_name()).click();
    await vi.waitFor(() => expect(api.puts).toContainEqual({ pinned: true }));
  });
});

describe("RepoSettingsWindow — pin and hide follow the Backlog list", () => {
  it("shows a flip made in the list, and the list reads a flip made here", async () => {
    mockApi();
    await open({ section: "display" });
    await expect.element(sw(m.reposettings_pin_name())).toHaveAttribute("aria-checked", "false");
    // what BacklogView's Pin calls
    await repoConfig.togglePinned(repo, repoConfig.isPinned(repo, false));
    await expect.element(sw(m.reposettings_pin_name())).toHaveAttribute("aria-checked", "true");
    await sw(m.reposettings_hide_name()).click();
    // what BacklogView reads
    await vi.waitFor(() => expect(repoConfig.isHidden(repo, false)).toBe(true));
  });
});

describe("RepoSettingsWindow — hints and their marks", () => {
  it("no PR CI: the card on top, the Merge section marked and opened, and the note there", async () => {
    mockApi({ noPrCi: true });
    await open({});
    await expect.element(page.getByText(m.automation_no_pr_ci_title())).toBeVisible();
    await expect
      .element(tab(m.reposettings_section_merge()))
      .toMatchTextContent(m.reposettings_section_flagged());
    expect(tab(m.reposettings_section_agent()).element().textContent).not.toContain(
      m.reposettings_section_flagged(),
    );
    // nothing picked yet: the window moves to the section the hint concerns
    await expect
      .element(tab(m.reposettings_section_merge()))
      .toHaveAttribute("aria-selected", "true");
    await expect.element(tab(m.reposettings_section_merge())).toHaveFocus();
    await expect.element(page.getByText(m.reposettings_no_pr_ci_note())).toBeVisible();
    await page.getByRole("button", { name: m.automation_no_pr_ci_merge_without() }).click();
    await expect.element(page.getByText(m.automation_no_pr_ci_title())).not.toBeInTheDocument();
  });

  it("an epic held by the repo's sandbox: the card, Switch to Autonomous, and the Agent mark", async () => {
    const blockers = {
      causes: [
        {
          code: "sandbox_interactive",
          scope: "repo",
          detail: "standard",
          fix: { changes: { sandboxProfile: "autonomous" }, enabled: true, checks: [] },
        },
      ],
      options: [],
      preselect: null,
    };
    const api = mockApi({ sandboxProfile: "standard" }, blockers);
    const drain: DrainStatus = {
      repoPath: repo,
      enabled: true,
      paused: true,
      reason: "sandbox_interactive",
      detail: "standard",
      queued: 1,
      inFlight: 0,
      max: 1,
      epicParent: 7,
    };
    await open({ section: "review", drain });
    await expect
      .element(page.getByText(m.repooverview_halt_title({ repo: `rs-${n}` })))
      .toBeVisible();
    await expect
      .element(tab(m.reposettings_section_agent()))
      .toMatchTextContent(m.reposettings_section_flagged());
    await page.getByRole("button", { name: m.repooverview_halt_autonomous() }).click();
    await vi.waitFor(() => expect(api.autoFixPosts).toEqual([{ cause: "sandbox_interactive" }]));
    // the sandbox is no repo-config write of the window's own
    expect(api.puts).toEqual([]);
  });

  it("the claude.ai connectors say they apply to Claude Code only", async () => {
    mockApi();
    await open({ section: "agent" });
    await expect.element(page.getByText(m.reposettings_connectors_claude_only())).toBeVisible();
  });
});

describe("RepoSettingsWindow — phone", () => {
  it("goes full screen with section chips and never scrolls sideways", async () => {
    await page.viewport(375, 800);
    mockApi({ sharedBrowserEnabled: true, browserAllowedHosts: ["a-long-host.example.com"] });
    await open({ section: "agent" });
    const card = document.querySelector<HTMLElement>("[data-repo-settings]")!;
    await vi.waitFor(() => expect(card.getBoundingClientRect().width).toBe(375));
    for (const id of ["agent", "start", "merge", "display"] as const) {
      await tab(sectionLabel(id)).click();
      await tick();
      for (const el of [card, ...card.querySelectorAll<HTMLElement>("*")]) {
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "hidden")
          expect.soft(el.scrollWidth, el.className).toBeLessThanOrEqual(el.clientWidth + 1);
      }
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
    }
    // every chip on screen, none clipped off the right edge
    for (const t of card.querySelectorAll<HTMLElement>('[role="tab"]'))
      expect(t.getBoundingClientRect().right).toBeLessThanOrEqual(375);
  });
});
