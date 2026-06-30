import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { Issue, RepoConfig, RepoEntry } from "$lib/types";
import { m } from "$lib/paraglide/messages";
import {
  listIssues,
  getEpics,
  getTodo,
  listBranches,
  getRepoConfig,
  putRepoConfig,
  listRepos,
  branchStatus,
  getCommands,
} from "$lib/api";

// Mock the API so the issue picker renders deterministically with no network.
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    listIssues: vi.fn(),
    getEpics: vi.fn(),
    getTodo: vi.fn(),
    listBranches: vi.fn(),
    getRepoConfig: vi.fn(),
    putRepoConfig: vi.fn(),
    listRepos: vi.fn(),
    branchStatus: vi.fn(),
    getCommands: vi.fn(),
  };
});

const { default: NewTask } = await import("./NewTask.svelte");
const { default: FirstTaskAutomationConfirm } = await import("./FirstTaskAutomationConfirm.svelte");

const mockListIssues = vi.mocked(listIssues);
const mockGetEpics = vi.mocked(getEpics);
const mockGetTodo = vi.mocked(getTodo);
const mockListBranches = vi.mocked(listBranches);
const mockGetRepoConfig = vi.mocked(getRepoConfig);
const mockPutRepoConfig = vi.mocked(putRepoConfig);
const mockListRepos = vi.mocked(listRepos);
const mockBranchStatus = vi.mocked(branchStatus);
const mockGetCommands = vi.mocked(getCommands);

// A full RepoConfig with the plan gate flag overridable; the composer only reads
// planGateEnabled but the store ingests the whole shape. automationConfirmed defaults
// to true so existing tests (which don't test the confirm step) bypass the gate.
function repoConfig(
  planGateEnabled: boolean,
): RepoConfig & { automationConfirmed: boolean; automationRowExists: boolean } {
  return {
    criticEnabled: true,
    criticAllPrs: false,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: false,
    autoDrainEnabled: false,
    autoMergeEnabled: false,
    buildQueueEnabled: false,
    planGateEnabled,
    draftMode: false,
    signoffAuthority: "human",
    sandboxProfile: "trusted",
    maxAuto: 1,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
    defaultModel: "inherit",
    repoMode: "forge",
    autoOptimizeFlagged: false,
    manualStepsIssueEnabled: false,
    hidden: false,
    automationConfirmed: true,
    automationRowExists: true,
  };
}

beforeEach(() => {
  mockListIssues.mockReset();
  mockGetEpics.mockReset();
  mockGetTodo.mockReset();
  mockListBranches.mockReset();
  mockGetRepoConfig.mockReset();
  mockPutRepoConfig.mockReset();
  mockListRepos.mockReset();
  mockBranchStatus.mockReset();
  mockGetCommands.mockReset();
  // Safe defaults so any test that mounts the picker (PromptSources) gets resolved
  // promises, never `undefined`; individual tests override as needed.
  mockGetTodo.mockResolvedValue({ exists: false, content: "" });
  mockListIssues.mockResolvedValue({ slug: null, webUrl: null, issues: [], viewer: null });
  mockGetEpics.mockResolvedValue({ epics: [], subIssues: [] });
  mockListBranches.mockResolvedValue({ current: "main", branches: ["main"], default: null });
  mockGetRepoConfig.mockResolvedValue(repoConfig(false));
  mockPutRepoConfig.mockResolvedValue(repoConfig(false));
  mockListRepos.mockResolvedValue({ repos: [], recentWindowDays: 30 });
  mockGetCommands.mockResolvedValue({ commands: [] });
  // Default: up to date — no hint rendered
  mockBranchStatus.mockResolvedValue({
    behind: 0,
    ahead: 0,
    diverged: false,
    hasUpstream: true,
    localExists: true,
  });
});

afterEach(() => {
  document.body.innerHTML = "";
});

const base = (extra: Record<string, unknown> = {}) => ({
  onsubmit: vi.fn(),
  ...extra,
});

describe("NewTask initialImages seed", () => {
  it("renders a removable chip per seeded image", async () => {
    render(NewTask, {
      props: base({
        initialImages: [
          { path: "/srv/a.png", name: "a.png" },
          { path: "/srv/b.png", name: "b.png" },
        ],
      }),
    });

    await expect.element(page.getByText("a.png")).toBeInTheDocument();
    await expect.element(page.getByText("b.png")).toBeInTheDocument();
    // Each seeded chip carries its own remove control.
    const removers = page.getByRole("button", { name: m.newtask_remove_image_aria() }).all();
    expect(removers.length).toBe(2);
  });

  it("renders no chips when initialImages is omitted", async () => {
    render(NewTask, { props: base() });
    expect(document.querySelector(".chip")).toBeNull();
  });

  it("removing a seeded chip drops it without mutating the others", async () => {
    render(NewTask, {
      props: base({
        initialImages: [
          { path: "/srv/a.png", name: "a.png" },
          { path: "/srv/b.png", name: "b.png" },
        ],
      }),
    });

    await page.getByRole("button", { name: m.newtask_remove_image_aria() }).first().click();

    expect(page.getByText("a.png").query()).toBeNull();
    await expect.element(page.getByText("b.png")).toBeInTheDocument();
  });
});

describe("NewTask issue picker epic-parent rows", () => {
  function issue(number: number, title: string, labels: string[] = []): Issue {
    return {
      number,
      title,
      body: "",
      url: `https://example.com/i/${number}`,
      labels,
      createdAt: 0,
      assignees: [],
    };
  }

  it("renders the epic-parent row non-selectable and the normal row selectable", async () => {
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      webUrl: null,
      issues: [issue(30, "Epic parent", ["shepherd:active"]), issue(31, "Plain issue")],
      viewer: null,
    });
    mockGetEpics.mockResolvedValue({
      epics: [
        {
          parentIssueNumber: 30,
          parentTitle: "Epic parent",
          total: 2,
          merged: 1,
          status: "idle",
          source: "markdown",
        },
      ],
      subIssues: [],
    });

    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: "/repo" } });

    // Open the Issues tab in the picker, then wait for the rows to render.
    // exact: true avoids matching the "hide sub-issues" chip (accessible name contains "issues").
    await page.getByRole("button", { name: m.promptsources_issues_tab(), exact: true }).click();
    await expect.poll(() => document.querySelectorAll(".ps-body .row").length).toBe(2);

    // The EPIC tag chip renders (exact match: "Epic parent" also contains "Epic").
    await expect
      .element(page.getByText(m.promptsources_epic_tag(), { exact: true }))
      .toBeInTheDocument();
    expect(document.querySelector(".chip-epic")?.textContent).toBe(m.promptsources_epic_tag());

    const rows = Array.from(document.querySelectorAll<HTMLElement>(".ps-body .row"));
    const epicRow = rows.find((r) => r.textContent?.includes("Epic parent"))!;
    const plainRow = rows.find((r) => r.textContent?.includes("Plain issue"))!;

    // Epic-parent row is a non-interactive element marked aria-disabled, not a button.
    expect(epicRow.tagName).not.toBe("BUTTON");
    expect(epicRow.getAttribute("aria-disabled")).toBe("true");
    expect(epicRow.textContent).toContain(m.promptsources_epic_tag());

    // The epic row keeps the issue's normal label chips ALONGSIDE the EPIC tag:
    // the EPIC chip and the "shepherd:active" highlight chip both render.
    expect(epicRow.querySelector(".chip-epic")?.textContent).toBe(m.promptsources_epic_tag());
    const epicLabelChips = Array.from(
      epicRow.querySelectorAll<HTMLElement>(".chip:not(.chip-epic)"),
    );
    expect(epicLabelChips.map((c) => c.textContent?.trim())).toContain("shepherd:active");
    expect(epicLabelChips.some((c) => c.classList.contains("active"))).toBe(true);

    // Clicking it does NOT seed the prompt (no pick handler fires).
    const promptField = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    epicRow.click();
    expect(promptField.value).toBe("");

    // The normal row is a clickable button; picking it seeds the prompt template.
    expect(plainRow.tagName).toBe("BUTTON");
    expect((plainRow as HTMLButtonElement).disabled).toBe(false);
    plainRow.click();
    await expect.poll(() => promptField.value).toContain("#31");
  });
});

