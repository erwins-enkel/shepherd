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
  return { ...actual, cancelRemoteDispatch: vi.fn() };
});

const api = await import("#lib/api.js");
const { default: HerdMachineGroups } = await import("./HerdMachineGroups.svelte");

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

function renderGroups(dispatches: RemoteDispatch[], sessions: Session[] = []) {
  return render(HerdMachineGroups, {
    props: { sessions, dispatches, filter: "all", selectedId: null, nowMs: 1, onselect: () => {} },
  });
}

afterEach(() => {
  document.body.innerHTML = "";
  toasts.items = [];
  vi.mocked(api.cancelRemoteDispatch).mockReset();
});

describe("a task whose start on a machine is unknown (#2774)", () => {
  it("leads its machine's group with the state, an explanation and Cancel", async () => {
    renderGroups([dispatch()]);
    const group = page.getByRole("region", { name: m.remote_group_aria({ machine: "MacBook" }) });
    await expect.element(group).toBeVisible();
    // No session reports the link, so the group says nothing about it.
    expect(document.querySelector(".machine-state")).toBeNull();

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
    renderGroups([dispatch()]);
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
    renderGroups([dispatch()]);
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
    renderGroups([dispatch({ state: "canceling" })]);
    const state = page.getByText(m.remote_dispatch_canceling());
    await expect.element(state).toBeVisible();
    expect(document.querySelector(".dispatch-state")!.getAttribute("aria-description")).toContain(
      m.tooltip_dispatch_canceling_summary({ machine: "MacBook" }),
    );
    expect(document.querySelector(".dispatch-row button")).toBeNull();
  });

  it("only in the all lens, like the machine's sessions", async () => {
    render(HerdMachineGroups, {
      props: {
        sessions: [],
        dispatches: [dispatch()],
        filter: "ready",
        selectedId: null,
        nowMs: 1,
        onselect: () => {},
      },
    });
    expect(document.querySelector(".dispatch-row")).toBeNull();
  });
});
