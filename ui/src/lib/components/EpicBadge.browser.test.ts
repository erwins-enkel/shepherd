import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { Epic, EpicChild, EpicChildState, EpicSummary } from "$lib/types";

const { default: EpicBadge } = await import("./EpicBadge.svelte");

const summary = (p: Partial<EpicSummary> = {}): EpicSummary => ({
  parentIssueNumber: 327,
  parentTitle: "Epic",
  total: 5,
  merged: 2,
  status: "idle",
  source: "native",
  ...p,
});

const child = (state: EpicChildState, number: number): EpicChild => ({
  number,
  title: `c${number}`,
  url: "",
  order: number,
  body: "",
  blockedBy: [],
  state,
  sessionId: null,
  prNumber: null,
  issueClosed: false,
  claimed: false,
});

const epic = (children: EpicChild[]): Epic => ({
  repoPath: "/repo",
  parentIssueNumber: 327,
  parentTitle: "Epic",
  source: "native",
  children,
  warnings: [],
  run: { repoPath: "/repo", parentIssueNumber: 327, mode: "auto", status: "idle" },
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("EpicBadge", () => {
  it("renders EPIC merged/total from the summary when no live Epic", async () => {
    render(EpicBadge, {
      summary: summary({ total: 5, merged: 2 }),
      repoPath: "/repo",
      issueNumber: 327,
    });
    await expect.element(page.getByText("EPIC 2/5")).toBeInTheDocument();
  });

  it("prefers live Epic counts over the summary", async () => {
    // summary says 2/5, but live has 4 children, 1 merged → EPIC 1/4
    const live = epic([
      child("merged", 1),
      child("in-review", 2),
      child("running", 3),
      child("ready", 4),
    ]);
    render(EpicBadge, {
      summary: summary({ total: 5, merged: 2 }),
      live,
      repoPath: "/repo",
      issueNumber: 327,
    });
    await expect.element(page.getByText("EPIC 1/4")).toBeInTheDocument();
  });

  it("calls onepic with (repoPath, issueNumber) on click", async () => {
    const onepic = vi.fn();
    render(EpicBadge, { summary: summary(), repoPath: "/myrepo", issueNumber: 42, onepic });
    const btn = document.querySelector(".epic-badge") as HTMLButtonElement;
    btn.click();
    expect(onepic).toHaveBeenCalledTimes(1);
    expect(onepic).toHaveBeenCalledWith("/myrepo", 42);
  });

  it("progress fill width reflects merged/total via --epic-pct", async () => {
    render(EpicBadge, {
      summary: summary({ total: 5, merged: 2 }),
      repoPath: "/repo",
      issueNumber: 327,
    });
    const btn = document.querySelector(".epic-badge") as HTMLButtonElement;
    // 2/5 = 40%
    expect(btn.style.getPropertyValue("--epic-pct")).toBe("40%");
  });

  it("total: 0 yields 0% without error", async () => {
    render(EpicBadge, {
      summary: summary({ total: 0, merged: 0 }),
      repoPath: "/repo",
      issueNumber: 327,
    });
    const btn = document.querySelector(".epic-badge") as HTMLButtonElement;
    expect(btn.style.getPropertyValue("--epic-pct")).toBe("0%");
    await expect.element(page.getByText("EPIC 0/0")).toBeInTheDocument();
  });
});
