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

// The designator's hover panel, as assistive tech reads it (statusTip's aria-description).
function factsOf(el: Element): string {
  return el.getAttribute("aria-description") ?? "";
}

// The forwarded reads and actions (#2765) go through the api module; the server forwards them.
vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return {
    ...actual,
    interruptSession: vi.fn(async () => {}),
    getSessionUsage: vi.fn(async () => ({
      available: true,
      source: "live" as const,
      total: 1200,
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      messageCount: null,
      byModel: null,
    })),
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
    getPreviewReach: vi.fn(async () => ({ bound: false, url: null, unavailable: null })),
    startPreview: vi.fn(async () => ({ ok: true, command: "bun run dev", mode: "local" })),
    stopPreview: vi.fn(async () => ({ killed: 1 })),
  };
});
const api = await import("#lib/api.js");
const { toasts } = await import("#lib/toasts.svelte.js");

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(connectPty).mockClear();
  for (const fn of [
    api.interruptSession,
    api.getSessionUsage,
    api.getLeftovers,
    api.getActivity,
    api.getDiff,
    api.getScratchpadListing,
    api.getPreviewReach,
    api.startPreview,
    api.stopPreview,
  ])
    vi.mocked(fn).mockClear();
});

describe("RemoteSessionDetail started from here (#2763)", () => {
  it("shows the commit the machine started from and a sandbox it did not have", async () => {
    render(RemoteSessionDetail, {
      session: remote({ baseCommit: "a".repeat(40), sandboxDegraded: true }),
      nowMs: Date.now(),
    });
    const facts = factsOf(page.getByRole("button", { name: "MacBook · TASK-07" }).element());
    expect(facts).toContain(`${m.remote_detail_base()}: main @ aaaaaaa`);
    expect(facts).toContain(`${m.remote_detail_sandbox()}: ${m.session_sandbox_degraded_label()}`);
  });

  it("shows neither fact for a session that reports no base commit and a working sandbox", async () => {
    render(RemoteSessionDetail, { session: remote({ sandboxDegraded: false }), nowMs: Date.now() });
    const facts = factsOf(page.getByRole("button", { name: "MacBook · TASK-07" }).element());
    expect(facts).not.toContain(`${m.remote_detail_base()}:`);
    expect(facts).not.toContain(`${m.remote_detail_sandbox()}:`);
  });

  it("says why it runs on that machine, as the Shepherd that chose it recorded (#2772)", async () => {
    const placement = {
      mode: "auto" as const,
      target: host,
      requirements: ["xcode"],
      basis: "requirements" as const,
      preferred: null,
      by: { instanceId: "l1", name: "moes-tavern" },
      decidedAt: 1,
    };
    render(RemoteSessionDetail, {
      session: remote({
        launchMetadata: {
          placement,
          agent: { provider: "claude" },
          resolvedLaunch: { effort: null },
        } as unknown as Session["launchMetadata"],
      }),
      nowMs: Date.now(),
    });
    // The status bar's, as for a local session.
    await expect
      .element(
        page.getByText(m.placement_basis_requirements({ list: m.settings_machines_cap_xcode() })),
      )
      .toBeInTheDocument();
  });
});

