import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { Issue, RepoConfig } from "$lib/types";
import { m } from "$lib/paraglide/messages";
import { listIssues, getEpics, getTodo, listBranches, getRepoConfig } from "$lib/api";

// Mock the API so the issue picker renders deterministically with no network.
vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return {
    ...actual,
    listIssues: vi.fn(),
    getEpics: vi.fn(),
    getTodo: vi.fn(),
    listBranches: vi.fn(),
    getRepoConfig: vi.fn(),
  };
});

const { default: NewTask } = await import("./NewTask.svelte");

const mockListIssues = vi.mocked(listIssues);
const mockGetEpics = vi.mocked(getEpics);
const mockGetTodo = vi.mocked(getTodo);
const mockListBranches = vi.mocked(listBranches);
const mockGetRepoConfig = vi.mocked(getRepoConfig);

// A full RepoConfig with the plan gate flag overridable; the composer only reads
// planGateEnabled but the store ingests the whole shape.
function repoConfig(planGateEnabled: boolean): RepoConfig {
  return {
    criticEnabled: true,
    criticAllPrs: false,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: false,
    autoDrainEnabled: false,
    autoMergeEnabled: false,
    buildQueueEnabled: false,
    planGateEnabled,
    draftMode: false,
    signoffAuthority: "human",
    sandboxProfile: "trusted",
    maxAuto: 1,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
    defaultModel: "inherit",
  };
}

