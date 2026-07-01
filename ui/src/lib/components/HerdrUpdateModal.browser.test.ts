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
});
