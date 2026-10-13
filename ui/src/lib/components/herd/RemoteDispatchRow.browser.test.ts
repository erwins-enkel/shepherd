import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import { m } from "#lib/paraglide/messages.js";
import { ApiError } from "#lib/api.js";
import { toasts } from "#lib/toasts.svelte.js";
import type { RemoteDispatch, Session } from "#lib/types.js";

// Cancel goes to the server; the row only says what came of it (#2774).
vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return { ...actual, cancelRemoteDispatch: vi.fn(), redirectRemoteDispatch: vi.fn() };
});

const api = await import("#lib/api.js");
const { default: RemoteDispatchRow } = await import("./RemoteDispatchRow.svelte");

const HOST = { instanceId: "m1", name: "MacBook", platform: "macos" };
const dispatch = (over: Partial<RemoteDispatch> = {}): RemoteDispatch => ({
  id: "d-1",
  state: "unknown",
  host: HOST,
  summary: "Port the settings screen",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

function renderRows(dispatches: RemoteDispatch[]) {
  for (const d of dispatches) render(RemoteDispatchRow, { props: { dispatch: d } });
}

afterEach(() => {
  document.body.innerHTML = "";
  toasts.items = [];
  vi.mocked(api.cancelRemoteDispatch).mockReset();
  vi.mocked(api.redirectRemoteDispatch).mockReset();
});

describe("a task whose start on a machine is unknown (#2774)", () => {
  it("names its machine and shows the state, an explanation and Cancel", async () => {
    renderRows([dispatch()]);
    // The machine's label (#3055); no session reports the link, so it says nothing about it.
    const label = page.getByRole("img", { name: m.remote_runs_on({ machine: "MacBook" }) });
    await expect.element(label).toHaveTextContent("MacBook");
    expect(document.querySelector(".machine-badge.offline")).toBeNull();

    const row = page.getByRole("group", {
      name: m.remote_dispatch_row_aria({ machine: "MacBook", state: m.remote_dispatch_unknown() }),
    });
    await expect.element(row).toBeVisible();
    expect(document.querySelector(".dispatch-summary")!.textContent).toBe(
      "Port the settings screen",
    );
    const state = document.querySelector(".dispatch-state")!;
    expect(state.textContent).toBe(m.remote_dispatch_unknown());
    expect(state.getAttribute("aria-description")).toContain(
      m.tooltip_dispatch_unknown_summary({ machine: "MacBook" }),
    );
    expect(state.getAttribute("aria-description")).toContain(
      m.tooltip_dispatch_cancel_body({ machine: "MacBook" }),
    );
    await expect
      .element(
        page.getByRole("button", { name: m.remote_dispatch_cancel_aria({ machine: "MacBook" }) }),
      )
      .toBeVisible();
  });

  it("Cancel asks the server; a machine out of reach gets it later", async () => {
    vi.mocked(api.cancelRemoteDispatch).mockResolvedValue(dispatch({ state: "canceling" }));
    renderRows([dispatch()]);
    await page
      .getByRole("button", { name: m.remote_dispatch_cancel_aria({ machine: "MacBook" }) })
      .click();
    expect(api.cancelRemoteDispatch).toHaveBeenCalledExactlyOnceWith("d-1");
    await vi.waitFor(() =>
      expect(toasts.items.map((t) => t.text)).toEqual([
        m.toast_dispatch_cancel_pending({ machine: "MacBook" }),
      ]),
    );
  });

  it("a task the machine already has says so", async () => {
    vi.mocked(api.cancelRemoteDispatch).mockRejectedValue(
      new ApiError(409, "already has it", "remote_dispatch_not_cancelable", true),
    );
    renderRows([dispatch()]);
    await page
      .getByRole("button", { name: m.remote_dispatch_cancel_aria({ machine: "MacBook" }) })
      .click();
    await vi.waitFor(() =>
      expect(toasts.items.map((t) => t.text)).toEqual([
        m.toast_dispatch_not_cancelable({ machine: "MacBook" }),
      ]),
    );
  });

  it("a pending cancel reads as such and offers no second Cancel", async () => {
    renderRows([dispatch({ state: "canceling" })]);
    const state = page.getByText(m.remote_dispatch_canceling());
    await expect.element(state).toBeVisible();
    expect(document.querySelector(".dispatch-state")!.getAttribute("aria-description")).toContain(
      m.tooltip_dispatch_canceling_summary({ machine: "MacBook" }),
    );
    expect(document.querySelector(".dispatch-row button")).toBeNull();
  });
});

describe("a task waiting for its machine, or held there (#2775)", () => {
  const HERE = { instanceId: "here", name: "moes-tavern", platform: "linux" };
  const BOX = { instanceId: "box", name: "Box", platform: "linux" };
  const placement = {
    mode: "auto" as const,
    target: HOST,
    requirements: ["xcode"],
    basis: "requirements" as const,
    preferred: null,
    by: { instanceId: HERE.instanceId, name: HERE.name },
    decidedAt: 1,
  };
  const waiting = (over: Partial<RemoteDispatch> = {}) =>
    dispatch({
      state: "waiting",
      placement,
      readiness: { state: "offline", status: "timeout" },
      alternatives: [],
      ...over,
    });
  const blocked = () =>
    waiting({
      readiness: {
        state: "missing_capabilities",
        missing: [{ capability: "xcode", reason: "license_not_accepted" }],
      },
    });
  const description = () =>
    document.querySelector(".dispatch-state")!.getAttribute("aria-description") ?? "";
  const buttons = () =>
    [...document.querySelectorAll(".dispatch-row button")].map((b) => b.textContent?.trim());

  it("offline: waits with what it needs, explains when it starts, offers Cancel", async () => {
    renderRows([waiting()]);
    await expect.element(page.getByText(m.remote_dispatch_waiting())).toBeVisible();
    expect(document.querySelector(".dispatch-detail")!.textContent).toBe(
      m.placement_basis_requirements({ list: "Xcode" }),
    );
    expect(description()).toContain(m.tooltip_waiting_title({ machine: "MacBook" }));
    expect(description()).toContain(m.tooltip_waiting_start_body({ machine: "MacBook" }));
    expect(description()).toContain(m.tooltip_waiting_fallback_none());
    expect(buttons()).toEqual([m.common_cancel()]);
  });

  it("offers the machines that fit now — this one as Run here — and runs it there", async () => {
    vi.mocked(api.redirectRemoteDispatch).mockResolvedValue({
      ...({} as Session),
      id: "s-1",
    });
    renderRows([waiting({ alternatives: [HERE, BOX] })]);
    await expect.element(page.getByText(m.remote_dispatch_waiting())).toBeVisible();
    expect(buttons()).toEqual([
      m.remote_dispatch_run_here(),
      m.remote_dispatch_run_on({ machine: "Box" }),
      m.common_cancel(),
    ]);
    expect(description()).toContain(
      m.tooltip_waiting_fallback_body({ machines: "moes-tavern, Box" }),
    );
    await page
      .getByRole("button", {
        name: m.remote_dispatch_redirect_aria({ machine: "MacBook", target: "Box" }),
      })
      .click();
    expect(api.redirectRemoteDispatch).toHaveBeenCalledExactlyOnceWith("d-1", "box");
    await vi.waitFor(() =>
      expect(toasts.items.map((t) => t.text)).toEqual([
        m.toast_dispatch_started_on({ machine: "Box" }),
      ]),
    );
  });

  it("a machine that does not fit (any more) says why", async () => {
    vi.mocked(api.redirectRemoteDispatch).mockRejectedValue(
      new ApiError(409, "not reachable", "remote_target_unavailable", true),
    );
    renderRows([waiting({ alternatives: [BOX] })]);
    await page
      .getByRole("button", {
        name: m.remote_dispatch_redirect_aria({ machine: "MacBook", target: "Box" }),
      })
      .click();
    await vi.waitFor(() =>
      expect(toasts.items.map((t) => t.text)).toEqual([
        m.newtask_runon_unavailable({ machine: "Box" }),
      ]),
    );
  });

  it("blocked: names the missing capability and the next step", async () => {
    renderRows([blocked()]);
    await expect.element(page.getByText(m.remote_dispatch_blocked())).toBeVisible();
    expect(document.querySelector(".dispatch-state")!.classList.contains("blocked")).toBe(true);
    const list = `Xcode (${m.settings_machines_cap_reason_license_not_accepted()})`;
    expect(document.querySelector(".dispatch-detail")!.textContent).toBe(
      m.remote_dispatch_missing_detail({ list }),
    );
    expect(description()).toContain(
      m.tooltip_blocked_missing_summary({ machine: "MacBook", list }),
    );
    expect(description()).toContain(m.tooltip_blocked_next_body({ machine: "MacBook" }));
  });

  it("busy: held there, cancelable, never redirected", async () => {
    renderRows([dispatch({ state: "held", heldId: "h-1", alternatives: [BOX] })]);
    await expect.element(page.getByText(m.remote_dispatch_held())).toBeVisible();
    expect(description()).toContain(m.tooltip_held_summary({ machine: "MacBook" }));
    expect(description()).toContain(m.tooltip_held_elsewhere_body());
    expect(buttons()).toEqual([m.common_cancel()]);
  });

  it("the four states side by side read differently", async () => {
    renderRows([
      waiting(),
      dispatch({ id: "d-2", state: "held", heldId: "h-1" }),
      { ...blocked(), id: "d-3" },
      dispatch({ id: "d-4" }),
    ]);
    await expect.element(page.getByText(m.remote_dispatch_held())).toBeVisible();
    const labels = [...document.querySelectorAll(".dispatch-state")].map((e) => e.textContent);
    expect(labels).toEqual([
      m.remote_dispatch_waiting(),
      m.remote_dispatch_held(),
      m.remote_dispatch_blocked(),
      m.remote_dispatch_unknown(),
    ]);
    const tips = [...document.querySelectorAll(".dispatch-state")].map((e) =>
      e.getAttribute("aria-description"),
    );
    expect(new Set(tips).size).toBe(4);
  });
});
