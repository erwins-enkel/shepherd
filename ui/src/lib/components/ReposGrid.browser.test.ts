import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { tick } from "svelte";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import ReposGrid from "./ReposGrid.svelte";
import { m } from "#lib/paraglide/messages.js";
import type { BacklogProject, DrainStatus } from "#lib/types.js";

const noop = () => {};

function project(name: string, over: Partial<BacklogProject> = {}): BacklogProject {
  return {
    path: `/r/${name}`,
    display: `erwins-enkel/${name}`,
    slug: `erwins-enkel/${name}`,
    kind: "github",
    openIssues: 3,
    openPRs: 1,
    prKinds: null,
    workflows: null,
    ciStatus: null,
    hidden: false,
    pinned: false,
    defaultBranch: "main",
    ...over,
  };
}

/** alpha/bravo carry recent agents (→ big tiles); the rest are "All repos". */
function projects(): BacklogProject[] {
  return [
    project("alpha", {
      recentAgentCount: 9,
      openIssues: 42,
      prKinds: { release: 0, dependabot: 0, regular: 1 },
      workflows: 2,
    }),
    project("bravo", { recentAgentCount: 7, openIssues: 5, openPRs: 2 }),
    project("charlie", { openIssues: 11 }),
    project("delta", { openIssues: 154 }),
    project("echo", { openIssues: null }),
    project("foxtrot", { openIssues: 20 }),
  ];
}

function drainOf(over: Partial<DrainStatus> = {}): DrainStatus {
  return {
    repoPath: "/r/alpha",
    enabled: true,
    paused: false,
    reason: null,
    detail: null,
    queued: 0,
    inFlight: 1,
    max: 3,
    epicParent: 158,
    runSummary: {
      leadingEpic: 158,
      windingDown: [],
      slots: { used: 1, max: 3, holders: [] },
      next: [],
      after: [],
    },
    ...over,
  };
}

function props(over: Partial<Record<string, unknown>> = {}) {
  return {
    projects: projects(),
    onselect: noop,
    onaddclone: noop,
    onaddfork: noop,
    onaddnewproject: noop,
    ...over,
  };
}

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const qa = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
const names = (sel: string) =>
  qa(sel).map((el) => el.querySelector(".rg-name")?.textContent?.trim());

function key(el: Element, k: string, init: KeyboardEventInit = {}) {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
}

async function type(value: string) {
  const search = q<HTMLInputElement>(".rg-search")!;
  search.value = value;
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
}

beforeEach(async () => {
  await page.viewport(1280, 900);
});

afterEach(async () => {
  document.body.innerHTML = "";
});