describe("NewTask plan-gate inheritance", () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  const planGateBox = () => document.querySelector<HTMLInputElement>(".plan-gate input")!;
  const submitBtn = () => document.querySelector<HTMLButtonElement>("button.run")!;

  async function fillAndSubmit() {
    const promptField = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    promptField.value = "do the thing";
    promptField.dispatchEvent(new Event("input", { bubbles: true }));
    await expect.poll(() => submitBtn().disabled).toBe(false);
    submitBtn().click();
  }

  it("submits planGateEnabled:null when the box is untouched on a gate-ON repo", async () => {
    // unique repoPath per test: repoConfig store is a module singleton that caches by path
    const repoPath = "/repo/gate-on-untouched";
    mockGetRepoConfig.mockResolvedValue(repoConfig(true));
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    // box mirrors the gate-ON default once config settles
    await expect.poll(() => planGateBox().checked).toBe(true);
    await fillAndSubmit();

    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({ planGateEnabled: null });
  });

  it("submits the explicit boolean once the user toggles the box", async () => {
    // gate-OFF repo, user ticks it ON → explicit true
    const repoPath = "/repo/toggle-on";
    mockGetRepoConfig.mockResolvedValue(repoConfig(false));
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    await expect.poll(() => planGateBox().disabled).toBe(false);
    planGateBox().click(); // toggles + pins planGateTouched
    expect(planGateBox().checked).toBe(true);
    await fillAndSubmit();

    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({ planGateEnabled: true });
  });

  it("submits explicit false when the user unticks a gate-ON repo", async () => {
    const repoPath = "/repo/toggle-off";
    mockGetRepoConfig.mockResolvedValue(repoConfig(true));
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    await expect.poll(() => planGateBox().checked).toBe(true);
    planGateBox().click(); // untick → explicit false
    expect(planGateBox().checked).toBe(false);
    await fillAndSubmit();

    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({ planGateEnabled: false });
  });

  it("disables the box until config settles, then re-enables", async () => {
    const repoPath = "/repo/settle-success";
    const d = deferred<RepoConfig>();
    mockGetRepoConfig.mockReturnValue(d.promise);
    render(NewTask, { props: { onsubmit: vi.fn(), initialRepoPath: repoPath } });

    // in flight: disabled + loading hint (both gate + autopilot show it, so match the first)
    await expect.poll(() => planGateBox().disabled).toBe(true);
    await expect.element(page.getByText(m.common_loading()).first()).toBeInTheDocument();

    d.resolve(repoConfig(true));
    await expect.poll(() => planGateBox().disabled).toBe(false);
    expect(planGateBox().checked).toBe(true);
  });

  it("never wedges disabled when the config fetch fails", async () => {
    const repoPath = "/repo/settle-failure";
    const d = deferred<RepoConfig>();
    mockGetRepoConfig.mockReturnValue(d.promise);
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    await expect.poll(() => planGateBox().disabled).toBe(true);

    d.reject(new Error("boom"));
    // failure still settles → box re-enables (unchecked) and inherits via null
    await expect.poll(() => planGateBox().disabled).toBe(false);
    expect(planGateBox().checked).toBe(false);

    // A FAILED fetch leaves confirmed/rowExists unset. The submit gate must NOT treat that
    // as a new repo: it must spawn DIRECTLY (no confirm step) and must NOT seed (no PUT that
    // would clobber a deliberate planGate=off on an existing-but-unloaded repo).
    mockPutRepoConfig.mockResolvedValue({ ...repoConfig(false), automationConfirmed: true });
    await fillAndSubmit();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({ planGateEnabled: null });
    // no confirm step, and crucially no seed PUT
    expect(document.querySelector(".ftac")).toBeNull();
    expect(mockPutRepoConfig).not.toHaveBeenCalled();
  });

  it("first-task confirm replays force from 'Submit anyway' (no silent downgrade to hold)", async () => {
    // Brand-new repo (unconfirmed, no row) that ALSO hits a likely usage hold. Clicking
    // "Submit anyway" (force=true) must keep force=true through the confirm step — not get
    // downgraded to force=false (which would silently become "Hold for reset").
    const repoPath = "/repo/force-through-confirm";
    mockGetRepoConfig.mockResolvedValue({
      ...repoConfig(false),
      automationConfirmed: false,
      automationRowExists: false,
    });
    mockPutRepoConfig.mockResolvedValue({ ...repoConfig(false), automationConfirmed: true });
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath, holdLikely: true } });

    const provider = document.querySelector<HTMLSelectElement>("#nt-agent-provider")!;
    provider.value = "claude";
    provider.dispatchEvent(new Event("change", { bubbles: true }));
    await expect.poll(() => provider.value).toBe("claude");

    const promptField = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    promptField.value = "do the thing";
    promptField.dispatchEvent(new Event("input", { bubbles: true }));

    const anyway = () => document.querySelector<HTMLButtonElement>("button.run-anyway")!;
    await expect.poll(() => anyway().disabled).toBe(false);
    anyway().click(); // submit(e, true)

    // first task on this repo → confirm step intercepts before spawning
    await expect.poll(() => document.querySelector(".ftac")).toBeTruthy();
    expect(onsubmit).not.toHaveBeenCalled();

    await page.getByRole("button", { name: m.firsttask_confirm_cta() }).click();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    // force must survive the confirm step
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({ force: true });
  });
});

