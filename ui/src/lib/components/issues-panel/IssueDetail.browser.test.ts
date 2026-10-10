import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import IssueDetail from "./IssueDetail.svelte";
import type { Epic, EpicChild, Issue } from "#lib/types.js";
import type { IssueSelection } from "../issues-panel";
import { m } from "#lib/paraglide/messages.js";

// The detail only reads; keep the repo-config / epic endpoints it touches off the network.
vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return { ...actual, getRepoConfig: vi.fn(async () => ({})) };
});

const BODY = Array.from({ length: 150 }, (_, i) => `Paragraph ${i} of the description.`).join(
  "\n\n",
);

const issue: Issue = {
  number: 150,
  title: "A readable issue",
  body: BODY,
  url: "https://example.com/issues/150",
  labels: [],
  createdAt: 0,
  assignees: [],
};

function child(number: number, blockedBy: number[], state: EpicChild["state"]): EpicChild {
  return {
    number,
    title: `Task ${number}`,
    url: "u",
    order: number,
    body: "Child body",
    blockedBy,
    state,
    sessionId: null,
    prNumber: null,
    issueClosed: false,
    claimed: false,
  };
}

const epic: Epic = {
  repoPath: "/repo",
  parentIssueNumber: 150,
  parentTitle: "Epic",
  source: "native",
  children: [child(151, [], "merged"), child(152, [151], "ready"), child(153, [152], "blocked")],
  warnings: [],
  run: { repoPath: "/repo", parentIssueNumber: 150, mode: "auto", status: "idle" },
};

function mount(selection: IssueSelection, withEpic?: Epic) {
  return render(IssueDetail, {
    repoPath: "/repo",
    selection,
    epic: withEpic,
    issueActions: [],
    onstart: vi.fn(),
    titleFor: () => null,
  });
}

const box = (selector: string) => {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el.getBoundingClientRect();
};
const detailWidth = () => document.querySelector<HTMLElement>(".issue-detail")!.offsetWidth;

beforeEach(async () => {
  await page.viewport(1100, 800);
});
afterEach(async () => {
  document.body.innerHTML = "";
  await page.viewport(1024, 768);
});

describe("IssueDetail reading layout (#2950)", () => {
  it("a single issue reads on the left (≤ 760px) with the task box beside it", async () => {
    mount({ kind: "single", issue });
    await expect.poll(() => document.querySelector(".task-box")).not.toBeNull();

    const task = box(".task-box");
    const text = box(".main");
    expect(text.right).toBeLessThanOrEqual(task.left);
    expect(text.width).toBeLessThanOrEqual(760);
    expect(task.width).toBeGreaterThanOrEqual(300);
    expect(task.width).toBeLessThanOrEqual(340);
    expect(Math.abs(task.top - text.top)).toBeLessThan(2);
  });

  it("a narrow reading view puts the task box above the description", async () => {
    await page.viewport(700, 800);
    mount({ kind: "single", issue });
    await expect.poll(() => document.querySelector(".task-box")).not.toBeNull();

    const task = box(".task-box");
    const text = box(".main");
    expect(task.bottom).toBeLessThanOrEqual(text.top);
    expect(task.left).toBe(text.left);
    expect(document.querySelector(".detail-body")!.classList.contains("wide")).toBe(false);
  });

  it("an epic gives the flow graph the full row; description left, Abarbeitung right", async () => {
    mount({ kind: "epic", issue }, epic);
    await expect.poll(() => document.querySelector("[data-epic-run]")).not.toBeNull();

    const flow = page.getByRole("region", { name: m.epicflow_title() });
    await expect.element(flow).toBeVisible();
    // Wide diagram, not the stacked list the narrow mode falls back to.
    expect(document.querySelector(".flow .canvas")).not.toBeNull();
    expect(document.querySelector(".flow .stage-list")).toBeNull();

    const flowBox = box(".flow");
    const run = box("[data-epic-run]");
    const text = box(".main");
    const body = box(".detail-body");
    // Full row: from the body's left edge to its right edge.
    expect(flowBox.left).toBe(body.left);
    expect(flowBox.width).toBeGreaterThan(body.width - 2);
    expect(text.right).toBeLessThanOrEqual(run.left);
    expect(text.width).toBeLessThanOrEqual(760);
    expect(run.width).toBeGreaterThanOrEqual(300);
    expect(run.width).toBeLessThanOrEqual(340);
    expect(flowBox.bottom).toBeLessThanOrEqual(Math.min(text.top, run.top));
  });

  it("the Abarbeitung stays pinned beside the description while it scrolls", async () => {
    mount({ kind: "epic", issue }, epic);
    await expect.poll(() => document.querySelector("[data-epic-run]")).not.toBeNull();
    // Stand in for IssuesPanel's scrolling .detail-col.
    const scroller = document.querySelector<HTMLElement>(".issue-detail")!.parentElement!;
    scroller.style.cssText = "height: 500px; overflow-y: auto;";
    const run = () => document.querySelector<HTMLElement>("[data-epic-run]")!;

    // The Markdown renders asynchronously: scroll only once the description has its height.
    await expect.poll(() => document.querySelectorAll(".md-body p").length).toBe(150);
    scroller.scrollTop = 600;
    await expect.poll(() => scroller.scrollTop).toBeGreaterThan(300);
    expect(
      Math.abs(run().getBoundingClientRect().top - scroller.getBoundingClientRect().top),
    ).toBeLessThan(2);
  });

  it("a narrow epic stacks Abarbeitung, flow, children and description", async () => {
    await page.viewport(700, 800);
    mount({ kind: "epic", issue }, epic);
    await expect.poll(() => document.querySelector("[data-epic-run]")).not.toBeNull();

    // Narrow = width below the breakpoint, so the flow is the stage list only below 480.
    expect(detailWidth()).toBeLessThan(760);
    const run = box("[data-epic-run]");
    const flow = box(".flow");
    const host = box(".epic-host");
    const text = box(".md-body");
    expect(run.bottom).toBeLessThanOrEqual(flow.top);
    expect(flow.bottom).toBeLessThanOrEqual(host.top);
    expect(host.bottom).toBeLessThanOrEqual(text.top);
    expect(run.left).toBe(host.left);
  });

  it("a selected epic child keeps the single column", async () => {
    mount({ kind: "child", parent: 150, child: child(152, [151], "ready") }, epic);
    await expect.poll(() => document.querySelector(".detail-body")).not.toBeNull();
    expect(document.querySelector(".detail-body")!.classList.contains("wide")).toBe(false);
  });
});
