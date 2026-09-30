import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import EpicSupersedeDialog from "./EpicSupersedeDialog.svelte";
import type { DrainRunSummary, Epic, EpicChild } from "$lib/types";
import { m } from "$lib/paraglide/messages";

const api = vi.hoisted(() => ({ getEpic: vi.fn() }));

vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return { ...actual, ...api };
});

// Epic A (#10) leads /repo/shop; its child #11 holds the only slot. The operator starts B (#20).
const A = 10;
const B = 20;

function child(number: number, state: EpicChild["state"]): EpicChild {
  return {
    number,
    title: `c${number}`,
    url: "u",
    order: number,
    body: "",
    blockedBy: [],
    state,
    sessionId: null,
    prNumber: null,
    issueClosed: false,
    claimed: false,
  };
}

const leaderEpic: Epic = {
  repoPath: "/repo/shop",
  parentIssueNumber: A,
  parentTitle: "Checkout rework",
  source: "native",
  children: [child(11, "running"), child(12, "ready"), child(13, "blocked"), child(14, "merged")],
  warnings: [],
  run: { repoPath: "/repo/shop", parentIssueNumber: A, mode: "auto", status: "running" },
};

const summary: DrainRunSummary = {
  leadingEpic: A,
  windingDown: [],
  slots: {
    used: 1,
    max: 1,
    holders: [{ sessionId: "s-11", desig: "TASK-11", issueNumber: 11, epicParent: A }],
  },
  next: [12],
  after: [],
};

function props(over: Record<string, unknown> = {}) {
  return {
    repoPath: "/repo/shop",
    parent: B,
    leader: A,
    summary,
    onconfirm: vi.fn(),
    onclose: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  api.getEpic.mockReset();
});

describe("EpicSupersedeDialog (#2623)", () => {
  it("shows the leader's state and what superseding it does", async () => {
    api.getEpic.mockResolvedValue(leaderEpic);
    render(EpicSupersedeDialog, props());

    await expect
      .element(page.getByRole("dialog", { name: m.epic_supersede_title({ epic: B }) }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(m.epic_supersede_intro({ leader: A, repo: "shop" })))
      .toBeInTheDocument();
    await expect.element(page.getByText("Checkout rework")).toBeInTheDocument();
    await expect
      .element(page.getByText(m.epic_progress({ merged: 1, total: 4 })))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(m.epic_slot_held({ index: 1, max: 1 }), { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(m.epic_supersede_unstarted({ count: 2 })))
      .toBeInTheDocument();
    await expect.element(page.getByText(m.epic_supersede_stops({ leader: A }))).toBeInTheDocument();
    await expect
      .element(page.getByText(m.epic_supersede_finishes({ inflight: "#11" })))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(m.epic_supersede_left_behind({ count: 2, list: "#12, #13" })))
      .toBeInTheDocument();
    expect(api.getEpic).toHaveBeenCalledWith("/repo/shop", A);
  });

  it("blurs what's behind it", async () => {
    api.getEpic.mockResolvedValue(leaderEpic);
    render(EpicSupersedeDialog, props());
    await expect.element(page.getByRole("dialog")).toBeInTheDocument();
    const overlay = document.querySelector<HTMLElement>(".overlay")!;
    expect(getComputedStyle(overlay).backdropFilter).toContain("blur");
  });

  it("Supersede confirms, Cancel and Escape close", async () => {
    api.getEpic.mockResolvedValue(leaderEpic);
    const p = props();
    render(EpicSupersedeDialog, p);

    await page.getByRole("button", { name: m.common_cancel() }).click();
    expect(p.onclose).toHaveBeenCalledTimes(1);
    page
      .getByRole("dialog")
      .element()
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(p.onclose).toHaveBeenCalledTimes(2);
    expect(p.onconfirm).not.toHaveBeenCalled();
    await page.getByRole("button", { name: m.epic_supersede_confirm() }).click();
    expect(p.onconfirm).toHaveBeenCalledTimes(1);
  });

  it("'Change agent slots' closes and opens the automation settings", async () => {
    api.getEpic.mockResolvedValue(leaderEpic);
    const onopenautomation = vi.fn();
    const p = props({ onopenautomation });
    render(EpicSupersedeDialog, p);

    await page.getByRole("button", { name: m.epic_supersede_slots() }).click();
    expect(p.onclose).toHaveBeenCalled();
    expect(onopenautomation).toHaveBeenCalled();
  });

  it("hides the slots link without a host route", async () => {
    api.getEpic.mockResolvedValue(leaderEpic);
    render(EpicSupersedeDialog, props());
    await expect.element(page.getByRole("dialog")).toBeInTheDocument();
    expect(page.getByRole("button", { name: m.epic_supersede_slots() }).query()).toBeNull();
  });

  it("a failed fetch still names the slot holder and offers Supersede", async () => {
    api.getEpic.mockRejectedValue(new Error("boom"));
    const p = props();
    render(EpicSupersedeDialog, p);

    await expect
      .element(page.getByText(m.epic_supersede_finishes({ inflight: "#11" })))
      .toBeInTheDocument();
    expect(page.getByText(m.common_loading()).query()).toBeNull();
    expect(page.getByText(m.epic_supersede_unstarted({ count: 2 })).query()).toBeNull();
    await page.getByRole("button", { name: m.epic_supersede_confirm() }).click();
    expect(p.onconfirm).toHaveBeenCalled();
  });
});
