import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../../app.css";
import EpicRunSettings from "./EpicRunSettings.svelte";
import type { Epic, InstanceIdentity, RemoteInstance } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";
import { machines } from "#lib/machines.svelte.js";

const api = vi.hoisted(() => ({
  updateEpic: vi.fn(async () => ({})),
  getRepoConfig: vi.fn<(repo: string) => Promise<unknown>>(async () => {
    throw new Error("offline");
  }),
}));

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return { ...actual, ...api };
});

// The machine an epic's children run on: offered only while another machine is registered.

const REPO = "/repo";
const SELF = "b1111111-1111-4111-8111-111111111111";
const MAC = "a2222222-2222-4222-8222-222222222222";

const self: InstanceIdentity = {
  instanceId: SELF,
  name: "moes-tavern",
  version: "2.6.0",
  federationApi: 1,
  platform: "linux",
  arch: "x64",
};

function mac(status: RemoteInstance["status"] = "connected"): RemoteInstance {
  return {
    instanceId: MAC,
    name: "macbook",
    label: "macbook",
    reportedName: "macbook",
    url: "https://mac.example",
    tokenHint: null,
    createdAt: 1,
    status,
    reason: null,
    checkedAt: 1,
    lastSeenAt: 1,
    info: { version: "2.6.0", federationApi: 1, platform: "macos", arch: "arm64" },
    projects: ["o/r"],
    capabilities: null,
    released: true,
  };
}

function epic(machine?: string): Epic {
  return {
    repoPath: REPO,
    parentIssueNumber: 7,
    parentTitle: "Epic",
    source: "native",
    children: [],
    warnings: [],
    run: {
      repoPath: REPO,
      parentIssueNumber: 7,
      mode: "auto",
      status: "idle",
      ...(machine && { machine }),
    },
  };
}

const machineSelect = () => page.getByRole("combobox", { name: m.epic_machine_aria() });

describe("EpicRunSettings: machine", () => {
  beforeEach(() => {
    api.updateEpic.mockClear();
    machines.list = [];
    machines.self = null;
  });

  it("is absent while no other machine is registered", async () => {
    render(EpicRunSettings, { repoPath: REPO, parent: 7, epic: epic() });
    await expect
      .element(page.getByRole("combobox", { name: m.epic_sandbox_aria({ repo: "repo" }) }))
      .toBeInTheDocument();
    expect(machineSelect().query()).toBeNull();
  });

  it("offers Automatic, this machine and the connected one; a pick is saved", async () => {
    machines.list = [mac()];
    machines.self = self;
    render(EpicRunSettings, { repoPath: REPO, parent: 7, epic: epic() });
    await expect.element(machineSelect()).toHaveValue("");
    await userEvent.selectOptions(machineSelect(), MAC);
    expect(api.updateEpic).toHaveBeenCalledWith(REPO, 7, { machine: MAC });
    await userEvent.selectOptions(machineSelect(), "");
    expect(api.updateEpic).toHaveBeenLastCalledWith(REPO, 7, { machine: null });
  });

  it("keeps a named machine that is not connected, marked as such", async () => {
    machines.list = [mac("unreachable")];
    machines.self = self;
    render(EpicRunSettings, { repoPath: REPO, parent: 7, epic: epic(MAC) });
    await expect.element(machineSelect()).toHaveValue(MAC);
    await expect
      .element(page.getByRole("option", { name: m.epic_machine_offline({ machine: "macbook" }) }))
      .toBeInTheDocument();
  });
});