describe("RemoteSessionDetail lays out like the local Viewport", () => {
  it("puts the tabs and the actions in the header and the terminal above the steer bar", async () => {
    render(RemoteSessionDetail, { session: remote(), nowMs: Date.now(), terminalOwners: {} });
    const term = page.getByRole("region", { name: m.remote_terminal_aria({ machine: "MacBook" }) });
    await expect.element(term).toBeInTheDocument();
    expect(page.getByRole("tablist").element().closest("header")).not.toBeNull();
    for (const name of [m.remote_detail_stop(), m.remote_detail_archive()])
      expect(page.getByRole("button", { name }).element().closest("header")).not.toBeNull();
    await vi.waitFor(() => expect(document.querySelector(".steer-row")).not.toBeNull());
    const steer = document.querySelector(".steer-row")!;
    expect(term.element().compareDocumentPosition(steer) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("shows the keyboard hints on the desktop layout only", async () => {
    const view = await render(RemoteSessionDetail, { session: remote(), nowMs: Date.now() });
    await expect.element(page.getByText(m.viewport_keynav_hint())).toBeInTheDocument();
    await expect.element(page.getByText(m.viewport_keynav_enter_hint())).toBeInTheDocument();
    await view.rerender({ compact: true });
    expect(page.getByText(m.viewport_keynav_hint()).query()).toBeNull();
  });

  it("reads the token usage from the machine for the status bar", async () => {
    render(RemoteSessionDetail, { session: remote(), nowMs: Date.now() });
    await vi.waitFor(() => expect(api.getSessionUsage).toHaveBeenCalledWith("r1"));
  });

  it("hands the keyboard back to its terminal", async () => {
    const { component } = await render(RemoteSessionDetail, {
      session: remote(),
      nowMs: Date.now(),
    });
    await vi.waitFor(() => expect(document.querySelector(".xterm")).not.toBeNull());
    (component as { focusTerminal: () => void }).focusTerminal();
    expect(document.activeElement?.closest(".xterm")).not.toBeNull();
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
    const desig = page.getByRole("button", { name: "MacBook · TASK-07" });
    await expect.element(desig).toBeInTheDocument();
    await expect.element(page.getByText("fix login redirect")).toBeInTheDocument();
    // The header's branch drops the `shepherd/` every session branch carries, as the Viewport's.
    await expect.element(page.getByText("fix-login", { exact: true })).toBeInTheDocument();
    // The task and where it works sit in the designator's hover panel.
    const facts = factsOf(desig.element());
    expect(facts).toContain(`${m.remote_detail_task()}: Fix the login redirect loop`);
    expect(facts).toContain(`${m.remote_detail_repo()}: app`);
    expect(facts).toContain(`${m.remote_detail_branch()}: shepherd/fix-login`);
    expect(facts).toContain(`${m.remote_detail_status()}: ${statusLabel("running")}`);
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
    for (const tab of [
      m.viewport_activity_tab(),
      m.viewport_diff_tab(),
      m.viewport_files_tab(),
      m.viewport_preview_tab(),
    ])
      await expect.element(page.getByRole("tab", { name: tab })).toBeDisabled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(api.interruptSession).not.toHaveBeenCalled();
    expect(api.getSessionUsage).not.toHaveBeenCalled();
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
      .element(
        page.getByRole("img", {
          name: m.statuspip_status_aria({ status: statusLabel("running") }),
        }),
      )
      .toBeInTheDocument();
  });

  it("offers the way back on the phone layout", async () => {
    const onback = vi.fn();
    render(RemoteSessionDetail, { session: remote(), nowMs: Date.now(), onback });
    await page.getByRole("button", { name: m.viewport_back_aria() }).click();
    expect(onback).toHaveBeenCalled();
  });
});

describe("RemoteSessionDetail preview (#2767)", () => {
  const SERVED = { bound: true, url: "https://macbook.example.ts.net:4100/", unavailable: null };

  async function openPreview(props: Record<string, unknown> = {}) {
    const view = render(RemoteSessionDetail, { session: remote(), nowMs: Date.now(), ...props });
    await page.getByRole("tab", { name: m.viewport_preview_tab() }).click();
    return view;
  }

  it("starts the dev server on the machine", async () => {
    await openPreview();
    await expect
      .element(page.getByText(m.remote_preview_none({ machine: "MacBook" })))
      .toBeInTheDocument();
    // The agent is working, so the start takes a confirming second click.
    await page.getByRole("button", { name: m.viewport_preview_start() }).click();
    expect(api.startPreview).not.toHaveBeenCalled();
    await page.getByRole("button", { name: m.viewport_preview_start_confirm_working() }).click();
    expect(api.startPreview).toHaveBeenCalledWith("r1", undefined);
    await expect
      .element(page.getByText(m.remote_preview_starting({ machine: "MacBook" })))
      .toBeInTheDocument();
  });

  it("asks for the command when the machine can't detect one", async () => {
    vi.mocked(api.startPreview).mockResolvedValueOnce({ needCommand: true });
    await openPreview({ session: remote({ status: "idle" }) });
    await page.getByRole("button", { name: m.viewport_preview_start() }).click();
    await page.getByRole("textbox", { name: m.viewport_preview_command_prompt() }).fill("pnpm dev");
    await page.getByRole("button", { name: m.viewport_preview_command_send() }).click();
    expect(api.startPreview).toHaveBeenLastCalledWith("r1", "pnpm dev");
  });

  it("opens the machine's own preview URL and stops it after a confirm", async () => {
    vi.mocked(api.getPreviewReach).mockResolvedValue(SERVED);
    await openPreview();
    const frame = page.getByTitle(m.viewport_preview_tab());
    await expect.element(frame).toHaveAttribute("src", SERVED.url);
    await expect
      .element(page.getByRole("link", { name: m.viewport_preview_open_new_tab() }))
      .toHaveAttribute("href", SERVED.url);
    await expect
      .element(
        page.getByText(
          m.remote_preview_served_by({ machine: "MacBook", host: "macbook.example.ts.net:4100" }),
        ),
      )
      .toBeInTheDocument();

    await page.getByRole("button", { name: m.viewport_preview_stop() }).click();
    expect(api.stopPreview).not.toHaveBeenCalled();
    await page.getByRole("button", { name: m.viewport_preview_stop_confirm() }).click();
    expect(api.stopPreview).toHaveBeenCalledWith("r1");
    vi.mocked(api.getPreviewReach).mockResolvedValue({
      bound: false,
      url: null,
      unavailable: null,
    });
  });

  it("re-reads where the preview opens when the machine reports a change", async () => {
    const session = remote();
    const view = await openPreview({ session, previewTick: 0 });
    await vi.waitFor(() => expect(api.getPreviewReach).toHaveBeenCalledTimes(1));
    // A status frame hands the detail a new session object: not a preview change.
    await view.rerender({ session: { ...session, status: "idle" }, previewTick: 0 });
    await new Promise((r) => setTimeout(r, 50));
    expect(api.getPreviewReach).toHaveBeenCalledTimes(1);
    vi.mocked(api.getPreviewReach).mockResolvedValueOnce(SERVED);
    await view.rerender({ previewTick: 1 });
    await expect.element(page.getByTitle(m.viewport_preview_tab())).toBeInTheDocument();
    expect(api.getPreviewReach).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["not_served", false],
    ["serve_denied", false],
    ["serve_failed", true],
  ] as const)("explains %s instead of offering a URL", async (unavailable, bound) => {
    vi.mocked(api.getPreviewReach).mockResolvedValueOnce({ bound, url: null, unavailable });
    await openPreview();
    const text = {
      not_served: m.remote_preview_not_served,
      serve_denied: m.remote_preview_serve_denied,
      serve_failed: m.remote_preview_serve_failed,
    }[unavailable]({ machine: "MacBook" });
    await expect.element(page.getByText(text)).toBeInTheDocument();
    expect(page.getByTitle(m.viewport_preview_tab()).query()).toBeNull();
    expect(page.getByRole("link", { name: m.viewport_preview_open_new_tab() }).query()).toBeNull();
  });

  it("never opens a URL that is not plain https", async () => {
    vi.mocked(api.getPreviewReach).mockResolvedValueOnce({
      bound: true,
      url: "javascript:alert(1)",
      unavailable: null,
    });
    await openPreview();
    await expect
      .element(page.getByText(m.remote_preview_load_failed({ machine: "MacBook" })))
      .toBeInTheDocument();
    expect(page.getByTitle(m.viewport_preview_tab()).query()).toBeNull();
  });

  it("names a machine that can't be reached", async () => {
    vi.mocked(api.getPreviewReach).mockRejectedValueOnce(
      new api.ApiError(502, "MacBook is not reachable", "machine_unreachable", true),
    );
    await openPreview();
    await expect
      .element(page.getByText(m.remote_action_unreachable({ machine: "MacBook" })))
      .toBeInTheDocument();
  });
});
