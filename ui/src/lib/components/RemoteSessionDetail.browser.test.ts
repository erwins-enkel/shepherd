import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import { connectPty } from "#lib/pty.js";
import RemoteSessionDetail from "./RemoteSessionDetail.svelte";
import { m } from "#lib/paraglide/messages.js";
import { statusLabel } from "#lib/format.js";
import type { Session } from "#lib/types.js";

// The terminal's socket is the server's business (bridged to the machine); here it is a spy.
vi.mock("#lib/pty.js", () => ({
  connectPty: vi.fn(() => ({
    send: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
    poke: vi.fn(),
    takeover: vi.fn(),
  })),
}));

const host = { instanceId: "m1", name: "MacBook", platform: "macos" };

function remote(over: Partial<Session> = {}): Session {
  return {
    id: "r1",
    desig: "TASK-07",
    name: "fix login redirect",
    prompt: "Fix the login redirect loop",
    repoPath: "/Users/kai/projects/app",
    baseBranch: "main",
    branch: "shepherd/fix-login",
    status: "running",
    readyToMerge: false,
    host,
    connection: { state: "connected", since: Date.now() },
    ...over,
  } as Session;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(connectPty).mockClear();
});

describe("RemoteSessionDetail (#2762)", () => {
  it("opens the session's terminal, bridged through this server (#2764)", async () => {
    render(RemoteSessionDetail, { session: remote(), nowMs: Date.now(), terminalOwners: {} });
    await expect
      .element(page.getByRole("region", { name: m.remote_terminal_aria({ machine: "MacBook" }) }))
      .toBeInTheDocument();
    await vi.waitFor(() => expect(connectPty).toHaveBeenCalledTimes(1));
    expect(vi.mocked(connectPty).mock.calls[0]![0]).toBe("r1");
  });

  it("shows what the machine reports and disables every action, saying why", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(RemoteSessionDetail, { session: remote(), nowMs: Date.now() });
    await expect.element(page.getByText("MacBook · TASK-07")).toBeInTheDocument();
    await expect.element(page.getByText("fix login redirect")).toBeInTheDocument();
    await expect.element(page.getByText("Fix the login redirect loop")).toBeInTheDocument();
    await expect.element(page.getByText("shepherd/fix-login")).toBeInTheDocument();
    await expect
      .element(page.getByRole("img", { name: m.remote_runs_on({ machine: "MacBook" }) }))
      .toBeInTheDocument();
    for (const label of [
      m.remote_detail_steer(),
      m.remote_detail_stop(),
      m.remote_detail_archive(),
    ]) {
      const button = page.getByRole("button", { name: label });
      await expect.element(button).toHaveAttribute("aria-disabled", "true");
      expect(button.element().getAttribute("aria-description")).toContain(
        m.tooltip_remote_actions_body({ machine: "MacBook" }),
      );
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the last known state visible while the machine is unreachable", async () => {
    const since = new Date(2026, 9, 11, 14, 32).getTime();
    render(RemoteSessionDetail, {
      session: remote({ connection: { state: "disconnected", since } }),
      nowMs: since + 60_000,
    });
    const time = new Date(since).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
    await expect.element(page.getByText(m.remote_disconnected_line({ time }))).toBeInTheDocument();
    // The last status the machine reported stays — a lost connection is not an end.
    await expect
      .element(page.getByText(statusLabel("running"), { exact: true }))
      .toBeInTheDocument();
  });

  it("offers the way back on the phone layout", async () => {
    const onback = vi.fn();
    render(RemoteSessionDetail, { session: remote(), nowMs: Date.now(), onback });
    await page.getByRole("button", { name: m.viewport_back_aria() }).click();
    expect(onback).toHaveBeenCalled();
  });
});
