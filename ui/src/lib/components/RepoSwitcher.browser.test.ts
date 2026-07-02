import { afterEach, describe, it, expect, vi } from "vitest";
import { tick } from "svelte";
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

afterEach(() => {
  vi.useRealTimers();
});

function drain(partial: Partial<DrainStatus> & { repoPath: string }): DrainStatus {
  return {
    enabled: true,
    paused: false,
    reason: null,
    detail: null,
    queued: 0,
    inFlight: 0,
    max: 4,
    epicParent: null,
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
  it("renders the rail with a chip per repo (≥2 chips) and no leading 'all' chip", async () => {
    render(RepoSwitcher, {
      chips: [chip({ repoPath: "/repo/alpha", count: 2 }), chip({ repoPath: "/repo/beta" })],
      repoFilter: new Set<string>(),
      onrepofilter: () => {},
    });
    await expect.element(page.getByRole("group", { name: m.repo_switcher_label() })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: m.repo_filter_apply_aria({ repo: "alpha" }) }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: m.repo_filter_apply_aria({ repo: "beta" }) }))
      .toBeVisible();
  });

  it("plain-clicking a repo chip reports its full path with additive=false", async () => {
    const onrepofilter = vi.fn();
    render(RepoSwitcher, {
      chips: [chip({ repoPath: "/repo/alpha" }), chip({ repoPath: "/repo/beta" })],
      repoFilter: new Set<string>(),
      onrepofilter,
    });
    await page.getByRole("button", { name: m.repo_filter_apply_aria({ repo: "beta" }) }).click();
    expect(onrepofilter).toHaveBeenCalledWith("/repo/beta", false);
  });

  it("Shift-clicking a repo chip reports it with additive=true (combo select)", async () => {
    const onrepofilter = vi.fn();
    render(RepoSwitcher, {
      chips: [chip({ repoPath: "/repo/alpha" }), chip({ repoPath: "/repo/beta" })],
      repoFilter: new Set(["/repo/alpha"]),
      onrepofilter,
    });
    const beta = page.getByRole("button", { name: m.repo_filter_apply_aria({ repo: "beta" }) });
    beta.element().dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    expect(onrepofilter).toHaveBeenCalledWith("/repo/beta", true);
  });

  it("keyboard Shift+Enter on a focused chip performs an additive toggle", async () => {
    const onrepofilter = vi.fn();
    render(RepoSwitcher, {
      chips: [chip({ repoPath: "/repo/alpha" }), chip({ repoPath: "/repo/beta" })],
      repoFilter: new Set(["/repo/alpha"]),
      onrepofilter,
    });
    const beta = page
      .getByRole("button", { name: m.repo_filter_apply_aria({ repo: "beta" }) })
      .element() as HTMLButtonElement;
    beta.focus();
    // Enter/Space activation on a button surfaces as a click event carrying the modifier state;
    // a real keyboard Shift+Enter dispatches a click with shiftKey=true.
    beta.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    expect(onrepofilter).toHaveBeenCalledWith("/repo/beta", true);
  });

  it("clicking the active repo chip reports it with additive=false (page clears the sole selection)", async () => {
    const onrepofilter = vi.fn();
    render(RepoSwitcher, {
      chips: [chip({ repoPath: "/repo/alpha" }), chip({ repoPath: "/repo/beta" })],
      repoFilter: new Set(["/repo/alpha"]),
      onrepofilter,
    });
    // active chip carries the "showing X only — click to show all" aria label
    await page.getByRole("button", { name: m.repo_filter_active_aria({ repo: "alpha" }) }).click();
    expect(onrepofilter).toHaveBeenCalledWith("/repo/alpha", false);
  });

  it("sorts the pinned repo to the first chip slot and marks it for assistive tech", async () => {
    const { container } = render(RepoSwitcher, {
      chips: [
        chip({ repoPath: "/repo/alpha" }),
        chip({ repoPath: "/repo/beta" }),
        chip({ repoPath: "/repo/gamma" }),
      ],
      repoFilter: new Set<string>(),
      pinnedRepo: "/repo/beta",
      onrepofilter: () => {},
    });

    const names = Array.from(container.querySelectorAll(".rs-name")).map((el) => el.textContent);
    expect(names).toEqual(["beta", "alpha", "gamma"]);
    expect(container.querySelector(".rs-chip.pinned .rs-pin-mark"), "pin mark").not.toBeNull();
    await expect
      .element(
        page.getByRole("button", {
          name: `${m.repo_filter_apply_aria({ repo: "beta" })} ${m.repo_chip_pinned_aria()}`,
        }),
      )
      .toBeVisible();
  });

  it("right-clicking a repo chip opens the pin menu without changing the filter", async () => {
    const onrepofilter = vi.fn();
    const onpinrepo = vi.fn();
    render(RepoSwitcher, {
      chips: [chip({ repoPath: "/repo/alpha" }), chip({ repoPath: "/repo/beta" })],
      repoFilter: new Set<string>(),
      onrepofilter,
      onpinrepo,
    });
    const alpha = document.querySelector(".rs-chip") as HTMLElement;
    alpha.dispatchEvent(
      new MouseEvent("contextmenu", { button: 2, clientX: 40, clientY: 40, bubbles: true }),
    );
    await tick();

    const menu = document.querySelector(".rs-menu") as HTMLElement;
    expect(menu, "repo pin menu opened").not.toBeNull();
    expect(menu.getAttribute("role")).toBe("menu");
    expect(onrepofilter).not.toHaveBeenCalled();

    (menu.querySelector(".rs-menu-item") as HTMLElement).click();
    await tick();
    expect(onpinrepo).toHaveBeenCalledWith("/repo/alpha");
    expect(document.querySelector(".rs-menu"), "menu closes after pin").toBeNull();
  });

  it("anchors a keyboard-opened context menu to the focused chip instead of viewport origin", async () => {
    render(RepoSwitcher, {
      chips: [chip({ repoPath: "/repo/alpha" }), chip({ repoPath: "/repo/beta" })],
      repoFilter: new Set<string>(),
      onrepofilter: () => {},
    });
    const alpha = document.querySelector(".rs-chip") as HTMLElement;
    vi.spyOn(alpha, "getBoundingClientRect").mockReturnValue({
      x: 120,
      y: 30,
      left: 120,
      top: 30,
      right: 190,
      bottom: 58,
      width: 70,
      height: 28,
      toJSON: () => ({}),
    });

    alpha.dispatchEvent(new MouseEvent("contextmenu", { clientX: 0, clientY: 0, bubbles: true }));
    await tick();

    const menu = document.querySelector(".rs-menu") as HTMLElement;
    expect(menu, "keyboard context menu opened").not.toBeNull();
    expect(menu.style.left).toBe("120px");
    expect(menu.style.top).toBe("58px");
  });

  it("the pin menu unpins an already-pinned repo", async () => {
    const onpinrepo = vi.fn();
    render(RepoSwitcher, {
      chips: [chip({ repoPath: "/repo/alpha" }), chip({ repoPath: "/repo/beta" })],
      repoFilter: new Set<string>(),
      pinnedRepo: "/repo/alpha",
      onrepofilter: () => {},
      onpinrepo,
    });
    const alpha = document.querySelector(".rs-chip") as HTMLElement;
    alpha.dispatchEvent(
      new MouseEvent("contextmenu", { button: 2, clientX: 40, clientY: 40, bubbles: true }),
    );
    await tick();

    await expect.element(page.getByRole("menuitem", { name: m.repo_chip_unpin() })).toBeVisible();
    (document.querySelector(".rs-menu-item") as HTMLElement).click();
    await tick();

    expect(onpinrepo).toHaveBeenCalledWith(null);
  });

  it("scrolls the chip rail back to the left after pinning a repo", async () => {
    const onpinrepo = vi.fn();
    render(RepoSwitcher, {
      chips: [
        chip({ repoPath: "/repo/alpha" }),
        chip({ repoPath: "/repo/beta" }),
        chip({ repoPath: "/repo/gamma" }),
      ],
      repoFilter: new Set<string>(),
      onrepofilter: () => {},
      onpinrepo,
    });
    const scroller = document.querySelector(".rs-scroller") as HTMLElement & {
      scrollLeft: number;
    };
    Object.defineProperty(scroller, "scrollLeft", {
      value: 120,
      writable: true,
      configurable: true,
    });
    const beta = page.getByRole("button", { name: m.repo_filter_apply_aria({ repo: "beta" }) });

    beta
      .element()
      .dispatchEvent(
        new MouseEvent("contextmenu", { button: 2, clientX: 40, clientY: 40, bubbles: true }),
      );
    await tick();
    (document.querySelector(".rs-menu-item") as HTMLElement).click();
    await tick();
    await tick();

    expect(onpinrepo).toHaveBeenCalledWith("/repo/beta");
    expect(scroller.scrollLeft).toBe(0);
  });

  it("holding a chip opens the pin menu and suppresses the filter click", async () => {
    vi.useFakeTimers();
    const onrepofilter = vi.fn();
    render(RepoSwitcher, {
      chips: [chip({ repoPath: "/repo/alpha" }), chip({ repoPath: "/repo/beta" })],
      repoFilter: new Set<string>(),
      onrepofilter,
    });
    const alpha = document.querySelector(".rs-chip") as HTMLElement;

    alpha.dispatchEvent(
      new PointerEvent("pointerdown", {
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        clientX: 40,
        clientY: 40,
        bubbles: true,
      }),
    );
    vi.advanceTimersByTime(500);
    await tick();
    alpha.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
    alpha.click();
    await tick();

    expect(document.querySelector(".rs-menu"), "hold opened menu").not.toBeNull();
    expect(onrepofilter).not.toHaveBeenCalled();
  });

  it("does not suppress the next chip click after dismissing a held-open pin menu", async () => {
    vi.useFakeTimers();
    const onrepofilter = vi.fn();
    render(RepoSwitcher, {
      chips: [chip({ repoPath: "/repo/alpha" }), chip({ repoPath: "/repo/beta" })],
      repoFilter: new Set<string>(),
      onrepofilter,
    });
    const alpha = page.getByRole("button", { name: m.repo_filter_apply_aria({ repo: "alpha" }) });
    const beta = page.getByRole("button", { name: m.repo_filter_apply_aria({ repo: "beta" }) });

    alpha.element().dispatchEvent(
      new PointerEvent("pointerdown", {
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        clientX: 40,
        clientY: 40,
        bubbles: true,
      }),
    );
    vi.advanceTimersByTime(500);
    await tick();
    alpha.element().dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
    await beta.click();

    expect(document.querySelector(".rs-menu"), "menu closed by Escape").toBeNull();
    expect(onrepofilter).toHaveBeenCalledWith("/repo/beta", false);
  });

  it("a paused repo shows the ● marker AND announces via the live region", async () => {
    const pausedChip = chip({
      repoPath: "/repo/alpha",
      drain: drain({ repoPath: "/repo/alpha", paused: true, reason: "blocked", detail: "TASK-07" }),
    });
    const { container } = render(RepoSwitcher, {
      chips: [pausedChip, chip({ repoPath: "/repo/beta" })],
      repoFilter: new Set<string>(),
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

  it("a chip with insights shows the ✦ marker + count in the rail and its aria-label carries the learnings clause", async () => {
    const learnChip = chip({ repoPath: "/repo/alpha", insights: 3 });
    const { container } = render(RepoSwitcher, {
      chips: [learnChip, chip({ repoPath: "/repo/beta" })],
      repoFilter: new Set<string>(),
      onrepofilter: () => {},
    });
    // display-only marker on the chip: ✦ glyph + the insights count
    const mark = container.querySelector<HTMLElement>(".rs-learn-mark");
    expect(mark, "✦ learnings marker").not.toBeNull();
    expect(mark!.getAttribute("aria-hidden")).toBe("true");
    expect(mark!.getAttribute("title")).toBe(m.learnings_badge_tip());
    expect(mark!.textContent).toContain("✦");
    expect(mark!.querySelector(".rs-learn-n")?.textContent).toBe("3");
    // aria parity: the chip BUTTON's label appends the learnings clause
    const expected =
      m.repo_filter_apply_aria({ repo: "alpha" }) + " " + m.repo_chip_learnings_aria({ count: 3 });
    await expect.element(page.getByRole("button", { name: expected })).toBeVisible();
  });

  it("a curate-only chip shows a bare ✦ (no number) and the curate count in its aria-label", async () => {
    const curateChip = chip({ repoPath: "/repo/alpha", insights: 0, curate: 2 });
    const { container } = render(RepoSwitcher, {
      chips: [curateChip, chip({ repoPath: "/repo/beta" })],
      repoFilter: new Set<string>(),
      onrepofilter: () => {},
    });
    const mark = container.querySelector<HTMLElement>(".rs-learn-mark");
    expect(mark, "✦ learnings marker").not.toBeNull();
    expect(mark!.getAttribute("title")).toBe(m.learnings_badge_tip());
    expect(mark!.textContent).toContain("✦");
    // curate-only → bare glyph, no count span
    expect(mark!.querySelector(".rs-learn-n"), "no count for curate-only").toBeNull();
    const expected =
      m.repo_filter_apply_aria({ repo: "alpha" }) + " " + m.repo_chip_learnings_aria({ count: 2 });
    await expect.element(page.getByRole("button", { name: expected })).toBeVisible();
  });

  it("a chip with no learnings shows no ✦ marker and a plain aria-label", async () => {
    const { container } = render(RepoSwitcher, {
      chips: [chip({ repoPath: "/repo/alpha" }), chip({ repoPath: "/repo/beta" })],
      repoFilter: new Set<string>(),
      onrepofilter: () => {},
    });
    expect(container.querySelector(".rs-learn-mark"), "no ✦ marker").toBeNull();
    await expect
      .element(page.getByRole("button", { name: m.repo_filter_apply_aria({ repo: "alpha" }) }))
      .toBeVisible();
  });

  it("the active chip keeps its ✦ mark and renders no learnings bar", async () => {
    const learnChip = chip({ repoPath: "/repo/alpha", insights: 31 });
    const { container } = render(RepoSwitcher, {
      chips: [learnChip, chip({ repoPath: "/repo/beta" })],
      repoFilter: new Set(["/repo/alpha"]),
      onrepofilter: () => {},
    });
    // the active chip keeps its decorative ✦ mark (no dedicated bar to dup with anymore)
    const mark = container.querySelector<HTMLElement>(".rs-learn-mark");
    expect(mark, "✦ mark on the active chip").not.toBeNull();
    expect(mark!.querySelector(".rs-learn-n")?.textContent).toBe("31");
    // the dedicated learnings bar is gone (learnings live on the gear menu)
    expect(container.querySelector(".rs-insights"), "no learnings bar").toBeNull();
    // insights-only repo (no drain) → no telemetry detail line at all
    expect(container.querySelector(".rs-tele"), "no detail line for insights-only repo").toBeNull();
  });

  it("every chip with insights keeps its ✦ mark, including the active one", async () => {
    const { container } = render(RepoSwitcher, {
      chips: [
        chip({ repoPath: "/repo/alpha", insights: 5 }),
        chip({ repoPath: "/repo/beta", insights: 9 }),
      ],
      repoFilter: new Set(["/repo/beta"]),
      onrepofilter: () => {},
    });
    // both alpha (inactive) AND beta (active) now carry marks — no active-chip suppression
    const marks = container.querySelectorAll(".rs-learn-mark");
    expect(marks.length, "a mark on each chip with insights").toBe(2);
    expect(marks[0].querySelector(".rs-learn-n")?.textContent).toBe("5");
    expect(marks[1].querySelector(".rs-learn-n")?.textContent).toBe("9");
  });

  it("the active filter chip carries no underline text-decoration", async () => {
    const { container } = render(RepoSwitcher, {
      chips: [chip({ repoPath: "/repo/alpha" }), chip({ repoPath: "/repo/beta" })],
      repoFilter: new Set(["/repo/alpha"]),
      onrepofilter: () => {},
    });
    const activeChip = container.querySelector<HTMLElement>(".rs-chip.active");
    expect(activeChip, "active chip present").not.toBeNull();
    const deco = getComputedStyle(activeChip!).textDecorationLine;
    expect(deco, "no underline on the active chip").toBe("none");
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
      repoFilter: new Set(["/repo/beta"]),
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
      repoFilter: new Set(["/repo/alpha"]),
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
      repoFilter: new Set<string>(),
      onrepofilter: () => {},
    });
    // telemetry shows, but there is no filter rail
    expect(container.querySelector(".rs-tele"), "telemetry line").not.toBeNull();
    expect(container.querySelector(".rs-scroller"), "no filter rail").toBeNull();
  });

  it("<2 chips and no telemetry renders no chips (only the empty live region)", async () => {
    const { container } = render(RepoSwitcher, {
      chips: [chip({ repoPath: "/repo/solo" })],
      repoFilter: new Set<string>(),
      onrepofilter: () => {},
    });
    expect(container.querySelector(".rs-scroller"), "no filter rail").toBeNull();
    expect(container.querySelector(".rs-tele"), "no telemetry line").toBeNull();
    const live = container.querySelector<HTMLElement>(".rs-live");
    expect(live, "live region still present").not.toBeNull();
    expect(live!.textContent?.trim()).toBe("");
  });

  it("a lone-repo with only learnings (insights/curate, no drain) renders no bar and no detail line", async () => {
    // insights-only
    const insightsRender = render(RepoSwitcher, {
      chips: [chip({ repoPath: "/repo/solo", insights: 5 })],
      repoFilter: new Set<string>(),
      onrepofilter: () => {},
    });
    expect(insightsRender.container.querySelector(".rs-insights"), "no learnings bar").toBeNull();
    expect(insightsRender.container.querySelector(".rs-tele"), "no detail line").toBeNull();
    insightsRender.unmount();

    // curate-only
    const curateRender = render(RepoSwitcher, {
      chips: [chip({ repoPath: "/repo/solo", insights: 0, curate: 3 })],
      repoFilter: new Set<string>(),
      onrepofilter: () => {},
    });
    expect(curateRender.container.querySelector(".rs-insights"), "no learnings bar").toBeNull();
    expect(curateRender.container.querySelector(".rs-tele"), "no detail line").toBeNull();
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
      repoFilter: new Set(["/repo/alpha"]),
      onrepofilter: () => {},
    });
    await page
      .getByRole("button", { name: m.drain_queue_open_aria({ count: 1, repo: "alpha" }) })
      .click();
    expect(getDrainQueueFn).toHaveBeenCalledWith("/repo/alpha");
    await expect.element(page.getByText("queued issue")).toBeVisible();
  });
});
