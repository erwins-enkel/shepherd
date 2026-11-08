import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { flushSync, mount, unmount, tick } from "svelte";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import CardMenu from "./CardMenu.svelte";
import CardMenuSpreadHarness from "./CardMenuSpreadHarness.test.svelte";
import { m } from "#lib/paraglide/messages.js";

// A real, connected opener: the menu measures its rect for positioning and
// restores focus to it on close.
let opener: HTMLButtonElement;
beforeEach(() => {
  opener = document.createElement("button");
  opener.textContent = "opener";
  document.body.appendChild(opener);
});
afterEach(() => {
  opener.remove();
  document.body.innerHTML = "";
});

const base = (extra: Record<string, unknown> = {}) => ({
  x: 10,
  y: 10,
  resumable: false,
  opener,
  onclose: vi.fn(),
  ...extra,
});

describe("CardMenu shelve action", () => {
  it("labels by state and fires onshelve in one click", async () => {
    const onshelve = vi.fn();
    const { rerender } = await render(CardMenu, { props: base() });
    expect(page.getByRole("menuitem", { name: m.cardmenu_shelve() }).query()).toBeNull();

    await rerender(base({ onshelve }));
    await page.getByRole("menuitem", { name: m.cardmenu_shelve() }).click();
    expect(onshelve).toHaveBeenCalledOnce();

    await rerender(base({ onshelve, shelved: true }));
    await expect
      .element(page.getByRole("menuitem", { name: m.cardmenu_unshelve() }))
      .toBeInTheDocument();
  });
});

describe("CardMenu repo group (#3443)", () => {
  it("sets the clean terminal and Repo settings apart under Repo · <name>, last", async () => {
    const onreposettings = vi.fn();
    await render(CardMenu, {
      props: base({
        onshelve: vi.fn(),
        oncleanTerminal: vi.fn(),
        onreposettings,
        repoName: "murmur",
      }),
    });
    const group = page.getByRole("group", { name: m.cardmenu_repo_group({ repo: "murmur" }) });
    await expect.element(group).toBeVisible();
    const names = [...group.element().querySelectorAll(".cm-item")].map((b) => b.textContent);
    expect(names).toEqual([
      expect.stringContaining(m.cardmenu_clean_terminal()),
      expect.stringContaining(m.reposettings_menu_open()),
    ]);
    // the session's own actions stay above the separator
    const menu = document.querySelector(".card-menu")!;
    expect(menu.querySelector('[role="separator"]')).not.toBeNull();
    expect(menu.lastElementChild).toBe(group.element());
    await group.getByRole("menuitem", { name: m.reposettings_menu_open() }).click();
    expect(onreposettings).toHaveBeenCalledOnce();
  });

  it("shows no group without a repo action", async () => {
    await render(CardMenu, { props: base({ onshelve: vi.fn() }) });
    expect(document.querySelector(".cm-group")).toBeNull();
    expect(document.querySelector('[role="separator"]')).toBeNull();
  });
});

