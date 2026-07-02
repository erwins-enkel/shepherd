import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../app.css";
import CommandBar from "./CommandBar.svelte";
import { m } from "$lib/paraglide/messages";
import { repos } from "$lib/repos.svelte";
import type { RepoEntry, Session } from "$lib/types";

function session(partial: Partial<Session> & { id: string }): Session {
  return {
    desig: "TASK-01",
    name: "task one",
    prompt: "p",
    repoPath: "/repos/alpha",
    baseBranch: "main",
    branch: "feat/x",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "h",
    herdrAgentId: "ha",
    claudeSessionId: "cs",
    model: null,
    status: "idle",
    readyToMerge: false,
    mergingSince: null,
    mergingTrainId: null,
    mergeTrainPrs: null,
    autopilotEnabled: null,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotComplete: false,
    autopilotQuestion: null,
    planGateEnabled: null,
    planPhase: null,
    autoMergeEnabled: null,
    autoMergeRebaseCount: 0,
    auto: false,
    sandboxApplied: null,
    sandboxDegraded: false,
    egressApplied: false,
    egressDegraded: false,
    research: false,
    issueNumber: null,
    lastState: "",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    haltReason: null,
    haltedAt: null,
    manualSteps: [],
    manualStepsAckedAt: null,
    experimentId: null,
    experimentRole: null,
    ...partial,
  } as Session;
}

function seedRepos(): RepoEntry[] {
  // beta has the higher lastUsedAt → sorts before alpha.
  return [
    {
      name: "alpha",
      path: "/repos/alpha",
      display: "~/repos/alpha",
      realPath: "/repos/alpha",
      lastUsedAt: 100,
    },
    {
      name: "beta",
      path: "/repos/beta",
      display: "~/repos/beta",
      realPath: "/repos/beta",
      lastUsedAt: 200,
    },
  ];
}

// s2 ("newer") has the higher updatedAt → sorts before s1 ("older").
function seedSessions(): Session[] {
  return [
    session({ id: "s1", name: "older", repoPath: "/repos/alpha", updatedAt: 10 }),
    session({ id: "s2", name: "newer", repoPath: "/repos/beta", updatedAt: 20 }),
  ];
}

function renderBar(overrides: Partial<Parameters<typeof CommandBar>[1]> = {}) {
  const onselectsession = vi.fn();
  const onselectrepo = vi.fn();
  const onselectlens = vi.fn();
  const onclose = vi.fn();
  render(CommandBar, {
    sessions: seedSessions(),
    workingBlocked: {},
    onselectsession,
    onselectrepo,
    onselectlens,
    onclose,
    ...overrides,
  });
  return { onselectsession, onselectrepo, onselectlens, onclose };
}

beforeEach(() => {
  repos.entries = seedRepos();
});

describe("CommandBar — grouping & recency", () => {
  it("renders the three groups and recency-orders each", async () => {
    renderBar();
    // Group headers present.
    await expect.element(page.getByText(m.commandbar_group_sessions())).toBeVisible();
    await expect.element(page.getByText(m.commandbar_group_repos())).toBeVisible();
    await expect.element(page.getByText(m.commandbar_group_lenses())).toBeVisible();
    // First option is the most-recently-updated session ("newer" = s2).
    await expect.element(page.getByRole("option").first()).toHaveTextContent("newer");
  });

  it("filters by substring across sessions, repos and lenses", async () => {
    renderBar();
    // "rundown" matches only the lens (no session/repo carries that text).
    await page.getByRole("combobox").fill("rundown");
    const opts = page.getByRole("option");
    await expect.element(opts.first()).toHaveTextContent(m.herd_seg_rundown());
    expect(opts.elements()).toHaveLength(1);
  });

  it("shows the empty state when nothing matches", async () => {
    renderBar();
    await page.getByRole("combobox").fill("zzzznomatch");
    await expect.element(page.getByText(m.commandbar_no_matches())).toBeVisible();
    expect(page.getByRole("option").elements()).toHaveLength(0);
  });
});

describe("CommandBar — selection", () => {
  it("Enter on the first option opens the most-recent session", async () => {
    const { onselectsession } = renderBar();
    await page.getByRole("combobox").click();
    await userEvent.keyboard("{Enter}");
    expect(onselectsession).toHaveBeenCalledWith("s2");
  });

  it("ArrowDown skips group headers — landing on a repo fires onselectrepo", async () => {
    // options: [s2, s1, (Repositories header), beta, alpha, (Lenses header), next…]
    // Two ArrowDowns from idx0 → idx2 = beta. If headers were roving targets, idx2
    // would be the header and Enter would no-op — so this asserts header-skipping.
    const { onselectrepo, onselectsession } = renderBar();
    await page.getByRole("combobox").click();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onselectrepo).toHaveBeenCalledWith("/repos/beta");
    expect(onselectsession).not.toHaveBeenCalled();
  });

  it("clicking a lens row fires onselectlens", async () => {
    const { onselectlens } = renderBar();
    await page.getByRole("option", { name: new RegExp(m.herd_seg_owed()) }).click();
    expect(onselectlens).toHaveBeenCalledWith("owed");
  });
});

describe("CommandBar — dismissal", () => {
  it("Escape closes", async () => {
    const { onclose } = renderBar();
    await page.getByRole("combobox").click();
    await userEvent.keyboard("{Escape}");
    expect(onclose).toHaveBeenCalled();
  });

  it("the close button closes", async () => {
    const { onclose } = renderBar();
    await page.getByRole("button", { name: m.common_close() }).click();
    expect(onclose).toHaveBeenCalled();
  });
});
