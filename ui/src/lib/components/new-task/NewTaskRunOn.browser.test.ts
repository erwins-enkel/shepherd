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
} from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";
import { capabilityList } from "#lib/placement.js";
import {
  ApiError,
  PlacementRefusedError,
  getInstance,
  previewPlacement,
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

// "Run on" in the New Task dialog (#2763): only there while a machine is connected. Automatic is
// the default (#2772) — the server's preview says where the task runs and why, the requirement chips
// feed it — or the operator names this machine or one that has the project. The submit carries the
// target only for a named machine, a dispatch key, the requirements and any attachments (#2766),
// and retries an unanswered send under the same key.

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

const self: InstanceIdentity = {
  instanceId: "self-1",
  name: "moes-tavern",
  version: "2.2.0",
  federationApi: 2,
  platform: "linux",
  arch: "x64",
};
const here = { instanceId: "self-1", name: "moes-tavern", platform: "linux" };
const mac = { instanceId: "mac-1", name: "MacBook", platform: "macos" };

function placed(target: Placement["target"], over: Partial<Placement> = {}): Placement {
  return {
    mode: "auto",
    target,
    requirements: [],
    basis: "preference",
    preferred: target.platform,
    by: { instanceId: "self-1", name: "moes-tavern" },
    decidedAt: 1,
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
  vi.mocked(getInstance).mockResolvedValue(self);
  vi.mocked(previewPlacement).mockResolvedValue({ active: true, placement: placed(here) });
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

const placementText = () => document.querySelector(".nt-placement")?.textContent?.trim();

async function addRequirement(id: string) {
  await expect.poll(() => addSelect()).not.toBeNull();
  const select = addSelect()!;
  select.value = id;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

const addSelect = () =>
  document.querySelector<HTMLSelectElement>(`select[aria-label="${m.newtask_requirements_add()}"]`);

async function pickMachine(instanceId: string) {
  await expect.poll(() => runOnSelect()).not.toBeNull();
  const select = runOnSelect()!;
  select.value = instanceId;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("Run on (#2763) and the automatic choice (#2772)", () => {
  it("is absent without machines: no target, no key, no preview", async () => {
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, { props: { onsubmit, initialRepoPath: repo.path } });
    await typePrompt("do it");
    await submit();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(runOnSelect()).toBeNull();
    expect(addSelect()).toBeNull();
    const input = onsubmit.mock.calls[0]![0];
    expect(input.target).toBeUndefined();
    expect(input.dispatchKey).toBeUndefined();
    expect(input.requirements).toBeUndefined();
    expect(previewPlacement).not.toHaveBeenCalled();
  });

  it("starts on Automatic and shows where the task runs and why before it is submitted", async () => {
    vi.mocked(listRemoteInstances).mockResolvedValue({ instances: [machine()] });
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, { props: { onsubmit, initialRepoPath: repo.path } });
    await expect.poll(() => runOnSelect()?.options.length).toBe(3);
    expect([...runOnSelect()!.options].map((o) => o.textContent?.trim())).toEqual([
      m.newtask_runon_auto(),
      m.newtask_runon_here(),
      "MacBook (macOS)",
    ]);
    expect(runOnSelect()!.value).toBe("");
    await expect.poll(placementText).toBe(
      m.placement_runs_on({
        machine: m.placement_this_machine({ machine: "moes-tavern" }),
        reason: m.placement_basis_preference_none({ platform: "Linux" }),
      }),
    );
    expect(previewPlacement).toHaveBeenLastCalledWith({ repoPath: repo.path });

    // Its explanation rides the select itself, so focus and assistive tech reach it.
    expect(runOnSelect()!.getAttribute("aria-description")).toContain(m.tooltip_runon_summary());
    await typePrompt("change the settings page");
    await submit();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    const input = onsubmit.mock.calls[0]![0];
    // Automatic: the server decides, so the task names no machine — but carries a key.
    expect(input.target).toBeUndefined();
    expect(input.dispatchKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("feeds the requirement chips to the preview and the task", async () => {
    vi.mocked(listRemoteInstances).mockResolvedValue({ instances: [machine()] });
    vi.mocked(previewPlacement).mockImplementation(async (body) =>
      body.requirements?.includes("xcode")
        ? {
            active: true,
            placement: placed(mac, {
              basis: "requirements",
              preferred: null,
              requirements: ["xcode"],
            }),
          }
        : { active: true, placement: placed(here) },
    );
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, { props: { onsubmit, initialRepoPath: repo.path } });
    await addRequirement("xcode");
    await expect.poll(placementText).toBe(
      m.placement_runs_on({
        machine: "MacBook",
        reason: m.placement_basis_requirements({ list: capabilityList(["xcode"]) }),
      }),
    );
    expect(previewPlacement).toHaveBeenLastCalledWith({
      repoPath: repo.path,
      requirements: ["xcode"],
    });
    // Bound for another machine: the dialog says what it has of the code.
    await expect
      .element(page.getByText(m.newtask_runon_notice({ machine: "MacBook", base: "main" })))
      .toBeVisible();

    await typePrompt("build the macOS app");
    await submit();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    const input = onsubmit.mock.calls[0]![0];
    expect(input.requirements).toEqual(["xcode"]);
    expect(input.target).toBeUndefined();

    // A chip can be removed again.
    await page
      .getByRole("button", {
        name: m.newtask_requirements_remove({ capability: capabilityList(["xcode"]) }),
      })
      .click();
    await expect.poll(() => addSelect()?.options.length).toBeGreaterThan(10);
  });

  it("names a machine as the target, and this machine by its own ID", async () => {
    vi.mocked(listRemoteInstances).mockResolvedValue({
      instances: [
        machine(),
        machine({ instanceId: "other-1", name: "Builder", projects: ["acme/other"] }),
        machine({ instanceId: "down-1", name: "Laptop", status: "unreachable" }),
      ],
    });
    vi.mocked(previewPlacement).mockImplementation(async (body) => ({
      active: true,
      placement: placed(body.target?.instanceId === "mac-1" ? mac : here, {
        mode: body.target ? "manual" : "auto",
        basis: body.target ? "manual" : "preference",
      }),
    }));
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, { props: { onsubmit, initialRepoPath: repo.path } });
    await expect.poll(() => runOnSelect()?.options.length).toBe(3);
    await pickMachine("mac-1");
    await expect
      .poll(placementText)
      .toBe(m.placement_runs_on({ machine: "MacBook", reason: m.placement_basis_manual() }));
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

    await pickMachine("self-1");
    await submit();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(2);
    expect(onsubmit.mock.calls[1]![0].target).toEqual({ instanceId: "self-1" });
  });

  it("says before submitting when no machine fits", async () => {
    vi.mocked(listRemoteInstances).mockResolvedValue({ instances: [machine()] });
    const refused: PlacementPreview = {
      active: true,
      refusal: {
        code: "no_suitable_machine",
        error: "no connected machine has android-sdk; nothing was started",
        missing: ["android-sdk"],
        together: false,
        elsewhere: [],
      },
    };
    vi.mocked(previewPlacement).mockResolvedValue(refused);
    render(NewTask, { props: { onsubmit: vi.fn(), initialRepoPath: repo.path } });
    await expect
      .poll(placementText)
      .toBe(m.placement_refusal_none({ list: capabilityList(["android-sdk"]) }));
  });

  it("names what is missing when the create refuses the machine choice", async () => {
    vi.mocked(listRemoteInstances).mockResolvedValue({ instances: [machine()] });
    const refusal = {
      code: "preferred_machine_offline",
      error: "MacBook would run this task but is not reachable right now (timeout)",
      host: mac,
      status: "timeout",
      alternatives: [],
    };
    const onsubmit = vi
      .fn()
      .mockRejectedValueOnce(
        new PlacementRefusedError(
          new ApiError(409, refusal.error, "preferred_machine_offline", true),
          refusal,
        ),
      );
    render(NewTask, { props: { onsubmit, initialRepoPath: repo.path } });
    await typePrompt("build it");
    await submit();
    await expect
      .element(page.getByText(m.placement_refusal_offline({ machine: "MacBook" })))
      .toBeVisible();
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
    await expect.poll(() => runOnSelect()?.options.length).toBe(3);
    expect([...runOnSelect()!.options].map((o) => o.value)).not.toContain("win-1");
  });

  it("is unchanged while the server says the choice is not active (only Windows)", async () => {
    vi.mocked(listRemoteInstances).mockResolvedValue({ instances: [windows()] });
    vi.mocked(previewPlacement).mockResolvedValue({ active: false });
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, { props: { onsubmit, initialRepoPath: repo.path } });
    await expect.poll(() => vi.mocked(previewPlacement).mock.calls.length).toBeGreaterThan(0);
    await expect.poll(runOnSelect).toBeNull();
    await typePrompt("do it");
    await submit();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(runOnSelect()).toBeNull();
    expect(onsubmit.mock.calls[0]![0].target).toBeUndefined();
    expect(onsubmit.mock.calls[0]![0].dispatchKey).toBeUndefined();
  });

  // #2766: attachments travel with the task; the server uploads them to the machine.
  it("sends attachments along to another machine", async () => {
    vi.mocked(listRemoteInstances).mockResolvedValue({ instances: [machine()] });
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, {
      props: {
        onsubmit,
        initialRepoPath: repo.path,
        initialImages: [{ path: "/staged/shot.png", name: "shot.png" }],
      },
    });
    await typePrompt("look at this");
    await pickMachine("mac-1");
    await submit();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    const input = onsubmit.mock.calls[0]![0];
    expect(input.target).toEqual({ instanceId: "mac-1" });
    expect(input.images).toEqual(["/staged/shot.png"]);
    expect(input.attachmentNames).toEqual(["shot.png"]);
  });

  it("names the machine when an attachment did not reach it", async () => {
    vi.mocked(listRemoteInstances).mockResolvedValue({ instances: [machine()] });
    const reason = "attachment 1 of 1: the machine answered 413 (file too large)";
    const onsubmit = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(502, reason, "remote_upload_failed", true));
    render(NewTask, {
      props: {
        onsubmit,
        initialRepoPath: repo.path,
        initialImages: [{ path: "/staged/shot.png", name: "shot.png" }],
      },
    });
    await typePrompt("look at this");
    await pickMachine("mac-1");
    await submit();
    await expect
      .element(page.getByText(m.newtask_runon_upload_failed({ machine: "MacBook", reason })))
      .toBeVisible();
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
