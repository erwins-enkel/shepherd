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
  uploadFile,
} from "#lib/api.js";

// Requirements read from the task (#2773): under Automatic, New Task asks the server a second after
// the last edit — prompt, issue and screenshots. What it reads becomes correctable chips; an unclear
// description asks first and nothing starts before the answer; a failed read derives nothing and
// says so. The operator's own chips win: a different answer is then only offered to take over.

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
    uploadFile: vi.fn(),
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
    mergeWithoutCi: false,
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
  vi.mocked(listRemoteInstances).mockResolvedValue({ instances: [mac], incoming: [] });
  vi.mocked(getInstance).mockResolvedValue(self);
  vi.mocked(previewPlacement).mockImplementation(async (body) => ({
    active: true,
    placement: placedHere,
    deriveRequirements: body.target === undefined,
  }));
  vi.mocked(deriveRequirements).mockReset();
  vi.mocked(branchStatus).mockResolvedValue({ ahead: 0, behind: 0, diverged: false } as never);
  vi.mocked(getCommands).mockResolvedValue({ commands: [] });
  vi.mocked(uploadFile).mockImplementation(async (file: File) => `/staged/${file.name}`);
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

    // The operator corrects them: theirs win from here on, and the next read is only offered.
    await removeChip(["sdk:ios"]).click();
    await addRequirement("android-sdk");
    await typePrompt("Implementiere die Ansicht in der iOS-App, mit Tests");
    const adopt = page.getByRole("button", { name: m.newtask_derive_adopt() });
    await expect.element(adopt, READ).toBeVisible();
    expect(deriveRequirements).toHaveBeenCalledTimes(2);
    expect(chips()).toEqual([capabilityList(["android-sdk"]), capabilityList(["xcode"])]);

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

  it("a failed preview still reads the task", async () => {
    vi.mocked(previewPlacement).mockRejectedValue(new TypeError("network down"));
    vi.mocked(deriveRequirements).mockResolvedValue({ status: "derived", requirements: ["xcode"] });
    const onsubmit = open();
    await typePrompt("Erweitere die native macOS-App");
    await expect.element(removeChip(["xcode"]), READ).toBeVisible();
    await submit();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0].requirements).toEqual(["xcode"]);
  });

  it("does not start before the Automatic preview says whether reading can matter", async () => {
    let answer: (value: PlacementPreview) => void = () => {};
    vi.mocked(previewPlacement).mockImplementation(
      () => new Promise((resolve) => (answer = resolve)),
    );
    vi.mocked(deriveRequirements).mockImplementation(() => new Promise(() => {}));
    const onsubmit = open();
    await typePrompt("Erweitere die native macOS-App");
    await expect.poll(() => vi.mocked(previewPlacement).mock.calls.length, READ).toBeGreaterThan(0);
    expect(runButton().disabled).toBe(true);
    expect(readinessText()).toContain(m.newtask_readiness_requirements_pending());

    // It cannot matter: the task starts while the read is still out.
    answer({ active: true, placement: placedHere, deriveRequirements: false });
    await submit();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
  });

  it("reads even while the machines do not differ, so the chips say what the task needs", async () => {
    vi.mocked(previewPlacement).mockResolvedValue({
      active: true,
      placement: placedHere,
      deriveRequirements: false,
    });
    vi.mocked(deriveRequirements).mockResolvedValue({ status: "derived", requirements: ["xcode"] });
    open();
    await typePrompt("Baue die macOS-App");
    await expect.poll(() => runButton().disabled).toBe(false);
    await expect.element(removeChip(["xcode"]), READ).toBeVisible();
  });

  it("the operator's own chips do not wait; a different answer is offered and can be taken over", async () => {
    let answer: (value: RequirementsDerivation) => void = () => {};
    vi.mocked(deriveRequirements).mockImplementation(
      () => new Promise((resolve) => (answer = resolve)),
    );
    const onsubmit = open();
    await addRequirement("android-sdk");
    await typePrompt("Baue die macOS-App");
    await expect.poll(() => vi.mocked(deriveRequirements).mock.calls.length, READ).toBe(1);
    // Still reading, but the chips are the operator's: the task can start.
    await expect.poll(() => runButton().disabled).toBe(false);
    answer({ status: "derived", requirements: ["xcode"] });
    await page.getByRole("button", { name: m.newtask_derive_adopt() }).click();
    await expect.element(removeChip(["xcode"])).toBeVisible();
    expect(chips()).toEqual([capabilityList(["xcode"])]);
    await submit();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0].requirements).toEqual(["xcode"]);
  });

  it("sends the task's screenshots along, but not its other attachments", async () => {
    vi.mocked(deriveRequirements).mockResolvedValue({ status: "derived", requirements: [] });
    open();
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const files = [
      new File(["png"], "sim.png", { type: "image/png" }),
      new File(["pdf"], "spec.pdf", { type: "application/pdf" }),
    ];
    Object.defineProperty(input, "files", { value: files, configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await typePrompt("Fix das");
    await expect
      .poll(() => vi.mocked(deriveRequirements).mock.calls.at(-1)?.[0], READ)
      .toEqual({ repoPath: repo.path, prompt: "Fix das", images: ["/staged/sim.png"] });
  });
});
