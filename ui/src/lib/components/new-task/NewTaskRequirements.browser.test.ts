import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import type {
  InstanceIdentity,
  Placement,
  PlacementPreview,
  RemoteInstance,
  RepoConfig,
  RepoEntry,
  RequirementsDerivation,
} from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";
import { capabilityList } from "#lib/placement.js";
import {
  getInstance,
  previewPlacement,
  deriveRequirements,
  listIssues,
  getEpics,
  getTodo,
  listBranches,
  getRepoConfig,
  putRepoConfig,
  listRepos,
  listRemoteInstances,
  branchStatus,
  getCommands,
} from "#lib/api.js";

// Requirements read from the task (#2773): while the machines that could take it differ (the
// Automatic preview says `deriveRequirements`), New Task asks the server a second after the last
// edit. What it reads becomes correctable chips; an unclear description asks first and nothing
// starts before the answer; a failed read derives nothing and says so. The operator's own chips win.

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return {
    ...actual,
    listIssues: vi.fn(),
    getEpics: vi.fn(),
    getTodo: vi.fn(),
    listBranches: vi.fn(),
    getRepoConfig: vi.fn(),
    putRepoConfig: vi.fn(),
    listRepos: vi.fn(),
    listRemoteInstances: vi.fn(),
    getInstance: vi.fn(),
    previewPlacement: vi.fn(),
    deriveRequirements: vi.fn(),
    branchStatus: vi.fn(),
    getCommands: vi.fn(),
  };
});

const { default: NewTask } = await import("../NewTask.svelte");

function cfg(): RepoConfig & { automationConfirmed: boolean; automationRowExists: boolean } {
  return {
    criticEnabled: true,
    criticAllPrs: false,
    criticSmellLensEnabled: false,
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
    defaultEffort: "inherit",
    repoMode: "forge",
    autoOptimizeFlagged: false,
    manualStepsIssueEnabled: false,
    preWarmEpicLandingCi: false,
    epicStacksEnabled: false,
    sharedBrowserEnabled: false,
    browserAllowedHosts: [],
    hidden: false,
    previewStartScript: null,
    previewStartCommand: null,
    previewOpenMode: "ask",
    automationConfirmed: true,
    automationRowExists: true,
  };
}

const repo: RepoEntry = {
  name: "app",
  path: "/repo/app",
  display: "app",
  realPath: "/repo/app",
  remoteSlug: "acme/app",
};

const mac: RemoteInstance = {
  instanceId: "mac-1",
  name: "MacBook",
  label: null,
  reportedName: "MacBook",
  url: "http://mac.test",
  tokenHint: null,
  createdAt: 1,
  status: "connected",
  reason: null,
  checkedAt: 1,
  lastSeenAt: 1,
  info: { version: "2.2.0", federationApi: 2, platform: "macos", arch: "arm64" },
  projects: ["acme/app"],
  capabilities: null,
  released: true,
};

const self: InstanceIdentity = {
  instanceId: "self-1",
  name: "moes-tavern",
  version: "2.2.0",
  federationApi: 2,
  platform: "linux",
  arch: "x64",
};

const placedHere: Placement = {
  mode: "auto",
  target: { instanceId: "self-1", name: "moes-tavern", platform: "linux" },
  requirements: [],
  basis: "preference",
  preferred: "linux",
  by: { instanceId: "self-1", name: "moes-tavern" },
  decidedAt: 1,
};

beforeEach(async () => {
  await page.viewport(1280, 900);
  vi.mocked(getTodo).mockResolvedValue({ exists: false, content: "" });
  vi.mocked(listIssues).mockResolvedValue({ slug: null, webUrl: null, issues: [], viewer: null });
  vi.mocked(getEpics).mockResolvedValue({ epics: [], subIssues: [] });
  vi.mocked(listBranches).mockResolvedValue({ current: "main", branches: ["main"], default: null });
  vi.mocked(getRepoConfig).mockResolvedValue(cfg());
  vi.mocked(putRepoConfig).mockResolvedValue(cfg());
  vi.mocked(listRepos).mockResolvedValue({ repos: [repo], recentWindowDays: 30 });
  vi.mocked(listRemoteInstances).mockResolvedValue({ instances: [mac] });
  vi.mocked(getInstance).mockResolvedValue(self);
  vi.mocked(previewPlacement).mockImplementation(async (body) => ({
    active: true,
    placement: placedHere,
    deriveRequirements: body.target === undefined,
  }));
  vi.mocked(deriveRequirements).mockReset();
  vi.mocked(branchStatus).mockResolvedValue({ ahead: 0, behind: 0, diverged: false } as never);
  vi.mocked(getCommands).mockResolvedValue({ commands: [] });
});

