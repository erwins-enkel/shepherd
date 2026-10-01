import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import EpicFlowGraph from "./EpicFlowGraph.svelte";
import type { Epic, EpicChild, Session } from "$lib/types";
import { m } from "$lib/paraglide/messages";

function child(number: number, blockedBy: number[], state: EpicChild["state"]): EpicChild {
  return {
    number,
    title: `Task ${number}`,
    url: "u",
    order: number,
    body: "",
    blockedBy,
    state,
    sessionId: null,
    prNumber: null,
    issueClosed: false,
    claimed: false,
  };
}

function epic(children: EpicChild[], over: Partial<Epic> = {}): Epic {
  return {
    repoPath: "/r",
    parentIssueNumber: 150,
    parentTitle: "Epic",
    source: "native",
    children,
    warnings: [],
    run: { repoPath: "/r", parentIssueNumber: 150, mode: "auto", status: "idle" },
    ...over,
  };
}

// The issue's acceptance example (#2621).
const EXAMPLE = [
  child(152, [], "merged"),
  child(153, [152], "running"),
  child(154, [153], "blocked"),
  child(155, [153], "blocked"),
  child(156, [155], "blocked"),
  child(157, [153], "blocked"),
  child(158, [153], "blocked"),
];

const group = (name: string) => page.getByRole("group", { name });

describe("EpicFlowGraph", () => {
  beforeEach(async () => {
    await page.viewport(1100, 800);
  });

  it("lays the example out in four stages, the third parallel, and names it in the hint", async () => {
    render(EpicFlowGraph, { epic: epic(EXAMPLE) });

    await expect.element(group(m.epicflow_stage_first())).toBeInTheDocument();
    await expect.element(group("2")).toBeInTheDocument();
    await expect.element(group(m.epicflow_stage_parallel({ stage: 3 }))).toBeInTheDocument();
    await expect.element(group("4")).toBeInTheDocument();
    expect(page.getByRole("group").all()).toHaveLength(4);

    const third = group(m.epicflow_stage_parallel({ stage: 3 }));
    expect(third.getByRole("button").all()).toHaveLength(4);
    await expect.element(page.getByText(/stage 3/)).toBeInTheDocument();
    await expect.element(page.getByText(m.epicflow_merged({ merged: 1, total: 7 }))).toBeVisible();
    expect(document.querySelectorAll(".edges path")).toHaveLength(6);
  });

  it("a node click selects that child", async () => {
    const onselect = vi.fn();
    render(EpicFlowGraph, { epic: epic(EXAMPLE), onselect });

    await page.getByRole("button", { name: /#155/ }).click();
    expect(onselect).toHaveBeenCalledWith(155);
  });

  it("shows the four legend groups", async () => {
    render(EpicFlowGraph, { epic: epic(EXAMPLE) });
    const legend = page.getByRole("list", { name: m.epicflow_legend() });
    for (const label of [
      m.epicflow_legend_ready(),
      m.epicflow_legend_active(),
      m.epicflow_legend_waiting(),
      m.epicflow_legend_merged(),
    ]) {
      await expect.element(legend.getByText(label, { exact: true })).toBeVisible();
    }
  });

  it("without dependency edges renders a list with a hint instead of stages", async () => {
    const children = [child(1, [], "ready"), child(2, [], "ready"), child(3, [], "ready")];
    render(EpicFlowGraph, { epic: epic(children, { noDependencyEdges: true }) });

    await expect.element(page.getByText(m.epicflow_no_deps())).toBeVisible();
    expect(page.getByRole("group").all()).toHaveLength(0);
    expect(page.getByRole("button", { name: /^#\d+/ }).all()).toHaveLength(3);
    expect(document.querySelector(".edges")).toBeNull();
    // Everything is parallel already — no slot hint on top of the no-deps hint.
    expect(page.getByText(/stage 1/).all()).toHaveLength(0);
  });

  it("stacks the stages as a list on a narrow width", async () => {
    await page.viewport(360, 700);
    render(EpicFlowGraph, { epic: epic(EXAMPLE) });

    await expect
      .element(page.getByText(m.epicflow_stage_parallel({ stage: 3 }), { exact: true }))
      .toBeVisible();
    expect(document.querySelector(".canvas")).toBeNull();
    expect(page.getByRole("button", { name: /^#\d+/ }).all()).toHaveLength(7);
  });

  it("omits the slot hint when no stage has two open children", async () => {
    const chain = [child(1, [], "merged"), child(2, [1], "ready"), child(3, [2], "blocked")];
    render(EpicFlowGraph, { epic: epic(chain) });

    await expect.element(group(m.epicflow_stage_first())).toBeInTheDocument();
    expect(page.getByText(/only help here/).all()).toHaveLength(0);
  });

  it("pulses only the in-flight node whose agent is working right now", async () => {
    const chain = [
      { ...child(1, [], "merged"), sessionId: "s1" },
      { ...child(2, [1], "running"), sessionId: "s2" },
      { ...child(3, [1], "in-review"), sessionId: "s3" },
      child(4, [1], "running"),
    ];
    const status: Record<string, Session["status"]> = { s1: "running", s2: "running", s3: "done" };
    render(EpicFlowGraph, {
      epic: epic(chain),
      sessionInfo: (id: string) => ({ session: { status: status[id] } as Session }),
    });

    await expect.element(page.getByRole("button", { name: /^#2/ })).toHaveClass("working");
    for (const n of [1, 3, 4]) {
      await expect
        .element(page.getByRole("button", { name: new RegExp(`^#${n}`) }))
        .not.toHaveClass("working");
    }
  });

  it("scrolls horizontally past four stages", async () => {
    const chain = [1, 2, 3, 4, 5, 6].map((n) => child(n, n > 1 ? [n - 1] : [], "blocked"));
    render(EpicFlowGraph, { epic: epic(chain) });

    await expect.element(group("6")).toBeInTheDocument();
    const scroll = document.querySelector<HTMLElement>(".scroll")!;
    expect(scroll.scrollWidth).toBeGreaterThan(scroll.clientWidth);
  });
});
