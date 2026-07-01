import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { DeployState, UpdateStatus } from "$lib/types";

vi.mock("$lib/api", async (orig) => ({
  ...((await orig()) as object),
  applyUpdate: vi.fn(() => new Promise(() => {})),
}));

import UpdateModal from "./UpdateModal.svelte";

const update: UpdateStatus = {
  behind: 1,
  current: "abc1234",
  latest: "def5678",
  commits: [{ sha: "def5678", subject: "Fix update modal scrollbar overflow" }],
  checkedAt: 0,
};

const deploy: DeployState = {
  phase: "running",
  exitCode: null,
  log: [
    "=== shepherd-update 2026-07-01T07:10:00Z abc1234 -> def5678 ===",
    "bun install",
    "bun run build",
    "restarting shepherd",
    "waiting for server",
  ].join("\n"),
};

afterEach(async () => {
  document.body.innerHTML = "";
  await page.viewport(1280, 900);
});

describe("UpdateModal", () => {
  it("keeps modal chrome from creating stray scrollbars with an active deploy log", async () => {
    await page.viewport(800, 600);

    render(UpdateModal, {
      props: {
        update,
        updating: true,
        deploy,
      },
    });

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
