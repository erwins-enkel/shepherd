import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../../app.css";
import EpicQueueList from "./EpicQueueList.svelte";
import { m } from "#lib/paraglide/messages.js";
import { toasts } from "#lib/toasts.svelte.js";

const api = vi.hoisted(() => ({
  reorderEpicQueue: vi.fn(async (_repo: string, order: number[]) => ({ queued: order })),
}));

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return { ...actual, ...api };
});

const TITLES: Record<number, string> = { 10: "Alpha", 20: "Beta", 30: "Gamma" };
const titleFor = (n: number) => TITLES[n] ?? null;

const rowOrder = () =>
  [...document.querySelectorAll<HTMLElement>(".queue .row")].map((r) => Number(r.dataset.epic));
const up = (n: number) => page.getByRole("button", { name: m.epicqueue_up_aria({ epic: n }) });
const down = (n: number) => page.getByRole("button", { name: m.epicqueue_down_aria({ epic: n }) });

function mount(queued = [10, 20, 30]) {
  const onselect = vi.fn();
  render(EpicQueueList, { repoPath: "/repo", queued, titleFor, onselect });
  return onselect;
}

beforeEach(() => {
  api.reorderEpicQueue.mockReset();
  api.reorderEpicQueue.mockImplementation(async (_repo, order) => ({ queued: order }));
  toasts.items = [];
});

describe("EpicQueueList (#2973)", () => {
  it("lists the queue in order with position, number and title; the title opens the epic", async () => {
    const onselect = mount();
    expect(rowOrder()).toEqual([10, 20, 30]);
    const first = document.querySelector<HTMLElement>(".queue .row")!;
    expect(first.querySelector(".pos")?.textContent).toBe("1.");
    expect(first.textContent).toContain("#10");
    expect(first.textContent).toContain("Alpha");
    await page.getByRole("button", { name: "#20 Beta" }).click();
    expect(onselect).toHaveBeenCalledWith(20);
  });

  it("↑ is disabled on the first row, ↓ on the last", async () => {
    mount();
    await expect.element(up(10)).toBeDisabled();
    await expect.element(down(10)).toBeEnabled();
    await expect.element(up(30)).toBeEnabled();
    await expect.element(down(30)).toBeDisabled();
  });

  it("↓ on the first row reorders, saves the new order and keeps focus on the moved row", async () => {
    mount();
    await down(10).click();
    expect(api.reorderEpicQueue).toHaveBeenCalledWith("/repo", [20, 10, 30]);
    await expect.poll(rowOrder).toEqual([20, 10, 30]);
    await expect.element(down(10)).toHaveFocus();
    await expect
      .element(page.getByText(m.epicqueue_moved({ epic: 10, position: 2, count: 3 })))
      .toBeInTheDocument();
  });

  it("moving to the end keeps focus on the row via its other button", async () => {
    mount();
    await down(20).click();
    await expect.poll(rowOrder).toEqual([10, 30, 20]);
    await expect.element(up(20)).toHaveFocus();
  });

  it("a rejected save reverts the order and toasts", async () => {
    let reject!: (e: Error) => void;
    api.reorderEpicQueue.mockImplementation(
      () => new Promise((_, r) => (reject = r as (e: Error) => void)),
    );
    mount();
    await up(30).click();
    // Optimistic first …
    await expect.poll(rowOrder).toEqual([10, 30, 20]);
    reject(new Error("409 queue changed"));
    // … then back to the live queue.
    await expect.poll(rowOrder).toEqual([10, 20, 30]);
    expect(toasts.items.map((t) => t.text)).toContain(m.epicqueue_reorder_failed());
  });

  it("dragging a row by keyboard (Space, ↓, Space) saves the new order once", async () => {
    mount();
    const grip = page.getByRole("button", { name: m.epicqueue_drag_aria({ epic: 10 }) });
    (grip.element() as HTMLElement).focus();
    await userEvent.keyboard(" ");
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("{ArrowDown}");
    expect(api.reorderEpicQueue).not.toHaveBeenCalled();
    await userEvent.keyboard(" ");
    await expect.poll(() => api.reorderEpicQueue.mock.calls.length).toBe(1);
    expect(api.reorderEpicQueue).toHaveBeenCalledWith("/repo", [20, 30, 10]);
    await expect.poll(rowOrder).toEqual([20, 30, 10]);
  });
});