describe("NewTask autopilot override", () => {
  const autopilotBox = () =>
    Array.from(document.querySelectorAll<HTMLInputElement>(".plan-gate input")).find((el) =>
      el.closest("label")?.textContent?.includes(m.newtask_autopilot_label()),
    )!;
  const submitBtn = () => document.querySelector<HTMLButtonElement>("button.run")!;

  async function fillAndSubmit() {
    const promptField = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    promptField.value = "do the thing";
    promptField.dispatchEvent(new Event("input", { bubbles: true }));
    await expect.poll(() => submitBtn().disabled).toBe(false);
    submitBtn().click();
  }

  it("submits autopilotEnabled:null when untouched (inherits the repo default)", async () => {
    const repoPath = "/repo/ap-untouched";
    mockGetRepoConfig.mockResolvedValue({ ...repoConfig(false), autopilotEnabled: true });
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    // box mirrors the autopilot-ON default once config settles
    await expect.poll(() => autopilotBox().checked).toBe(true);
    await fillAndSubmit();

    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({ autopilotEnabled: null });
  });

  it("submits explicit false when the user unticks an autopilot-ON repo", async () => {
    const repoPath = "/repo/ap-opt-out";
    mockGetRepoConfig.mockResolvedValue({ ...repoConfig(false), autopilotEnabled: true });
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    await expect.poll(() => autopilotBox().checked).toBe(true);
    autopilotBox().click(); // untick → explicit opt-out for this task
    expect(autopilotBox().checked).toBe(false);
    await fillAndSubmit();

    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({ autopilotEnabled: false });
  });

  it("hides the checkbox in relaunch mode (relaunch carries the original's value)", async () => {
    const repoPath = "/repo/ap-relaunch";
    mockGetRepoConfig.mockResolvedValue({ ...repoConfig(false), autopilotEnabled: true });
    render(NewTask, { props: base({ relaunch: true, initialRepoPath: repoPath }) });

    // plan-gate still renders in relaunch (it IS overridable); autopilot does not
    await expect.poll(() => document.querySelector(".plan-gate")).toBeTruthy();
    expect(autopilotBox()).toBeUndefined();
  });
});

describe("NewTask research toggle", () => {
  const researchBox = () =>
    Array.from(document.querySelectorAll<HTMLInputElement>(".plan-gate input")).find((el) =>
      el.closest("label")?.textContent?.includes(m.newtask_research_label()),
    )!;
  const planGateBox = () =>
    Array.from(document.querySelectorAll<HTMLInputElement>(".plan-gate input")).find((el) =>
      el.closest("label")?.textContent?.includes(m.newtask_plan_gate_label()),
    )!;
  const autopilotBox = () =>
    Array.from(document.querySelectorAll<HTMLInputElement>(".plan-gate input")).find((el) =>
      el.closest("label")?.textContent?.includes(m.newtask_autopilot_label()),
    )!;
  const autonomousOption = () =>
    document.querySelector<HTMLOptionElement>('#nt-sandbox option[value="autonomous"]')!;
  const sandboxSelect = () => document.querySelector<HTMLSelectElement>("#nt-sandbox")!;
  const submitBtn = () => document.querySelector<HTMLButtonElement>("button.run")!;

  async function fillAndSubmit() {
    const promptField = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    promptField.value = "do the thing";
    promptField.dispatchEvent(new Event("input", { bubbles: true }));
    await expect.poll(() => submitBtn().disabled).toBe(false);
    submitBtn().click();
  }

  it("renders the Research checkbox", async () => {
    render(NewTask, { props: base() });
    await expect.poll(() => researchBox()).toBeTruthy();
    expect(researchBox().checked).toBe(false);
  });

  it("toggling Research on unchecks plan-gate", async () => {
    const repoPath = "/repo/research-clears-plangate";
    mockGetRepoConfig.mockResolvedValue(repoConfig(true));
    render(NewTask, { props: base({ initialRepoPath: repoPath }) });

    // wait for plan-gate to reflect repo default
    await expect.poll(() => planGateBox().checked).toBe(true);

    researchBox().click();
    await expect.poll(() => researchBox().checked).toBe(true);
    await expect.poll(() => planGateBox().checked).toBe(false);
  });

  it("toggling Research on unchecks Autopilot", async () => {
    const repoPath = "/repo/research-clears-autopilot";
    mockGetRepoConfig.mockResolvedValue({ ...repoConfig(false), autopilotEnabled: true });
    render(NewTask, { props: base({ initialRepoPath: repoPath }) });

    // box mirrors the autopilot-ON default once config settles
    await expect.poll(() => autopilotBox().checked).toBe(true);

    researchBox().click();
    await expect.poll(() => researchBox().checked).toBe(true);
    await expect.poll(() => autopilotBox().checked).toBe(false);
  });

  it("keeps Autopilot unchecked after a repo switch (touched pin survives)", async () => {
    const repoA: RepoEntry = { name: "alpha", path: "/repo/ap-switch-a", display: "alpha" };
    const repoB: RepoEntry = { name: "bravo", path: "/repo/ap-switch-b", display: "bravo" };
    mockListRepos.mockResolvedValue({ repos: [repoA, repoB], recentWindowDays: 30 });
    // both repos report autopilot ON
    mockGetRepoConfig.mockResolvedValue({ ...repoConfig(false), autopilotEnabled: true });
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: repoA.path } });

    await expect.poll(() => autopilotBox().checked).toBe(true);

    researchBox().click();
    await expect.poll(() => researchBox().checked).toBe(true);
    await expect.poll(() => autopilotBox().checked).toBe(false);

    // switch to repo B via the RepoSelect combobox
    const trigger = document.querySelector<HTMLButtonElement>(".rs-trigger")!;
    trigger.click();
    await expect
      .poll(() =>
        Array.from(document.querySelectorAll<HTMLLIElement>('[role="option"]')).find((el) =>
          el.textContent?.includes(repoB.name),
        ),
      )
      .toBeTruthy();
    const optB = Array.from(document.querySelectorAll<HTMLLIElement>('[role="option"]')).find(
      (el) => el.textContent?.includes(repoB.name),
    )!;
    optB.click();

    // with autopilotTouched pinned, the re-seed $effect must NOT flip it back on
    await expect.poll(() => researchBox().checked).toBe(true);
    await expect.poll(() => autopilotBox().checked).toBe(false);

    // backstop: submit carries explicit false (not null) — proves the touched pin held
    await fillAndSubmit();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({ autopilotEnabled: false, research: true });
  });

  it("toggling plan-gate on unchecks Research", async () => {
    render(NewTask, { props: base() });
    await expect.poll(() => researchBox()).toBeTruthy();

    // tick Research on first
    researchBox().click();
    await expect.poll(() => researchBox().checked).toBe(true);

    // then tick plan-gate → Research should clear
    planGateBox().click();
    await expect.poll(() => planGateBox().checked).toBe(true);
    await expect.poll(() => researchBox().checked).toBe(false);
  });

  it("disables the autonomous sandbox option when Research is on", async () => {
    render(NewTask, { props: base() });
    await expect.poll(() => researchBox()).toBeTruthy();

    expect(autonomousOption().disabled).toBe(false);
    researchBox().click();
    await expect.poll(() => researchBox().checked).toBe(true);
    await expect.poll(() => autonomousOption().disabled).toBe(true);
  });

  it("resets autonomous sandbox to default when Research is toggled on", async () => {
    render(NewTask, { props: base() });
    await expect.poll(() => sandboxSelect()).toBeTruthy();

    // pick autonomous first
    sandboxSelect().value = "autonomous";
    sandboxSelect().dispatchEvent(new Event("change", { bubbles: true }));
    await expect.poll(() => sandboxSelect().value).toBe("autonomous");

    // toggle research on → sandbox should reset
    researchBox().click();
    await expect.poll(() => researchBox().checked).toBe(true);
    await expect.poll(() => sandboxSelect().value).toBe("default");
  });

  it("submits research:true when Research is checked", async () => {
    const captured = vi.fn();
    render(NewTask, {
      props: base({ onsubmit: captured, initialRepoPath: "/repo/research-submit" }),
    });
    await expect.poll(() => researchBox()).toBeTruthy();

    researchBox().click();
    await fillAndSubmit();

    await expect.poll(() => captured.mock.calls.length).toBe(1);
    expect(captured.mock.calls[0]![0]).toMatchObject({ research: true });
  });

  it("submits research:false by default", async () => {
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: "/repo/research-default" } });
    await expect.poll(() => submitBtn()).toBeTruthy();

    await fillAndSubmit();

    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({ research: false });
  });
});

