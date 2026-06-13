import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { Issue } from "$lib/types";
import { m } from "$lib/paraglide/messages";
import { listIssues, getEpics, getTodo } from "$lib/api";

// Mock the API so the issue picker renders deterministically with no network.
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    listIssues: vi.fn(),
    getEpics: vi.fn(),
    getTodo: vi.fn(),
  };
});

const { default: NewTask } = await import("./NewTask.svelte");

const mockListIssues = vi.mocked(listIssues);
const mockGetEpics = vi.mocked(getEpics);
const mockGetTodo = vi.mocked(getTodo);

beforeEach(() => {
  mockListIssues.mockReset();
  mockGetEpics.mockReset();
  mockGetTodo.mockReset();
  // Safe defaults so any test that mounts the picker (PromptSources) gets resolved
  // promises, never `undefined`; individual tests override as needed.
  mockGetTodo.mockResolvedValue({ exists: false, content: "" });
  mockListIssues.mockResolvedValue({ slug: null, issues: [] });
  mockGetEpics.mockResolvedValue([]);
});

afterEach(() => {
  document.body.innerHTML = "";
});

const base = (extra: Record<string, unknown> = {}) => ({
  onsubmit: vi.fn(),
  ...extra,
});

describe("NewTask initialImages seed", () => {
  it("renders a removable chip per seeded image", async () => {
    render(NewTask, {
      props: base({
        initialImages: [
          { path: "/srv/a.png", name: "a.png" },
          { path: "/srv/b.png", name: "b.png" },
        ],
      }),
    });

    await expect.element(page.getByText("a.png")).toBeInTheDocument();
    await expect.element(page.getByText("b.png")).toBeInTheDocument();
    // Each seeded chip carries its own remove control.
    const removers = page.getByRole("button", { name: m.newtask_remove_image_aria() }).all();
    expect(removers.length).toBe(2);
  });

  it("renders no chips when initialImages is omitted", async () => {
    render(NewTask, { props: base() });
    expect(document.querySelector(".chip")).toBeNull();
  });

  it("removing a seeded chip drops it without mutating the others", async () => {
    render(NewTask, {
      props: base({
        initialImages: [
          { path: "/srv/a.png", name: "a.png" },
          { path: "/srv/b.png", name: "b.png" },
        ],
      }),
    });

    await page.getByRole("button", { name: m.newtask_remove_image_aria() }).first().click();

    expect(page.getByText("a.png").query()).toBeNull();
    await expect.element(page.getByText("b.png")).toBeInTheDocument();
  });
});

describe("NewTask issue picker epic-parent rows", () => {
  function issue(number: number, title: string, labels: string[] = []): Issue {
    return {
      number,
      title,
      body: "",
      url: `https://example.com/i/${number}`,
      labels,
      createdAt: 0,
    };
  }

  it("renders the epic-parent row non-selectable and the normal row selectable", async () => {
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      issues: [issue(30, "Epic parent", ["shepherd:active"]), issue(31, "Plain issue")],
    });
    mockGetEpics.mockResolvedValue([
      {
        parentIssueNumber: 30,
        parentTitle: "Epic parent",
        total: 2,
        merged: 1,
        status: "idle",
        source: "markdown",
      },
    ]);

    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: "/repo" } });

    // Open the Issues tab in the picker, then wait for the rows to render.
    await page.getByRole("button", { name: m.promptsources_issues_tab() }).click();
    await expect.poll(() => document.querySelectorAll(".ps-body .row").length).toBe(2);

    // The EPIC tag chip renders (exact match: "Epic parent" also contains "Epic").
    await expect
      .element(page.getByText(m.promptsources_epic_tag(), { exact: true }))
      .toBeInTheDocument();
    expect(document.querySelector(".chip-epic")?.textContent).toBe(m.promptsources_epic_tag());

    const rows = Array.from(document.querySelectorAll<HTMLElement>(".ps-body .row"));
    const epicRow = rows.find((r) => r.textContent?.includes("Epic parent"))!;
    const plainRow = rows.find((r) => r.textContent?.includes("Plain issue"))!;

    // Epic-parent row is a non-interactive element marked aria-disabled, not a button.
    expect(epicRow.tagName).not.toBe("BUTTON");
    expect(epicRow.getAttribute("aria-disabled")).toBe("true");
    expect(epicRow.textContent).toContain(m.promptsources_epic_tag());

    // The epic row keeps the issue's normal label chips ALONGSIDE the EPIC tag:
    // the EPIC chip and the "shepherd:active" highlight chip both render.
    expect(epicRow.querySelector(".chip-epic")?.textContent).toBe(m.promptsources_epic_tag());
    const epicLabelChips = Array.from(
      epicRow.querySelectorAll<HTMLElement>(".chip:not(.chip-epic)"),
    );
    expect(epicLabelChips.map((c) => c.textContent?.trim())).toContain("shepherd:active");
    expect(epicLabelChips.some((c) => c.classList.contains("active"))).toBe(true);

    // Clicking it does NOT seed the prompt (no pick handler fires).
    const promptField = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    epicRow.click();
    expect(promptField.value).toBe("");

    // The normal row is a clickable button; picking it seeds the prompt template.
    expect(plainRow.tagName).toBe("BUTTON");
    expect((plainRow as HTMLButtonElement).disabled).toBe(false);
    plainRow.click();
    await expect.poll(() => promptField.value).toContain("#31");
  });
});