describe("CardMenu relaunch action", () => {
  it("renders the Relaunch item only when onrelaunch is provided", async () => {
    const { rerender } = await render(CardMenu, { props: base() });
    expect(document.querySelector(".card-menu")).not.toBeNull();
    // no onrelaunch → no Relaunch item
    expect(page.getByRole("menuitem", { name: m.cardmenu_relaunch() }).query()).toBeNull();

    await rerender(base({ onrelaunch: vi.fn() }));
    await expect
      .element(page.getByRole("menuitem", { name: m.cardmenu_relaunch() }))
      .toBeInTheDocument();
  });

  it("a single click arms (does NOT fire onrelaunch) and a second click fires it once", async () => {
    const onrelaunch = vi.fn();
    render(CardMenu, { props: base({ onrelaunch }) });

    const item = page.getByRole("menuitem", { name: m.cardmenu_relaunch() });
    await item.click();

    // armed: label switched to the confirm text, callback NOT yet fired
    expect(onrelaunch).not.toHaveBeenCalled();
    const confirm = page.getByRole("menuitem", { name: m.cardmenu_relaunch_confirm() });
    await expect.element(confirm).toBeInTheDocument();
    // the armed item gains the danger-wash class so the second click is obviously hot
    await expect.element(confirm).toHaveClass(/\barmed\b/);

    // second click within the window fires it exactly once
    await confirm.click();
    expect(onrelaunch).toHaveBeenCalledTimes(1);
  });

  it("auto-disarms after the arm window without firing onrelaunch", async () => {
    vi.useFakeTimers();
    try {
      const onrelaunch = vi.fn();
      render(CardMenu, { props: base({ onrelaunch }) });

      const item = page.getByRole("menuitem", { name: m.cardmenu_relaunch() });
      await item.click();
      await expect
        .element(page.getByRole("menuitem", { name: m.cardmenu_relaunch_confirm() }))
        .toBeInTheDocument();

      // past the ~3s arm window → disarms back to the idle label (and drops the
      // armed danger-wash), no fire
      vi.advanceTimersByTime(3500);
      const idle = page.getByRole("menuitem", { name: m.cardmenu_relaunch() });
      await expect.element(idle).toBeInTheDocument();
      await expect.element(idle).not.toHaveClass(/\barmed\b/);
      expect(onrelaunch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CardMenu mark-ready action", () => {
  it("renders a checkbox item by `ready` and fires onready in one click", async () => {
    const onready = vi.fn();
    const { rerender } = await render(CardMenu, { props: base() });
    const item = () => page.getByRole("menuitemcheckbox", { name: m.prrow_menu_mark_ready() });
    expect(item().query()).toBeNull();

    await rerender(base({ onready }));
    await expect.element(item()).toHaveAttribute("aria-checked", "false");
    await item().click();
    expect(onready).toHaveBeenCalledOnce();

    await rerender(base({ onready, ready: true }));
    await expect.element(item()).toHaveAttribute("aria-checked", "true");
  });
});

describe("CardMenu merge action", () => {
  it("renders the Merge PR item only when onmergepr is provided", async () => {
    const { rerender } = await render(CardMenu, { props: base() });
    // no onmergepr → no Merge PR item
    expect(page.getByRole("menuitem", { name: m.prbadge_merge() }).query()).toBeNull();

    await rerender(base({ onmergepr: vi.fn() }));
    await expect
      .element(page.getByRole("menuitem", { name: m.prbadge_merge() }))
      .toBeInTheDocument();
  });

  it("a single click fires onmergepr once — the confirmation lives in the merge dialog", async () => {
    // The two-step arm this item used to carry was answerable by one double-click (#2299), so the
    // item now only OPENS the merge confirmation, where the deliberate answer is given.
    const onmergepr = vi.fn();
    render(CardMenu, { props: base({ onmergepr }) });

    await page.getByRole("menuitem", { name: m.prbadge_merge() }).click();
    expect(onmergepr).toHaveBeenCalledTimes(1);
  });
});

describe("CardMenu stop action", () => {
  it("renders the Stop agent item only when onstop is provided", async () => {
    const { rerender } = await render(CardMenu, { props: base() });
    // no onstop → no Stop item (a non-working session never offers it)
    expect(page.getByRole("menuitem", { name: m.cardmenu_stop() }).query()).toBeNull();

    await rerender(base({ onstop: vi.fn() }));
    await expect
      .element(page.getByRole("menuitem", { name: m.cardmenu_stop() }))
      .toBeInTheDocument();
  });

  it("fires onstop on the FIRST click (no two-step arm) and takes no danger/armed wash", async () => {
    const onstop = vi.fn();
    render(CardMenu, { props: base({ onstop }) });

    const item = page.getByRole("menuitem", { name: m.cardmenu_stop() });
    // it must not read as the fleet e-stop: no armed wash, no danger colour
    await expect.element(item).not.toHaveClass(/\barmed\b/);
    await expect.element(item).not.toHaveClass(/\bdanger\b/);

    await item.click();
    expect(onstop).toHaveBeenCalledTimes(1);
  });
});

describe("CardMenu amend action (#2225)", () => {
  it("renders the Amend item only when onamend is provided", async () => {
    const { rerender } = await render(CardMenu, { props: base() });
    expect(page.getByRole("menuitem", { name: m.cardmenu_amend() }).query()).toBeNull();

    await rerender(base({ onamend: vi.fn() }));
    await expect
      .element(page.getByRole("menuitem", { name: m.cardmenu_amend() }))
      .toBeInTheDocument();
  });

  it("fires onamend on a SINGLE click — the dialog's own submit is the confirmation", async () => {
    const onamend = vi.fn();
    render(CardMenu, { props: base({ onamend }) });
    await page.getByRole("menuitem", { name: m.cardmenu_amend() }).click();
    expect(onamend).toHaveBeenCalledTimes(1);
  });
});

describe("CardMenu bring-back action", () => {
  it("renders Bring back only when onbringback is provided", async () => {
    const { rerender } = await render(CardMenu, { props: base() });
    expect(page.getByRole("menuitem", { name: m.donerecap_bringback() }).query()).toBeNull();

    await rerender(base({ onbringback: vi.fn() }));
    await expect
      .element(page.getByRole("menuitem", { name: m.donerecap_bringback() }))
      .toBeInTheDocument();
  });

  it("first click arms, second click fires onbringback once", async () => {
    const onbringback = vi.fn();
    render(CardMenu, { props: base({ onbringback }) });

    await page.getByRole("menuitem", { name: m.donerecap_bringback() }).click();
    expect(onbringback).not.toHaveBeenCalled();
    const confirm = page.getByRole("menuitem", { name: m.donerecap_bringback_confirm() });
    await expect.element(confirm).toHaveClass(/\barmed\b/);

    await confirm.click();
    expect(onbringback).toHaveBeenCalledTimes(1);
  });
});

describe("CardMenu ask-the-assistant action (#1446)", () => {
  it("renders Ask the assistant only when onaskassistant is provided", async () => {
    const { rerender } = await render(CardMenu, { props: base() });
    expect(page.getByRole("menuitem", { name: m.operator_assistant_ask() }).query()).toBeNull();

    await rerender(base({ onaskassistant: vi.fn() }));
    await expect
      .element(page.getByRole("menuitem", { name: m.operator_assistant_ask() }))
      .toBeInTheDocument();
  });

  it("fires onaskassistant on a SINGLE click — nothing is sent until the operator sends it", async () => {
    const onaskassistant = vi.fn();
    render(CardMenu, { props: base({ onaskassistant }) });
    await page.getByRole("menuitem", { name: m.operator_assistant_ask() }).click();
    expect(onaskassistant).toHaveBeenCalledTimes(1);
  });
});

// Regression: a long-press near the right edge opened the menu squeezed (labels wrapped,
// so it measured too narrow), then every session poll re-ran the clamp through UnitRow's
// `{...menuActions}` spread and hopped it further left — a moving target — and yanked
// keyboard focus back to the first item.
describe("CardMenu placement stability", () => {
  const nearRight = () => ({ x: window.innerWidth - 20, y: 40 });
  const menu = () => document.querySelector<HTMLElement>(".card-menu")!;
  const place = () => ({ left: menu().style.left, top: menu().style.top });

  function mountHarness() {
    const target = document.createElement("div");
    document.body.append(target);
    const harness = mount(CardMenuSpreadHarness, { target, props: nearRight() }) as unknown as {
      refresh(): void;
    };
    flushSync();
    return { harness, cleanup: () => void unmount(harness) };
  }

  it("opens near the right edge at its natural width, fully inside the viewport", async () => {
    render(CardMenu, {
      props: base({ ...nearRight(), onrelaunchElsewhere: vi.fn(), oncleanTerminal: vi.fn() }),
    });
    await tick();
    const r = menu().getBoundingClientRect();
    expect(r.right).toBeLessThanOrEqual(window.innerWidth - 8);
    // no label wraps: every row is as tall as a single-line row
    const heights = Array.from(menu().querySelectorAll<HTMLElement>(".cm-item")).map(
      (b) => b.getBoundingClientRect().height,
    );
    expect(Math.max(...heights)).toBeLessThanOrEqual(Math.min(...heights) + 1);
  });

  it("does not move when the spread actions object is replaced (a session poll)", async () => {
    const { harness, cleanup } = mountHarness();
    try {
      await tick();
      const before = place();
      for (let i = 0; i < 3; i++) {
        harness.refresh();
        flushSync();
        await tick();
      }
      expect(place()).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("keeps keyboard focus where the operator put it across a session poll", async () => {
    const { harness, cleanup } = mountHarness();
    try {
      await tick();
      const third = menu().querySelectorAll<HTMLButtonElement>(".cm-item")[2]!;
      third.focus();
      harness.refresh();
      flushSync();
      await tick();
      expect(document.activeElement).toBe(third);
    } finally {
      cleanup();
    }
  });
});
