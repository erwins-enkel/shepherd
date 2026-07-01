import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { CodexUpdateStatus } from "$lib/types";

vi.mock("$lib/api", async (orig) => ({
  ...((await orig()) as object),
  applyCodexUpdate: vi.fn(() => new Promise(() => {})),
}));

import CodexUpdateModal from "./CodexUpdateModal.svelte";

const update: CodexUpdateStatus = {
  current: "0.142.4",
  latest: "0.142.5",
  updateAvailable: true,
  notes: null,
  checkedAt: 0,
};

afterEach(async () => {
  document.body.innerHTML = "";
  await page.viewport(1280, 900);
});

describe("CodexUpdateModal", () => {
  it("keeps modal chrome from creating stray scrollbars with an active update log", async () => {
    await page.viewport(800, 600);

    render(CodexUpdateModal, {
      props: {
        update,
        log: [
          "=== codex-update 2026-07-01T07:10:00Z 0.142.4 -> 0.142.5 ===",
          ">>> codex-update: running npm install -g @openai/codex",
          "changed 2 packages in 5s",
          "Reshimming mise 24.14.1...",
          ">>> codex-update: npm install exited rc=0",
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
