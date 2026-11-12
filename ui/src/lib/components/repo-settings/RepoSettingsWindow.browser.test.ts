import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import { tick } from "svelte";
import "../../../app.css";
import { repoSettingsSearchEntries } from "./search";
import RepoSettingsWindow from "./RepoSettingsWindow.svelte";
import { sectionLabel } from "./sections";
import { m } from "#lib/paraglide/messages.js";
import { repoConfig } from "#lib/reviews.svelte.js";
import { mergeModePatch, type MergeMode } from "#lib/merge-mode.js";
import { AUTONOMY_LEVELS, autonomyPatch, type AutonomyLevel } from "#lib/autonomy.js";
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
  /** The config as the fake server holds it now. */
  stored: () => Record<string, unknown>;
  scheduleWrites: { method: string; body: unknown }[];
  autoFixPosts: unknown[];
}

/** Fake the server: the repo's config (with `over`), its schedules, roles and the epic auto-fix. */
function mockApi(over: Partial<RepoConfig & { noPrCi: boolean }> = {}, autoFix?: unknown): Api {
  let config: Record<string, unknown> = { ...BASE, ...over };
  const api: Api = { puts: [], stored: () => config, scheduleWrites: [], autoFixPosts: [] };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.startsWith("/api/repo-config")) {
      if (method === "PUT") {
        api.puts.push(body);
        const next = { ...config, ...body };
        // the server's cross-field invariants (src/repo-config-service.ts)
        if (next.draftMode && next.autoMergeEnabled) return new Response("{}", { status: 400 });
        if (next.draftMode && !next.criticEnabled && next.signoffAuthority !== "human")
          return new Response("{}", { status: 400 });
        config = next;
      }
      return Response.json(config);
    }
    if (url.startsWith("/api/repo-bootstrap?") && method === "GET") {
      return Response.json({
        state: "off",
        phase: 1,
        overrideAt: null,
        missing: [],
        suggested: false,
      });
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
const MODE_NAMES: Record<MergeMode, () => string> = {
  manual: () => m.reposettings_merge_mode_manual(),
  draft: () => m.reposettings_merge_mode_draft(),
  auto: () => m.automation_automerge_name(),
};
const radio = (mode: MergeMode) =>
  page.getByRole("radio", { name: MODE_NAMES[mode](), exact: true });
const signoff = () => page.getByRole("combobox", { name: m.automation_signoff_authority_label() });

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
  it("names the repo, lists every section with its status and opens on Autonomy", async () => {
    mockApi();
    await open({});
    await expect
      .element(page.getByRole("dialog", { name: m.reposettings_dialog_label({ repo: `rs-${n}` }) }))
      .toBeVisible();
    const names = [...document.querySelectorAll('[role="tab"] .label')].map((t) =>
      t.textContent!.trim(),
    );
    expect(names).toEqual([
      m.reposettings_section_autonomy(),
      m.reposettings_section_agent(),
      m.reposettings_section_start(),
      m.reposettings_section_schedules(),
      m.reposettings_section_review(),
      m.reposettings_section_merge(),
      m.reposettings_section_epics(),
      m.reposettings_section_display(),
    ]);
    await expect
      .element(tab(m.reposettings_section_autonomy()))
      .toHaveAttribute("aria-selected", "true");
    await expect.element(tab(m.reposettings_section_autonomy())).toHaveFocus();
    // the Critic alone is no level
    await expect
      .element(tab(m.reposettings_section_autonomy()))
      .toMatchTextContent(m.reposettings_autonomy_custom());
    // the hands-off guide moved into Full auto's description
    expect(document.querySelector(".rail a")).toBeNull();
    await expect
      .element(tab(m.reposettings_section_review()))
      .toMatchTextContent(m.reposettings_summary_on({ on: 1, total: 4 }));
  });

  it("opens at the asked section and moves between sections by arrow key", async () => {
    mockApi();
    await open({ section: "merge" });
    await expect.element(tab(m.reposettings_section_merge())).toHaveFocus();
    await expect.element(radio("auto")).toBeVisible();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(tab(m.reposettings_section_epics())).toHaveFocus();
    await expect.element(sw(m.automation_epic_stacks_name())).toBeVisible();
    expect(radio("auto").query()).toBeNull();
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

describe("RepoSettingsWindow — Finished PRs (#3444)", () => {
  it("every option writes both fields and never leaves draft and full-auto on together", async () => {
    const api = mockApi();
    await open({ section: "merge" });
    for (const mode of ["draft", "auto", "manual", "auto", "draft", "manual"] as const) {
      await radio(mode).click();
      await vi.waitFor(() => expect(api.puts.at(-1)).toEqual(mergeModePatch(mode)));
      await expect.element(radio(mode)).toBeChecked();
      const stored = api.stored();
      expect(stored.draftMode && stored.autoMergeEnabled).toBe(false);
      expect({ draftMode: stored.draftMode, autoMergeEnabled: stored.autoMergeEnabled }).toEqual(
        mergeModePatch(mode),
      );
    }
  });

  it("shows each saved option again after a reload", async () => {
    const api = mockApi();
    for (const mode of ["draft", "auto", "manual"] as const) {
      const first = await render(RepoSettingsWindow, {
        repoPath: repo,
        section: "merge",
        globals: GLOBALS,
        onclose: vi.fn(),
      });
      await vi.waitFor(() => expect(repoConfig.isConfigLoaded(repo)).toBe(true));
      await radio(mode).click();
      await vi.waitFor(() => expect(api.puts.at(-1)).toEqual(mergeModePatch(mode)));
      await first.unmount();
      // a reload: the store forgets the repo and reads it from the server again
      repoConfig.loaded = {};
      repoConfig.settled = {};
      repoConfig.draftMode = {};
      repoConfig.autoMerge = {};
      const again = await render(RepoSettingsWindow, {
        repoPath: repo,
        section: "merge",
        globals: GLOBALS,
        onclose: vi.fn(),
      });
      await vi.waitFor(() => expect(repoConfig.isConfigLoaded(repo)).toBe(true));
      await expect.element(radio(mode)).toBeChecked();
      for (const other of (["manual", "draft", "auto"] as const).filter((o) => o !== mode))
        await expect.element(radio(other)).not.toBeChecked();
      await again.unmount();
    }
  });

  it("Sign-off by shows only under Draft; without the Critic its Critic options are locked", async () => {
    mockApi({ criticEnabled: false });
    await open({ section: "merge" });
    expect(signoff().query()).toBeNull();
    await radio("draft").click();
    await expect.element(signoff()).toBeVisible();
    const disabled = [...signoff().element().querySelectorAll("option")]
      .filter((o) => o.disabled)
      .map((o) => o.value);
    expect(disabled).toEqual(["critic", "either"]);
    await expect.element(page.getByText(m.automation_signoff_needs_critic())).toBeVisible();
    await radio("auto").click();
    await expect.element(signoff()).not.toBeInTheDocument();
  });

  it("switching the Critic off moves a Critic sign-off to Human in the same write, visibly", async () => {
    const api = mockApi({ draftMode: true, signoffAuthority: "critic" });
    await open({ section: "review" });
    const reset = page.getByText(m.reposettings_signoff_reset_human());
    await expect.element(reset).not.toBeVisible();
    await sw(m.automation_critic_name()).click();
    await vi.waitFor(() =>
      expect(api.puts).toEqual([{ criticEnabled: false, signoffAuthority: "human" }]),
    );
    await expect.element(sw(m.automation_critic_name())).toHaveAttribute("aria-checked", "false");
    await expect.element(reset).toBeVisible();
    await tab(m.reposettings_section_merge()).click();
    await expect.element(signoff()).toHaveValue("human");
  });

  it("Full-auto merge with Autopilot off warns and links to the Autopilot switch", async () => {
    mockApi({ autoMergeEnabled: true });
    await open({ section: "merge" });
    const warning = page.getByText(m.reposettings_merge_auto_needs_autopilot());
    await expect.element(warning).toBeVisible();
    await page.getByRole("button", { name: m.reposettings_merge_goto_autopilot() }).click();
    await expect
      .element(tab(m.reposettings_section_start()))
      .toHaveAttribute("aria-selected", "true");
    await expect.element(sw(m.automation_autopilot_name())).toHaveFocus();
    await userEvent.keyboard(" ");
    await expect.element(sw(m.automation_autopilot_name())).toHaveAttribute("aria-checked", "true");
    await tab(m.reposettings_section_merge()).click();
    await expect.element(radio("auto")).toBeChecked();
    await expect.element(warning).not.toBeInTheDocument();
  });

  it("a local-only repo locks Draft with its reason and keeps the other two", async () => {
    mockApi({ repoMode: "lightweight" });
    await open({ section: "merge" });
    await expect.element(radio("draft")).toBeDisabled();
    await expect
      .element(radio("draft"))
      .toHaveAccessibleDescription(
        `${m.automation_draftmode_desc()} ${m.automation_lightweight_unavailable()}`,
      );
    await expect.element(radio("manual")).toBeEnabled();
    await expect.element(radio("auto")).toBeEnabled();
  });
});

const LEVEL_NAMES: Record<AutonomyLevel, () => string> = {
  onCall: () => m.reposettings_autonomy_oncall(),
  review: () => m.reposettings_autonomy_review(),
  backlog: () => m.reposettings_autonomy_backlog(),
  full: () => m.reposettings_autonomy_full(),
};
const level = (id: AutonomyLevel) =>
  page.getByRole("radio", { name: LEVEL_NAMES[id](), exact: true });
const LEVEL_KEYS = [
  "criticEnabled",
  "autoAddressEnabled",
  "autopilotEnabled",
  "autoDrainEnabled",
  "draftMode",
  "autoMergeEnabled",
];
/** The stored config without the five values a level sets. */
const rest = (stored: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(stored).filter(([k]) => !LEVEL_KEYS.includes(k)));

describe("RepoSettingsWindow — Autonomy (#3445)", () => {
  it("a level writes exactly its five values in one patch and leaves every other setting", async () => {
    const api = mockApi({
      planGateEnabled: true,
      buildQueueEnabled: true,
      sandboxProfile: "autonomous",
      mergeWithoutCi: true,
      signoffAuthority: "critic",
      draftMode: true,
      maxAuto: 3,
    });
    await open({});
    const before = rest(api.stored());
    for (const id of ["full", "onCall", "backlog", "review", "full"] as const) {
      const puts = api.puts.length;
      await level(id).click();
      await vi.waitFor(() => expect(api.puts).toHaveLength(puts + 1));
      expect(api.puts.at(-1)).toEqual(autonomyPatch(id));
      await expect.element(level(id)).toBeChecked();
      await expect
        .element(tab(m.reposettings_section_autonomy()))
        .toMatchTextContent(LEVEL_NAMES[id]());
      expect(rest(api.stored())).toEqual(before);
    }
  });

  it("checks no level for a custom mix and says so", async () => {
    mockApi({ autopilotEnabled: true });
    await open({});
    await expect.element(page.getByText(m.reposettings_autonomy_custom_note())).toBeVisible();
    for (const id of AUTONOMY_LEVELS) await expect.element(level(id)).not.toBeChecked();
  });

  it("a local-only repo locks Backlog and Full auto with the reason", async () => {
    // a drain stored before the repo went local takes no effect: With review
    mockApi({
      repoMode: "lightweight",
      autoAddressEnabled: true,
      autopilotEnabled: true,
      autoDrainEnabled: true,
    });
    await open({});
    await expect.element(level("review")).toBeChecked();
    for (const id of ["backlog", "full"] as const) {
      await expect.element(level(id)).toBeDisabled();
      await expect
        .element(level(id))
        .toHaveAccessibleDescription(new RegExp(`${m.automation_lightweight_unavailable()}$`));
    }
    await expect.element(level("onCall")).toBeEnabled();
  });

  it("on Sandbox Standard Backlog and Full auto say the work halts; the level keeps the sandbox", async () => {
    const api = mockApi({ sandboxProfile: "standard" });
    await open({});
    const halt = `${m.reposettings_autonomy_sandbox_halt()} ${m.reposettings_autonomy_sandbox_change()}`;
    for (const id of ["backlog", "full"] as const)
      await expect.element(level(id)).toHaveAccessibleDescription(new RegExp(halt));
    for (const id of ["onCall", "review"] as const)
      await expect
        .element(level(id))
        .not.toHaveAccessibleDescription(new RegExp(m.reposettings_autonomy_sandbox_halt()));
    await level("backlog").click();
    await vi.waitFor(() => expect(api.puts).toHaveLength(1));
    expect(api.puts[0]).not.toHaveProperty("sandboxProfile");
    expect(api.stored().sandboxProfile).toBe("standard");
  });

  it("with the sandbox-halt note on top, Backlog and Full auto point at it", async () => {
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
    mockApi({ sandboxProfile: "standard" }, blockers);
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
    await open({ section: "autonomy", drain });
    await expect
      .element(page.getByText(m.repooverview_halt_title({ repo: `rs-${n}` })))
      .toBeVisible();
    for (const id of ["backlog", "full"] as const)
      await expect
        .element(level(id))
        .toHaveAccessibleDescription(
          new RegExp(
            `${m.reposettings_autonomy_sandbox_halt()} ${m.reposettings_autonomy_sandbox_see_hint()}`,
          ),
        );
  });

  it("Full auto's description links to the hands-off guide", async () => {
    mockApi();
    await open({});
    const link = page.getByRole("link", { name: m.reposettings_autonomy_full_guide() });
    await expect.element(link).toHaveAttribute("href", expect.stringMatching(/hands-off-epics\/$/));
  });

  it("the chain follows a switch flipped in another section", async () => {
    mockApi();
    await open({});
    const step = (s: string) => document.querySelector(`[data-step="${s}"]`)!.textContent!;
    expect(step("stops")).toContain(m.guardtl_marker_you());
    expect(step("review")).toContain(m.reposettings_chain_shepherd());
    await tab(m.reposettings_section_start()).click();
    await sw(m.automation_autopilot_name()).click();
    await tab(m.reposettings_section_autonomy()).click();
    await vi.waitFor(() => expect(step("stops")).toContain(m.reposettings_chain_shepherd()));
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

/** Narrow, the sticky chip strip covers the top of the scroller; a revealed target must clear
 *  it. Wide, the rail sits beside the section, so only the viewport's top counts. */
function stripBottom() {
  const strip = document.querySelector<HTMLElement>("[data-repo-settings] [role=tablist]")!;
  return getComputedStyle(strip.parentElement!).position === "sticky"
    ? strip.getBoundingClientRect().bottom - 1
    : 0;
}

describe("RepoSettingsWindow — phone", () => {
  it("goes full screen with a sideways chip strip, and nothing else scrolls sideways", async () => {
    await page.viewport(375, 800);
    mockApi({ sharedBrowserEnabled: true, browserAllowedHosts: ["a-long-host.example.com"] });
    await open({ section: "agent" });
    const card = document.querySelector<HTMLElement>("[data-repo-settings]")!;
    await vi.waitFor(() => expect(card.getBoundingClientRect().width).toBe(375));
    for (const id of ["autonomy", "agent", "start", "merge", "display"] as const) {
      await tab(sectionLabel(id)).click();
      await tick();
      // the chip strip is the one sideways scroller, and keeps the active chip fully in view
      const strip = card.querySelector<HTMLElement>('[role="tablist"]')!;
      const chip = strip.querySelector('[aria-selected="true"]')!.getBoundingClientRect();
      const box = strip.getBoundingClientRect();
      expect(chip.left).toBeGreaterThanOrEqual(box.left - 1);
      expect(chip.right).toBeLessThanOrEqual(box.right + 1);
      for (const el of [card, ...card.querySelectorAll<HTMLElement>("*")]) {
        if (el === strip) continue;
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "hidden")
          expect.soft(el.scrollWidth, el.className).toBeLessThanOrEqual(el.clientWidth + 1);
      }
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
    }
  });
});

describe("RepoSettingsWindow — search", () => {
  it("reaches every catalog target or its conditional parent without saving", async () => {
    const api = mockApi();
    await open({});
    const input = page.getByRole("searchbox", { name: m.reposettings_search_label() });
    for (const entry of repoSettingsSearchEntries()) {
      await input.fill(entry.name);
      const label = entry.section ? `${entry.name} ${sectionLabel(entry.section)}` : entry.name;
      await page
        .getByRole("region", { name: m.reposettings_search_results() })
        .getByRole("button", { name: label, exact: true })
        .click();
      const root = document.querySelector("[data-repo-settings]")!;
      const findRow = () =>
        root.querySelector(`[data-field~="${entry.field}"]`) ??
        root.querySelector(`[data-field~="${entry.fallbackField}"]`);
      await expect.poll(findRow, { message: entry.field }).not.toBeNull();
      const row = findRow()!;
      await expect
        .poll(() => row!.contains(document.activeElement), { message: entry.field })
        .toBe(true);
      expect(row!.getBoundingClientRect().bottom, entry.field).toBeGreaterThan(0);
      expect(row!.getBoundingClientRect().top, entry.field).toBeLessThan(window.innerHeight);
    }
    expect(api.puts).toEqual([]);
    expect(api.scheduleWrites).toEqual([]);
    expect(api.autoFixPosts).toEqual([]);
  });

  it("activates a result with the keyboard and preserves Escape dismissal", async () => {
    mockApi();
    const onclose = await open({});
    const input = page.getByRole("searchbox", { name: m.reposettings_search_label() });
    await input.fill(m.automation_critic_name());
    const result = page.getByRole("button", {
      name: `${m.automation_critic_name()} ${m.reposettings_section_review()}`,
      exact: true,
    });
    (result.query() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(sw(m.automation_critic_name())).toHaveFocus();
    await input.fill("not-found");
    await userEvent.keyboard("{Escape}");
    expect(onclose).toHaveBeenCalledTimes(1);
  });
});

describe("RepoSettingsWindow — search edge cases", () => {
  it("focuses a locked row and keeps its existing reason visible", async () => {
    const api = mockApi({ repoMode: "lightweight" });
    await open({});
    await page
      .getByRole("searchbox", { name: m.reposettings_search_label() })
      .fill(m.automation_allprs_name());
    await page
      .getByRole("region", { name: m.reposettings_search_results() })
      .getByRole("button", {
        name: `${m.automation_allprs_name()} ${sectionLabel("review")}`,
        exact: true,
      })
      .click();
    await expect.element(sw(m.automation_allprs_name())).toBeDisabled();
    const row = document.querySelector<HTMLElement>('[data-field="criticAllPrs"]')!;
    expect(document.activeElement).toBe(row);
    expect(row.textContent).toContain(m.automation_lightweight_unavailable());
    expect(api.puts).toEqual([]);
  });

  it("keeps focus on the responsibilities row while its data loads", async () => {
    const api = mockApi();
    const baseFetch = vi.mocked(fetch).getMockImplementation()!;
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (String(input).startsWith("/api/repo-roles?"))
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      return baseFetch(input, init);
    });
    await open({});
    await page
      .getByRole("searchbox", { name: m.reposettings_search_label() })
      .fill(m.roles_reviewer_label());
    await page
      .getByRole("region", { name: m.reposettings_search_results() })
      .getByRole("button", {
        name: `${m.roles_reviewer_label()} ${sectionLabel("merge")}`,
        exact: true,
      })
      .click();
    const row = document.querySelector<HTMLElement>('[data-field="roles.reviewer"]')!;
    expect(document.activeElement).toBe(row);
    finish(Response.json({ roles: { reviewer: null, merger: null }, me: null }));
    await expect
      .element(page.getByRole("combobox", { name: m.roles_reviewer_label() }))
      .toBeEnabled();
    expect(document.activeElement).toBe(row);
    expect(api.puts).toEqual([]);
  });

  for (const width of [390, 1280]) {
    it(`keeps search and focused targets visible at ${width}px`, async () => {
      mockApi();
      await page.viewport(width, 844);
      await open({});
      const input = page.getByRole("searchbox", { name: m.reposettings_search_label() });
      await input.fill(sectionLabel("display"));
      await expect
        .element(page.getByRole("region", { name: m.reposettings_search_results() }))
        .toBeVisible();
      const result = page.getByRole("button", {
        name: `${m.reposettings_hide_name()} ${sectionLabel("display")}`,
        exact: true,
      });
      await result.click();
      await expect.element(sw(m.reposettings_hide_name())).toHaveFocus();
      const target = sw(m.reposettings_hide_name()).query()!.getBoundingClientRect();
      expect(target.top).toBeGreaterThanOrEqual(stripBottom());
      expect(target.bottom).toBeLessThanOrEqual(844);
      const root = document.querySelector<HTMLElement>("[data-repo-settings]")!;
      expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
      await input.fill("zzzz_no_such_setting");
      const rect = input.query()!.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(width);
      expect(rect.bottom).toBeLessThanOrEqual(844);
      expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
    });
  }
});

describe("RepoSettingsWindow — search control priority", () => {
  it("focuses the Shared browser switch rather than its Open action", async () => {
    mockApi({ sharedBrowserEnabled: true });
    await open({});
    await page
      .getByRole("searchbox", { name: m.reposettings_search_label() })
      .fill(m.automation_shared_browser_name());
    await page
      .getByRole("region", { name: m.reposettings_search_results() })
      .getByRole("button", {
        name: `${m.automation_shared_browser_name()} ${sectionLabel("agent")}`,
        exact: true,
      })
      .click();
    await expect.element(sw(m.automation_shared_browser_name())).toHaveFocus();
  });

  it("focuses a populated host list's editor rather than its Remove action", async () => {
    mockApi({ sharedBrowserEnabled: true, browserAllowedHosts: ["example.com"] });
    await open({});
    await page
      .getByRole("searchbox", { name: m.reposettings_search_label() })
      .fill(m.automation_browser_hosts_label());
    await page
      .getByRole("region", { name: m.reposettings_search_results() })
      .getByRole("button", {
        name: `${m.automation_browser_hosts_label()} ${sectionLabel("agent")}`,
        exact: true,
      })
      .click();
    await expect
      .element(page.getByRole("textbox", { name: m.automation_browser_hosts_label() }))
      .toHaveFocus();
  });
});

it("keeps the selected autonomy radio visible on a narrow screen after search", async () => {
  mockApi({
    autoDrainEnabled: true,
    criticEnabled: true,
    autoAddressEnabled: true,
    autopilotEnabled: true,
    autoMergeEnabled: true,
  });
  await page.viewport(390, 844);
  await open({ section: "display" });
  await page
    .getByRole("searchbox", { name: m.reposettings_search_label() })
    .fill(m.reposettings_autonomy_name());
  await page
    .getByRole("region", { name: m.reposettings_search_results() })
    .getByRole("button", {
      name: `${m.reposettings_autonomy_name()} ${sectionLabel("autonomy")}`,
      exact: true,
    })
    .click();
  const selected = page.getByRole("radio", { name: m.reposettings_autonomy_full(), exact: true });
  await expect.element(selected).toHaveFocus();
  const rect = selected.query()!.getBoundingClientRect();
  expect(rect.top).toBeGreaterThanOrEqual(stripBottom());
  expect(rect.bottom).toBeLessThanOrEqual(844);
});

it("waits for the bootstrap search target to load without focusing Auto-drain", async () => {
  const api = mockApi();
  const baseFetch = vi.mocked(fetch).getMockImplementation()!;
  let finish!: (response: Response) => void;
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (String(input).startsWith("/api/repo-bootstrap?"))
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    return baseFetch(input, init);
  });
  await open({});
  await page
    .getByRole("searchbox", { name: m.reposettings_search_label() })
    .fill(m.automation_bootstrap_name());
  await page
    .getByRole("region", { name: m.reposettings_search_results() })
    .getByRole("button", {
      name: `${m.automation_bootstrap_name()} ${sectionLabel("start")}`,
      exact: true,
    })
    .click();
  expect(document.querySelector('[data-field="bootstrap"]')).toBeNull();
  expect(document.activeElement).not.toBe(sw(m.automation_autodrain_name()).query());
  finish(
    Response.json({ state: "off", phase: 1, overrideAt: null, missing: [], suggested: false }),
  );
  await expect.element(sw(m.automation_bootstrap_name())).toHaveFocus();
  expect(api.puts).toEqual([]);
});
