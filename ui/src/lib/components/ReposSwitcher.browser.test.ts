import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { tick } from "svelte";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import BacklogOverlay from "./BacklogOverlay.svelte";
import { m } from "#lib/paraglide/messages.js";
import type { BacklogPayload, BacklogProject } from "#lib/types.js";

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
    ...over,
  };
}

/** alpha..foxtrot; alpha/bravo/charlie/delta carry recent agents (rank: alpha first). */
function payload(over: Partial<BacklogPayload> = {}): BacklogPayload {
  return {
    pinnedPath: "/r/echo",
    projects: [
      project("alpha", { recentAgentCount: 9, openIssues: 42 }),
      project("bravo", { recentAgentCount: 7, openIssues: 5, openPRs: 2 }),
      project("charlie", { recentAgentCount: 5, openIssues: 11 }),
      project("delta", { recentAgentCount: 3, openIssues: 154 }),
      project("echo"),
      project("foxtrot", { hidden: true }),
    ],
    totals: { openIssues: 0, openPRs: 0 },
    ...over,
  };
}

function props(over: Partial<Record<string, unknown>> = {}) {
  return {
    payload: payload(),
    mobile: false,
    onissue: noop,
    onpr: noop,
    onadopt: noop,
    onlaunchtrain: noop,
    onclose: noop,
    onaddclone: noop,
    onaddfork: noop,
    onaddnewproject: noop,
    ...over,
  };
}

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const qa = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];

function key(el: Element, k: string, init: KeyboardEventInit = {}) {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
}

async function openByClick() {
  q<HTMLButtonElement>(".rs-trigger")!.click();
  await tick();
  await vi.waitFor(() => expect(q(".rs-pop:popover-open")).not.toBeNull());
}

const names = (sel: string, nameSel: string) =>
  qa(sel).map((el) => el.querySelector(nameSel)?.textContent?.trim());

beforeEach(async () => {
  await page.viewport(1280, 900);
});

afterEach(async () => {
  document.body.innerHTML = "";
  await page.viewport(1280, 900);
});

