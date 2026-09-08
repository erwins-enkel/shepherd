import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { HerdrUpdateStatus } from "$lib/types";
import { m } from "$lib/paraglide/messages";

vi.mock("$lib/api", async (orig) => ({
  ...((await orig()) as object),
  applyHerdrUpdate: vi.fn(() => new Promise(() => {})),
  applyHerdrDowngrade: vi.fn(() => new Promise(() => {})),
  applyHerdrSandboxDowngrade: vi.fn(() => new Promise(() => {})),
  getHerdrUpdate: vi.fn(() => new Promise(() => {})),
  restartHerdrServer: vi.fn(() => new Promise(() => {})),
}));

import HerdrUpdateModal from "./HerdrUpdateModal.svelte";
import { getHerdrUpdate, restartHerdrServer } from "$lib/api";

const update: HerdrUpdateStatus = {
  current: "0.6.9",
  latest: "0.6.10",
  updateAvailable: true,
  notes: null,
  checkedAt: 0,
};

afterEach(async () => {
  vi.clearAllMocks();
  vi.mocked(getHerdrUpdate)
    .mockReset()
    .mockImplementation(() => new Promise(() => {}));
  vi.mocked(restartHerdrServer)
    .mockReset()
    .mockImplementation(() => new Promise(() => {}));
  document.body.innerHTML = "";
  await page.viewport(1280, 900);
});