describe("NewTask repo shortcuts", () => {
  // Three repos in list order: alpha, bravo, charlie.
  // bravo has the highest recentAgentCount → recents[0]
  // charlie has lower count but a more recent lastUsedAt → recents[1]
  // alpha has no recent activity → excluded from recents entirely
  // So recentRepos order is: bravo, charlie (only 2 have positive counts).
  // Note charlie is list-index 2 but recents-index 1 — proves the digit jump
  // reads the recents ranking, not the list order.
  const repoA: RepoEntry = { name: "alpha", path: "/repo/alpha", display: "alpha" };
  const repoB: RepoEntry = {
    name: "bravo",
    path: "/repo/bravo",
    display: "bravo",
    recentAgentCount: 5,
    lastUsedAt: 1000,
  };
  const repoC: RepoEntry = {
    name: "charlie",
    path: "/repo/charlie",
    display: "charlie",
    recentAgentCount: 2,
    lastUsedAt: 2000,
  };
  const repos = [repoA, repoB, repoC];

  function triggerLabel() {
    return document.querySelector<HTMLElement>(".rs-trigger b")?.textContent ?? null;
  }

  function press(code: string, opts: KeyboardEventInit = {}) {
    const ta = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    ta.focus();
    ta.dispatchEvent(
      new KeyboardEvent("keydown", {
        code,
        altKey: true,
        bubbles: true,
        cancelable: true,
        ...opts,
      }),
    );
  }

  beforeEach(() => {
    mockListRepos.mockResolvedValue({ repos, recentWindowDays: 30 });
  });

  it("Alt+] advances to the next repo; wraps from last to first", async () => {
    // start at alpha (index 0); ] → bravo (index 1)
    render(NewTask, { props: base({ initialRepoPath: repoA.path }) });
    await expect.poll(() => triggerLabel()).toBe(repoA.name);

    press("BracketRight");
    await expect.poll(() => triggerLabel()).toBe(repoB.name);

    // advance to charlie (index 2)
    press("BracketRight");
    await expect.poll(() => triggerLabel()).toBe(repoC.name);

    // wrap from last → first
    press("BracketRight");
    await expect.poll(() => triggerLabel()).toBe(repoA.name);
  });

  it("Alt+[ moves to the previous repo; wraps from first to last", async () => {
    // start at alpha (index 0); [ → wrap to charlie (index 2)
    render(NewTask, { props: base({ initialRepoPath: repoA.path }) });
    await expect.poll(() => triggerLabel()).toBe(repoA.name);

    press("BracketLeft");
    await expect.poll(() => triggerLabel()).toBe(repoC.name);

    // previous from charlie → bravo
    press("BracketLeft");
    await expect.poll(() => triggerLabel()).toBe(repoB.name);
  });

  it("Alt+2 selects the 2nd recent repo (charlie, differs from list order)", async () => {
    // list order: alpha, bravo, charlie
    // recents order: bravo (count=5), charlie (count=2, more recent lastUsedAt)
    // Digit2 → charlie (index 1 in recents)
    render(NewTask, { props: base({ initialRepoPath: repoA.path }) });
    await expect.poll(() => triggerLabel()).toBe(repoA.name);

    press("Digit2");
    await expect.poll(() => triggerLabel()).toBe(repoC.name);
  });

  it("Alt+3 is a silent no-op when only 2 recents exist", async () => {
    // only repoB and repoC have recentAgentCount > 0, so recents has 2 entries
    render(NewTask, { props: base({ initialRepoPath: repoA.path }) });
    await expect.poll(() => triggerLabel()).toBe(repoA.name);

    press("Digit3");
    // label stays unchanged
    await expect.poll(() => triggerLabel()).toBe(repoA.name);
  });

  it("Alt+R opens the picker and focuses the filter input", async () => {
    render(NewTask, { props: base({ initialRepoPath: repoA.path }) });
    await expect.poll(() => triggerLabel()).toBe(repoA.name);

    press("KeyR");
    await expect.poll(() => document.querySelector(".rs-panel")).toBeTruthy();
    await expect
      .poll(() => document.activeElement === document.querySelector(".rs-filter"))
      .toBe(true);
  });

  it("Escape in open picker closes dropdown but not the modal, refocuses prompt", async () => {
    const onclose = vi.fn();
    render(NewTask, { props: base({ initialRepoPath: repoA.path, onclose }) });
    await expect.poll(() => triggerLabel()).toBe(repoA.name);

    // Open the picker via Alt+R
    press("KeyR");
    await expect.poll(() => document.querySelector(".rs-panel")).toBeTruthy();

    // Dispatch Escape from inside .rs-root (mirroring real focus on the filter input)
    const filter = document.querySelector<HTMLInputElement>(".rs-filter")!;
    filter.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );

    // Dropdown closes
    await expect.poll(() => document.querySelector(".rs-panel")).toBeFalsy();
    // Modal stays mounted (onclose did NOT fire)
    expect(document.querySelector("#nt-prompt")).toBeTruthy();
    expect(onclose).not.toHaveBeenCalled();
    // Prompt is refocused
    expect(document.activeElement).toBe(document.querySelector("#nt-prompt"));
  });

  it("bare ] without Alt does NOT change the selected repo", async () => {
    render(NewTask, { props: base({ initialRepoPath: repoA.path }) });
    await expect.poll(() => triggerLabel()).toBe(repoA.name);

    // fire without altKey
    press("BracketRight", { altKey: false });
    // label must remain unchanged
    expect(triggerLabel()).toBe(repoA.name);
  });
});

