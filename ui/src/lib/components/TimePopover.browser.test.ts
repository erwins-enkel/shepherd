import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import TimePopover from "./TimePopover.svelte";
import type { GitState, Session } from "$lib/types";
import { m } from "$lib/paraglide/messages";
import { sessionPulse } from "$lib/session-pulse";

// The panel re-reads the steer log on open; keep that off the network.
vi.mock("$lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/api")>()),
  getSteerLog: vi.fn(async () => []),
}));

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

describe("TimePopover status panel", () => {
  it("leads with the verdict, CI rows and loop check, keeping the time lines as footer", async () => {
    const MIN = 60_000;
    const now = 1_000 * MIN;
    const running = { ...session, status: "running", createdAt: now - 150 * MIN } as Session;
    const pr: GitState = {
      kind: "github",
      state: "open",
      number: 128,
      checks: "pending",
      deployConfigured: false,
      createdAt: now - 58 * MIN,
      jobs: [
        {
          name: "CI / Release-Gate",
          state: "pending",
          startedAt: now - 9 * MIN,
          typicalMs: 43 * MIN,
        },
        {
          name: "CI / lint",
          state: "success",
          startedAt: now - 30 * MIN,
          completedAt: now - 29 * MIN,
        },
      ],
    };
    const steers = [{ ts: now - 20 * MIN, kind: "ci_fix" as const }];
    const pulse = sessionPulse({ session: running, git: pr, steers, nowMs: now });
    render(TimePopover, {
      session: running,
      git: pr,
      pulse,
      steers,
      nowMs: now,
      anchorRect,
      onclose: vi.fn(),
    });

    await expect.element(page.getByText(m.pulse_title_waiting_ci())).toBeInTheDocument();
    await expect.element(page.getByText("CI / Release-Gate")).toBeInTheDocument();
    await expect.element(page.getByText(m.pulse_loop_none())).toBeInTheDocument();
    await expect.element(page.getByText("/repo/fork")).toBeInTheDocument();
    // The panel uses the wide tooltip layout (sections flow into columns where there is room).
    expect(document.querySelector(".tooltip-body.wide .tooltip-sections")).not.toBeNull();
  });
});
