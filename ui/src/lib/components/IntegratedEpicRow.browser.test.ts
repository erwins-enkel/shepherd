import { describe, it, expect, vi, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { CompletedEpic, CompletedEpicChild } from "$lib/types";

const { default: IntegratedEpicRow } = await import("./IntegratedEpicRow.svelte");

const child = (p: Partial<CompletedEpicChild> = {}): CompletedEpicChild => ({
  number: 11,
  title: "child task",
  url: "https://github.com/o/r/issues/11",
  prNumber: 101,
  prUrl: "https://github.com/o/r/pull/101",
  mergedAt: Date.now() - 60_000,
  integrated: true,
  ...p,
});

const epic = (children: CompletedEpicChild[], p: Partial<CompletedEpic> = {}): CompletedEpic => ({
  repoPath: "/home/me/work/myrepo",
  parentIssueNumber: 327,
  parentTitle: "Big epic",
  completedAt: Date.now() - 120_000,
  children,
  landingPrNumber: null,
  landingPrUrl: null,
  landingState: "pending",
  migrationPaths: [],
  migrationsAckedAt: null,
  ...p,
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("IntegratedEpicRow", () => {
  it("collapsed shows the slate INTEGRATED n/n chip", async () => {
    render(IntegratedEpicRow, {
      epic: epic([child({ number: 1 }), child({ number: 2 })]),
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
    });
    await expect.element(page.getByText("INTEGRATED 2/2")).toBeInTheDocument();
    const chip = document.querySelector(".chip") as HTMLElement;
    expect(chip.classList.contains("chip-done")).toBe(true);
  });

  it("expanding a mixed epic shows a PR link for integrated + issue link & closed marker for out-of-band", async () => {
    render(IntegratedEpicRow, {
      epic: epic([
        child({
          number: 1,
          prNumber: 501,
          prUrl: "https://github.com/o/r/pull/501",
          integrated: true,
        }),
        child({
          number: 2,
          prNumber: null,
          prUrl: null,
          mergedAt: null,
          integrated: false,
          url: "https://github.com/o/r/issues/2",
        }),
      ]),
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
    });
    // mixed epic: merged counts only integrated children, total counts all → 1/2 (not 2/2)
    await expect.element(page.getByText("INTEGRATED 1/2")).toBeInTheDocument();
    (document.querySelector(".row-head") as HTMLButtonElement).click();

    const prLink = await vi.waitFor(() => {
      const a = [...document.querySelectorAll("a.ref")].find((el) =>
        el.textContent?.includes("PR #501"),
      ) as HTMLAnchorElement | undefined;
      if (!a) throw new Error("no pr link yet");
      return a;
    });
    expect(prLink.getAttribute("href")).toBe("https://github.com/o/r/pull/501");

    const issueLink = [...document.querySelectorAll("a.ref")].find(
      (el) => el.textContent?.trim() === "#2",
    ) as HTMLAnchorElement;
    expect(issueLink.getAttribute("href")).toBe("https://github.com/o/r/issues/2");
    await expect.element(page.getByText("closed")).toBeInTheDocument();
  });

  it("integrated child with prUrl but null prNumber shows a number-less PR label (not the issue number)", async () => {
    render(IntegratedEpicRow, {
      epic: epic([
        child({
          number: 77,
          prNumber: null,
          prUrl: "https://github.com/o/r/pull/abc",
          integrated: true,
        }),
      ]),
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
    });
    (document.querySelector(".row-head") as HTMLButtonElement).click();

    const prLink = await vi.waitFor(() => {
      const a = document.querySelector("a.ref") as HTMLAnchorElement | null;
      if (!a) throw new Error("no pr link yet");
      return a;
    });
    expect(prLink.getAttribute("href")).toBe("https://github.com/o/r/pull/abc");
    expect(prLink.textContent?.trim()).toBe("PR");
    // must NOT mislabel with the issue number
    expect(prLink.textContent).not.toContain("77");
  });

  it("integrated child with empty prUrl renders the PR ref as text + merged-ago, no closed marker", async () => {
    render(IntegratedEpicRow, {
      epic: epic([
        child({
          number: 33,
          prNumber: 808,
          prUrl: "", // persisted empty when prCache lacked the URL at merge time
          mergedAt: Date.now() - 90_000,
          integrated: true,
        }),
      ]),
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
    });
    (document.querySelector(".row-head") as HTMLButtonElement).click();

    // PR ref renders as text (no link) — still labelled "PR #808"
    const ref = await vi.waitFor(() => {
      const el = document.querySelector(".child .ref") as HTMLElement | null;
      if (!el) throw new Error("no ref yet");
      return el;
    });
    expect(ref.tagName).toBe("SPAN"); // text, not <a>
    expect(ref.textContent).toContain("PR #808");
    // shows the merged-ago line and NOT the closed marker
    expect(document.querySelector(".child .child-ago")).not.toBeNull();
    expect(document.querySelector(".child .closed")).toBeNull();
  });

  it("landingState 'open' with a PR number renders the Landing PR link to landingPrUrl", async () => {
    render(IntegratedEpicRow, {
      epic: epic([child({ number: 1 })], {
        landingState: "open",
        landingPrNumber: 42,
        landingPrUrl: "https://github.com/o/r/pull/42",
      }),
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
    });
    (document.querySelector(".row-head") as HTMLButtonElement).click();

    const link = await vi.waitFor(() => {
      const a = [...document.querySelectorAll(".actions a")].find((el) =>
        el.textContent?.includes("Landing PR #42"),
      ) as HTMLAnchorElement | undefined;
      if (!a) throw new Error("no landing pr link yet");
      return a;
    });
    expect(link.getAttribute("href")).toBe("https://github.com/o/r/pull/42");
    // not the fallback awaiting-landing copy
    expect(document.querySelector(".actions")?.textContent).not.toContain("awaiting landing");
  });

  it("landingState 'merged' renders the merged Landing PR link, not the awaiting copy", async () => {
    render(IntegratedEpicRow, {
      epic: epic([child({ number: 1 })], {
        landingState: "merged",
        landingPrNumber: 42,
        landingPrUrl: "https://github.com/o/r/pull/42",
      }),
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
    });
    (document.querySelector(".row-head") as HTMLButtonElement).click();

    const link = await vi.waitFor(() => {
      const a = [...document.querySelectorAll(".actions a")].find((el) =>
        el.textContent?.includes("Landing PR #42"),
      ) as HTMLAnchorElement | undefined;
      if (!a) throw new Error("no landing pr link yet");
      return a;
    });
    expect(link.getAttribute("href")).toBe("https://github.com/o/r/pull/42");
    expect(link.textContent).toContain("merged");
    // not the "awaiting merge" copy, not the awaiting-landing fallback
    expect(document.querySelector(".actions")?.textContent).not.toContain("awaiting merge");
    expect(document.querySelector(".actions")?.textContent).not.toContain("awaiting landing");
  });

  it("landingState 'error' renders the failure note and NO PR link", async () => {
    render(IntegratedEpicRow, {
      epic: epic([child({ number: 1 })], {
        landingState: "error",
        landingPrNumber: null,
        landingPrUrl: null,
      }),
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
    });
    (document.querySelector(".row-head") as HTMLButtonElement).click();

    const note = await vi.waitFor(() => {
      const el = document.querySelector(".actions .landing-failed") as HTMLElement | null;
      if (!el) throw new Error("no failure note yet");
      return el;
    });
    expect(note.textContent).toContain("retrying");
    // no link in the actions block — there's no PR yet
    expect(document.querySelector(".actions a")).toBeNull();
  });

  it("landingState 'pending' falls back to the awaiting-landing copy", async () => {
    render(IntegratedEpicRow, {
      epic: epic([child({ number: 1 })], { landingState: "pending" }),
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
    });
    (document.querySelector(".row-head") as HTMLButtonElement).click();

    const awaiting = await vi.waitFor(() => {
      const el = document.querySelector(".actions .awaiting") as HTMLElement | null;
      if (!el) throw new Error("no awaiting copy yet");
      return el;
    });
    expect(awaiting.textContent).toContain("awaiting landing");
    expect(document.querySelector(".actions .landing-failed")).toBeNull();
  });

  it("clicking Dismiss calls ondismiss(repoPath, parentIssueNumber)", async () => {
    const ondismiss = vi.fn();
    render(IntegratedEpicRow, {
      epic: epic([child({ number: 1 })], { repoPath: "/x/y/zrepo", parentIssueNumber: 42 }),
      ondismiss,
      onackmigrations: vi.fn(),
    });
    (document.querySelector(".row-head") as HTMLButtonElement).click();
    const btn = await vi.waitFor(() => {
      const b = document.querySelector(".actions .gbtn") as HTMLButtonElement | null;
      if (!b) throw new Error("no dismiss yet");
      return b;
    });
    btn.click();
    expect(ondismiss).toHaveBeenCalledTimes(1);
    expect(ondismiss).toHaveBeenCalledWith("/x/y/zrepo", 42);
  });

  // ── Migration-awareness checkpoint (#645) ──────────────────────────────────

  it("pending ack: shows the warning chip (count from array) + ack button, hides plain Dismiss", async () => {
    render(IntegratedEpicRow, {
      epic: epic([child({ number: 1 })], {
        migrationPaths: ["server/migrations/001.sql", "drizzle/0002.sql"],
        migrationsAckedAt: null,
      }),
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
    });
    (document.querySelector(".row-head") as HTMLButtonElement).click();

    const chip = await vi.waitFor(() => {
      const el = document.querySelector(".actions .chip-migrations") as HTMLElement | null;
      if (!el) throw new Error("no migration chip yet");
      return el;
    });
    // count derives from migrationPaths.length (2), not a hardcoded number
    expect(chip.textContent).toContain("2 migration");
    // amber warning tone (NOT green)
    expect(getComputedStyle(chip).color).not.toBe("");

    // the ack action replaces the plain Dismiss button
    const actionText = document.querySelector(".actions")?.textContent ?? "";
    expect(actionText).toContain("Acknowledge migrations");
    expect(actionText).not.toContain("Dismiss");
  });

  it("acknowledged migrations: behaves as normal (plain Dismiss, no chip)", async () => {
    render(IntegratedEpicRow, {
      epic: epic([child({ number: 1 })], {
        migrationPaths: ["server/migrations/001.sql"],
        migrationsAckedAt: Date.now(),
      }),
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
    });
    (document.querySelector(".row-head") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      if (!document.querySelector(".actions .gbtn")) throw new Error("no actions yet");
    });
    expect(document.querySelector(".actions .chip-migrations")).toBeNull();
    expect(document.querySelector(".actions")?.textContent).toContain("Dismiss");
    expect(document.querySelector(".actions")?.textContent).not.toContain("Acknowledge migrations");
  });

  it("no migrations: behaves as normal (plain Dismiss, no chip)", async () => {
    render(IntegratedEpicRow, {
      epic: epic([child({ number: 1 })], { migrationPaths: [], migrationsAckedAt: null }),
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
    });
    (document.querySelector(".row-head") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      if (!document.querySelector(".actions .gbtn")) throw new Error("no actions yet");
    });
    expect(document.querySelector(".actions .chip-migrations")).toBeNull();
    expect(document.querySelector(".actions")?.textContent).toContain("Dismiss");
  });

  it("clicking the ack button calls onackmigrations(repoPath, parentIssueNumber)", async () => {
    const onackmigrations = vi.fn();
    render(IntegratedEpicRow, {
      epic: epic([child({ number: 1 })], {
        repoPath: "/x/y/zrepo",
        parentIssueNumber: 42,
        migrationPaths: ["migrations/001.sql"],
        migrationsAckedAt: null,
      }),
      ondismiss: vi.fn(),
      onackmigrations,
    });
    (document.querySelector(".row-head") as HTMLButtonElement).click();
    const btn = await vi.waitFor(() => {
      const b = document.querySelector(".actions .gbtn") as HTMLButtonElement | null;
      if (!b) throw new Error("no ack button yet");
      return b;
    });
    btn.click();
    expect(onackmigrations).toHaveBeenCalledTimes(1);
    expect(onackmigrations).toHaveBeenCalledWith("/x/y/zrepo", 42);
  });
});