describe("NewTask upstream status hint", () => {
  it("renders behind hint when branch is behind origin and not diverged", async () => {
    mockBranchStatus.mockResolvedValue({
      behind: 4,
      ahead: 0,
      diverged: false,
      hasUpstream: true,
      localExists: true,
    });
    render(NewTask, { props: base({ initialRepoPath: "/repo/upstream-behind" }) });
    // The effect debounces 300ms then resolves; poll until the hint appears
    await expect
      .poll(() => document.querySelector(".nt-upstream")?.textContent, { timeout: 2000 })
      .toContain("4");
    expect(document.querySelector(".nt-upstream-warn")).toBeNull();
  });

  it("renders diverged hint (with warn styling) when branch has diverged", async () => {
    mockBranchStatus.mockResolvedValue({
      behind: 2,
      ahead: 3,
      diverged: true,
      hasUpstream: true,
      localExists: true,
    });
    render(NewTask, { props: base({ initialRepoPath: "/repo/upstream-diverged" }) });
    await expect
      .poll(() => document.querySelector(".nt-upstream-warn")?.textContent, { timeout: 2000 })
      .toBeTruthy();
    const hint = document.querySelector(".nt-upstream-warn")!;
    expect(hint.textContent).toContain("2");
    expect(hint.textContent).toContain("3");
  });

  it("renders nothing when branch is up to date (behind:0, diverged:false)", async () => {
    mockBranchStatus.mockResolvedValue({
      behind: 0,
      ahead: 0,
      diverged: false,
      hasUpstream: true,
      localExists: true,
    });
    render(NewTask, { props: base({ initialRepoPath: "/repo/upstream-utd" }) });
    // Give the debounce time to fire and resolve
    await new Promise((r) => setTimeout(r, 600));
    expect(document.querySelector(".nt-upstream")).toBeNull();
  });
});

describe("NewTask base branch default", () => {
  const submitBtn = () => document.querySelector<HTMLButtonElement>("button.run")!;
  const baseSelect = () => document.querySelector<HTMLSelectElement>("#nt-base")!;

  async function fillAndSubmit() {
    const promptField = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    promptField.value = "do the thing";
    promptField.dispatchEvent(new Event("input", { bubbles: true }));
    await expect.poll(() => submitBtn().disabled).toBe(false);
    submitBtn().click();
  }

  // Regression: the base must prefer the repo default branch (origin/HEAD) over the
  // currently-checked-out branch. flowagent sits on `main` but defaults to `dev`; basing
  // on `main` is what made the plan reviewer ground on a stale branch (TASK-581).
  it("preselects the repo default branch over the current checkout", async () => {
    mockListBranches.mockResolvedValue({
      current: "main",
      branches: ["main", "dev"],
      default: "dev",
    });
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: "/repo/default-pref" } });

    await expect.poll(() => baseSelect().value).toBe("dev");
    await fillAndSubmit();

    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({ baseBranch: "dev" });
  });

  // The default branch (origin/HEAD) need not exist locally — surface it as an option so
  // the dropdown's shown value matches the submitted base (not a silently-mismatched first
  // option). Here `dev` is the default but only `main` exists locally.
  it("includes a non-local default branch as a selectable option", async () => {
    mockListBranches.mockResolvedValue({
      current: "main",
      branches: ["main"],
      default: "dev",
    });
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: "/repo/nonlocal-default" } });

    await expect.poll(() => baseSelect().value).toBe("dev");
    const options = Array.from(baseSelect().options).map((o) => o.value);
    expect(options).toContain("dev");
    await fillAndSubmit();

    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({ baseBranch: "dev" });
  });
});

describe("NewTask fableAvailable prop", () => {
  const modelSelect = () => document.querySelector<HTMLSelectElement>("#nt-model")!;

  it("hides the fable option and does not preselect it when fableAvailable=false", async () => {
    render(NewTask, { props: base({ fableAvailable: false }) });

    // fable option must not be present in the select
    const options = Array.from(modelSelect().options).map((o) => o.value);
    expect(options).not.toContain("fable");

    // selected value must not be "fable"
    expect(modelSelect().value).not.toBe("fable");
  });

  it("shows the fable option when fableAvailable=true (default)", async () => {
    render(NewTask, { props: base({ fableAvailable: true }) });

    const options = Array.from(modelSelect().options).map((o) => o.value);
    expect(options).toContain("fable");
  });

  it("shows the fable option when fableAvailable is omitted (defaults to true)", async () => {
    render(NewTask, { props: base() });

    const options = Array.from(modelSelect().options).map((o) => o.value);
    expect(options).toContain("fable");
  });

  it("falls back from fable to default when initialModel=fable and fableAvailable=false", async () => {
    render(NewTask, { props: base({ initialModel: "fable", fableAvailable: false }) });

    expect(modelSelect().value).toBe("default");
  });

  it("shows the unavailability hint when fableAvailable=false", async () => {
    render(NewTask, { props: base({ fableAvailable: false }) });

    // The hint is a <p class="micro"> inside .model-field, distinct from the <label class="micro">
    const hint = document.querySelector(".model-field p.micro");
    expect(hint?.textContent).toContain("Fable is temporarily unavailable");
  });

  it("does not show the unavailability hint when fableAvailable=true", async () => {
    render(NewTask, { props: base({ fableAvailable: true }) });

    // No <p class="micro"> inside .model-field should render when fable is available
    expect(document.querySelector(".model-field p.micro")).toBeNull();
  });
});

describe("NewTask Codex model picker", () => {
  const providerSelect = () => document.querySelector<HTMLSelectElement>("#nt-agent-provider")!;
  const modelSelect = () => document.querySelector<HTMLSelectElement>("#nt-model")!;

  it("shows codex models and normalizes a claude model when Codex is selected", async () => {
    render(NewTask, {
      props: base({ defaultAgentProvider: "codex", defaultModel: "opus" }),
    });

    await expect.poll(() => providerSelect().value).toBe("codex");
    await expect.poll(() => modelSelect().value).toBe("gpt-5.5");
    const options = Array.from(modelSelect().options).map((o) => o.value);
    expect(options).toContain("gpt-5.5");
    expect(options).not.toContain("opus");
    expect(modelSelect().disabled).toBe(false);
  });

  it("submits the selected codex model", async () => {
    const repoPath = "/repo/codex-model";
    mockGetRepoConfig.mockResolvedValue(confirmedRepoConfig());
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, {
      props: { onsubmit, initialRepoPath: repoPath, defaultAgentProvider: "codex" },
    });

    await expect
      .poll(() => Array.from(modelSelect().options).map((o) => o.value))
      .toContain("gpt-5.4");
    modelSelect().value = "gpt-5.4";
    modelSelect().dispatchEvent(new Event("change", { bubbles: true }));

    await fillPromptAndClickRun();

    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]?.[0]).toMatchObject({
      agentProvider: "codex",
      model: "gpt-5.4",
    });
  });
});

// ── Helpers shared by the confirm-step test suites ──────────────────────────

/** A RepoConfigResponse for unconfirmed brand-new repos (no row yet). */
function unconfirmedNewRepoConfig(): RepoConfig & {
  automationConfirmed: boolean;
  automationRowExists: boolean;
} {
  return {
    criticEnabled: true,
    criticAllPrs: false,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: false,
    autoDrainEnabled: false,
    autoMergeEnabled: false,
    buildQueueEnabled: false,
    planGateEnabled: false,
    draftMode: false,
    signoffAuthority: "human",
    sandboxProfile: "trusted",
    maxAuto: 1,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
    defaultModel: "inherit",
    repoMode: "forge",
    autoOptimizeFlagged: false,
    manualStepsIssueEnabled: false,
    hidden: false,
    automationConfirmed: false,
    automationRowExists: false,
  };
}

