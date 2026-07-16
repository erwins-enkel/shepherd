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
          ">>> codex-update: running codex update",
          "Updating Codex via `npm install -g @openai/codex`...",
          "changed 2 packages in 5s",
          ">>> codex-update: codex update exited rc=0",
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

  it("shows the stuck-update message naming the on-PATH binary on non-convergence", async () => {
    const props = { update, log: [">>> codex-update: codex update exited rc=0"] };
    const { rerender } = await render(CodexUpdateModal, { props });

    // click Run so the modal enters its submitting state, then deliver a
    // non-converged `done` that carries the on-PATH binary (as the server would).
    document.querySelector<HTMLButtonElement>(".run")?.click();
    await rerender({
      ...props,
      done: {
        ok: false,
        from: "0.142.4",
        to: "0.142.4",
        onPathBinary: "/home/op/.local/bin/codex",
      },
    });

    await vi.waitFor(() =>
      expect(document.querySelector(".status.fail")?.textContent ?? "").toContain(
        "/home/op/.local/bin/codex",
      ),
    );
  });

  it("keeps the completed update's actual version transition after status refreshes", async () => {
    const { rerender } = await render(CodexUpdateModal, { props: { update } });

    await rerender({
      update: { ...update, current: "0.142.5", latest: "0.142.5", updateAvailable: false },
      done: { ok: true, from: "0.142.4", to: "0.142.5" },
    });

    await vi.waitFor(() =>
      expect(document.querySelector(".versions")?.textContent).toContain("0.142.4 → 0.142.5"),
    );
  });
});
