import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { HerdrUpdateStatus } from "$lib/types";

vi.mock("$lib/api", async (orig) => ({
  ...((await orig()) as object),
  applyHerdrUpdate: vi.fn(() => new Promise(() => {})),
  applyHerdrDowngrade: vi.fn(() => new Promise(() => {})),
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

  it("blocks the upgrade + warns when the latest herdr is unsupported (0.7.5+, #1889)", async () => {
    render(HerdrUpdateModal, {
      props: {
        update: {
          current: "0.7.4",
          latest: "0.7.5",
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
});