/** A RepoConfigResponse for repos that have a row but haven't confirmed yet. */
function unconfirmedExistingRepoConfig(): RepoConfig & {
  automationConfirmed: boolean;
  automationRowExists: boolean;
} {
  return { ...unconfirmedNewRepoConfig(), automationRowExists: true };
}

/** A RepoConfigResponse for confirmed repos. */
function confirmedRepoConfig(): RepoConfig & {
  automationConfirmed: boolean;
  automationRowExists: boolean;
} {
  return { ...unconfirmedNewRepoConfig(), automationConfirmed: true, automationRowExists: true };
}

async function fillPromptAndClickRun() {
  const promptField = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
  promptField.value = "do the thing";
  promptField.dispatchEvent(new Event("input", { bubbles: true }));
  // Wait for the run button to be enabled (prompt filled)
  const runBtn = () => document.querySelector<HTMLButtonElement>("button.run");
  await expect.poll(() => runBtn()?.disabled).toBe(false);
  runBtn()!.click();
}

describe("NewTask first-task confirm step", () => {
  it("usage hold keeps the operator's Claude default and offers a manual handoff", async () => {
    const repoPath = "/repo/hold-keeps-claude";
    mockGetRepoConfig.mockResolvedValue(confirmedRepoConfig());
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    // Default CLI is Claude; a usage hold must NOT silently switch it to Codex.
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath, holdLikely: true } });

    const provider = () => document.querySelector<HTMLSelectElement>("#nt-agent-provider")!;
    await expect.poll(() => provider().value).toBe("claude");
    // Held → the dual Hold-for-reset / Submit-anyway buttons offer the handoff
    // without hijacking the selected CLI.
    await expect.poll(() => document.querySelector("button.run-hold")).toBeTruthy();
    expect(document.querySelector("button.run-anyway")).toBeTruthy();

    // The Codex hold note only appears once the operator picks Codex by hand.
    provider().value = "codex";
    provider().dispatchEvent(new Event("change", { bubbles: true }));
    await expect.poll(() => provider().value).toBe("codex");
    await expect
      .element(page.getByText(m.newtask_agent_provider_codex_suggested_for_hold()))
      .toBeInTheDocument();
  });

  it("switching Codex→Claude: plan-gate forced off (restored on flip back), autopilot available throughout", async () => {
    const repoPath = "/repo/codex-restore";
    // Repo defaults both automation toggles ON.
    mockGetRepoConfig.mockResolvedValue({
      ...confirmedRepoConfig(),
      planGateEnabled: true,
      autopilotEnabled: true,
    });
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    const provider = () => document.querySelector<HTMLSelectElement>("#nt-agent-provider")!;
    const boxByLabel = (label: string) =>
      Array.from(document.querySelectorAll<HTMLInputElement>(".plan-gate input")).find((el) =>
        el.closest("label")?.textContent?.includes(label),
      )!;
    const planGateBox = () => boxByLabel(m.newtask_plan_gate_label());
    const autopilotBox = () => boxByLabel(m.newtask_autopilot_label());

    // Seeded ON from the repo default.
    await expect.poll(() => planGateBox().checked).toBe(true);
    await expect.poll(() => autopilotBox().checked).toBe(true);

    // Codex: plan-gate forced off + disabled; autopilot stays available (on + enabled).
    provider().value = "codex";
    provider().dispatchEvent(new Event("change", { bubbles: true }));
    await expect.poll(() => planGateBox().checked).toBe(false);
    expect(planGateBox().disabled).toBe(true);
    await expect.poll(() => autopilotBox().checked).toBe(true);
    expect(autopilotBox().disabled).toBe(false);

    // Back to Claude in a single flip → plan-gate restored to the repo default, not stuck off.
    provider().value = "claude";
    provider().dispatchEvent(new Event("change", { bubbles: true }));
    await expect.poll(() => planGateBox().checked).toBe(true);
    await expect.poll(() => autopilotBox().checked).toBe(true);
    expect(planGateBox().disabled).toBe(false);
    expect(autopilotBox().disabled).toBe(false);
  });

  it("preserves a manual plan-gate override (forced-off display) and keeps autopilot on across a Codex round-trip", async () => {
    const repoPath = "/repo/codex-preserve-override";
    // Repo defaults both automation toggles OFF.
    mockGetRepoConfig.mockResolvedValue(confirmedRepoConfig());
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    const provider = () => document.querySelector<HTMLSelectElement>("#nt-agent-provider")!;
    const boxByLabel = (label: string) =>
      Array.from(document.querySelectorAll<HTMLInputElement>(".plan-gate input")).find((el) =>
        el.closest("label")?.textContent?.includes(label),
      )!;
    const planGateBox = () => boxByLabel(m.newtask_plan_gate_label());
    const autopilotBox = () => boxByLabel(m.newtask_autopilot_label());

    // Settle, then manually turn BOTH on — differs from the repo default.
    await expect.poll(() => planGateBox().disabled).toBe(false);
    planGateBox().click();
    autopilotBox().click();
    await expect.poll(() => planGateBox().checked).toBe(true);
    await expect.poll(() => autopilotBox().checked).toBe(true);

    // Codex displays plan-gate off (state preserved underneath, not mutated); autopilot stays on.
    provider().value = "codex";
    provider().dispatchEvent(new Event("change", { bubbles: true }));
    await expect.poll(() => planGateBox().checked).toBe(false);
    await expect.poll(() => autopilotBox().checked).toBe(true);
    expect(autopilotBox().disabled).toBe(false);

    // Back to Claude → the manual plan-gate override survives the round-trip.
    provider().value = "claude";
    provider().dispatchEvent(new Event("change", { bubbles: true }));
    await expect.poll(() => planGateBox().checked).toBe(true);
    await expect.poll(() => autopilotBox().checked).toBe(true);
  });

  it("confirmed repo: Run calls onsubmit directly, no confirm step shown", async () => {
    const repoPath = "/repo/ftac-confirmed";
    mockGetRepoConfig.mockResolvedValue(confirmedRepoConfig());
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    // Wait for config to settle (plan-gate box becomes enabled)
    await expect.poll(() => document.querySelector(".plan-gate input")).toBeTruthy();

    await fillPromptAndClickRun();

    // Confirm step must NOT appear
    expect(document.querySelector(".ftac")).toBeNull();
    // onsubmit must have been called
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
  });

  it("unconfirmed brand-new repo: Run shows confirm step, does NOT call onsubmit, calls seedNewRepoDefaults", async () => {
    const repoPath = "/repo/ftac-new-unconfirmed";
    mockGetRepoConfig.mockResolvedValue(unconfirmedNewRepoConfig());
    // putRepoConfig is called by seedNewRepoDefaults
    mockPutRepoConfig.mockResolvedValue(unconfirmedNewRepoConfig());
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    await expect.poll(() => document.querySelector(".plan-gate input")).toBeTruthy();
    await fillPromptAndClickRun();

    // Confirm step appears
    await expect.poll(() => document.querySelector(".ftac")).toBeTruthy();
    // onsubmit must NOT have been called
    expect(onsubmit).not.toHaveBeenCalled();
    // putRepoConfig was called for seedNewRepoDefaults (planGateEnabled: true)
    await expect.poll(() => mockPutRepoConfig.mock.calls.length).toBeGreaterThanOrEqual(1);
    const seedCall = mockPutRepoConfig.mock.calls.find((c) => c[1]?.planGateEnabled === true);
    expect(seedCall).toBeTruthy();
  });

  it("unconfirmed brand-new repo + Codex: skips Claude automation confirm and submits", async () => {
    const repoPath = "/repo/ftac-codex-unconfirmed";
    mockGetRepoConfig.mockResolvedValue(unconfirmedNewRepoConfig());
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, {
      props: { onsubmit, initialRepoPath: repoPath, defaultAgentProvider: "codex" },
    });

    await expect.poll(() => document.querySelector(".plan-gate input")).toBeTruthy();
    await fillPromptAndClickRun();

    expect(document.querySelector(".ftac")).toBeNull();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(mockPutRepoConfig).not.toHaveBeenCalled();
    expect(onsubmit.mock.calls[0]?.[0]?.agentProvider).toBe("codex");
  });

  it("unconfirmed but row exists: confirm step appears, seedNewRepoDefaults NOT called", async () => {
    const repoPath = "/repo/ftac-existing-unconfirmed";
    mockGetRepoConfig.mockResolvedValue(unconfirmedExistingRepoConfig());
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    await expect.poll(() => document.querySelector(".plan-gate input")).toBeTruthy();
    await fillPromptAndClickRun();

    // Confirm step appears
    await expect.poll(() => document.querySelector(".ftac")).toBeTruthy();
    // putRepoConfig must NOT have been called (no seed)
    expect(mockPutRepoConfig).not.toHaveBeenCalled();
    expect(onsubmit).not.toHaveBeenCalled();
  });

  it("Confirm: calls confirmAutomation (putRepoConfig with automationConfirmed:true) then onsubmit", async () => {
    const repoPath = "/repo/ftac-confirm-action";
    mockGetRepoConfig.mockResolvedValue(unconfirmedNewRepoConfig());
    // seed call
    mockPutRepoConfig.mockResolvedValueOnce(unconfirmedNewRepoConfig());
    // confirm call
    mockPutRepoConfig.mockResolvedValueOnce(confirmedRepoConfig());
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    await expect.poll(() => document.querySelector(".plan-gate input")).toBeTruthy();
    await fillPromptAndClickRun();

    // Wait for confirm step
    await expect.poll(() => document.querySelector(".ftac")).toBeTruthy();

    // Click Confirm
    const confirmBtn = page.getByRole("button", { name: m.firsttask_confirm_cta() });
    await confirmBtn.click();

    // onsubmit must have been called
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    // putRepoConfig was called with automationConfirmed: true
    const confirmCall = mockPutRepoConfig.mock.calls.find(
      (c) => c[1]?.automationConfirmed === true,
    );
    expect(confirmCall).toBeTruthy();
  });

  it("Cancel: hides confirm step and does NOT call onsubmit", async () => {
    const repoPath = "/repo/ftac-cancel";
    mockGetRepoConfig.mockResolvedValue(unconfirmedNewRepoConfig());
    mockPutRepoConfig.mockResolvedValue(unconfirmedNewRepoConfig());
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    await expect.poll(() => document.querySelector(".plan-gate input")).toBeTruthy();
    await fillPromptAndClickRun();

    // Wait for confirm step
    await expect.poll(() => document.querySelector(".ftac")).toBeTruthy();

    // Click Cancel
    const cancelBtn = page.getByRole("button", { name: m.common_cancel() });
    await cancelBtn.click();

    // Confirm step is gone; back to form
    await expect.poll(() => document.querySelector(".ftac")).toBeFalsy();
    await expect.poll(() => document.querySelector("#nt-prompt")).toBeTruthy();
    expect(onsubmit).not.toHaveBeenCalled();
  });

  it("confirm PUT fails: onsubmit NOT called, confirm step still shown, error visible", async () => {
    const repoPath = "/repo/ftac-confirm-reject";
    mockGetRepoConfig.mockResolvedValue(unconfirmedNewRepoConfig());
    // seedNewRepoDefaults call (first put)
    mockPutRepoConfig.mockResolvedValueOnce(unconfirmedNewRepoConfig());
    // confirmAutomation call (second put) rejects
    mockPutRepoConfig.mockRejectedValueOnce(new Error("network error"));
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    await expect.poll(() => document.querySelector(".plan-gate input")).toBeTruthy();
    await fillPromptAndClickRun();

    // Confirm step appears
    await expect.poll(() => document.querySelector(".ftac")).toBeTruthy();

    // Click Confirm — the PUT will reject
    const confirmBtn = page.getByRole("button", { name: m.firsttask_confirm_cta() });
    await confirmBtn.click();

    // onsubmit must NOT have been called
    expect(onsubmit).not.toHaveBeenCalled();
    // Confirm step must still be shown
    await expect.poll(() => document.querySelector(".ftac")).toBeTruthy();
    // Error must be visible inside the confirm step
    await expect.poll(() => document.querySelector(".ftac .err")).toBeTruthy();
    expect(document.querySelector(".ftac .err")?.textContent).toBeTruthy();
  });

  it("double-click Confirm spawns exactly once (re-entry guard)", async () => {
    const repoPath = "/repo/ftac-double-click";
    mockGetRepoConfig.mockResolvedValue(unconfirmedNewRepoConfig());
    // seedNewRepoDefaults
    mockPutRepoConfig.mockResolvedValueOnce(unconfirmedNewRepoConfig());

    // confirmAutomation: use a deferred promise so both clicks arrive before it resolves
    let resolveConfirm!: (
      v: RepoConfig & { automationConfirmed: boolean; automationRowExists: boolean },
    ) => void;
    const confirmPromise = new Promise<
      RepoConfig & { automationConfirmed: boolean; automationRowExists: boolean }
    >((res) => {
      resolveConfirm = res;
    });
    mockPutRepoConfig.mockReturnValueOnce(confirmPromise);

    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    await expect.poll(() => document.querySelector(".plan-gate input")).toBeTruthy();
    await fillPromptAndClickRun();

    // Confirm step must appear
    await expect.poll(() => document.querySelector(".ftac")).toBeTruthy();

    // Find the Confirm button by its text content (it has no aria-label — text node only)
    const confirmBtn = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".ftac button"),
    ).find((b) => b.textContent?.trim() === m.firsttask_confirm_cta())!;
    // Click Confirm twice in rapid succession before the promise resolves
    confirmBtn.click();
    confirmBtn.click();

    // Now resolve the confirm promise
    resolveConfirm(confirmedRepoConfig());

    // onsubmit must be called at most once (not twice)
    await expect.poll(() => onsubmit.mock.calls.length, { timeout: 3000 }).toBe(1);
    expect(onsubmit.mock.calls.length).toBe(1);
  });

  it("settle race: ensure resolving to confirmed repo spawns directly with no spurious step", async () => {
    const repoPath = "/repo/ftac-settle-race";

    let resolveConfig!: (v: RepoConfig) => void;
    const configPromise = new Promise<RepoConfig>((res) => {
      resolveConfig = res;
    });
    mockGetRepoConfig.mockReturnValue(configPromise);

    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    // Fill prompt while config is still in flight
    const promptField = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    promptField.value = "do the thing";
    promptField.dispatchEvent(new Event("input", { bubbles: true }));

    // Click Run while config is still loading (submitting guard: not yet enabled, but
    // the submit() gate only checks prompt+repoPath+submitting, so we wait for the
    // store to settle via ensure() before it reads confirmed state — we resolve AFTER click)
    // We need to wait for the run button to NOT be disabled (prompt is filled).
    const runBtn = () => document.querySelector<HTMLButtonElement>("button.run");
    await expect.poll(() => runBtn()?.disabled).toBe(false);
    runBtn()!.click();

    // Before config settles — neither step is active yet (submit is awaiting ensure())
    // Now resolve with a confirmed config
    resolveConfig(confirmedRepoConfig());

    // Because ensure() awaited, reads happen AFTER it resolves → confirmed → spawn directly
    await expect.poll(() => onsubmit.mock.calls.length, { timeout: 3000 }).toBe(1);
    // Confirm step must NOT have appeared
    expect(document.querySelector(".ftac")).toBeNull();
  });
});