afterEach(() => {
  document.body.innerHTML = "";
});

async function typePrompt(text: string) {
  const field = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
  field.value = text;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

const runButton = () => document.querySelector<HTMLButtonElement>("button.run")!;

async function submit() {
  await expect.poll(() => runButton().disabled).toBe(false);
  runButton().click();
}

const deriveText = () => document.querySelector(".nt-derive")?.textContent?.trim();
/** The requirement chips' labels. */
const chips = () =>
  [...document.querySelectorAll(".nt-requirements .chip")].map((c) =>
    c.firstChild?.textContent?.trim(),
  );
const readinessText = () => document.querySelector(".readiness")?.textContent?.trim() ?? "";
const removeChip = (ids: string[]) =>
  page.getByRole("button", {
    name: m.newtask_requirements_remove({ capability: capabilityList(ids) }),
  });

async function addRequirement(id: string) {
  const addSelect = () =>
    document.querySelector<HTMLSelectElement>(
      `select[aria-label="${m.newtask_requirements_add()}"]`,
    );
  await expect.poll(addSelect).not.toBeNull();
  const select = addSelect()!;
  select.value = id;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

const settle = (ms = 1_300) => new Promise((resolve) => setTimeout(resolve, ms));
/** The read starts a second after the last edit, so its answer needs longer than a poll's default. */
const READ = { timeout: 4_000 };

function open() {
  const onsubmit = vi.fn().mockResolvedValue(undefined);
  render(NewTask, { props: { onsubmit, initialRepoPath: repo.path } });
  return onsubmit;
}

describe("requirements read from the task (#2773)", () => {
  it("shows what it read as chips the operator corrects, and sends the correction", async () => {
    vi.mocked(deriveRequirements).mockResolvedValue({
      status: "derived",
      requirements: ["sdk:ios", "xcode"],
    });
    const onsubmit = open();
    await typePrompt("Implementiere die Ansicht in der iOS-App");
    await expect
      .poll(deriveText, READ)
      .toBe(m.newtask_derive_found({ list: capabilityList(["sdk:ios", "xcode"]) }));
    expect(deriveRequirements).toHaveBeenCalledWith(
      { repoPath: repo.path, prompt: "Implementiere die Ansicht in der iOS-App" },
      expect.any(AbortSignal),
    );
    await expect.element(removeChip(["sdk:ios"])).toBeVisible();
    await expect.element(removeChip(["xcode"])).toBeVisible();

    // The operator corrects them: theirs win from here on.
    await removeChip(["sdk:ios"]).click();
    await addRequirement("android-sdk");
    await typePrompt("Implementiere die Ansicht in der iOS-App, mit Tests");
    await settle();
    expect(deriveRequirements).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".nt-derive")).toBeNull();

    await submit();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0].requirements).toEqual(["android-sdk", "xcode"]);
  });

  it("asks when the description is unclear, and nothing starts before the answer", async () => {
    vi.mocked(deriveRequirements).mockResolvedValue({
      status: "unclear",
      options: [["xcode"], []],
    });
    const onsubmit = open();
    await typePrompt("Passe die App an das neue Logo an");
    await expect.element(page.getByText(m.newtask_derive_question()).first(), READ).toBeVisible();
    expect(runButton().disabled).toBe(true);
    expect(readinessText()).toContain(m.newtask_readiness_requirements_unclear());
    runButton().click();
    await settle(300);
    expect(onsubmit).not.toHaveBeenCalled();

    await page.getByRole("button", { name: m.newtask_derive_option_none() }).click();
    await submit();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0].requirements).toBeUndefined();
  });

  it("an answered question sets the chips it names", async () => {
    vi.mocked(deriveRequirements).mockResolvedValue({
      status: "unclear",
      options: [["xcode"], []],
    });
    const onsubmit = open();
    await typePrompt("Passe die App an das neue Logo an");
    const xcode = page.getByRole("button", { name: capabilityList(["xcode"]), exact: true });
    await expect.element(xcode, READ).toBeVisible();
    await xcode.click();
    await expect.element(removeChip(["xcode"])).toBeVisible();
    await submit();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0].requirements).toEqual(["xcode"]);
  });

  it("does not start while it is still reading", async () => {
    let answer: (value: RequirementsDerivation) => void = () => {};
    vi.mocked(deriveRequirements).mockImplementation(
      () => new Promise((resolve) => (answer = resolve)),
    );
    const onsubmit = open();
    await typePrompt("Ändere die Android-App");
    await expect.poll(deriveText).toBe(m.newtask_derive_pending());
    expect(runButton().disabled).toBe(true);
    expect(readinessText()).toContain(m.newtask_readiness_requirements_pending());
    await expect.poll(() => vi.mocked(deriveRequirements).mock.calls.length, READ).toBe(1);
    answer({ status: "derived", requirements: ["android-sdk"] });
    await submit();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0].requirements).toEqual(["android-sdk"]);
  });

  it("a failed read derives nothing and says so; the task can still start", async () => {
    vi.mocked(deriveRequirements).mockRejectedValue(new TypeError("network down"));
    const onsubmit = open();
    await typePrompt("Implementiere die Web-Einstellungen");
    await expect.poll(deriveText, READ).toBe(m.newtask_derive_failed());
    expect(chips()).toEqual([]);
    await submit();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0].requirements).toBeUndefined();
  });

  it("a timed-out read drops the chips an older text derived", async () => {
    vi.mocked(deriveRequirements)
      .mockResolvedValueOnce({ status: "derived", requirements: ["xcode"] })
      .mockResolvedValueOnce({ status: "failed", cause: "timeout" });
    open();
    await typePrompt("Erweitere die native macOS-App");
    await expect.element(removeChip(["xcode"]), READ).toBeVisible();
    await typePrompt("Erweitere die Web-Einstellungen");
    await expect.poll(deriveText, READ).toBe(m.newtask_derive_failed());
    expect(chips()).toEqual([]);
  });

  it("does not start before the Automatic preview says whether reading can matter", async () => {
    let answer: (value: PlacementPreview) => void = () => {};
    vi.mocked(previewPlacement).mockImplementation(
      () => new Promise((resolve) => (answer = resolve)),
    );
    const onsubmit = open();
    await typePrompt("Erweitere die native macOS-App");
    await expect.poll(() => vi.mocked(previewPlacement).mock.calls.length, READ).toBeGreaterThan(0);
    expect(runButton().disabled).toBe(true);
    expect(readinessText()).toContain(m.newtask_readiness_requirements_pending());
    runButton().click();
    await settle(300);
    expect(onsubmit).not.toHaveBeenCalled();

    answer({ active: true, placement: placedHere, deriveRequirements: false });
    await submit();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(deriveRequirements).not.toHaveBeenCalled();
  });

  it("a failed preview still reads the task: the server checks whether it matters", async () => {
    vi.mocked(previewPlacement).mockRejectedValue(new TypeError("network down"));
    vi.mocked(deriveRequirements).mockResolvedValue({ status: "derived", requirements: ["xcode"] });
    const onsubmit = open();
    await typePrompt("Erweitere die native macOS-App");
    await expect.element(removeChip(["xcode"]), READ).toBeVisible();
    await submit();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0].requirements).toEqual(["xcode"]);
  });

  it("reads nothing while the machines do not differ, and the task starts right away", async () => {
    vi.mocked(previewPlacement).mockResolvedValue({
      active: true,
      placement: placedHere,
      deriveRequirements: false,
    });
    const onsubmit = open();
    await typePrompt("Baue die macOS-App");
    await submit();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    await settle();
    expect(deriveRequirements).not.toHaveBeenCalled();
  });

  it("reads nothing once the operator set the chips", async () => {
    open();
    await addRequirement("xcode");
    await typePrompt("Baue die macOS-App");
    await settle();
    expect(deriveRequirements).not.toHaveBeenCalled();
    expect(document.querySelector(".nt-derive")).toBeNull();
  });
});