describe("Repos header", () => {
  it("names the open repo: owner small above, name below, ▾ and the R hint", async () => {
    await render(BacklogOverlay, props());
    const trigger = q(".rs-trigger")!;
    expect(trigger.querySelector(".rs-owner")?.textContent).toBe("erwins-enkel");
    expect(trigger.querySelector(".rs-name")?.textContent?.trim()).toBe("echo"); // pinned → seeded
    expect(trigger.textContent).toContain("▾");
    expect(trigger.getAttribute("aria-keyshortcuts")).toBe("R");
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    const owner = trigger.querySelector(".rs-owner")!.getBoundingClientRect();
    const name = trigger.querySelector(".rs-name")!.getBoundingClientRect();
    expect(owner.bottom).toBeLessThanOrEqual(name.top + 1);
  });

  it("asks to choose a repo when none is open", async () => {
    await render(BacklogOverlay, props({ payload: payload({ pinnedPath: null }) }));
    expect(q(".rs-trigger .rs-name")?.textContent?.trim()).toBe(m.repos_switcher_choose());
    expect(q(".rs-trigger .rs-owner")).toBeNull();
  });

  it("lists the OTHER recent repos as chips with their issue count and jumps on click", async () => {
    await render(BacklogOverlay, props());
    const chips = qa(".rh-chip");
    expect(chips.map((c) => c.querySelector(".rh-chip-name")?.textContent)).toEqual([
      "alpha",
      "bravo",
      "charlie",
    ]);
    expect(chips[0].querySelector(".rh-chip-count")?.textContent).toBe("42");

    chips[1].click(); // bravo
    await tick();
    expect(q(".rs-trigger .rs-name")?.textContent?.trim()).toBe("bravo");
  });

  it("drops the open repo from the chips (and backfills the next recent)", async () => {
    await render(BacklogOverlay, props({ payload: payload({ pinnedPath: "/r/alpha" }) }));
    expect(names(".rh-chip", ".rh-chip-name")).toEqual(["bravo", "charlie", "delta"]);
  });

  it("puts Fast-forward in the header (not the tab bar) and ✕ at the far right", async () => {
    const onclose = vi.fn();
    await render(BacklogOverlay, props({ onclose }));
    const ff = q(".rh .ff-btn")!;
    expect(ff).not.toBeNull();
    expect(q(".tab-bar .ff-btn")).toBeNull();
    expect((ff as HTMLButtonElement).disabled).toBe(false);
    const close = q(".rh .x")!;
    expect(ff.getBoundingClientRect().right).toBeLessThanOrEqual(
      close.getBoundingClientRect().left + 1,
    );
    close.click();
    expect(onclose).toHaveBeenCalledOnce();
  });

  it("disables Fast-forward with no repo open", async () => {
    await render(BacklogOverlay, props({ payload: payload({ pinnedPath: null }) }));
    expect((q(".rh .ff-btn") as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps Fast-forward and ✕ visible at the 640px modal floor", async () => {
    await page.viewport(700, 800);
    await render(BacklogOverlay, props());
    const card = q(".card")!.getBoundingClientRect();
    for (const sel of [".rh .ff-btn", ".rh .x"]) {
      const r = q(sel)!.getBoundingClientRect();
      expect(r.right, sel).toBeLessThanOrEqual(card.right + 1);
      expect(r.left, sel).toBeGreaterThanOrEqual(card.left);
    }
  });

  it("shows a plain title + ✕ while loading and with no repos", async () => {
    const view = await render(BacklogOverlay, props({ payload: null }));
    expect(q(".rh .rh-title")?.textContent).toBe(m.actionbar_backlog());
    expect(q(".rh .x")).not.toBeNull();
    expect(q(".rs-trigger")).toBeNull();
    await view.rerender(props({ payload: payload({ projects: [], pinnedPath: null }) }));
    expect(q(".rh .rh-title")).not.toBeNull();
    expect(q(".rs-trigger")).toBeNull();
    expect(q(".rh .ff-btn")).toBeNull();
  });

  it("moves Fast-forward nowhere on mobile: it stays in the tab strip", async () => {
    await render(BacklogOverlay, props({ mobile: true }));
    expect(q(".rh")).toBeNull();
    q(".project-row")!.click();
    await tick();
    expect(q(".overlay-tabs .ff-btn")).not.toBeNull();
  });
});

describe("Repo switcher popover", () => {
  it("opens as a non-modal dialog with the search focused", async () => {
    await render(BacklogOverlay, props());
    expect(q(".rs-pop")).toBeNull();
    await openByClick();
    const pop = q(".rs-pop")!;
    expect(pop.getAttribute("role")).toBe("dialog");
    expect(pop.hasAttribute("aria-modal")).toBe(false);
    expect(q(".rs-trigger")!.getAttribute("aria-expanded")).toBe("true");
    await vi.waitFor(() => expect(document.activeElement).toBe(q(".filter-search")));
    // anchored under the trigger (Floating UI positions it a frame later), no scrim
    const t = q(".rs-trigger")!.getBoundingClientRect();
    await vi.waitFor(() =>
      expect(pop.getBoundingClientRect().top).toBeGreaterThanOrEqual(t.bottom),
    );
    expect(q(".scrim")).toBeNull();
  });

  it("shows recent tiles (name + Issues · PRs) and the rest in two columns, no repeats", async () => {
    await render(BacklogOverlay, props());
    await openByClick();
    expect(names(".rs-tile", ".rs-tile-name")).toEqual(["alpha", "bravo", "charlie"]);
    expect(q(".rs-tile .rs-tile-counts")?.textContent?.trim()).toBe(
      m.repos_switcher_tile_counts({ issues: 42, prs: 1 }),
    );
    expect(names(".rs-cols .project-row", ".row-name")).toEqual(["delta", "echo"]);
    const cols = getComputedStyle(q(".rs-cols")!).columnCount;
    expect(cols).toBe("2");
  });

  it("keeps hidden repos, the Hidden toggle, filters and + Add repo", async () => {
    const onaddclone = vi.fn();
    await render(BacklogOverlay, props({ onaddclone }));
    await openByClick();
    expect(q(".hidden-toggle")).not.toBeNull(); // foxtrot is hidden
    expect(q(".project-row.dim")).toBeNull();
    q<HTMLButtonElement>(".hidden-toggle")!.click();
    await tick();
    expect(q(".project-row.dim .row-name")?.textContent?.trim()).toBe("foxtrot");
    expect(q(".repo-filter-trigger")).not.toBeNull();
    expect(q(".rs-foot .add-repo-btn")).not.toBeNull();

    q<HTMLButtonElement>(".add-repo-btn")!.click();
    await tick();
    qa<HTMLButtonElement>(".add-repo-menu .ar-item")
      .find((b) => b.textContent?.includes(m.clonerepo_trigger()))!
      .click();
    await tick();
    expect(onaddclone).toHaveBeenCalledOnce();
    expect(q(".rs-pop")).toBeNull(); // handing off to the modal closes the switcher
  });

  it("filters by the search and opens the top match on ↵", async () => {
    await render(BacklogOverlay, props());
    await openByClick();
    const search = q<HTMLInputElement>(".filter-search")!;
    search.value = "del";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(names(".project-row", ".row-name")).toEqual(["delta"]);

    key(search, "Enter");
    await tick();
    expect(q(".rs-pop")).toBeNull();
    expect(q(".rs-trigger .rs-name")?.textContent?.trim()).toBe("delta");
    expect(document.activeElement).toBe(q(".rs-trigger"));
  });

  it("walks the list with ↑↓ (tiles first, then rows) and returns to the search", async () => {
    await render(BacklogOverlay, props());
    await openByClick();
    const search = q<HTMLInputElement>(".filter-search")!;
    key(search, "ArrowDown");
    const items = qa(".rs-tile, .project-row");
    expect(document.activeElement).toBe(items[0]);
    key(items[0], "ArrowDown");
    expect(document.activeElement).toBe(items[1]);
    key(items[items.length - 1], "ArrowDown"); // clamps at the end
    expect(document.activeElement).toBe(items[items.length - 1]);
    key(items[1], "ArrowUp");
    key(items[0], "ArrowUp");
    expect(document.activeElement).toBe(search);
  });

  it("picks a focused row with ↵ and returns focus to the trigger", async () => {
    await render(BacklogOverlay, props());
    await openByClick();
    key(q(".filter-search")!, "ArrowDown");
    const rows = qa(".project-row");
    rows[0].focus(); // delta
    key(rows[0], "Enter");
    await tick();
    expect(q(".rs-pop")).toBeNull();
    expect(q(".rs-trigger .rs-name")?.textContent?.trim()).toBe("delta");
  });

  it("Esc closes only the popover — the dialog and onclose stay put", async () => {
    const onclose = vi.fn();
    await render(BacklogOverlay, props({ onclose }));
    await openByClick();
    key(q(".filter-search")!, "ArrowDown");
    const e = key(document.activeElement!, "Escape");
    await tick();
    expect(e.defaultPrevented).toBe(true);
    expect(q(".rs-pop")).toBeNull();
    expect(q(".card")).not.toBeNull();
    expect(onclose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(q(".rs-trigger"));

    // …and the next Esc reaches the dialog as before.
    key(q(".rs-trigger")!, "Escape");
    expect(onclose).toHaveBeenCalledOnce();
  });

  it("Esc with text in the search clears it first, then closes", async () => {
    await render(BacklogOverlay, props());
    await openByClick();
    const search = q<HTMLInputElement>(".filter-search")!;
    search.value = "al";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    key(search, "Escape");
    await tick();
    expect(q(".rs-pop")).not.toBeNull();
    expect(search.value).toBe("");
    key(search, "Escape");
    await tick();
    expect(q(".rs-pop")).toBeNull();
  });

  it("Esc inside the open filter popover closes only that popover", async () => {
    const onclose = vi.fn();
    await render(BacklogOverlay, props({ onclose }));
    await openByClick();
    q<HTMLButtonElement>(".repo-filter-trigger")!.click();
    await tick();
    await vi.waitFor(() => expect(q(".filter-popover:popover-open")).not.toBeNull());
    await new Promise((r) => setTimeout(r, 20)); // its Esc listener attaches a tick after open
    const e = key(q(".filter-popover input")!, "Escape");
    await tick();
    // its window-capture listener marks the event handled → switcher + dialog survive
    expect(e.defaultPrevented).toBe(true);
    expect(q(".filter-popover:popover-open")).toBeNull();
    expect(q(".rs-pop")).not.toBeNull();
    expect(q(".card")).not.toBeNull();
    expect(onclose).not.toHaveBeenCalled();
  });

  it("closes on an outside pointerdown but not on one inside", async () => {
    await render(BacklogOverlay, props());
    await openByClick();
    await new Promise((r) => setTimeout(r, 20)); // listener attaches one tick after open
    q(".rs-label")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await tick();
    expect(q(".rs-pop")).not.toBeNull();
    q(".detail-column")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await tick();
    expect(q(".rs-pop")).toBeNull();
  });

  it("toggles from the trigger", async () => {
    await render(BacklogOverlay, props());
    await openByClick();
    q<HTMLButtonElement>(".rs-trigger")!.click();
    await tick();
    expect(q(".rs-pop")).toBeNull();
  });
});

describe("R shortcut", () => {
  it("opens the switcher from the dialog card", async () => {
    await render(BacklogOverlay, props());
    const e = key(q(".card")!, "r");
    await tick();
    expect(e.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(q(".rs-pop:popover-open")).not.toBeNull());
  });

  it("accepts a capital R and a focused non-text control", async () => {
    await render(BacklogOverlay, props());
    key(q(".tab-btn")!, "R");
    await tick();
    expect(q(".rs-pop")).not.toBeNull();
  });

  it("never fires while typing, with a modifier, on repeat, or already handled", async () => {
    await render(BacklogOverlay, props());
    await openByClick();
    const search = q<HTMLInputElement>(".filter-search")!;
    expect(key(search, "r").defaultPrevented).toBe(false); // typing "r" in the search
    key(q(".rs-trigger")!, "Escape");
    await tick();
    expect(q(".rs-pop")).toBeNull();

    for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { repeat: true }]) {
      key(q(".card")!, "r", init);
      await tick();
      expect(q(".rs-pop"), JSON.stringify(init)).toBeNull();
    }
  });

  it("does nothing on mobile or with no repos", async () => {
    const view = await render(BacklogOverlay, props({ payload: payload({ projects: [] }) }));
    key(q(".card")!, "r");
    await tick();
    expect(q(".rs-pop")).toBeNull();
    await view.rerender(props({ mobile: true }));
    key(q(".card")!, "r");
    await tick();
    expect(q(".rs-pop")).toBeNull();
  });

  it("stays on the card: a key aimed at another overlay never opens it", async () => {
    await render(BacklogOverlay, props());
    key(document.body, "r");
    await tick();
    expect(q(".rs-pop")).toBeNull();
  });
});