// ── FirstTaskAutomationConfirm component tests ──────────────────────────────

describe("FirstTaskAutomationConfirm", () => {
  it("renders title, intro with repo basename, and both buttons", async () => {
    const onconfirm = vi.fn();
    const oncancel = vi.fn();
    render(FirstTaskAutomationConfirm, {
      props: { active: true, repoPath: "/home/user/my-project", onconfirm, oncancel },
    });

    await expect.element(page.getByText(m.firsttask_confirm_title())).toBeInTheDocument();
    // intro interpolates the basename ("my-project")
    const intro = document.querySelector(".ftac-intro");
    expect(intro?.textContent).toContain("my-project");
    await expect
      .element(page.getByRole("button", { name: m.firsttask_confirm_cta() }))
      .toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: m.common_cancel() })).toBeInTheDocument();
  });

  it("Confirm button calls onconfirm", async () => {
    const onconfirm = vi.fn();
    const oncancel = vi.fn();
    render(FirstTaskAutomationConfirm, {
      props: { active: true, repoPath: "/repo/test", onconfirm, oncancel },
    });

    await page.getByRole("button", { name: m.firsttask_confirm_cta() }).click();
    expect(onconfirm).toHaveBeenCalledOnce();
    expect(oncancel).not.toHaveBeenCalled();
  });

  it("Cancel button calls oncancel", async () => {
    const onconfirm = vi.fn();
    const oncancel = vi.fn();
    render(FirstTaskAutomationConfirm, {
      props: { active: true, repoPath: "/repo/test", onconfirm, oncancel },
    });

    await page.getByRole("button", { name: m.common_cancel() }).click();
    expect(oncancel).toHaveBeenCalledOnce();
    expect(onconfirm).not.toHaveBeenCalled();
  });

  it("Confirm button is disabled when submitting=true", async () => {
    const onconfirm = vi.fn();
    const oncancel = vi.fn();
    render(FirstTaskAutomationConfirm, {
      props: { active: true, repoPath: "/repo/test", onconfirm, oncancel, submitting: true },
    });

    const confirmBtn = document.querySelector<HTMLButtonElement>(`button[disabled]`);
    expect(confirmBtn).toBeTruthy();
    expect(confirmBtn?.textContent?.trim()).toContain(m.firsttask_confirm_cta());
  });
});

