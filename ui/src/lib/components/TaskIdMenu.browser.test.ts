import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import TaskIdMenu from "./TaskIdMenu.svelte";
import { m } from "$lib/paraglide/messages";

// A real, connected opener: the menu restores focus to it on close.
let opener: HTMLButtonElement;
beforeEach(() => {
  opener = document.createElement("button");
  opener.textContent = "TASK-07";
  document.body.appendChild(opener);
});
afterEach(() => {
  opener.remove();
  document.body.innerHTML = "";
});

const base = (extra: Record<string, unknown> = {}) => ({
  anchor: opener.getBoundingClientRect(),
  opener,
  oncopy: vi.fn(),
  onrecommend: vi.fn(),
  onclose: vi.fn(),
  ...extra,
});

describe("TaskIdMenu", () => {
  it("renders the three actions", async () => {
    render(TaskIdMenu, { props: base() });
    expect(document.querySelector(".taskid-menu")).not.toBeNull();
    await expect.element(page.getByRole("menuitem", { name: m.taskid_copy() })).toBeInTheDocument();
    await expect
      .element(page.getByRole("menuitem", { name: m.taskid_recommend_opus() }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("menuitem", { name: m.taskid_recommend_gpt() }))
      .toBeInTheDocument();
  });

  it("Copy ID fires oncopy", async () => {
    const oncopy = vi.fn();
    render(TaskIdMenu, { props: base({ oncopy }) });
    await page.getByRole("menuitem", { name: m.taskid_copy() }).click();
    expect(oncopy).toHaveBeenCalledTimes(1);
  });

  it("recommend items pass the right provider + model", async () => {
    const onrecommend = vi.fn();
    render(TaskIdMenu, { props: base({ onrecommend }) });
    await page.getByRole("menuitem", { name: m.taskid_recommend_opus() }).click();
    expect(onrecommend).toHaveBeenLastCalledWith("claude", "opus");
    await page.getByRole("menuitem", { name: m.taskid_recommend_gpt() }).click();
    expect(onrecommend).toHaveBeenLastCalledWith("codex", "gpt-5.5");
  });
});