describe("ReposGrid tiles", () => {
  it("puts pinned repos in a Pinned group of big tiles above Recently edited", async () => {
    const ps = projects().map((p) => (p.path === "/r/delta" ? { ...p, pinned: true } : p));
    await render(ReposGrid, props({ projects: ps }));
    const labels = qa(".rg-label").map((l) => l.textContent?.trim());
    expect(labels.slice(0, 2)).toEqual([m.backlog_pinned_heading(), m.repos_grid_recent()]);
    expect(names(".rg-tile-big")).toEqual(["delta", "alpha", "bravo"]);
    expect(names(".rg-tile-small")).not.toContain("delta");
  });

  it("every tile carries the repo mark, never ▣", async () => {
    await render(ReposGrid, props());
    expect(qa(".rg-tile").every((t) => t.querySelector(".repo-mark"))).toBe(true);
    expect(q(".rg")!.textContent).not.toContain("▣");
  });

  it("shows recent repos as big tiles and the rest as compact ones", async () => {
    await render(ReposGrid, props());
    expect(names(".rg-tile-big")).toEqual(["alpha", "bravo"]);
    // Sorted by open issues (default): 154, 42-less rest … unknown (echo) last.
    expect(names(".rg-tile-small")).toEqual(["delta", "foxtrot", "charlie", "echo"]);
    expect(qa(".rg-label").map((l) => l.textContent)).toEqual([
      m.repos_grid_recent(),
      m.repos_switcher_all(),
    ]);
  });

  it("a big tile carries owner, counts and — with workflows — the Actions count", async () => {
    await render(ReposGrid, props());
    const [alpha, bravo] = qa(".rg-tile-big");
    expect(alpha.querySelector(".rg-owner")?.textContent).toBe("erwins-enkel");
    expect(alpha.querySelector(".rg-counts")?.textContent).toBe(
      m.repos_grid_counts_actions({ issues: 42, prs: 1, actions: 2 }),
    );
    // No workflows (non-GitHub / unknown): no Actions segment.
    expect(bravo.querySelector(".rg-counts")?.textContent).toBe(
      m.repos_switcher_tile_counts({ issues: 5, prs: 2 }),
    );
  });

  it("a big tile says what the drain is doing: leading epic and agents", async () => {
    await render(ReposGrid, props({ drain: { "/r/alpha": drainOf() } }));
    const [alpha, bravo] = qa(".rg-tile-big");
    expect(alpha.querySelector(".rg-run")?.textContent).toContain(
      `${m.repooverview_leading_only({ epic: 158 })} · ${m.drain_inflight({ count: 1, max: 3 })}`,
    );
    expect(bravo.querySelector(".rg-run")).toBeNull();
  });

  it("a paused drain shows its reason on the tile", async () => {
    const d = drainOf({ paused: true, reason: "credits" });
    await render(ReposGrid, props({ drain: { "/r/alpha": d } }));
    const run = q(".rg-tile-big .rg-run")!;
    expect(run.classList.contains("paused")).toBe(true);
    expect(run.textContent).toContain(m.drain_paused_credits());
  });

  it("compact tiles scale the size bar to the largest repo", async () => {
    await render(ReposGrid, props());
    const widths = Object.fromEntries(
      qa(".rg-tile-small").map((t) => [
        t.querySelector(".rg-name")!.textContent!.trim(),
        (t.querySelector(".rg-size-fill") as HTMLElement).style.width,
      ]),
    );
    expect(widths.delta).toBe("100%");
    expect(parseFloat(widths.foxtrot)).toBeCloseTo((20 / 154) * 100, 1);
    expect(widths.echo).toBe("0%");
  });

  it("sorts 'All repos' by name on request", async () => {
    await render(ReposGrid, props());
    const select = q<HTMLSelectElement>(".rg-sort")!;
    select.value = "name";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    expect(names(".rg-tile-small")).toEqual(["charlie", "delta", "echo", "foxtrot"]);
    // The recents keep their ranking.
    expect(names(".rg-tile-big")).toEqual(["alpha", "bravo"]);
  });

  it("opens the clicked repo", async () => {
    const onselect = vi.fn();
    await render(ReposGrid, props({ onselect }));
    qa(".rg-tile-small")[0].click();
    expect(onselect).toHaveBeenCalledWith("/r/delta");
  });

  it("names the dashboard-filter scope when the parent narrowed the grid", async () => {
    const { rerender } = await render(ReposGrid, props());
    expect(q(".rg-badge")).toBeNull();
    await rerender(props({ filteredCount: 2 }));
    expect(q(".rg-badge")?.textContent).toBe(m.repos_grid_filtered({ count: 2 }));
  });
});

describe("ReposGrid typography", () => {
  // #3597: the grid, its tiles and search read in the body face; repo names and owners stay mono.
  it("sets tiles and search in the body face and keeps repo names and owners mono", async () => {
    render(ReposGrid, props());
    await expect.poll(() => q(".rg-tile-big .rg-owner")).not.toBeNull();

    const family = (el: Element) => getComputedStyle(el).fontFamily;
    const sans = getComputedStyle(document.body).fontFamily;
    const probe = document.body.appendChild(document.createElement("span"));
    probe.style.fontFamily = "var(--font-mono)";
    const mono = getComputedStyle(probe).fontFamily;
    probe.remove();
    expect(sans).not.toBe(mono);

    for (const sel of [".rg", ".rg-search", ".rg-tile-big", ".rg-tile-big .rg-counts"]) {
      expect(family(q(sel)!), sel).toBe(sans);
    }
    for (const sel of [".rg-tile-big .rg-name", ".rg-tile-big .rg-owner"]) {
      expect(family(q(sel)!), sel).toBe(mono);
    }
  });
});

describe("ReposGrid search", () => {
  it("filters by name and drops the recents group while searching", async () => {
    await render(ReposGrid, props());
    await type("lph");
    expect(q(".rg-tile-big")).toBeNull();
    expect(names(".rg-tile-small")).toEqual(["alpha"]);
    expect(qa(".rg-label").map((l) => l.textContent)).toEqual([m.repos_switcher_all()]);
  });

  it("says so when nothing matches", async () => {
    await render(ReposGrid, props());
    await type("zzz");
    expect(q(".rg-empty")?.textContent).toBe(m.backlog_filter_none_match());
    expect(qa(".rg-tile")).toHaveLength(0);
  });

  it("does not take focus outside a dialog (the empty-herd panel must keep page shortcuts)", async () => {
    await render(ReposGrid, props());
    await tick();
    expect(document.activeElement).not.toBe(q(".rg-search"));
  });
});