describe("HerdrUpdateModal", () => {
  it("keeps the completed update's actual version transition after status refreshes", async () => {
    const before = { ...update, current: "0.8.2", latest: "0.9.0" };
    const after = { ...before, current: "0.9.0", updateAvailable: false };
    const done = { ok: true, from: "0.8.2", to: "0.9.0" };
    const { rerender } = await render(HerdrUpdateModal, { props: { update: before } });

    expect(document.querySelector(".versions")?.textContent).toBe("0.8.2 → 0.9.0");
    expect(document.querySelector(".chead .micro")?.textContent).toBe(m.herdrupdate_title());
    document.querySelector<HTMLButtonElement>(".run")!.click();
    // The server publishes the refreshed installed version before its terminal result.
    await rerender({ update: after });
    await rerender({ update: after, done });

    expect(document.querySelector(".versions")?.textContent).toBe("0.8.2 → 0.9.0");
    expect(document.querySelector(".chead .micro")?.textContent).toBe(m.herdrupdate_done_title());
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
      m.herdrupdate_done_title(),
    );
    expect(document.querySelector(".status.ok")).not.toBeNull();
    expect(document.querySelector(".actions .later")).not.toBeNull();
    expect(document.querySelector(".run")).toBeNull();

    await rerender({ update: { ...after, latest: "0.9.1" }, done });
    expect(document.querySelector(".versions")?.textContent).toBe("0.8.2 → 0.9.0");
  });

  it.each(["rescue", "sandbox"])(
    "keeps the %s downgrade result after support flags change",
    async (kind) => {
      const before: HerdrUpdateStatus = {
        ...update,
        current: "0.7.5",
        latest: "0.7.5",
        updateAvailable: false,
        currentUnsupported: kind === "rescue",
        downgradeTarget: kind === "rescue" ? "0.7.4" : null,
        sandboxIdleRegressed: kind === "sandbox",
        sandboxDowngradeTarget: kind === "sandbox" ? "0.7.4" : null,
      };
      const { rerender } = await render(HerdrUpdateModal, { props: { update: before } });
      if (kind === "rescue") {
        expect(document.querySelector(".versions")?.textContent).toBe("0.7.5 → 0.7.4");
        expect(document.querySelector(".chead .micro")?.textContent).toBe(
          m.herdrupdate_downgrade_title(),
        );
      }
      document.querySelector<HTMLButtonElement>(".run.downgrade")!.click();
      const after: HerdrUpdateStatus = {
        ...before,
        current: "0.7.4",
        updateAvailable: true,
        currentUnsupported: false,
        downgradeTarget: null,
        sandboxIdleRegressed: false,
        sandboxDowngradeTarget: null,
      };
      await rerender({ update: after });
      await rerender({ update: after, done: { ok: true, from: "0.7.5", to: "0.7.4" } });

      expect(document.querySelector(".versions")?.textContent).toBe("0.7.5 → 0.7.4");
      expect(document.querySelector(".chead .micro")?.textContent).toBe(
        m.herdrupdate_downgrade_done_title(),
      );
      expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
        m.herdrupdate_downgrade_done_title(),
      );
      expect(document.querySelector(".status.ok")?.textContent).toBe(
        m.herdrupdate_downgrade_done_ok({ target: "0.7.4" }),
      );
    },
  );

  it("shows the failed update's actual versions and failure title", async () => {
    const { rerender } = await render(HerdrUpdateModal, { props: { update } });
    document.querySelector<HTMLButtonElement>(".run")!.click();
    await rerender({
      update,
      done: { ok: false, from: "0.6.9", to: "0.6.9", error: "herdr was not updated" },
    });

    expect(document.querySelector(".versions")?.textContent).toBe("0.6.9 → 0.6.9");
    expect(document.querySelector(".chead .micro")?.textContent).toBe(m.herdrupdate_failed_title());
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
      m.herdrupdate_failed_title(),
    );
    expect(document.querySelector(".status.fail")?.textContent).toBe(
      m.herdrupdate_done_fail({ current: "0.6.9" }),
    );
    expect(document.querySelector(".details .log")?.textContent).toBe("herdr was not updated");
  });

  it.each([
    { from: null, to: "0.6.8", expected: "0.6.9 → 0.6.8" },
    { from: "0.6.7", to: null, expected: "0.6.7 → 0.6.10" },
    { from: null, to: null, expected: "0.6.9 → 0.6.10" },
  ])("falls back to status for missing result values ($from → $to)", ({ from, to, expected }) => {
    render(HerdrUpdateModal, { props: { update, done: { ok: false, from, to } } });
    expect(document.querySelector(".versions")?.textContent).toBe(expected);
  });

  it.each([
    { current: null, latest: "0.6.10" },
    { current: "0.6.9", latest: null },
  ])(
    "hides the version transition when status also lacks a value ($current → $latest)",
    (versions) => {
      render(HerdrUpdateModal, {
        props: { update: { ...update, ...versions }, done: { ok: false, from: null, to: null } },
      });
      expect(document.querySelector(".versions")).toBeNull();
    },
  );
  it("explains an incomplete installed update and only repairs after explicit confirmation", async () => {
    const { restartHerdrServer } = await import("$lib/api");
    vi.mocked(restartHerdrServer).mockClear();
    const runtime = {
      state: "restart_required" as const,
      installedVersion: "0.9.0",
      serverVersion: "0.8.2",
      reason: "protocol_mismatch" as const,
    };
    render(HerdrUpdateModal, {
      props: {
        update: {
          ...update,
          current: "0.9.0",
          latest: "0.9.0",
          updateAvailable: false,
          phase: "idle",
          runtime,
          result: {
            ok: false,
            from: "0.8.2",
            to: "0.9.0",
            errorCode: "restart_required",
            handoffPaneLimit: 64,
          },
        },
      },
    });
    await expect.element(page.getByText(m.herdrupdate_repair_warning())).toBeVisible();
    await expect.element(page.getByText(m.herdrupdate_repair_limit({ count: 64 }))).toBeVisible();
    expect(restartHerdrServer).not.toHaveBeenCalled();
    await page.getByRole("button", { name: m.herdrupdate_restart_confirm(), exact: true }).click();
    expect(restartHerdrServer).toHaveBeenCalledExactlyOnceWith(runtime);
    await expect.element(page.getByText(m.herdrupdate_repair_restarting())).toBeVisible();
  });

  it("does not let an old done event finish a repair being verified", async () => {
    render(HerdrUpdateModal, {
      props: {
        update: { ...update, phase: "verifying", result: null },
        done: { ok: true, from: "0.8.2", to: "0.9.0" },
      },
    });
    await expect.element(page.getByText(m.herdrupdate_repair_verifying())).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: m.herdrupdate_confirm_plain(), exact: true }))
      .not.toBeInTheDocument();
  });
  it("reloads repair needs on open without a new release and declining has no mutation", async () => {
    const snapshot: HerdrUpdateStatus = {
      ...update,
      current: "0.9.0",
      latest: "0.9.0",
      updateAvailable: false,
      phase: "idle",
      revision: 2,
      runtime: { state: "restart_required", installedVersion: "0.9.0", serverVersion: "0.8.2" },
    };
    vi.mocked(getHerdrUpdate).mockResolvedValue(snapshot);
    const onclose = vi.fn();
    const first = await render(HerdrUpdateModal, {
      props: { update: { ...snapshot, revision: 1, runtime: undefined }, onclose },
    });
    await expect.element(page.getByText(m.herdrupdate_repair_warning())).toBeVisible();
    await page.getByRole("button", { name: m.herdrupdate_later(), exact: true }).click();
    expect(onclose).toHaveBeenCalledOnce();
    expect(restartHerdrServer).not.toHaveBeenCalled();
    await first.unmount();
    await render(HerdrUpdateModal, { props: { update: snapshot } });
    await expect
      .element(page.getByRole("button", { name: m.herdrupdate_restart_confirm(), exact: true }))
      .toBeVisible();
    expect(getHerdrUpdate).toHaveBeenCalledTimes(2);
    expect(restartHerdrServer).not.toHaveBeenCalled();
  });

  it("polls a confirmed repair to verified success when websocket events are missed", async () => {
    const snapshot: HerdrUpdateStatus = {
      ...update,
      current: "0.9.0",
      latest: "0.9.0",
      updateAvailable: false,
      phase: "idle",
      revision: 1,
      runtime: { state: "restart_required", installedVersion: "0.9.0", serverVersion: "0.8.2" },
    };
    vi.mocked(getHerdrUpdate)
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce({ ...snapshot, revision: 2, phase: "verifying" })
      .mockResolvedValue({
        ...snapshot,
        revision: 3,
        runtime: { state: "ready", installedVersion: "0.9.0", serverVersion: "0.9.0" },
        result: { ok: true, from: "0.8.2", to: "0.9.0" },
      });
    vi.mocked(restartHerdrServer).mockResolvedValue(undefined);
    const view = await render(HerdrUpdateModal, { props: { update: snapshot } });
    await page.getByRole("button", { name: m.herdrupdate_restart_confirm(), exact: true }).click();
    await expect.element(page.getByText(m.herdrupdate_repair_verifying())).toBeVisible();
    await expect.element(page.getByText(m.herdrupdate_repair_ready())).toBeVisible();
    expect(restartHerdrServer).toHaveBeenCalledOnce();
    const count = vi.mocked(getHerdrUpdate).mock.calls.length;
    await view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(getHerdrUpdate).toHaveBeenCalledTimes(count);
  });

  it("keeps polling after an accepted repair when the first GET and websocket events are lost", async () => {
    const snapshot: HerdrUpdateStatus = {
      ...update,
      current: "0.9.0",
      latest: "0.9.0",
      updateAvailable: false,
      phase: "idle",
      revision: 1,
      runtime: { state: "restart_required", installedVersion: "0.9.0", serverVersion: "0.8.2" },
    };
    vi.mocked(getHerdrUpdate)
      .mockResolvedValueOnce(snapshot)
      .mockRejectedValueOnce(new Error("connection interrupted"))
      .mockResolvedValue({
        ...snapshot,
        revision: 3,
        runtime: { state: "ready", installedVersion: "0.9.0", serverVersion: "0.9.0" },
        result: { ok: true, from: "0.8.2", to: "0.9.0" },
      });
    vi.mocked(restartHerdrServer).mockResolvedValue(undefined);
    await render(HerdrUpdateModal, { props: { update: snapshot } });
    await page.getByRole("button", { name: m.herdrupdate_restart_confirm(), exact: true }).click();
    await expect.element(page.getByText(m.herdrupdate_repair_restarting())).toBeVisible();
    await expect.element(page.getByText(m.herdrupdate_repair_ready())).toBeVisible();
    expect(restartHerdrServer).toHaveBeenCalledOnce();
  });

  it("rechecks an unknown runtime without stopping anything and clears transient probe errors", async () => {
    const snapshot: HerdrUpdateStatus = {
      ...update,
      current: "0.9.0",
      latest: "0.9.0",
      updateAvailable: false,
      phase: "idle",
      revision: 1,
      runtime: { state: "unknown", installedVersion: "0.9.0", serverVersion: null },
    };
    vi.mocked(getHerdrUpdate)
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValue({
        ...snapshot,
        revision: 2,
        runtime: { state: "ready", installedVersion: "0.9.0", serverVersion: "0.9.0" },
      });
    await render(HerdrUpdateModal, { props: { update: snapshot } });
    await expect
      .poll(() => document.querySelector(".err")?.textContent)
      .toBe(m.herdrupdate_repair_unknown());
    await page.getByRole("button", { name: m.herdrupdate_repair_check(), exact: true }).click();
    await expect.element(page.getByText(m.herdrupdate_repair_ready())).toBeVisible();
    expect(document.querySelector(".err")).toBeNull();
    expect(restartHerdrServer).not.toHaveBeenCalled();
  });

  it("allows retrying a persisted downgrade failure after reopening", async () => {
    const { applyHerdrDowngrade } = await import("$lib/api");
    vi.mocked(applyHerdrDowngrade).mockClear();
    const snapshot: HerdrUpdateStatus = {
      ...update,
      current: "0.9.1",
      latest: "0.9.1",
      currentUnsupported: true,
      downgradeTarget: "0.9.0",
      updateAvailable: false,
      phase: "idle",
      revision: 1,
      result: { ok: false, from: "0.9.1", to: "0.9.1", error: "manifest unavailable" },
    };
    vi.mocked(getHerdrUpdate).mockResolvedValue(snapshot);
    await render(HerdrUpdateModal, { props: { update: snapshot } });
    await page
      .getByRole("button", {
        name: m.herdrupdate_downgrade_confirm({ target: "0.9.0" }),
        exact: true,
      })
      .click();
    expect(applyHerdrDowngrade).toHaveBeenCalledOnce();
  });

  it("keeps a failed repair actionable with its technical error collapsed", async () => {
    const snapshot: HerdrUpdateStatus = {
      ...update,
      phase: "idle",
      revision: 1,
      runtime: { state: "restart_required", installedVersion: "0.9.0", serverVersion: "0.8.2" },
      result: {
        ok: false,
        from: "0.8.2",
        to: "0.9.0",
        errorCode: "restart_failed",
        error: "selected herdr server stop failed",
      },
    };
    await render(HerdrUpdateModal, { props: { update: snapshot } });
    await expect.element(page.getByText(m.herdrupdate_repair_failed())).toBeVisible();
    expect(document.querySelector<HTMLDetailsElement>("details")!.open).toBe(false);
    await page.getByRole("button", { name: m.herdrupdate_restart_confirm(), exact: true }).click();
    expect(restartHerdrServer).toHaveBeenCalledOnce();
  });

  it.each([
    [390, 844],
    [1280, 900],
  ])("keeps the repair explanation and confirmation usable at %ix%i", async (width, height) => {
    await page.viewport(width, height);
    await render(HerdrUpdateModal, {
      props: {
        update: {
          ...update,
          phase: "idle",
          runtime: { state: "restart_required", installedVersion: "0.9.0", serverVersion: "0.8.2" },
          result: {
            ok: false,
            from: "0.8.2",
            to: "0.9.0",
            errorCode: "restart_required",
            handoffPaneLimit: 64,
          },
        },
      },
    });
    const card = document.querySelector<HTMLElement>(".card")!;
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
    await expect
      .element(page.getByRole("button", { name: m.herdrupdate_restart_confirm(), exact: true }))
      .toBeVisible();
  });

  it("keeps modal chrome from creating stray scrollbars with an active update log", async () => {
    await page.viewport(800, 600);

    render(HerdrUpdateModal, {
      props: {
        update,
        log: [
          "=== herdr-update 2026-07-01T07:10:00Z 0.6.9 -> 0.6.10 ===",
          ">>> herdr-update: downloading release asset",
          "stopping live panes",
          "installing herdr 0.6.10",
          ">>> herdr-update: install still running",
        ],
      },
    });

    document.querySelector<HTMLButtonElement>(".run")?.click();
    await vi.waitFor(() => expect(document.querySelector(".log")).not.toBeNull());

    const card = document.querySelector<HTMLElement>(".card");
    expect(card).not.toBeNull();
    expect(card!.scrollWidth, "dialog should not have horizontal overflow").toBeLessThanOrEqual(
      card!.clientWidth,
    );
    expect(
      card!.scrollHeight,
      "dialog should not need its own vertical scrollbar",
    ).toBeLessThanOrEqual(card!.clientHeight + 1);
  });

  it("blocks the upgrade + warns when the latest herdr is newer than supported", async () => {
    render(HerdrUpdateModal, {
      props: {
        update: {
          current: "0.7.5",
          latest: "0.8.0",
          updateAvailable: true,
          latestUnsupported: true,
          notes: null,
          checkedAt: 0,
        },
      },
    });

    // The blocked warning is shown…
    expect(document.querySelector(".blocked")).not.toBeNull();
    // …and the run/upgrade button is gone (can't upgrade into an unsupported herdr).
    expect(document.querySelector(".run")).toBeNull();
  });

  it("offers the one-click downgrade when the INSTALLED herdr is unsupported (#1898)", async () => {
    const { applyHerdrDowngrade } = await import("$lib/api");
    render(HerdrUpdateModal, {
      props: {
        update: {
          current: "0.7.5",
          latest: "0.7.5",
          updateAvailable: false,
          currentUnsupported: true,
          downgradeTarget: "0.7.4",
          notes: null,
          checkedAt: 0,
        },
      },
    });

    // The stranded explanation is shown…
    expect(document.querySelector(".blocked")).not.toBeNull();
    // …the downgrade action names the target version…
    const btn = document.querySelector<HTMLButtonElement>(".run.downgrade");
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toContain("0.7.4");
    // …and there is NO plain upgrade button (nothing to upgrade to).
    expect(document.querySelector(".run:not(.downgrade)")).toBeNull();

    // Clicking it fires the downgrade endpoint.
    btn!.click();
    await vi.waitFor(() => expect(vi.mocked(applyHerdrDowngrade)).toHaveBeenCalledOnce());
  });

  it("keeps the plain upgrade flow free of the downgrade action", () => {
    render(HerdrUpdateModal, { props: { update } }); // the ordinary 0.6.9→0.6.10 fixture
    expect(document.querySelector(".run.downgrade")).toBeNull();
    expect(document.querySelector(".run")).not.toBeNull();
  });

  it("shows the non-blocking two-path advisory + sandbox downgrade on a supported-but-regressed herdr (#1716)", async () => {
    const { applyHerdrSandboxDowngrade } = await import("$lib/api");
    render(HerdrUpdateModal, {
      props: {
        update: {
          current: "0.7.5",
          latest: "0.7.5",
          updateAvailable: false,
          currentUnsupported: false, // SUPPORTED — non-blocking advisory, not the stranded alert
          sandboxIdleRegressed: true,
          sandboxDowngradeTarget: "0.7.4",
          notes: null,
          checkedAt: 0,
        },
      },
    });

    // Advisory is informational, NOT the red blocking alert.
    expect(document.querySelector(".advisory")).not.toBeNull();
    expect(document.querySelector(".blocked")).toBeNull();
    // The sandbox downgrade action names the target…
    const btn = document.querySelector<HTMLButtonElement>(".run.sandbox-downgrade");
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toContain("0.7.4");
    // …and clicking it fires the sandbox downgrade endpoint.
    btn!.click();
    await vi.waitFor(() => expect(vi.mocked(applyHerdrSandboxDowngrade)).toHaveBeenCalledOnce());
  });

  it("shows no advisory when herdr is supported and unregressed", () => {
    render(HerdrUpdateModal, { props: { update } }); // ordinary fixture, no sandboxIdleRegressed
    expect(document.querySelector(".advisory")).toBeNull();
    expect(document.querySelector(".run.sandbox-downgrade")).toBeNull();
  });

  it("surfaces the server-authored refusal reason on a failed downgrade (#1898)", async () => {
    const props = {
      update: {
        current: "0.7.5",
        latest: "0.7.5",
        updateAvailable: false,
        currentUnsupported: true,
        downgradeTarget: "0.7.4",
        notes: null,
        checkedAt: 0,
      },
    };
    const { rerender } = await render(HerdrUpdateModal, { props });

    // Click Run so the modal enters its submitting state (applyHerdrDowngrade is
    // mocked to a Promise that never resolves), then deliver a fail `done` — a
    // pre-flight refusal (e.g. the manifest is missing the target asset) — as the
    // server's onDone would stream it in.
    document.querySelector<HTMLButtonElement>(".run.downgrade")?.click();
    await rerender({
      ...props,
      done: {
        ok: false,
        from: "0.7.5",
        to: "0.7.5",
        error: "herdr.dev manifest has no 0.7.4 asset for linux-x86_64",
      },
    });

    await vi.waitFor(() => expect(document.querySelector(".status.fail")).not.toBeNull());
    expect(document.querySelector(".versions")?.textContent).toBe("0.7.5 → 0.7.5");
    expect(document.querySelector(".chead .micro")?.textContent).toBe(
      m.herdrupdate_downgrade_failed_title(),
    );
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
      m.herdrupdate_downgrade_failed_title(),
    );
    await page.getByText(m.herdrupdate_repair_details()).click();
    const errEl = document.querySelector(".details .log");
    expect(errEl).not.toBeNull();
    expect(errEl!.textContent).toContain("herdr.dev manifest has no 0.7.4 asset for linux-x86_64");
  });

  it("offers the upgrade (run button, no warning) for a supported latest (0.7.4 → 0.7.5)", async () => {
    render(HerdrUpdateModal, {
      props: {
        update: {
          current: "0.7.4",
          latest: "0.7.5",
          updateAvailable: true,
          latestUnsupported: false,
          notes: null,
          checkedAt: 0,
        },
      },
    });

    // No blocked warning…
    expect(document.querySelector(".blocked")).toBeNull();
    // …and the run/upgrade button is offered.
    expect(document.querySelector(".run")).not.toBeNull();
  });
});
