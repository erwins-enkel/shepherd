import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../app.css";
import type { CompletedEpic } from "$lib/types";

const { default: IntegratedEpicLanding } = await import("./IntegratedEpicLanding.svelte");

// An open landing PR paused on a real conflict — the state the "Resolve conflicts" CTA serves (#1841).
const epic = (p: Partial<CompletedEpic> = {}): CompletedEpic => ({
  repoPath: "/home/me/work/myrepo",
  parentIssueNumber: 327,
  parentTitle: "Big epic",
  completedAt: Date.now() - 120_000,
  children: [],
  landingPrNumber: 55,
  landingPrUrl: "https://github.com/o/r/pull/55",
  landingState: "open",
  migrationPaths: [],
  migrationsAckedAt: null,
  landingConflictReworkCount: 0,
  landingReady: false,
  landingMergeable: false,
  landingRebasePauseReason: "conflict",
  ...p,
});

const props = (e: CompletedEpic, onresolveconflicts = vi.fn()) => ({
  epic: e,
  onland: vi.fn(),
  ondismiss: vi.fn(),
  onackmigrations: vi.fn(),
  onresolveconflicts,
});

const resolveBtn = () =>
  [...document.querySelectorAll<HTMLButtonElement>(".actions .gbtn")].find(
    (b) => b.textContent?.trim() === "Resolve conflicts",
  );

afterEach(() => {
  document.body.innerHTML = "";
});

describe("IntegratedEpicLanding — Resolve conflicts (#1841)", () => {
  it("shows the button when the auto-rebase paused on a conflict", async () => {
    render(IntegratedEpicLanding, props(epic({ landingMergeable: null })));
    await vi.waitFor(() => {
      if (!resolveBtn()) throw new Error("no resolve button");
    });
  });

  it("shows the button when the forge reports the PR unmergeable (no pause yet)", async () => {
    render(IntegratedEpicLanding, props(epic({ landingRebasePauseReason: null })));
    await vi.waitFor(() => {
      if (!resolveBtn()) throw new Error("no resolve button");
    });
  });

  it("hides the button while a repair session is live; the auto-repairing chip shows instead", async () => {
    render(IntegratedEpicLanding, props(epic({ landingRepairing: true })));
    await vi.waitFor(() => {
      if (!document.querySelector(".actions .chip-repairing")) throw new Error("no chip");
    });
    expect(resolveBtn()).toBeUndefined();
  });

  it("hides the button when the landing PR is not conflicting", async () => {
    render(
      IntegratedEpicLanding,
      props(epic({ landingRebasePauseReason: null, landingMergeable: true })),
    );
    await vi.waitFor(() => {
      if (!document.querySelector(".actions .gbtn")) throw new Error("no actions yet");
    });
    expect(resolveBtn()).toBeUndefined();
  });

  it("clicking it calls the handler with repo + parent", async () => {
    const onresolveconflicts = vi.fn();
    render(IntegratedEpicLanding, props(epic(), onresolveconflicts));
    const btn = await vi.waitFor(() => {
      const b = resolveBtn();
      if (!b) throw new Error("no resolve button");
      return b;
    });
    btn.click();
    expect(onresolveconflicts).toHaveBeenCalledWith("/home/me/work/myrepo", 327);
  });

  it("carries a structured explanation (title + labelled sections), not a native title", async () => {
    render(IntegratedEpicLanding, props(epic()));
    const btn = await vi.waitFor(() => {
      const b = resolveBtn();
      if (!b) throw new Error("no resolve button");
      return b;
    });
    expect(btn.getAttribute("title")).toBeNull();
    const desc = btn.getAttribute("aria-description") ?? "";
    expect(desc).toContain("Resolve landing conflicts with an agent");
    expect(desc).toContain("force-pushes");
  });
});
