import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../../app.css";
import RepoMenuStatus from "./RepoMenuStatus.svelte";
import RepoSettingsWindow from "./RepoSettingsWindow.svelte";
import { m } from "#lib/paraglide/messages.js";
import { repoConfig } from "#lib/reviews.svelte.js";
import { repoSettingsWindow } from "#lib/repo-settings-window.svelte.js";
import type { DrainStatus, RepoConfig, Settings } from "#lib/types.js";

// #3445: the context menus' short status under "Repo settings …" — level · CLI · merge mode and a
// line per hint the window shows on top, from the inputs the window reads.

const BASE: Partial<RepoConfig> = {
  criticEnabled: true,
  criticAllPrs: false,
  criticSmellLensEnabled: false,
  autoAddressEnabled: true,
  autopilotEnabled: true,
  autoDrainEnabled: false,
  autoMergeEnabled: false,
  buildQueueEnabled: false,
  planGateEnabled: false,
  draftMode: false,
  signoffAuthority: "human",
  sandboxProfile: "autonomous",
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

const BLOCKERS = {
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

function mockApi(over: Partial<RepoConfig & { noPrCi: boolean }> = {}) {
  let config: Record<string, unknown> = { ...BASE, ...over };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/repo-config")) {
      if (init?.method === "PUT") config = { ...config, ...JSON.parse(String(init.body)) };
      return Response.json(config);
    }
    if (url.startsWith("/api/schedules")) return Response.json({ schedules: [] });
    if (url.startsWith("/api/epic/auto-fix")) return Response.json(BLOCKERS);
    return new Response("{}", { status: 404 });
  });
}

let n = 0;
let repo = "";
beforeEach(() => {
  repo = `/work/rms-${++n}`;
});
afterEach(() => {
  vi.restoreAllMocks();
  repoSettingsWindow.provide({ drain: () => null, globals: () => null });
  document.body.innerHTML = "";
});

function provide(globals: Partial<Settings>, drain: DrainStatus | null = null) {
  repoSettingsWindow.provide({
    drain: (p) => (p === repo ? drain : null),
    globals: () => globals as Settings,
  });
}

const status = () => document.querySelector<HTMLElement>("[data-repo-menu-status]");
const line = () => status()?.querySelector(".rms-line")?.textContent ?? "";
const hints = () =>
  [...(status()?.querySelectorAll(".rms-hint") ?? [])].map((h) => h.textContent!.trim());

const heldDrain = (): DrainStatus => ({
  repoPath: repo,
  enabled: true,
  paused: true,
  reason: "sandbox_interactive",
  detail: "standard",
  queued: 1,
  inFlight: 0,
  max: 1,
  epicParent: 7,
});

describe("RepoMenuStatus", () => {
  it("says level · CLI · merge mode, the CLI inherited from the global default", async () => {
    mockApi();
    provide({ defaultAgentProvider: "codex" });
    render(RepoMenuStatus, { repoPath: repo });
    await vi.waitFor(() =>
      expect(line()).toBe(
        `${m.reposettings_autonomy_review()} · ${m.agent_provider_codex()} · ${m.reposettings_merge_mode_manual()}`,
      ),
    );
    expect(hints()).toEqual([]);
  });

  it("follows a level picked meanwhile", async () => {
    mockApi({ agentProvider: "claude" });
    provide({ defaultAgentProvider: "codex" });
    render(RepoMenuStatus, { repoPath: repo });
    await vi.waitFor(() => expect(repoConfig.isConfigLoaded(repo)).toBe(true));
    await repoConfig.setAutonomyLevel(repo, "full");
    await vi.waitFor(() =>
      expect(line()).toBe(
        `${m.reposettings_autonomy_full()} · ${m.agent_provider_claude()} · ${m.automation_automerge_name()}`,
      ),
    );
  });

  it("adds a line per hint: no PR CI, then the sandbox halt", async () => {
    mockApi({ noPrCi: true, sandboxProfile: "standard" });
    provide({ defaultAgentProvider: "claude" }, heldDrain());
    render(RepoMenuStatus, { repoPath: repo });
    await vi.waitFor(() =>
      expect(hints()).toEqual([
        `⚠ ${m.repo_chip_no_pr_ci()}`,
        `⚠ ${m.reposettings_menu_halt_sandbox()}`,
      ]),
    );
  });

  it("reads the backlog's no-PR-CI hold until the config is in", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    render(RepoMenuStatus, { repoPath: repo, noPrCiPayload: true });
    await vi.waitFor(() => expect(hints()).toEqual([`⚠ ${m.repo_chip_no_pr_ci()}`]));
    expect(line()).toBe("");
  });

  it("agrees with the window: its Autonomy status, CLI, Finished PRs choice and hint cards", async () => {
    mockApi({
      noPrCi: true,
      sandboxProfile: "standard",
      autoDrainEnabled: true,
      agentProvider: "codex",
    });
    const drain = heldDrain();
    const globals = { defaultAgentProvider: "claude", fableAvailable: true } as Settings;
    provide(globals, drain);
    render(RepoSettingsWindow, {
      repoPath: repo,
      section: "merge",
      drain,
      globals,
      onclose: () => {},
    });
    render(RepoMenuStatus, { repoPath: repo });
    // the window's two hint cards: no PR CI, and the epic its sandbox halts
    await vi.waitFor(() => expect(document.querySelectorAll(".auto-hold")).toHaveLength(2));
    expect(document.querySelector("[data-epic-halt]")).not.toBeNull();
    await vi.waitFor(() => expect(hints()).toHaveLength(2));

    const summary = (id: string) =>
      document.querySelector(`[role="tab"][id$="-tab-${id}"] .summary`)!.textContent!.trim();
    const checked = document.querySelector<HTMLInputElement>(
      `[role="radiogroup"][aria-label="${m.reposettings_merge_mode_name()}"] input:checked`,
    )!;
    const mergeName = document.getElementById(
      checked.getAttribute("aria-labelledby")!,
    )!.textContent!;
    expect(line()).toBe(
      [summary("autonomy"), summary("agent").split(" · ")[0], mergeName.trim()].join(" · "),
    );
    expect(line()).toBe(
      `${m.reposettings_autonomy_backlog()} · ${m.agent_provider_codex()} · ${m.reposettings_merge_mode_manual()}`,
    );
  });
});