describe("ReposGrid keyboard", () => {
  it("↵ in the search opens the top match", async () => {
    const onselect = vi.fn();
    await render(ReposGrid, props({ onselect }));
    await type("brav");
    key(q(".rg-search")!, "Enter");
    expect(onselect).toHaveBeenCalledWith("/r/bravo");
  });

  it("↓ in the search steps into the first tile", async () => {
    await render(ReposGrid, props());
    key(q(".rg-search")!, "ArrowDown");
    expect(document.activeElement).toBe(qa(".rg-tile")[0]);
  });

  it("←/→ walk the tiles in order and clamp at the ends", async () => {
    await render(ReposGrid, props());
    const tiles = qa(".rg-tile");
    tiles[0].focus();
    key(tiles[0], "ArrowRight");
    expect(document.activeElement).toBe(tiles[1]);
    key(tiles[1], "ArrowLeft");
    key(tiles[0], "ArrowLeft");
    expect(document.activeElement).toBe(tiles[0]);
    tiles.at(-1)!.focus();
    key(tiles.at(-1)!, "ArrowRight");
    expect(document.activeElement).toBe(tiles.at(-1));
  });

  it("↓/↑ move between rows by position; ↑ from the first row returns to the search", async () => {
    await render(ReposGrid, props());
    const tiles = qa(".rg-tile");
    const big = qa(".rg-tile-big");
    // From the first big tile, ↓ lands in the compact grid below, then ↑ returns.
    big[0].focus();
    key(big[0], "ArrowDown");
    const landed = document.activeElement as HTMLElement;
    expect(landed.classList.contains("rg-tile-small")).toBe(true);
    key(landed, "ArrowUp");
    expect(big).toContain(document.activeElement as HTMLElement);
    key(document.activeElement!, "ArrowUp");
    expect(document.activeElement).toBe(q(".rg-search"));
    expect(tiles.length).toBe(6);
  });

  it("Esc clears search text without closing the dialog, then falls through when empty", async () => {
    await render(ReposGrid, props());
    await type("alp");
    const search = q<HTMLInputElement>(".rg-search")!;
    const first = key(search, "Escape");
    expect(first.defaultPrevented).toBe(true);
    await tick();
    expect(search.value).toBe("");
    const second = key(search, "Escape");
    expect(second.defaultPrevented).toBe(false); // the dialog card closes on this one
  });

  it("↵ on a focused tile opens it (native button)", async () => {
    const onselect = vi.fn();
    await render(ReposGrid, props({ onselect }));
    const tile = qa(".rg-tile")[1];
    tile.focus();
    tile.click(); // ↵ on a <button> is a click
    expect(onselect).toHaveBeenCalledWith("/r/bravo");
  });
});

it("shows claim diagnostics on an idle repo with no running agents", async () => {
  await render(
    ReposGrid,
    props({
      drain: {
        "/r/alpha": drainOf({
          inFlight: 0,
          epicParent: null,
          runSummary: undefined,
          claimDiagnostics: [
            {
              number: 133,
              title: "claim",
              url: "https://github.com/o/r/issues/133",
              ownership: "unknown",
              evidence: "complete",
              mergedPrs: [],
            },
          ],
        }),
      },
    }),
  );
  await expect
    .element(page.getByRole("button", { name: m.drain_claims_status(), exact: false }))
    .toBeVisible();
});

it("keeps a blocked-session reason ahead of claim diagnostics", async () => {
  await render(
    ReposGrid,
    props({
      drain: {
        "/r/alpha": drainOf({
          paused: true,
          reason: "blocked",
          detail: "TASK-1",
          claimDiagnosticsFailed: true,
        }),
      },
    }),
  );
  await expect
    .element(
      page.getByRole("button", { name: m.drain_paused_blocked({ desig: "TASK-1" }), exact: false }),
    )
    .toBeVisible();
});

describe("ReposGrid no-PR-CI hold (#3305)", () => {
  const held = () =>
    projects().map((p) =>
      p.path === "/r/alpha" || p.path === "/r/charlie" ? { ...p, noPrCiHold: true } : p,
    );

  it("flags held repos on big and small tiles only", async () => {
    await render(ReposGrid, props({ projects: held() }));
    const holdOf = (name: string) =>
      qa(".rg-tile").find((t) => t.querySelector(".rg-name")?.textContent?.trim() === name);
    expect(holdOf("alpha")!.querySelector(".rg-hold")?.textContent).toContain(
      m.repos_grid_no_pr_ci(),
    );
    expect(holdOf("charlie")!.querySelector(".rg-hold-mark")).not.toBeNull();
    expect(holdOf("bravo")!.querySelector(".rg-hold, .rg-hold-mark")).toBeNull();
    expect(holdOf("delta")!.querySelector(".rg-hold, .rg-hold-mark")).toBeNull();
  });

  it("narrows the grid to held repos with the bar's toggle", async () => {
    await render(ReposGrid, props({ projects: held() }));
    const toggle = page.getByRole("button", { name: m.repos_grid_no_pr_ci_filter({ count: 2 }) });
    await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
    (toggle.element() as HTMLButtonElement).click();
    await tick();
    await expect.element(toggle).toHaveAttribute("aria-pressed", "true");
    expect(names(".rg-tile").sort()).toEqual(["alpha", "charlie"]);
  });

  it("shows no toggle when no repo is held", async () => {
    await render(ReposGrid, props());
    expect(q(".rg-hold-filter")).toBeNull();
  });
});
