import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import TimePopover from "./TimePopover.svelte";
import type { GitState, Session } from "$lib/types";

const session = {
  id: "fork-wait",
  repoPath: "/repo/fork",
  status: "idle",
  createdAt: 1_000,
} as Session;

const anchorRect = new DOMRect(10, 10, 100, 20);

function git(handoff: "reviewer" | "merger"): GitState {
  return {
    kind: "github",
    state: "open",
    number: 42,
    checks: "success",
    deployConfigured: false,
    createdAt: 1_000,
    handoff,
  };
}

describe("TimePopover anonymous fork handoffs", () => {
  it("describes an anonymous reviewer handoff as a maintainer review wait", async () => {
    render(TimePopover, {
      session,
      git: git("reviewer"),
      nowMs: 61_000,
      anchorRect,
      onclose: vi.fn(),
    });

    await expect.element(page.getByText(/Waiting for maintainer review/)).toBeInTheDocument();
  });

  it("describes an anonymous merger handoff as a maintainer merge wait", async () => {
    render(TimePopover, {
      session,
      git: git("merger"),
      nowMs: 61_000,
      anchorRect,
      onclose: vi.fn(),
    });

    await expect.element(page.getByText(/Waiting for maintainers to merge/)).toBeInTheDocument();
  });
});
