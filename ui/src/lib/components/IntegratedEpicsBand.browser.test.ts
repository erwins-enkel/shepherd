import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { CompletedEpic } from "$lib/types";

const { default: IntegratedEpicsBand } = await import("./IntegratedEpicsBand.svelte");

const epic = (n: number): CompletedEpic => ({
  repoPath: `/home/me/work/repo${n}`,
  parentIssueNumber: 300 + n,
  parentTitle: `Epic ${n}`,
  completedAt: Date.now() - 60_000,
  children: [
    {
      number: n * 10,
      title: "c",
      url: `https://github.com/o/r/issues/${n * 10}`,
      prNumber: n * 100,
      prUrl: `https://github.com/o/r/pull/${n * 100}`,
      mergedAt: Date.now() - 30_000,
      integrated: true,
    },
  ],
  landingPrNumber: null,
  landingPrUrl: null,
  landingState: "pending",
  migrationPaths: [],
  migrationsAckedAt: null,
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("IntegratedEpicsBand", () => {
  it("renders nothing when epics is empty", async () => {
    render(IntegratedEpicsBand, { epics: [], ondismiss: vi.fn(), onackmigrations: vi.fn() });
    expect(document.querySelector(".band")).toBeNull();
    expect(document.querySelector(".band-head")).toBeNull();
  });

  it("header shows the count and expanding reveals one row per epic", async () => {
    render(IntegratedEpicsBand, {
      epics: [epic(1), epic(2)],
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
    });
    await expect.element(page.getByText("Integrated epics (2)")).toBeInTheDocument();
    // collapsed by default → no rows
    expect(document.querySelectorAll(".rows .row").length).toBe(0);
    (document.querySelector(".band-head") as HTMLButtonElement).click();
    const rows = await vi.waitFor(() => {
      const r = document.querySelectorAll(".rows .row");
      if (r.length !== 2) throw new Error("rows not yet rendered");
      return r;
    });
    expect(rows.length).toBe(2);
  });
});