beforeEach(() => {
  mockListIssues.mockReset();
  mockGetEpics.mockReset();
  mockGetTodo.mockReset();
  mockListBranches.mockReset();
  mockGetRepoConfig.mockReset();
  // Safe defaults so any test that mounts the picker (PromptSources) gets resolved
  // promises, never `undefined`; individual tests override as needed.
  mockGetTodo.mockResolvedValue({ exists: false, content: "" });
  mockListIssues.mockResolvedValue({ slug: null, webUrl: null, issues: [] });
  mockGetEpics.mockResolvedValue([]);
  mockListBranches.mockResolvedValue({ current: "main", branches: ["main"] });
  mockGetRepoConfig.mockResolvedValue(repoConfig(false));
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
      webUrl: null,
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

describe("NewTask plan-gate inheritance", () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  const planGateBox = () => document.querySelector<HTMLInputElement>(".plan-gate input")!;
  const submitBtn = () => document.querySelector<HTMLButtonElement>("button.run")!;

  async function fillAndSubmit() {
    const promptField = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    promptField.value = "do the thing";
    promptField.dispatchEvent(new Event("input", { bubbles: true }));
    await expect.poll(() => submitBtn().disabled).toBe(false);
    submitBtn().click();
  }

  it("submits planGateEnabled:null when the box is untouched on a gate-ON repo", async () => {
    // unique repoPath per test: repoConfig store is a module singleton that caches by path
    const repoPath = "/repo/gate-on-untouched";
    mockGetRepoConfig.mockResolvedValue(repoConfig(true));
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    // box mirrors the gate-ON default once config settles
    await expect.poll(() => planGateBox().checked).toBe(true);
    await fillAndSubmit();

    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({ planGateEnabled: null });
  });

  it("submits the explicit boolean once the user toggles the box", async () => {
    // gate-OFF repo, user ticks it ON → explicit true
    const repoPath = "/repo/toggle-on";
    mockGetRepoConfig.mockResolvedValue(repoConfig(false));
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    await expect.poll(() => planGateBox().disabled).toBe(false);
    planGateBox().click(); // toggles + pins planGateTouched
    expect(planGateBox().checked).toBe(true);
    await fillAndSubmit();

    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({ planGateEnabled: true });
  });

  it("submits explicit false when the user unticks a gate-ON repo", async () => {
    const repoPath = "/repo/toggle-off";
    mockGetRepoConfig.mockResolvedValue(repoConfig(true));
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    await expect.poll(() => planGateBox().checked).toBe(true);
    planGateBox().click(); // untick → explicit false
    expect(planGateBox().checked).toBe(false);
    await fillAndSubmit();

    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({ planGateEnabled: false });
  });

  it("disables the box until config settles, then re-enables", async () => {
    const repoPath = "/repo/settle-success";
    const d = deferred<RepoConfig>();
    mockGetRepoConfig.mockReturnValue(d.promise);
    render(NewTask, { props: { onsubmit: vi.fn(), initialRepoPath: repoPath } });

    // in flight: disabled + loading hint
    await expect.poll(() => planGateBox().disabled).toBe(true);
    await expect.element(page.getByText(m.common_loading())).toBeInTheDocument();

    d.resolve(repoConfig(true));
    await expect.poll(() => planGateBox().disabled).toBe(false);
    expect(planGateBox().checked).toBe(true);
  });

  it("never wedges disabled when the config fetch fails", async () => {
    const repoPath = "/repo/settle-failure";
    const d = deferred<RepoConfig>();
    mockGetRepoConfig.mockReturnValue(d.promise);
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    await expect.poll(() => planGateBox().disabled).toBe(true);

    d.reject(new Error("boom"));
    // failure still settles → box re-enables (unchecked) and inherits via null
    await expect.poll(() => planGateBox().disabled).toBe(false);
    expect(planGateBox().checked).toBe(false);

    await fillAndSubmit();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({ planGateEnabled: null });
  });
});

describe("NewTask research toggle", () => {
  const researchBox = () =>
    Array.from(document.querySelectorAll<HTMLInputElement>(".plan-gate input")).find((el) =>
      el.closest("label")?.textContent?.includes(m.newtask_research_label()),
    )!;
  const planGateBox = () =>
    Array.from(document.querySelectorAll<HTMLInputElement>(".plan-gate input")).find((el) =>
      el.closest("label")?.textContent?.includes(m.newtask_plan_gate_label()),
    )!;
  const autonomousOption = () =>
    document.querySelector<HTMLOptionElement>('#nt-sandbox option[value="autonomous"]')!;
  const sandboxSelect = () => document.querySelector<HTMLSelectElement>("#nt-sandbox")!;
  const submitBtn = () => document.querySelector<HTMLButtonElement>("button.run")!;

  async function fillAndSubmit() {
    const promptField = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    promptField.value = "do the thing";
    promptField.dispatchEvent(new Event("input", { bubbles: true }));
    await expect.poll(() => submitBtn().disabled).toBe(false);
    submitBtn().click();
  }

  it("renders the Research checkbox", async () => {
    render(NewTask, { props: base() });
    await expect.poll(() => researchBox()).toBeTruthy();
    expect(researchBox().checked).toBe(false);
  });

  it("toggling Research on unchecks plan-gate", async () => {
    const repoPath = "/repo/research-clears-plangate";
    mockGetRepoConfig.mockResolvedValue(repoConfig(true));
    render(NewTask, { props: base({ initialRepoPath: repoPath }) });

    // wait for plan-gate to reflect repo default
    await expect.poll(() => planGateBox().checked).toBe(true);

    researchBox().click();
    await expect.poll(() => researchBox().checked).toBe(true);
    await expect.poll(() => planGateBox().checked).toBe(false);
  });

  it("toggling plan-gate on unchecks Research", async () => {
    render(NewTask, { props: base() });
    await expect.poll(() => researchBox()).toBeTruthy();

    // tick Research on first
    researchBox().click();
    await expect.poll(() => researchBox().checked).toBe(true);

    // then tick plan-gate → Research should clear
    planGateBox().click();
    await expect.poll(() => planGateBox().checked).toBe(true);
    await expect.poll(() => researchBox().checked).toBe(false);
  });

  it("disables the autonomous sandbox option when Research is on", async () => {
    render(NewTask, { props: base() });
    await expect.poll(() => researchBox()).toBeTruthy();

    expect(autonomousOption().disabled).toBe(false);
    researchBox().click();
    await expect.poll(() => researchBox().checked).toBe(true);
    await expect.poll(() => autonomousOption().disabled).toBe(true);
  });

  it("resets autonomous sandbox to default when Research is toggled on", async () => {
    render(NewTask, { props: base() });
    await expect.poll(() => sandboxSelect()).toBeTruthy();

    // pick autonomous first
    sandboxSelect().value = "autonomous";
    sandboxSelect().dispatchEvent(new Event("change", { bubbles: true }));
    await expect.poll(() => sandboxSelect().value).toBe("autonomous");

    // toggle research on → sandbox should reset
    researchBox().click();
    await expect.poll(() => researchBox().checked).toBe(true);
    await expect.poll(() => sandboxSelect().value).toBe("default");
  });

  it("submits research:true when Research is checked", async () => {
    const captured = vi.fn();
    render(NewTask, {
      props: base({ onsubmit: captured, initialRepoPath: "/repo/research-submit" }),
    });
    await expect.poll(() => researchBox()).toBeTruthy();

    researchBox().click();
    await fillAndSubmit();

    await expect.poll(() => captured.mock.calls.length).toBe(1);
    expect(captured.mock.calls[0]![0]).toMatchObject({ research: true });
  });

  it("submits research:false by default", async () => {
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: "/repo/research-default" } });
    await expect.poll(() => submitBtn()).toBeTruthy();

    await fillAndSubmit();

    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({ research: false });
  });
});