describe("NewTask — hidden repos excluded from keyboard selection paths", () => {
  // The bold name in the repo picker's trigger reflects the currently-selected repo.
  const selectedRepo = () => document.querySelector(".rs-trigger b")?.textContent ?? "";

  // The repo Alt-tier shortcuts listen on the dialog <form> (keydown bubbles up from the
  // prompt textarea), keyed on physical e.code. Dispatch there to drive them in a test.
  function altChord(code: string) {
    document
      .querySelector("form")!
      .dispatchEvent(new KeyboardEvent("keydown", { code, altKey: true, bubbles: true }));
  }

  it("default selection skips a hidden repo even when it's the most-recently-used", async () => {
    const visible: RepoEntry = {
      name: "visible",
      path: "/repo/hh-default-visible",
      display: "visible",
      lastUsedAt: 100,
    };
    const secret: RepoEntry = {
      name: "secret",
      path: "/repo/hh-default-secret",
      display: "secret",
      lastUsedAt: 999, // most-recently-used, but hidden → must not be auto-selected
      hidden: true,
    };
    mockListRepos.mockResolvedValue({ repos: [secret, visible], recentWindowDays: 30 });
    render(NewTask, { props: base() });

    await expect.poll(() => selectedRepo()).toBe("visible");
  });

  it("Alt+] cycle steps over a hidden repo instead of surfacing it", async () => {
    const a: RepoEntry = { name: "aaa", path: "/repo/hh-cyc-a", display: "aaa" };
    const hidden: RepoEntry = {
      name: "hhh",
      path: "/repo/hh-cyc-hidden",
      display: "hhh",
      hidden: true,
    };
    const c: RepoEntry = { name: "ccc", path: "/repo/hh-cyc-c", display: "ccc" };
    mockListRepos.mockResolvedValue({ repos: [a, hidden, c], recentWindowDays: 30 });
    render(NewTask, { props: base({ initialRepoPath: a.path }) });

    await expect.poll(() => selectedRepo()).toBe("aaa");
    altChord("BracketRight");
    // The cycle skips the hidden "hhh" between aaa and ccc and lands on ccc.
    await expect.poll(() => selectedRepo()).toBe("ccc");
  });

  it("Alt+1 digit shortcut never targets a hidden repo", async () => {
    const secret: RepoEntry = {
      name: "secret",
      path: "/repo/hh-dig-secret",
      display: "secret",
      recentAgentCount: 9, // would be the #1 recent if not hidden
      hidden: true,
    };
    const realtop: RepoEntry = {
      name: "realtop",
      path: "/repo/hh-dig-top",
      display: "realtop",
      recentAgentCount: 5,
    };
    const other: RepoEntry = { name: "other", path: "/repo/hh-dig-other", display: "other" };
    mockListRepos.mockResolvedValue({ repos: [secret, realtop, other], recentWindowDays: 30 });
    render(NewTask, { props: base({ initialRepoPath: other.path }) });

    await expect.poll(() => selectedRepo()).toBe("other");
    altChord("Digit1");
    // Alt+1 = first NON-hidden recent (realtop), never the higher-count hidden "secret".
    await expect.poll(() => selectedRepo()).toBe("realtop");
  });
});
