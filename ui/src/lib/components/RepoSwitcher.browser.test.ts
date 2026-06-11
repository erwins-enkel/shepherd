import { describe, it, expect, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { DrainStatus, QueuedItem } from "$lib/types";
import type { RepoChip } from "./queue-strip";
import { m } from "$lib/paraglide/messages";

// getDrainQueue is only exercised by the inline-expand interaction; stub it so no
// network call fires. Preserve the rest of $lib/api so the import graph resolves.
const getDrainQueueFn = vi.fn(async (): Promise<QueuedItem[]> => []);
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return { ...actual, getDrainQueue: getDrainQueueFn };
});

const { default: RepoSwitcher } = await import("./RepoSwitcher.svelte");

function drain(partial: Partial<DrainStatus> & { repoPath: string }): DrainStatus {
  return {
    enabled: true,
    paused: false,
    reason: null,
    detail: null,
    queued: 0,
    inFlight: 0,
    max: 4,
    ...partial,
  };
}

function chip(partial: Partial<RepoChip> & { repoPath: string }): RepoChip {
  return {
    count: 1,
    drain: null,
    insights: 0,
    curate: 0,
    ...partial,
  };
}

describe("RepoSwitcher — filter rail", () => {
  it("renders the rail with the leading 'all' chip + a chip per repo (≥2 chips)", async () => {
    render(RepoSwitcher, {
      chips: [chip({ repoPath: "/repo/alpha", count: 2 }), chip({ repoPath: "/repo/beta" })],
      repoFilter: null,
      onrepofilter: () => {},
    });
    await expect.element(page.getByRole("group", { name: m.repo_switcher_label() })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: m.repo_filter_all_aria() }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: m.repo_filter_apply_aria({ repo: "alpha" }) }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: m.repo_filter_apply_aria({ repo: "beta" }) }))
      .toBeVisible();
  });

  it("clicking a repo chip calls onrepofilter with its full path", async () => {
    let filtered: string | null | undefined;
    render(RepoSwitcher, {
      chips: [chip({ repoPath: "/repo/alpha" }), chip({ repoPath: "/repo/beta" })],
      repoFilter: null,
      onrepofilter: (p: string | null) => (filtered = p),
    });
    await page.getByRole("button", { name: m.repo_filter_apply_aria({ repo: "beta" }) }).click();
    expect(filtered).toBe("/repo/beta");
  });

  it("clicking the active repo chip clears the filter (null)", async () => {
    let filtered: string | null | undefined = "unset";
    render(RepoSwitcher, {
      chips: [chip({ repoPath: "/repo/alpha" }), chip({ repoPath: "/repo/beta" })],
      repoFilter: "/repo/alpha",
      onrepofilter: (p: string | null) => (filtered = p),
    });
    // active chip carries the "showing X only — click to show all" aria label
    await page.getByRole("button", { name: m.repo_filter_active_aria({ repo: "alpha" }) }).click();
    expect(filtered).toBe(null);
  });

  it("clicking the 'all' chip clears the filter (null)", async () => {
    let filtered: string | null | undefined = "unset";
    render(RepoSwitcher, {
      chips: [chip({ repoPath: "/repo/alpha" }), chip({ repoPath: "/repo/beta" })],
      repoFilter: "/repo/alpha",
      onrepofilter: (p: string | null) => (filtered = p),
    });
    await page.getByRole("button", { name: m.repo_filter_all_aria() }).click();
    expect(filtered).toBe(null);
  });

  it("a paused repo shows the ● marker AND announces via the live region", async () => {
    const pausedChip = chip({
      repoPath: "/repo/alpha",
      drain: drain({ repoPath: "/repo/alpha", paused: true, reason: "blocked", detail: "TASK-07" }),
    });
    const { container } = render(RepoSwitcher, {
      chips: [pausedChip, chip({ repoPath: "/repo/beta" })],
      repoFilter: null,
      onrepofilter: () => {},
    });
    // the marker glyph
    expect(container.querySelector(".rs-paused-dot"), "paused ● marker").not.toBeNull();
    // the live region carries the announcement text
    const live = container.querySelector<HTMLElement>(".rs-live");
    expect(live, "live region present").not.toBeNull();
    expect(live!.textContent).toContain("alpha");
    expect(live!.textContent).toContain("TASK-07");
  });

  it("active-repo detail line appears only when the filtered repo has telemetry", async () => {
    const withTele = chip({
      repoPath: "/repo/alpha",
      drain: drain({ repoPath: "/repo/alpha", inFlight: 1, max: 4 }),
    });
    const bare = chip({ repoPath: "/repo/beta" });

    // filter on the bare repo: no detail line
    const bareRender = render(RepoSwitcher, {
      chips: [withTele, bare],
      repoFilter: "/repo/beta",
      onrepofilter: () => {},
    });
    expect(
      bareRender.container.querySelector(".rs-tele"),
      "no detail line for bare repo",
    ).toBeNull();
    bareRender.unmount();

    // filter on the telemetry repo: detail line shows its inflight count
    const teleRender = render(RepoSwitcher, {
      chips: [withTele, bare],
      repoFilter: "/repo/alpha",
      onrepofilter: () => {},
    });
    expect(
      teleRender.container.querySelector(".rs-tele"),
      "detail line for telemetry repo",
    ).not.toBeNull();
    await expect.element(page.getByText(m.drain_inflight({ count: 1, max: 4 }))).toBeVisible();
  });

  it("lone-repo (1 chip + telemetry) renders the telemetry line WITHOUT filter chips", async () => {
    const { container } = render(RepoSwitcher, {
      chips: [
        chip({
          repoPath: "/repo/solo",
          drain: drain({ repoPath: "/repo/solo", inFlight: 2, max: 4 }),
        }),
      ],
      repoFilter: null,
      onrepofilter: () => {},
    });
    // telemetry shows, but there is no filter rail / 'all' chip
    expect(container.querySelector(".rs-tele"), "telemetry line").not.toBeNull();
    expect(container.querySelector(".rs-scroller"), "no filter rail").toBeNull();
    await expect
      .element(page.getByRole("button", { name: m.repo_filter_all_aria() }))
      .not.toBeInTheDocument();
  });

  it("<2 chips and no telemetry renders no chips (only the empty live region)", async () => {
    const { container } = render(RepoSwitcher, {
      chips: [chip({ repoPath: "/repo/solo" })],
      repoFilter: null,
      onrepofilter: () => {},
    });
    expect(container.querySelector(".rs-scroller"), "no filter rail").toBeNull();
    expect(container.querySelector(".rs-tele"), "no telemetry line").toBeNull();
    const live = container.querySelector<HTMLElement>(".rs-live");
    expect(live, "live region still present").not.toBeNull();
    expect(live!.textContent?.trim()).toBe("");
  });

  it("clicking the queued button expands the inline queue (fetches via getDrainQueue)", async () => {
    getDrainQueueFn.mockResolvedValueOnce([
      { number: 42, title: "queued issue", url: "https://example.test/42" },
    ]);
    render(RepoSwitcher, {
      chips: [
        chip({
          repoPath: "/repo/alpha",
          drain: drain({ repoPath: "/repo/alpha", inFlight: 1, max: 4, queued: 1 }),
        }),
        chip({ repoPath: "/repo/beta" }),
      ],
      repoFilter: "/repo/alpha",
      onrepofilter: () => {},
    });
    await page
      .getByRole("button", { name: m.drain_queue_open_aria({ count: 1, repo: "alpha" }) })
      .click();
    expect(getDrainQueueFn).toHaveBeenCalledWith("/repo/alpha");
    await expect.element(page.getByText("queued issue")).toBeVisible();
  });
});
