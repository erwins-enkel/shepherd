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

// The forwarded reads and actions (#2765) go through the api module; the server forwards them.
vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return {
    ...actual,
    interruptSession: vi.fn(async () => {}),
    getLeftovers: vi.fn(async () => ({ leftovers: [], probesUnavailable: false })),
    getActivity: vi.fn(async () => []),
    getDiff: vi.fn(async () => ({
      base: "main",
      baseRef: "main",
      head: "shepherd/fix-login",
      fetchFailed: false,
      truncated: false,
      files: [],
    })),
    getDiffAnnotations: vi.fn(async () => ({ notes: [] })),
    getScratchpadListing: vi.fn(async () => ({ path: "", parent: null, entries: [] })),
  };
});
const api = await import("#lib/api.js");
const { toasts } = await import("#lib/toasts.svelte.js");

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(connectPty).mockClear();
  for (const fn of [
    api.interruptSession,
    api.getLeftovers,
    api.getActivity,
    api.getDiff,
    api.getScratchpadListing,
  ])
    vi.mocked(fn).mockClear();
});

describe("RemoteSessionDetail started from here (#2763)", () => {
  it("shows the commit the machine started from and a sandbox it did not have", async () => {
    render(RemoteSessionDetail, {
      session: remote({ baseCommit: "a".repeat(40), sandboxDegraded: true }),
      nowMs: Date.now(),
    });
    await expect.element(page.getByText(m.remote_detail_base())).toBeInTheDocument();
    await expect.element(page.getByText("main @ aaaaaaa")).toBeInTheDocument();
    await expect.element(page.getByText(m.session_sandbox_degraded_label())).toBeInTheDocument();
  });

  it("shows neither fact for a session that reports no base commit and a working sandbox", async () => {
    render(RemoteSessionDetail, { session: remote({ sandboxDegraded: false }), nowMs: Date.now() });
    await expect.element(page.getByText("MacBook · TASK-07")).toBeInTheDocument();
    expect(page.getByText(m.remote_detail_base()).elements()).toHaveLength(0);
    expect(page.getByText(m.remote_detail_sandbox()).elements()).toHaveLength(0);
  });
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

  it("shows what the machine reports", async () => {
    render(RemoteSessionDetail, { session: remote(), nowMs: Date.now() });
    await expect.element(page.getByText("MacBook · TASK-07")).toBeInTheDocument();
    await expect.element(page.getByText("fix login redirect")).toBeInTheDocument();
    await expect.element(page.getByText("Fix the login redirect loop")).toBeInTheDocument();
    await expect.element(page.getByText("shepherd/fix-login")).toBeInTheDocument();
    await expect
      .element(page.getByRole("img", { name: m.remote_runs_on({ machine: "MacBook" }) }))
      .toBeInTheDocument();
  });

  it("stops the session on its machine and names a machine that can't be reached (#2765)", async () => {
    render(RemoteSessionDetail, { session: remote(), nowMs: Date.now() });
    const actions = page.getByRole("group", {
      name: m.remote_detail_actions_live_aria({ machine: "MacBook" }),
    });
    await actions.getByRole("button", { name: m.remote_detail_stop() }).click();
    expect(api.interruptSession).toHaveBeenCalledWith("r1");
    await vi.waitFor(() =>
      expect(
        toasts.items.some((t) => t.text === m.cardmenu_stop_toast({ name: "fix login redirect" })),
      ).toBe(true),
    );

    vi.mocked(api.interruptSession).mockRejectedValueOnce(
      new api.ApiError(502, "MacBook is not reachable", "machine_unreachable", true),
    );
    await actions.getByRole("button", { name: m.remote_detail_stop() }).click();
    await vi.waitFor(() =>
      expect(
        toasts.items.some((t) => t.text === m.remote_action_unreachable({ machine: "MacBook" })),
      ).toBe(true),
    );
  });

  it("its steer bar's pencil opens this Shepherd's steers editor", async () => {
    const onedit = vi.fn();
    render(RemoteSessionDetail, { session: remote(), nowMs: Date.now(), onedit });
    // SteerBar's own tap wiring (pointerdown → pointerup), as its tests drive it; the bar may
    // show the pencil or the label toggle depending on width, so reach it in the DOM.
    await vi.waitFor(() => expect(document.querySelector(".edit-steers")).not.toBeNull());
    const pencil = document.querySelector(".edit-steers") as HTMLElement;
    pencil.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, bubbles: true }));
    pencil.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
    await vi.waitFor(() => expect(onedit).toHaveBeenCalled());
  });

  it("archives after a confirm, offering what would keep running on the machine first", async () => {
    const ondecommission = vi.fn();
    render(RemoteSessionDetail, { session: remote(), nowMs: Date.now(), ondecommission });
    await page.getByRole("button", { name: m.remote_detail_archive() }).click();
    expect(api.getLeftovers).not.toHaveBeenCalled(); // armed only
    await page.getByRole("button", { name: m.viewport_confirm_decommission() }).click();
    await vi.waitFor(() => expect(ondecommission).toHaveBeenCalledWith("r1"));
    expect(api.getLeftovers).toHaveBeenCalledWith("r1");

    ondecommission.mockClear();
    vi.mocked(api.getLeftovers).mockResolvedValueOnce({
      leftovers: [{ key: "vite", kind: "process", name: "vite", port: 5173 }],
      probesUnavailable: false,
    });
    await page.getByRole("button", { name: m.remote_detail_archive() }).click();
    await page.getByRole("button", { name: m.viewport_confirm_decommission() }).click();
    await expect.element(page.getByRole("dialog")).toBeInTheDocument();
    await page.getByRole("button", { name: m.leftover_close_only() }).click();
    expect(ondecommission).toHaveBeenCalledWith("r1", undefined);
  });

  it("an Archive armed on one session never confirms another", async () => {
    const ondecommission = vi.fn();
    const { rerender } = await render(RemoteSessionDetail, {
      session: remote(),
      nowMs: Date.now(),
      ondecommission,
    });
    await page.getByRole("button", { name: m.remote_detail_archive() }).click();
    await expect
      .element(page.getByRole("button", { name: m.viewport_confirm_decommission() }))
      .toBeInTheDocument();
    await rerender({ session: remote({ id: "r2", desig: "TASK-08" }), ondecommission });
    // Checked at once: the arm would otherwise lapse by itself after a few seconds.
    expect(
      page.getByRole("button", { name: m.viewport_confirm_decommission() }).query(),
    ).toBeNull();
    expect(page.getByRole("button", { name: m.remote_detail_archive() }).query()).not.toBeNull();
    expect(ondecommission).not.toHaveBeenCalled();
    expect(api.getLeftovers).not.toHaveBeenCalled();
  });

  it("reads activity, diff and files from the machine; the terminal stays attached", async () => {
    render(RemoteSessionDetail, { session: remote(), nowMs: Date.now(), terminalOwners: {} });
    await vi.waitFor(() => expect(connectPty).toHaveBeenCalledTimes(1));

    await page.getByRole("tab", { name: m.viewport_activity_tab() }).click();
    await vi.waitFor(() => expect(api.getActivity).toHaveBeenCalledWith("r1"));
    await page.getByRole("tab", { name: m.viewport_diff_tab() }).click();
    await vi.waitFor(() => expect(api.getDiff).toHaveBeenCalledWith("r1"));
    await expect
      .element(page.getByRole("tab", { name: m.viewport_diff_tab() }))
      .toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: m.viewport_files_tab() }).click();
    await vi.waitFor(() => expect(api.getScratchpadListing).toHaveBeenCalledWith("r1", undefined));
    await page.getByRole("tab", { name: m.viewport_terminal_tab() }).click();
    await expect
      .element(page.getByRole("region", { name: m.remote_terminal_aria({ machine: "MacBook" }) }))
      .toBeVisible();
    // Never re-attached: the terminal was only hidden while the other tabs showed.
    expect(connectPty).toHaveBeenCalledTimes(1);
  });

  it("disables every action and read while the machine is disconnected, saying why", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(RemoteSessionDetail, {
      session: remote({ connection: { state: "disconnected", since: Date.now() } }),
      nowMs: Date.now(),
    });
    for (const label of [
      m.remote_detail_steer(),
      m.remote_detail_stop(),
      m.remote_detail_archive(),
    ]) {
      const button = page.getByRole("button", { name: label });
      await expect.element(button).toHaveAttribute("aria-disabled", "true");
      expect(button.element().getAttribute("aria-description")).toContain(
        m.tooltip_remote_forwarded_body({ machine: "MacBook" }),
      );
    }
    for (const tab of [m.viewport_activity_tab(), m.viewport_diff_tab(), m.viewport_files_tab()])
      await expect.element(page.getByRole("tab", { name: tab })).toBeDisabled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(api.interruptSession).not.toHaveBeenCalled();
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
