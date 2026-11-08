import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import { ApiError, moveSession, replaceSessionAgent } from "#lib/api.js";
import { machines } from "#lib/machines.svelte.js";
import { toasts } from "#lib/toasts.svelte.js";
import type { InstanceIdentity, RemoteInstance, Session } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return { ...actual, moveSession: vi.fn(), replaceSessionAgent: vi.fn() };
});

const { default: ExperimentPicker } = await import("./ExperimentPicker.svelte");

const mockMove = vi.mocked(moveSession);
const mockReplace = vi.mocked(replaceSessionAgent);

// "Continue with…" offers the machines a session can move to: its own first, then this Shepherd
// and every connected machine released for tasks. Its own machine keeps today's in-place replace.

const SELF = { instanceId: "self-id", name: "moes-tavern" } as InstanceIdentity;
const MAC = {
  instanceId: "mac-id",
  name: "macbook",
  status: "connected",
  released: true,
  info: { version: "2.7.0", federationApi: 4, platform: "macos", arch: "arm64" },
  projects: ["acme/app"],
} as RemoteInstance;

beforeEach(() => {
  vi.clearAllMocks();
  toasts.items = [];
  machines.list = [MAC];
  machines.self = SELF;
  mockReplace.mockResolvedValue({ id: "s1" } as Session);
  mockMove.mockResolvedValue({ session: { id: "moved" } as Session, archived: true });
});

function open(over: Record<string, unknown> = {}) {
  const onselect = vi.fn();
  render(ExperimentPicker, {
    picker: { mode: "replace", id: "s1", x: 10, y: 10, project: "acme/app", ...over },
    fableAvailable: true,
    initialProvider: "claude",
    onselect,
  });
  return onselect;
}

const machineField = () => page.getByRole("combobox", { name: m.experiment_machine_label() });

describe("ExperimentPicker — Continue with… on another machine", () => {
  it("shows no machine field without another machine, and replaces in place", async () => {
    machines.list = [];
    const onselect = open();
    await expect.element(machineField()).not.toBeInTheDocument();
    await page.getByRole("button", { name: m.experiment_replace_confirm(), exact: true }).click();
    await vi.waitFor(() => expect(mockReplace).toHaveBeenCalledOnce());
    expect(mockMove).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(onselect).toHaveBeenCalledWith("s1"));
  });

  it("shows no machine field for a session that cannot move (no project)", async () => {
    open({ project: undefined });
    await expect.element(machineField()).not.toBeInTheDocument();
  });

  it("defaults to the session's machine; keeping it replaces in place", async () => {
    open();
    await expect.element(machineField()).toHaveValue("self-id");
    await expect.element(page.getByText(m.experiment_continue_scope())).toBeInTheDocument();
    await page.getByRole("button", { name: m.experiment_replace_confirm(), exact: true }).click();
    await vi.waitFor(() => expect(mockReplace).toHaveBeenCalledOnce());
    expect(mockMove).not.toHaveBeenCalled();
  });

  it("picking another machine explains the move and moves the session there", async () => {
    const onselect = open();
    await machineField().selectOptions("mac-id");
    await expect.element(page.getByText(m.experiment_move_note())).toBeInTheDocument();
    await page
      .getByRole("button", { name: m.experiment_move_confirm({ machine: "macbook" }) })
      .click();
    await vi.waitFor(() => expect(mockMove).toHaveBeenCalledOnce());
    expect(mockMove.mock.calls[0]![0]).toBe("s1");
    expect(mockMove.mock.calls[0]![1]).toMatchObject({
      target: { instanceId: "mac-id" },
      handoffMode: "resume",
    });
    expect(mockReplace).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(onselect).toHaveBeenCalledWith("moved"));
  });

  it("a session on another machine lists that machine first and can move here", async () => {
    open({ host: { instanceId: "mac-id", name: "macbook", platform: "macos" } });
    await expect.element(machineField()).toHaveValue("mac-id");
    await machineField().selectOptions("self-id");
    await page
      .getByRole("button", { name: m.experiment_move_confirm({ machine: "moes-tavern" }) })
      .click();
    await vi.waitFor(() =>
      expect(mockMove.mock.calls[0]![1]).toMatchObject({ target: { instanceId: "self-id" } }),
    );
  });

  it("a move the target holds names the machine", async () => {
    mockMove.mockResolvedValue({ held: true, archived: true });
    open();
    await machineField().selectOptions("mac-id");
    await page
      .getByRole("button", { name: m.experiment_move_confirm({ machine: "macbook" }) })
      .click();
    await vi.waitFor(() =>
      expect(toasts.items.map((t) => t.text)).toContain(
        m.experiment_move_held({ machine: "macbook" }),
      ),
    );
  });

  it("a refused move says why", async () => {
    mockMove.mockRejectedValue(new ApiError(409, "merging", "move_merging", true));
    open();
    await machineField().selectOptions("mac-id");
    await page
      .getByRole("button", { name: m.experiment_move_confirm({ machine: "macbook" }) })
      .click();
    await vi.waitFor(() =>
      expect(toasts.items.map((t) => t.text)).toContain(m.experiment_move_merging()),
    );
  });
});
