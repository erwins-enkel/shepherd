import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import { mockBreakdown } from "$lib/usage-mock";

const { default: SpendLens } = await import("./SpendLens.svelte");

afterEach(() => {
  document.body.innerHTML = "";
});

describe("SpendLens", () => {
  it("renders repo rows from fixture", async () => {
    const breakdown = mockBreakdown("7d");
    render(SpendLens, { breakdown });

    // All 3 repos should be present
    await expect.element(page.getByText("shepherd")).toBeInTheDocument();
    await expect.element(page.getByText("web-app")).toBeInTheDocument();
    await expect.element(page.getByText("infra")).toBeInTheDocument();
  });

  it("default-expands the largest repo and shows ≤3 task rows", async () => {
    const breakdown = mockBreakdown("7d");
    render(SpendLens, { breakdown });

    // Shepherd is the largest repo in 7d fixture.
    // Its button should have aria-expanded="true"
    const shepherdButton = document.querySelector<HTMLButtonElement>(
      'button[aria-expanded="true"]',
    );
    expect(shepherdButton, "one repo is default-expanded").not.toBeNull();
    expect(shepherdButton?.textContent).toContain("shepherd");

    // Task rows visible in the expanded section
    const taskRows = document.querySelectorAll(".task-row");
    expect(taskRows.length, "at most 3 task rows visible").toBeLessThanOrEqual(3);
    expect(taskRows.length, "at least 1 task row visible").toBeGreaterThanOrEqual(1);
  });

  it("shows '… N more' when a repo has more than 3 tasks", async () => {
    // Shepherd in 7d has 9 tasks (7 from 24h + 2 extra) → should show "… 6 more"
    const breakdown = mockBreakdown("7d");
    render(SpendLens, { breakdown });

    // The default-expanded repo (shepherd, 9 tasks) should have a "more" row
    const moreRow = document.querySelector(".task-more");
    expect(moreRow, "task-more row present").not.toBeNull();

    // Remaining count = 9 - 3 = 6
    const moreText = moreRow?.textContent ?? "";
    expect(moreText).toMatch(/6/);
  });

  it("api-key mode shows $ cost cells and total", async () => {
    const breakdown = mockBreakdown("7d");
    render(SpendLens, { breakdown });

    // Each repo row should have a cost cell
    const costCells = document.querySelectorAll(".repo-cost");
    expect(costCells.length, "repo-cost cells rendered").toBeGreaterThanOrEqual(
      breakdown.repos.length,
    );

    // Grand-total cost element should exist with $ prefix
    const totalEl = document.querySelector(".spend-total-cost");
    expect(totalEl, "spend-total-cost element exists").not.toBeNull();
    expect(totalEl?.textContent?.trim().startsWith("$"), "total starts with $").toBe(true);
  });

  it("subscription mode hides $ cost cells and total", async () => {
    const sub = {
      ...mockBreakdown("7d"),
      dollars: null,
      repos: mockBreakdown("7d").repos.map((r) => ({ ...r, dollars: null })),
    };
    render(SpendLens, { breakdown: sub });

    const costCells = document.querySelectorAll(".repo-cost");
    expect(costCells.length, "no repo-cost cells in subscription mode").toBe(0);

    const totalEl = document.querySelector(".spend-total-cost");
    expect(totalEl, "no spend-total-cost in subscription mode").toBeNull();
  });

  it("toggling a collapsed repo expands it and shows task rows", async () => {
    const breakdown = mockBreakdown("7d");
    render(SpendLens, { breakdown });

    // Shepherd is expanded by default (3 task rows). web-app and infra are collapsed.
    const collapsedBtn = document.querySelector<HTMLButtonElement>(
      'button.repo-row[aria-expanded="false"]',
    );
    expect(collapsedBtn, "collapsed repo button exists").not.toBeNull();

    const tasksBefore = document.querySelectorAll(".task-row").length;
    expect(tasksBefore, "shepherd tasks shown before toggle").toBe(3);

    // Click the collapsed repo button
    collapsedBtn!.click();

    // Svelte 5 batches DOM updates; poll until the attribute flips
    await expect.poll(() => collapsedBtn!.getAttribute("aria-expanded")).toBe("true");

    // New task rows should now be visible
    const tasksAfter = document.querySelectorAll(".task-row").length;
    expect(tasksAfter, "task rows increased after expanding").toBeGreaterThan(tasksBefore);
  });
});
