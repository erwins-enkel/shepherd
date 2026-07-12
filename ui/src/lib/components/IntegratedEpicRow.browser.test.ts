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
      onland: vi.fn(),
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
      onland: vi.fn(),
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
    // closed-but-not-Shepherd-merged child reads clearly distinct from a merged one
    await expect.element(page.getByText("closed · not merged")).toBeInTheDocument();
  });

  it("child whose title is the bare '#<n>' fallback renders the number once (no '#2 #2')", async () => {
    render(IntegratedEpicRow, {
      epic: epic([
        child({
          number: 2,
          title: "#2",
          prNumber: null,
          prUrl: null,
          mergedAt: null,
          integrated: false,
          url: "https://github.com/o/r/issues/2",
        }),
      ]),
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
      onland: vi.fn(),
    });
    (document.querySelector(".row-head") as HTMLButtonElement).click();
    const childRow = await vi.waitFor(() => {
      const el = document.querySelector(".child") as HTMLElement | null;
      if (!el) throw new Error("no child row yet");
      return el;
    });
    // the ref link shows "#2"; the redundant title span is suppressed → no ".child .title"
    expect(childRow.querySelector("a.ref")?.textContent?.trim()).toBe("#2");
    expect(childRow.querySelector(".title")).toBeNull();
  });

  it("landingState 'none' with no Shepherd-merged children shows the nothing-merged copy (not 'awaiting landing')", async () => {
    render(IntegratedEpicRow, {
      epic: epic(
        [
          child({ number: 1, integrated: false, prNumber: null, prUrl: null, mergedAt: null }),
          child({ number: 2, integrated: false, prNumber: null, prUrl: null, mergedAt: null }),
        ],
        { landingState: "none", parentIssueNumber: 182 },
      ),
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
      onland: vi.fn(),
    });
    (document.querySelector(".row-head") as HTMLButtonElement).click();
    const awaiting = await vi.waitFor(() => {
      const el = document.querySelector(".actions .awaiting") as HTMLElement | null;
      if (!el) throw new Error("no footer copy yet");
      return el;
    });
    expect(awaiting.textContent).toContain("nothing to land");
    expect(awaiting.textContent).toContain("#182");
    expect(awaiting.textContent).not.toContain("awaiting landing");
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
      onland: vi.fn(),
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
      onland: vi.fn(),
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

  it("landingState 'open' with a PR number renders the Land button + awaiting-landing link", async () => {
    render(IntegratedEpicRow, {
      epic: epic([child({ number: 1 })], {
        landingState: "open",
        landingPrNumber: 42,
        landingPrUrl: "https://github.com/o/r/pull/42",
        landingReady: true,
      }),
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
      onland: vi.fn(),
    });
    (document.querySelector(".row-head") as HTMLButtonElement).click();

    // Land button must be present and enabled
    const landBtn = await vi.waitFor(() => {
      const btns = [...document.querySelectorAll(".actions .gbtn")] as HTMLButtonElement[];
      const b = btns.find((el) => el.textContent?.includes("Land epic"));
      if (!b) throw new Error("no land button yet");
      return b;
    });
    expect(landBtn.disabled).toBe(false);
    // not the fallback awaiting-landing copy
    expect(document.querySelector(".actions")?.textContent).not.toContain("awaiting landing");
  });

  it("landingState 'merged' renders the merged Landing PR link, no Land button", async () => {
    render(IntegratedEpicRow, {
      epic: epic([child({ number: 1 })], {
        landingState: "merged",
        landingPrNumber: 42,
        landingPrUrl: "https://github.com/o/r/pull/42",
      }),
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
      onland: vi.fn(),
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
    // No Land button in merged state
    const btns = [...document.querySelectorAll(".actions .gbtn")] as HTMLButtonElement[];
    expect(btns.find((b) => b.textContent?.includes("Land epic"))).toBeUndefined();
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
      onland: vi.fn(),
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

  it("landingState 'pending' shows the 'preparing the landing PR' copy", async () => {
    render(IntegratedEpicRow, {
      epic: epic([child({ number: 1 })], { landingState: "pending" }),
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
      onland: vi.fn(),
    });
    (document.querySelector(".row-head") as HTMLButtonElement).click();

    const awaiting = await vi.waitFor(() => {
      const el = document.querySelector(".actions .awaiting") as HTMLElement | null;
      if (!el) throw new Error("no footer copy yet");
      return el;
    });
    expect(awaiting.textContent).toContain("preparing the landing PR");
    expect(document.querySelector(".actions .landing-failed")).toBeNull();
  });

  it("clicking Dismiss calls ondismiss(repoPath, parentIssueNumber)", async () => {
    const ondismiss = vi.fn();
    render(IntegratedEpicRow, {
      epic: epic([child({ number: 1 })], { repoPath: "/x/y/zrepo", parentIssueNumber: 42 }),
      ondismiss,
      onackmigrations: vi.fn(),
      onland: vi.fn(),
    });
    (document.querySelector(".row-head") as HTMLButtonElement).click();
    const btn = await vi.waitFor(() => {
      const btns = [...document.querySelectorAll(".actions .gbtn")] as HTMLButtonElement[];
      const b = btns.find((el) => el.textContent?.includes("Dismiss"));
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
        // landingState defaults to "pending" — ack path is for non-open states
        landingState: "pending",
      }),
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
      onland: vi.fn(),
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
      onland: vi.fn(),
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
      onland: vi.fn(),
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
        landingState: "pending",
      }),
      ondismiss: vi.fn(),
      onackmigrations,
      onland: vi.fn(),
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

  // ── Land epic CTA (#1039) ──────────────────────────────────────────────────

  it("open+ready: Land button present, enabled; clicking shows confirm step; confirming calls onland", async () => {
    const onland = vi.fn();
    render(IntegratedEpicRow, {
      epic: epic([child({ number: 1 })], {
        repoPath: "/x/y/zrepo",
        parentIssueNumber: 42,
        landingState: "open",
        landingPrNumber: 55,
        landingPrUrl: "https://github.com/o/r/pull/55",
        landingReady: true,
      }),
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
      onland,
    });
    (document.querySelector(".row-head") as HTMLButtonElement).click();

    const landBtn = await vi.waitFor(() => {
      const btns = [...document.querySelectorAll(".actions .gbtn")] as HTMLButtonElement[];
      const b = btns.find((el) => el.textContent?.includes("Land epic"));
      if (!b) throw new Error("no land button");
      return b;
    });
    expect(landBtn.disabled).toBe(false);

    // click → confirm step appears
    landBtn.click();
    const confirmBtn = await vi.waitFor(() => {
      const btns = [...document.querySelectorAll(".actions .gbtn")] as HTMLButtonElement[];
      const b = btns.find((el) => el.textContent?.trim() === "Confirm");
      if (!b) throw new Error("no confirm button");
      return b;
    });
    expect(document.querySelector(".actions")?.textContent).toContain(
      "Merge the landing PR and close the epic?",
    );

    // confirm → calls onland with correct args
    confirmBtn.click();
    expect(onland).toHaveBeenCalledTimes(1);
    expect(onland).toHaveBeenCalledWith("/x/y/zrepo", 42);
  });

  it("open+not-ready: Land button is disabled with a tooltip", async () => {
    render(IntegratedEpicRow, {
      epic: epic([child({ number: 1 })], {
        landingState: "open",
        landingPrNumber: 55,
        landingPrUrl: "https://github.com/o/r/pull/55",
        landingReady: false,
        landingChecks: "failure",
      }),
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
      onland: vi.fn(),
    });
    (document.querySelector(".row-head") as HTMLButtonElement).click();

    const landBtn = await vi.waitFor(() => {
      const btns = [...document.querySelectorAll(".actions .gbtn")] as HTMLButtonElement[];
      const b = btns.find((el) => el.textContent?.includes("Land epic"));
      if (!b) throw new Error("no land button");
      return b;
    });
    expect(landBtn.disabled).toBe(true);
    expect(landBtn.title).toBeTruthy();
    expect(landBtn.title).toContain("CI");
  });

  it("open+landingReady undefined: Land button disabled with generic tooltip", async () => {
    render(IntegratedEpicRow, {
      epic: epic([child({ number: 1 })], {
        landingState: "open",
        landingPrNumber: 55,
        landingPrUrl: "https://github.com/o/r/pull/55",
        // landingReady undefined (forge unreachable)
      }),
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
      onland: vi.fn(),
    });
    (document.querySelector(".row-head") as HTMLButtonElement).click();

    const landBtn = await vi.waitFor(() => {
      const btns = [...document.querySelectorAll(".actions .gbtn")] as HTMLButtonElement[];
      const b = btns.find((el) => el.textContent?.includes("Land epic"));
      if (!b) throw new Error("no land button");
      return b;
    });
    expect(landBtn.disabled).toBe(true);
    expect(landBtn.title).toBeTruthy();
  });

  it("landingStranded: stranded badge is rendered", async () => {
    render(IntegratedEpicRow, {
      epic: epic([child({ number: 1 })], {
        landingState: "open",
        landingPrNumber: 55,
        landingPrUrl: "https://github.com/o/r/pull/55",
        landingReady: false,
        landingStranded: true,
      }),
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
      onland: vi.fn(),
    });
    (document.querySelector(".row-head") as HTMLButtonElement).click();

    const badge = await vi.waitFor(() => {
      const el = document.querySelector(".actions .chip-stranded") as HTMLElement | null;
      if (!el) throw new Error("no stranded badge");
      return el;
    });
    expect(badge.textContent?.toLowerCase()).toContain("stranded");
  });

  it("landingRepairing: auto-repair chip is rendered (slate, non-actionable)", async () => {
    render(IntegratedEpicRow, {
      epic: epic([child({ number: 1 })], {
        landingState: "open",
        landingPrNumber: 55,
        landingPrUrl: "https://github.com/o/r/pull/55",
        landingReady: false,
        landingRepairing: true,
      }),
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
      onland: vi.fn(),
    });
    (document.querySelector(".row-head") as HTMLButtonElement).click();

    const chip = await vi.waitFor(() => {
      const el = document.querySelector(".actions .chip-repairing") as HTMLElement | null;
      if (!el) throw new Error("no repairing chip");
      return el;
    });
    expect(chip.textContent?.toLowerCase()).toContain("auto-repair");
  });

  it("no landingRepairing: no auto-repair chip rendered", async () => {
    render(IntegratedEpicRow, {
      epic: epic([child({ number: 1 })], {
        landingState: "open",
        landingPrNumber: 55,
        landingPrUrl: "https://github.com/o/r/pull/55",
        landingReady: true,
      }),
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
      onland: vi.fn(),
    });
    (document.querySelector(".row-head") as HTMLButtonElement).click();

    await vi.waitFor(() => {
      if (!document.querySelector(".actions .gbtn")) throw new Error("no actions yet");
    });
    expect(document.querySelector(".actions .chip-repairing")).toBeNull();
  });

  it("open+pendingAck: Ack-migrations button NOT rendered; Land button shown; migration warn in confirm step", async () => {
    const onland = vi.fn();
    render(IntegratedEpicRow, {
      epic: epic([child({ number: 1 })], {
        landingState: "open",
        landingPrNumber: 55,
        landingPrUrl: "https://github.com/o/r/pull/55",
        landingReady: true,
        migrationPaths: ["migrations/001.sql", "migrations/002.sql"],
        migrationsAckedAt: null,
      }),
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
      onland,
    });
    (document.querySelector(".row-head") as HTMLButtonElement).click();

    await vi.waitFor(() => {
      const btns = [...document.querySelectorAll(".actions .gbtn")] as HTMLButtonElement[];
      if (!btns.find((b) => b.textContent?.includes("Land epic"))) throw new Error("no land btn");
    });

    const actionText = document.querySelector(".actions")?.textContent ?? "";
    // Ack-migrations button must NOT appear in open state
    expect(actionText).not.toContain("Acknowledge migrations");

    // click Land → confirm step with migration warning
    const landBtn = [...document.querySelectorAll(".actions .gbtn")].find((b) =>
      b.textContent?.includes("Land epic"),
    ) as HTMLButtonElement;
    landBtn.click();

    const confirmText = await vi.waitFor(() => {
      const t = document.querySelector(".actions")?.textContent ?? "";
      if (!t.includes("migration")) throw new Error("no migration warn in confirm");
      return t;
    });
    expect(confirmText).toContain("2 migration");
  });

  it("pendingAck+landingState NOT open: Ack-migrations button still rendered (legacy unchanged)", async () => {
    render(IntegratedEpicRow, {
      epic: epic([child({ number: 1 })], {
        landingState: "pending",
        migrationPaths: ["migrations/001.sql"],
        migrationsAckedAt: null,
      }),
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
      onland: vi.fn(),
    });
    (document.querySelector(".row-head") as HTMLButtonElement).click();

    const ackBtn = await vi.waitFor(() => {
      const btns = [...document.querySelectorAll(".actions .gbtn")] as HTMLButtonElement[];
      const b = btns.find((el) => el.textContent?.includes("Acknowledge migrations"));
      if (!b) throw new Error("no ack button");
      return b;
    });
    expect(ackBtn).toBeTruthy();
    // No Land button when landingState is not "open"
    const btns = [...document.querySelectorAll(".actions .gbtn")] as HTMLButtonElement[];
    expect(btns.find((b) => b.textContent?.includes("Land epic"))).toBeUndefined();
  });

  // ── Auto-rebase paused chip (#1071) ───────────────────────────────────────

  it("landingRebasePauseReason 'cap': shows cap paused chip", async () => {
    render(IntegratedEpicRow, {
      epic: epic([child({ number: 1 })], {
        landingState: "open",
        landingPrNumber: 55,
        landingPrUrl: "https://github.com/o/r/pull/55",
        landingRebasePauseReason: "cap",
      }),
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
      onland: vi.fn(),
    });
    (document.querySelector(".row-head") as HTMLButtonElement).click();

    const chip = await vi.waitFor(() => {
      const el = document.querySelector(".actions .chip-rebase-paused") as HTMLElement | null;
      if (!el) throw new Error("no rebase-paused chip");
      return el;
    });
    expect(chip.textContent).toContain("repeated tries");
  });

  it("landingRebasePauseReason 'conflict': shows conflict paused chip", async () => {
    render(IntegratedEpicRow, {
      epic: epic([child({ number: 1 })], {
        landingState: "open",
        landingPrNumber: 55,
        landingPrUrl: "https://github.com/o/r/pull/55",
        landingRebasePauseReason: "conflict",
      }),
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
      onland: vi.fn(),
    });
    (document.querySelector(".row-head") as HTMLButtonElement).click();

    const chip = await vi.waitFor(() => {
      const el = document.querySelector(".actions .chip-rebase-paused") as HTMLElement | null;
      if (!el) throw new Error("no rebase-paused chip");
      return el;
    });
    expect(chip.textContent).toContain("real conflict");
  });

  it("landingRebasePauseReason 'driver': shows driver paused chip", async () => {
    render(IntegratedEpicRow, {
      epic: epic([child({ number: 1 })], {
        landingState: "open",
        landingPrNumber: 55,
        landingPrUrl: "https://github.com/o/r/pull/55",
        landingRebasePauseReason: "driver",
      }),
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
      onland: vi.fn(),
    });
    (document.querySelector(".row-head") as HTMLButtonElement).click();

    const chip = await vi.waitFor(() => {
      const el = document.querySelector(".actions .chip-rebase-paused") as HTMLElement | null;
      if (!el) throw new Error("no rebase-paused chip");
      return el;
    });
    expect(chip.textContent).toContain("Merge driver");
  });

  it("no landingRebasePauseReason: no rebase-paused chip rendered", async () => {
    render(IntegratedEpicRow, {
      epic: epic([child({ number: 1 })], {
        landingState: "open",
        landingPrNumber: 55,
        landingPrUrl: "https://github.com/o/r/pull/55",
      }),
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
      onland: vi.fn(),
    });
    (document.querySelector(".row-head") as HTMLButtonElement).click();

    await vi.waitFor(() => {
      if (!document.querySelector(".actions .gbtn")) throw new Error("no actions yet");
    });
    expect(document.querySelector(".actions .chip-rebase-paused")).toBeNull();
  });

  it("confirm cancel: clicking Cancel resets confirming state without calling onland", async () => {
    const onland = vi.fn();
    render(IntegratedEpicRow, {
      epic: epic([child({ number: 1 })], {
        landingState: "open",
        landingPrNumber: 55,
        landingPrUrl: "https://github.com/o/r/pull/55",
        landingReady: true,
      }),
      ondismiss: vi.fn(),
      onackmigrations: vi.fn(),
      onland,
    });
    (document.querySelector(".row-head") as HTMLButtonElement).click();

    const landBtn = await vi.waitFor(() => {
      const btns = [...document.querySelectorAll(".actions .gbtn")] as HTMLButtonElement[];
      const b = btns.find((el) => el.textContent?.includes("Land epic"));
      if (!b) throw new Error("no land button");
      return b;
    });
    landBtn.click();

    // Cancel should be visible
    const cancelBtn = await vi.waitFor(() => {
      const btns = [...document.querySelectorAll(".actions .gbtn")] as HTMLButtonElement[];
      const b = btns.find((el) => el.textContent?.trim() === "Cancel");
      if (!b) throw new Error("no cancel button");
      return b;
    });
    cancelBtn.click();

    // Land button reappears, onland not called
    await vi.waitFor(() => {
      const btns = [...document.querySelectorAll(".actions .gbtn")] as HTMLButtonElement[];
      if (!btns.find((b) => b.textContent?.includes("Land epic"))) throw new Error("land not back");
    });
    expect(onland).not.toHaveBeenCalled();
  });
});
