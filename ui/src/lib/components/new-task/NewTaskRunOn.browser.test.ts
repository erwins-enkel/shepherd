import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import type { RemoteInstance, RepoConfig, RepoEntry } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";
import {
  ApiError,
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

// "Run on" in the New Task dialog (#2763): only there while a machine is connected, offering the
// machines that have the project, carrying the target and a dispatch key into the submit, and
// retrying an unanswered send under the same key.

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

function machine(over: Partial<RemoteInstance> = {}): RemoteInstance {
  return {
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
    info: { version: "2.2.0", federationApi: 1, platform: "macos", arch: "arm64" },
    projects: ["acme/app"],
    capabilities: null,
    released: true,
    ...over,
  };
}

beforeEach(async () => {
  await page.viewport(1280, 900);
  vi.mocked(getTodo).mockResolvedValue({ exists: false, content: "" });
  vi.mocked(listIssues).mockResolvedValue({ slug: null, webUrl: null, issues: [], viewer: null });
  vi.mocked(getEpics).mockResolvedValue({ epics: [], subIssues: [] });
  vi.mocked(listBranches).mockResolvedValue({ current: "main", branches: ["main"], default: null });
  vi.mocked(getRepoConfig).mockResolvedValue(cfg());
  vi.mocked(putRepoConfig).mockResolvedValue(cfg());
  vi.mocked(listRepos).mockResolvedValue({ repos: [repo], recentWindowDays: 30 });
  vi.mocked(listRemoteInstances).mockResolvedValue({ instances: [] });
  vi.mocked(branchStatus).mockResolvedValue({ ahead: 0, behind: 0, diverged: false } as never);
  vi.mocked(getCommands).mockResolvedValue({ commands: [] });
});

afterEach(() => {
  document.body.innerHTML = "";
});

const runOnSelect = () =>
  document.querySelector<HTMLSelectElement>(`select[aria-label="${m.newtask_runon_label()}"]`);

async function typePrompt(text: string) {
  const field = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
  field.value = text;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

async function submit() {
  const run = document.querySelector<HTMLButtonElement>("button.run")!;
  await expect.poll(() => run.disabled).toBe(false);
  run.click();
}

async function pickMachine(instanceId: string) {
  await expect.poll(() => runOnSelect()).not.toBeNull();
  const select = runOnSelect()!;
  select.value = instanceId;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("Run on (#2763)", () => {
  it("is absent without a connected machine, and the task carries no target", async () => {
    vi.mocked(listRemoteInstances).mockResolvedValue({
      instances: [machine({ status: "unreachable" })],
    });
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, { props: { onsubmit, initialRepoPath: repo.path } });
    await typePrompt("do it");
    await submit();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(runOnSelect()).toBeNull();
    expect(onsubmit.mock.calls[0]![0].target).toBeUndefined();
    expect(onsubmit.mock.calls[0]![0].dispatchKey).toBeUndefined();
  });

  it("offers the connected machines that have the project and sends the task there", async () => {
    vi.mocked(listRemoteInstances).mockResolvedValue({
      instances: [
        machine(),
        machine({ instanceId: "other-1", name: "Builder", projects: ["acme/other"] }),
        machine({ instanceId: "down-1", name: "Laptop", status: "unreachable" }),
      ],
    });
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, { props: { onsubmit, initialRepoPath: repo.path } });
    await expect.poll(() => runOnSelect()?.options.length).toBe(2);
    expect([...runOnSelect()!.options].map((o) => o.textContent?.trim())).toEqual([
      m.newtask_runon_here(),
      "MacBook (macOS)",
    ]);

    // Its explanation rides the select itself, so focus and assistive tech reach it.
    expect(runOnSelect()!.getAttribute("aria-description")).toContain(m.tooltip_runon_summary());
    await pickMachine("mac-1");
    await expect
      .element(page.getByText(m.newtask_runon_notice({ machine: "MacBook", base: "main" })))
      .toBeVisible();
    await typePrompt("port the settings screen");
    await submit();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    const input = onsubmit.mock.calls[0]![0];
    expect(input.target).toEqual({ instanceId: "mac-1" });
    expect(input.dispatchKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(input.repoPath).toBe(repo.path);
    expect(input.prompt).toBe("port the settings screen");
  });

  const windows = () =>
    machine({
      instanceId: "win-1",
      name: "WinBox",
      info: { version: "2.2.0", federationApi: 1, platform: "windows", arch: "x64" },
      released: false,
    });

  it("never offers a Windows machine (not released, #2770)", async () => {
    vi.mocked(listRemoteInstances).mockResolvedValue({ instances: [windows(), machine()] });
    render(NewTask, { props: { onsubmit: vi.fn(), initialRepoPath: repo.path } });
    await expect.poll(() => runOnSelect()?.options.length).toBe(2);
    expect([...runOnSelect()!.options].map((o) => o.value)).not.toContain("win-1");
  });

  it("with only a Windows machine connected the dialog is unchanged", async () => {
    vi.mocked(listRemoteInstances).mockResolvedValue({ instances: [windows()] });
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, { props: { onsubmit, initialRepoPath: repo.path } });
    await typePrompt("do it");
    await submit();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(runOnSelect()).toBeNull();
    expect(onsubmit.mock.calls[0]![0].target).toBeUndefined();
  });

  it("says when no connected machine has the project", async () => {
    vi.mocked(listRemoteInstances).mockResolvedValue({
      instances: [machine({ projects: ["acme/other"] })],
    });
    render(NewTask, { props: { onsubmit: vi.fn(), initialRepoPath: repo.path } });
    await expect.element(page.getByText(m.newtask_runon_none())).toBeVisible();
    expect(runOnSelect()!.disabled).toBe(true);
  });

  it("blocks attachments for another machine, with the reason", async () => {
    vi.mocked(listRemoteInstances).mockResolvedValue({ instances: [machine()] });
    const onsubmit = vi.fn();
    render(NewTask, {
      props: {
        onsubmit,
        initialRepoPath: repo.path,
        initialImages: [{ path: "/staged/shot.png", name: "shot.png" }],
      },
    });
    await typePrompt("look at this");
    await pickMachine("mac-1");
    await expect.element(page.getByText(m.newtask_readiness_remote_attachments())).toBeVisible();
    expect(document.querySelector<HTMLButtonElement>("button.run")!.disabled).toBe(true);
    expect(onsubmit).not.toHaveBeenCalled();
  });

  it("retries an unanswered send under the same key, and names the machine", async () => {
    vi.mocked(listRemoteInstances).mockResolvedValue({ instances: [machine()] });
    const onsubmit = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(504, "no answer", "remote_dispatch_unknown", true))
      .mockRejectedValueOnce(new ApiError(422, "base missing", "remote_rejected", true));
    render(NewTask, { props: { onsubmit, initialRepoPath: repo.path } });
    await pickMachine("mac-1");
    await typePrompt("port it");
    await submit();
    await expect
      .element(page.getByText(m.newtask_runon_unknown({ machine: "MacBook" })))
      .toBeVisible();

    await page.getByRole("button", { name: m.common_retry() }).click();
    await expect
      .element(
        page.getByText(m.newtask_runon_rejected({ machine: "MacBook", reason: "base missing" })),
      )
      .toBeVisible();
    const [first, second] = onsubmit.mock.calls.map((c) => c[0]);
    expect(second.dispatchKey).toBe(first.dispatchKey);

    // A refusal is final for that dispatch: the next attempt is a new one.
    onsubmit.mockResolvedValueOnce(undefined);
    await page.getByRole("button", { name: m.common_retry() }).click();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(3);
    expect(onsubmit.mock.calls[2]![0].dispatchKey).not.toBe(first.dispatchKey);
  });
});
