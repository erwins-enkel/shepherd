import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { HerdrUpdateStatus } from "$lib/types";

vi.mock("$lib/api", async (orig) => ({
  ...((await orig()) as object),
  applyHerdrUpdate: vi.fn(() => new Promise(() => {})),
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
