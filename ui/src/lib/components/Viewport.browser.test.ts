import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import Viewport from "./Viewport.svelte";
import type { Session } from "$lib/types";

function session(partial: Partial<Session> & { id: string }): Session {
  return {
    desig: "TASK-01",
    name: "task one",
    prompt: "p",
    repoPath: "/repo/a",
    baseBranch: "main",
    branch: "feat/x",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "h",
    herdrAgentId: "ha",
    claudeSessionId: "cs",
    model: null,
    status: "idle",
    readyToMerge: false,
    mergingSince: null,
    mergingTrainId: null,
    autopilotEnabled: null,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotComplete: false,
    autopilotQuestion: null,
    planGateEnabled: null,
    planPhase: null,
    autoMergeEnabled: null,
    autoMergeRebaseCount: 0,
    auto: false,
    issueNumber: null,
    lastState: "",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    ...partial,
  };
}

// The Preview tab is driven by a server-fed `previewPort` (single source of truth
// for tab+pane) plus a monotonic `openPreviewTick`/`lastPreviewTick` guard so a
// row's badge click opens the tab without an iframe-load round-trip. The effect
// choreography (open on tick bump, auto-fallback to the terminal when the port
// vanishes, and NOT re-yanking the user on a later null→port flip with no bump)
// is regression-prone, so exercise it through the real component.
describe("Viewport preview tab", () => {
  const previewTab = () => page.getByRole("button", { name: "Preview" });

  it("opens the Preview tab + renders the iframe on a badge-click tick bump", async () => {
    const { rerender } = render(Viewport, {
      session: session({ id: "v1" }),
      previewPort: 8001,
      openPreviewTick: 0,
    });
    // bound port → the tab exists, but nothing opens it until the tick bumps
    await expect.element(previewTab()).toBeInTheDocument();
    await expect.element(previewTab()).not.toHaveClass(/active/);

    // simulate the row's Preview-badge click: a monotonic tick bump
    await rerender({
      session: session({ id: "v1" }),
      previewPort: 8001,
      openPreviewTick: 1,
    });

    await expect.element(previewTab()).toHaveClass(/active/);
    // the pane mounts a cross-origin iframe at the assigned port (URL built from
    // the live origin → host varies in CI, but the :port/ suffix is load-bearing)
    const frame = page.getByTitle("Preview", { exact: true }).element() as HTMLIFrameElement;
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("src")).toMatch(/:8001\/$/);
  });

  it("falls back to the terminal tab when the preview port goes null while open", async () => {
    const { rerender } = render(Viewport, {
      session: session({ id: "v2" }),
      previewPort: 8002,
      openPreviewTick: 1,
    });
    await expect.element(previewTab()).toHaveClass(/active/);

    // dev server stopped / session archived → server drops the port
    await rerender({
      session: session({ id: "v2" }),
      previewPort: null,
      openPreviewTick: 1,
    });

    // the Preview tab itself disappears (gated on hasPreview) and the terminal
    // tab is active again — no stranded dead iframe
    await expect.element(previewTab()).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Terminal" })).toHaveClass(/active/);
  });

  it("does not re-open Preview on a later null→port flip without a fresh tick bump", async () => {
    // open via the initial tick, then the operator navigates away to another tab
    const { rerender } = render(Viewport, {
      session: session({ id: "v3" }),
      previewPort: 8003,
      openPreviewTick: 1,
    });
    await expect.element(previewTab()).toHaveClass(/active/);

    // exact: the open DiffPanel also exposes a "Refresh diff" button whose
    // accessible name otherwise matches; we want the tab button itself.
    const diffTab = page.getByRole("button", { name: "Diff", exact: true });
    await diffTab.click();
    await expect.element(diffTab).toHaveClass(/active/);

    // port vanishes then returns — same tick (no new badge click). The
    // lastPreviewTick guard must NOT yank the user back to Preview.
    await rerender({
      session: session({ id: "v3" }),
      previewPort: null,
      openPreviewTick: 1,
    });
    await rerender({
      session: session({ id: "v3" }),
      previewPort: 8003,
      openPreviewTick: 1,
    });

    // the tab is available again, but the operator stays on Diff
    await expect.element(previewTab()).toBeInTheDocument();
    await expect.element(previewTab()).not.toHaveClass(/active/);
    await expect.element(diffTab).toHaveClass(/active/);

    // and a genuine new badge click (tick bump) still opens it
    await rerender({
      session: session({ id: "v3" }),
      previewPort: 8003,
      openPreviewTick: 2,
    });
    await expect.element(previewTab()).toHaveClass(/active/);
  });
});
