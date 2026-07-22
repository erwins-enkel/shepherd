import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { HerdrUpdateStatus } from "$lib/types";

vi.mock("$lib/api", async (orig) => ({
  ...((await orig()) as object),
  applyHerdrUpdate: vi.fn(() => new Promise(() => {})),
  applyHerdrDowngrade: vi.fn(() => new Promise(() => {})),
  applyHerdrSandboxDowngrade: vi.fn(() => new Promise(() => {})),
}));

import HerdrUpdateModal from "./HerdrUpdateModal.svelte";

const update: HerdrUpdateStatus = {
  current: "0.6.9",
  latest: "0.6.10",
  updateAvailable: true,
  notes: null,
  checkedAt: 0,
};

afterEach(async () => {
  document.body.innerHTML = "";
  await page.viewport(1280, 900);
});

describe("HerdrUpdateModal", () => {
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
    const errEl = document.querySelector(".status.fail + .err");
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
