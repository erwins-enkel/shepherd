import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import { overwriteGetLocale } from "$lib/paraglide/runtime";
import type { Issue, RepoConfig, RepoEntry, SlashCommand, Steer } from "$lib/types";
import { m } from "$lib/paraglide/messages";
import { steers } from "$lib/steers.svelte";
import { viewerCache } from "$lib/viewer-cache.svelte";
import {
  listIssues,
  getEpics,
  getTodo,
  listBranches,
  getRepoConfig,
  putRepoConfig,
  listRepos,
  branchStatus,
  initEmptyCommit,
  getCommands,
  uploadFile,
} from "$lib/api";

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
    putRepoConfig: vi.fn(),
    listRepos: vi.fn(),
    branchStatus: vi.fn(),
    initEmptyCommit: vi.fn(),
    getCommands: vi.fn(),
    uploadFile: vi.fn(),
  };
});

const { default: NewTask } = await import("./NewTask.svelte");
const { default: FirstTaskAutomationConfirm } = await import("./FirstTaskAutomationConfirm.svelte");

const mockListIssues = vi.mocked(listIssues);
const mockGetEpics = vi.mocked(getEpics);
const mockGetTodo = vi.mocked(getTodo);
const mockListBranches = vi.mocked(listBranches);
const mockGetRepoConfig = vi.mocked(getRepoConfig);
const mockPutRepoConfig = vi.mocked(putRepoConfig);
const mockListRepos = vi.mocked(listRepos);
const mockBranchStatus = vi.mocked(branchStatus);
const mockInitEmptyCommit = vi.mocked(initEmptyCommit);
const mockGetCommands = vi.mocked(getCommands);
const mockUploadFile = vi.mocked(uploadFile);

// A full RepoConfig with the plan gate flag overridable; the composer only reads
// planGateEnabled but the store ingests the whole shape. automationConfirmed defaults
// to true so existing tests (which don't test the confirm step) bypass the gate.
function repoConfig(
  planGateEnabled: boolean,
): RepoConfig & { automationConfirmed: boolean; automationRowExists: boolean } {
  return {
    criticEnabled: true,
    criticAllPrs: false,
    criticSmellLensEnabled: false,
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
    defaultEffort: "inherit",
    repoMode: "forge",
    autoOptimizeFlagged: false,
    manualStepsIssueEnabled: false,
    preWarmEpicLandingCi: false,
    hidden: false,
    previewStartScript: null,
    previewStartCommand: null,
    previewOpenMode: "ask",
    automationConfirmed: true,
    automationRowExists: true,
  };
}

beforeEach(async () => {
  // The redesigned modal is responsive (MediaQuery-switched rail vs. mobile sheet);
  // vitest-browser's default viewport is mobile-width, so pin desktop here. Tests
  // that exercise the mobile layout set their own viewport explicitly.
  await page.viewport(1280, 900);
  mockListIssues.mockReset();
  mockGetEpics.mockReset();
  mockGetTodo.mockReset();
  mockListBranches.mockReset();
  mockGetRepoConfig.mockReset();
  mockPutRepoConfig.mockReset();
  mockListRepos.mockReset();
  mockBranchStatus.mockReset();
  mockInitEmptyCommit.mockReset();
  mockGetCommands.mockReset();
  mockUploadFile.mockReset();
  // Safe defaults so any test that mounts the picker (PromptSources) gets resolved
  // promises, never `undefined`; individual tests override as needed.
  mockGetTodo.mockResolvedValue({ exists: false, content: "" });
  mockListIssues.mockResolvedValue({ slug: null, webUrl: null, issues: [], viewer: null });
  mockGetEpics.mockResolvedValue({ epics: [], subIssues: [] });
  mockListBranches.mockResolvedValue({ current: "main", branches: ["main"], default: null });
  mockGetRepoConfig.mockResolvedValue(repoConfig(false));
  mockPutRepoConfig.mockResolvedValue(repoConfig(false));
  mockListRepos.mockResolvedValue({ repos: [], recentWindowDays: 30 });
  mockGetCommands.mockResolvedValue({ commands: [] });
  mockUploadFile.mockImplementation(async (file: File) => `/staged/${file.name}`);
  // Default: up to date — no hint rendered
  mockBranchStatus.mockResolvedValue({
    behind: 0,
    ahead: 0,
    diverged: false,
    hasUpstream: true,
    localExists: true,
  });
  mockInitEmptyCommit.mockResolvedValue({ branch: "main" });
});

let matchMediaSpy: ReturnType<typeof vi.spyOn> | undefined;
let createObjectUrlSpy: ReturnType<typeof vi.spyOn> | undefined;
let revokeObjectUrlSpy: ReturnType<typeof vi.spyOn> | undefined;
function mockPointer(coarse: boolean) {
  const real = window.matchMedia.bind(window);
  matchMediaSpy = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
    if (query === "(pointer: coarse)") {
      return {
        matches: coarse,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
        onchange: null,
      } as unknown as MediaQueryList;
    }
    return real(query);
  });
}

afterEach(async () => {
  matchMediaSpy?.mockRestore();
  matchMediaSpy = undefined;
  createObjectUrlSpy?.mockRestore();
  createObjectUrlSpy = undefined;
  revokeObjectUrlSpy?.mockRestore();
  revokeObjectUrlSpy = undefined;
  overwriteGetLocale(() => "en");
  await page.viewport(1280, 900);
  document.body.innerHTML = "";
});

const base = (extra: Record<string, unknown> = {}) => ({
  onsubmit: vi.fn(),
  ...extra,
});

function slashCommand(name: string, providers: SlashCommand["providers"]): SlashCommand {
  return {
    id: `test:${name}`,
    name,
    displayName: name,
    description: `${name} description`,
    scope: "project",
    kind: "skill",
    invocationName: name,
    sourceNamespace: providers?.includes("codex") ? "codex:repo" : "claude:repo",
    providers,
    invocations: {
      ...(providers?.includes("claude") ? { claude: `/${name}` } : {}),
      ...(providers?.includes("codex") ? { codex: `$${name}` } : {}),
    },
  };
}

// ── redesigned-DOM helpers: Guards switches (role=switch) + Mode segments ──
// The label part of a glossary marker ("[[plan-gate|Plan gate]]" → "Plan gate").
function glossLabel(markup: string): string {
  const match = /\[\[[^|]+\|([^\]]+)\]\]/.exec(markup);
  return match ? match[1]! : markup;
}
const switchByLabel = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('button[role="switch"]')).find((el) =>
    el.closest(".toggle-row")?.querySelector(".label")?.textContent?.includes(label),
  )!;
const planGateSwitch = () => switchByLabel(glossLabel(m.newtask_guard_plan_gate()));
const autopilotSwitch = () => switchByLabel(glossLabel(m.newtask_guard_autopilot()));
const isOn = (sw: HTMLButtonElement | undefined) => sw?.getAttribute("aria-checked") === "true";
const segButton = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(".seg-btn")).find(
    (el) => el.textContent?.trim() === label,
  )!;
const segActive = (label: string) => segButton(label)?.getAttribute("aria-pressed") === "true";

describe("NewTask initialImages seed", () => {
  it("renders a removable chip per seeded attachment", async () => {
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
    expect(
      page.getByRole("button", { name: m.newtask_preview_image_aria({ name: "a.png" }) }).query(),
    ).toBeNull();
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

describe("NewTask provider-aware command picker", () => {
  it("selecting a Codex skill from $ inserts a mention and switches CLI", async () => {
    mockGetCommands.mockResolvedValue({
      commands: [slashCommand("codex-skill", ["codex"])],
    });
    render(NewTask, { props: base({ initialRepoPath: "/repo/codex-skill" }) });

    const promptField = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    promptField.value = "$cod";
    promptField.dispatchEvent(new Event("input", { bubbles: true }));
    await expect.element(page.getByText("$codex-skill")).toBeVisible();
    await page.getByText("$codex-skill").click();

    await expect.poll(() => promptField.value).toBe("$codex-skill ");
    expect(document.querySelector<HTMLSelectElement>("#nt-agent-provider")!.value).toBe("codex");
    await expect.element(page.getByText(m.newtask_provider_constraint_title())).toBeVisible();
    await expect.element(page.getByText("codex-skill is only available in Codex.")).toBeVisible();
    await expect
      .element(
        page.getByText(
          "Shepherd selected Codex and disabled incompatible CLIs while this token is in the prompt.",
        ),
      )
      .toBeVisible();
    const options = Array.from(
      document.querySelectorAll<HTMLOptionElement>("#nt-agent-provider option"),
    );
    expect(options.find((option) => option.value === "claude")?.disabled).toBe(true);
  });

  it("selecting a both-provider skill does not lock or explain the provider", async () => {
    mockGetCommands.mockResolvedValue({
      commands: [slashCommand("shared-skill", ["claude", "codex"])],
    });
    render(NewTask, { props: base({ initialRepoPath: "/repo/shared-skill" }) });

    const promptField = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    promptField.value = "$shared";
    promptField.dispatchEvent(new Event("input", { bubbles: true }));
    await expect.element(page.getByText("$shared-skill")).toBeVisible();
    await page.getByText("$shared-skill").click();

    await expect.poll(() => promptField.value).toBe("$shared-skill ");
    expect(document.querySelector<HTMLSelectElement>("#nt-agent-provider")!.value).toBe("codex");
    expect(page.getByText(m.newtask_provider_constraint_title()).query()).toBeNull();
    expect(page.getByText("shared-skill is only available in Codex.").query()).toBeNull();
    const options = Array.from(
      document.querySelectorAll<HTMLOptionElement>("#nt-agent-provider option"),
    );
    expect(options.every((option) => !option.disabled)).toBe(true);
  });
});

describe("NewTask task attachments", () => {
  async function upload(files: File[]) {
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: files, configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await expect.poll(() => mockUploadFile.mock.calls.length).toBe(files.length);
  }

  function mockObjectUrls() {
    let next = 0;
    createObjectUrlSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation(() => `blob:attachment-preview-${++next}`);
    revokeObjectUrlSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  }

  it("renders the toolbar attach button with the keyboard paste-image hint as its title", async () => {
    mockPointer(false);
    render(NewTask, { props: base({ initialRepoPath: "/repo/attachments" }) });

    await expect.element(page.getByPlaceholder(m.newtask_prompt_placeholder())).toBeInTheDocument();
    const attach = document.querySelector<HTMLButtonElement>(".toolbar .tool-btn")!;
    expect(attach.getAttribute("aria-label")).toBe(m.newtask_attach_aria());
    expect(attach.title).toBe(m.newtask_drop_hint_keyboard({ shortcut: "Ctrl+V" }));
  });

  it("uses the short touch hint in coarse pointer contexts", async () => {
    mockPointer(true);
    render(NewTask, { props: base({ initialRepoPath: "/repo/attachments" }) });

    await expect
      .poll(() => document.querySelector<HTMLButtonElement>(".toolbar .tool-btn"))
      .toBeTruthy();
    const attach = document.querySelector<HTMLButtonElement>(".toolbar .tool-btn")!;
    expect(attach.title).toBe(m.newtask_drop_hint());
  });

  it("keeps the German in-field toolbar inside a mobile-width sheet", async () => {
    await page.viewport(390, 800);
    overwriteGetLocale(() => "de");
    mockPointer(false);
    render(NewTask, { props: base({ initialRepoPath: "/repo/attachments" }) });

    await expect.poll(() => document.querySelector<HTMLElement>(".toolbar")).toBeTruthy();
    const row = document.querySelector<HTMLElement>(".toolbar")!;
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
  });

  it("uploads a non-image file, renders a chip, and submits its staged path", async () => {
    mockUploadFile.mockResolvedValue("/staged/notes.md");
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, { props: base({ onsubmit, initialRepoPath: "/repo/attachments" }) });

    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["# Notes"], "notes.md", { type: "text/markdown" });
    const dt = new DataTransfer();
    dt.items.add(file);
    Object.defineProperty(input, "files", { value: dt.files, configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    await expect.poll(() => mockUploadFile.mock.calls.length).toBe(1);
    expect(mockUploadFile).toHaveBeenCalledWith(file);
    await expect.element(page.getByText("notes.md")).toBeInTheDocument();

    const promptField = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    promptField.value = "use the attached notes";
    promptField.dispatchEvent(new Event("input", { bubbles: true }));

    const run = document.querySelector<HTMLButtonElement>("button.run")!;
    await expect.poll(() => run.disabled).toBe(false);
    run.click();

    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({
      prompt: "use the attached notes",
      images: ["/staged/notes.md"],
    });
  });

  it("selects non-image files, uploads them, renders chips, and has no image-only accept", async () => {
    render(NewTask, { props: base() });

    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input).not.toBeNull();
    expect(input.getAttribute("accept")).not.toBe("image/*");

    const files = [
      new File(["pdf"], "report.pdf", { type: "application/pdf" }),
      new File(["txt"], "notes.txt", { type: "text/plain" }),
      new File(["md"], "brief.md", { type: "" }),
    ];
    Object.defineProperty(input, "files", { value: files, configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    await expect.poll(() => mockUploadFile.mock.calls.length).toBe(3);
    expect(mockUploadFile.mock.calls.map(([file]) => file.name)).toEqual([
      "report.pdf",
      "notes.txt",
      "brief.md",
    ]);
    await expect.element(page.getByText("report.pdf")).toBeInTheDocument();
    await expect.element(page.getByText("notes.txt")).toBeInTheDocument();
    await expect.element(page.getByText("brief.md")).toBeInTheDocument();
  });

  it("drops non-image files, uploads them, and renders chips", async () => {
    render(NewTask, { props: base() });

    const form = document.querySelector<HTMLFormElement>("form.card")!;
    expect(form).not.toBeNull();
    const dt = new DataTransfer();
    dt.items.add(new File(["pdf"], "drop.pdf", { type: "application/pdf" }));
    dt.items.add(new File(["txt"], "drop.txt", { type: "text/plain" }));
    dt.items.add(new File(["md"], "drop.md", { type: "" }));

    form.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }),
    );

    await expect.poll(() => mockUploadFile.mock.calls.length).toBe(3);
    expect(mockUploadFile.mock.calls.map(([file]) => file.name)).toEqual([
      "drop.pdf",
      "drop.txt",
      "drop.md",
    ]);
    await expect.element(page.getByText("drop.pdf")).toBeInTheDocument();
    await expect.element(page.getByText("drop.txt")).toBeInTheDocument();
    await expect.element(page.getByText("drop.md")).toBeInTheDocument();
  });

  it("previews only fresh image files and preserves the mixed attachment payload", async () => {
    mockObjectUrls();
    mockPointer(false);
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, { props: base({ onsubmit, initialRepoPath: "/repo/attachments" }) });

    await upload([
      new File(["png"], "shot.png", { type: "image/png" }),
      new File(["notes"], "notes.txt", { type: "text/plain" }),
    ]);

    await expect
      .element(
        page.getByRole("button", { name: m.newtask_preview_image_aria({ name: "shot.png" }) }),
      )
      .toBeVisible();
    expect(
      page
        .getByRole("button", { name: m.newtask_preview_image_aria({ name: "notes.txt" }) })
        .query(),
    ).toBeNull();
    expect(page.getByText("notes.txt").element().closest("button")).toBeNull();

    const promptField = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    promptField.value = "use both attachments";
    promptField.dispatchEvent(new Event("input", { bubbles: true }));
    const run = document.querySelector<HTMLButtonElement>("button.run")!;
    await expect.poll(() => run.disabled).toBe(false);
    run.click();

    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({
      images: ["/staged/shot.png", "/staged/notes.txt"],
      attachmentNames: ["shot.png", "notes.txt"],
    });
  });

  it("opens an image preview on desktop hover and keyboard focus", async () => {
    mockObjectUrls();
    mockPointer(false);
    render(NewTask, { props: base({ initialRepoPath: "/repo/attachments" }) });
    await upload([new File(["png"], "shot.png", { type: "image/png" })]);

    const trigger = page.getByRole("button", {
      name: m.newtask_preview_image_aria({ name: "shot.png" }),
    });
    await expect.element(trigger).toBeVisible();
    const triggerEl = trigger.element() as HTMLButtonElement;
    triggerEl.dispatchEvent(
      new PointerEvent("pointerenter", { bubbles: true, pointerType: "mouse" }),
    );

    await expect
      .poll(() => document.querySelector(".attachment-preview:popover-open"))
      .not.toBeNull();
    expect(document.querySelector<HTMLImageElement>(".attachment-preview img")?.src).toContain(
      "blob:attachment-preview-1",
    );

    triggerEl.dispatchEvent(
      new PointerEvent("pointerleave", { bubbles: true, pointerType: "mouse" }),
    );
    await expect.poll(() => document.querySelector(".attachment-preview:popover-open")).toBeNull();

    triggerEl.focus();
    await expect
      .poll(() => document.querySelector(".attachment-preview:popover-open"))
      .not.toBeNull();
    triggerEl.blur();
    await expect.poll(() => document.querySelector(".attachment-preview:popover-open")).toBeNull();
  });

  it("toggles an image preview on touch and dismisses it outside", async () => {
    mockObjectUrls();
    mockPointer(true);
    render(NewTask, { props: base({ initialRepoPath: "/repo/attachments" }) });
    await upload([new File(["png"], "mobile.png", { type: "image/png" })]);

    const trigger = page.getByRole("button", {
      name: m.newtask_preview_image_aria({ name: "mobile.png" }),
    });
    await trigger.click();
    await expect
      .poll(() => document.querySelector(".attachment-preview:popover-open"))
      .not.toBeNull();
    await trigger.click();
    await expect.poll(() => document.querySelector(".attachment-preview:popover-open")).toBeNull();

    await trigger.click();
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await expect.poll(() => document.querySelector(".attachment-preview:popover-open")).toBeNull();
  });

  it("dismisses an image preview on Escape, scroll, and resize", async () => {
    mockObjectUrls();
    mockPointer(true);
    render(NewTask, { props: base({ initialRepoPath: "/repo/attachments" }) });
    await upload([new File(["png"], "dismiss.png", { type: "image/png" })]);

    const trigger = page.getByRole("button", {
      name: m.newtask_preview_image_aria({ name: "dismiss.png" }),
    });
    const isOpen = () => document.querySelector(".attachment-preview:popover-open");

    await trigger.click();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await expect.poll(isOpen).toBeNull();

    await trigger.click();
    window.dispatchEvent(new Event("scroll"));
    await expect.poll(isOpen).toBeNull();

    await trigger.click();
    window.dispatchEvent(new Event("resize"));
    await expect.poll(isOpen).toBeNull();
  });

  it("revokes image preview URLs on attachment removal and dialog teardown", async () => {
    mockObjectUrls();
    const screen = await render(NewTask, {
      props: base({ initialRepoPath: "/repo/attachments" }),
    });
    await upload([
      new File(["a"], "a.png", { type: "image/png" }),
      new File(["b"], "b.png", { type: "image/png" }),
    ]);
    await expect.poll(() => createObjectUrlSpy?.mock.calls.length).toBe(2);

    await page.getByRole("button", { name: m.newtask_remove_image_aria() }).first().click();
    await expect.poll(() => revokeObjectUrlSpy?.mock.calls.length).toBe(1);
    expect(revokeObjectUrlSpy).toHaveBeenCalledWith("blob:attachment-preview-1");

    await screen.unmount();
    expect(revokeObjectUrlSpy).toHaveBeenCalledWith("blob:attachment-preview-2");
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
      assignees: [],
    };
  }

  it("renders the epic-parent row non-selectable and the normal row selectable", async () => {
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      webUrl: null,
      issues: [issue(30, "Epic parent", ["shepherd:active"]), issue(31, "Plain issue")],
      viewer: null,
    });
    mockGetEpics.mockResolvedValue({
      epics: [
        {
          parentIssueNumber: 30,
          parentTitle: "Epic parent",
          total: 2,
          merged: 1,
          status: "idle",
          source: "markdown",
        },
      ],
      subIssues: [],
    });

    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: "/repo" } });

    // Open the Issues tab in the picker, then wait for the rows to render.
    // exact: true avoids matching the "hide sub-issues" chip (accessible name contains "issues").
    await page.getByRole("button", { name: m.promptsources_issues_tab(), exact: true }).click();
    await expect.poll(() => document.querySelectorAll(".ps-body .issue-source-row").length).toBe(2);

    // The EPIC tag chip renders (exact match: "Epic parent" also contains "Epic").
    await expect
      .element(page.getByText(m.promptsources_epic_tag(), { exact: true }))
      .toBeInTheDocument();
    expect(document.querySelector(".source-epic-tag")?.textContent).toBe(
      m.promptsources_epic_tag(),
    );

    const rows = Array.from(document.querySelectorAll<HTMLElement>(".ps-body .issue-source-row"));
    const epicRow = rows.find((r) => r.textContent?.includes("Epic parent"))!;
    const plainRow = rows.find((r) => r.textContent?.includes("Plain issue"))!;

    // Epic-parent row is a non-interactive element marked aria-disabled, not a button.
    expect(epicRow.tagName).not.toBe("BUTTON");
    expect(epicRow.getAttribute("aria-disabled")).toBe("true");
    expect(epicRow.textContent).toContain(m.promptsources_epic_tag());

    // The epic row keeps the issue's normal label chips ALONGSIDE the EPIC tag:
    // the EPIC chip and the "shepherd:active" highlight chip both render.
    expect(epicRow.querySelector(".source-epic-tag")?.textContent).toBe(m.promptsources_epic_tag());
    const epicLabelChips = Array.from(epicRow.querySelectorAll<HTMLElement>(".issue-label-chip"));
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

  // Migrated to the redesigned Guards toggles: selectors move to role="switch" +
  // aria-checked; the behavioral assertions are preserved verbatim.
  const planGateBox = planGateSwitch;
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
    await expect.poll(() => isOn(planGateBox())).toBe(true);
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

    await expect.poll(() => planGateBox()?.disabled).toBe(false);
    planGateBox().click(); // toggles + pins planGateTouched
    await expect.poll(() => isOn(planGateBox())).toBe(true);
    await fillAndSubmit();

    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({ planGateEnabled: true });
  });

  it("submits explicit false when the user unticks a gate-ON repo", async () => {
    const repoPath = "/repo/toggle-off";
    mockGetRepoConfig.mockResolvedValue(repoConfig(true));
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    await expect.poll(() => isOn(planGateBox())).toBe(true);
    planGateBox().click(); // untick → explicit false
    await expect.poll(() => isOn(planGateBox())).toBe(false);
    await fillAndSubmit();

    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({ planGateEnabled: false });
  });

  it("disables the box until config settles, then re-enables", async () => {
    const repoPath = "/repo/settle-success";
    const d = deferred<RepoConfig>();
    mockGetRepoConfig.mockReturnValue(d.promise);
    render(NewTask, { props: { onsubmit: vi.fn(), initialRepoPath: repoPath } });

    // in flight: disabled + loading hint (both gate + autopilot show it, so match the first)
    await expect.poll(() => planGateBox()?.disabled).toBe(true);
    await expect.element(page.getByText(m.common_loading()).first()).toBeInTheDocument();

    d.resolve(repoConfig(true));
    await expect.poll(() => planGateBox()?.disabled).toBe(false);
    expect(isOn(planGateBox())).toBe(true);
  });

  it("never wedges disabled when the config fetch fails", async () => {
    const repoPath = "/repo/settle-failure";
    const d = deferred<RepoConfig>();
    mockGetRepoConfig.mockReturnValue(d.promise);
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    await expect.poll(() => planGateBox()?.disabled).toBe(true);

    d.reject(new Error("boom"));
    // failure still settles → box re-enables (unchecked) and inherits via null
    await expect.poll(() => planGateBox()?.disabled).toBe(false);
    expect(isOn(planGateBox())).toBe(false);

    // A FAILED fetch leaves confirmed/rowExists unset. The submit gate must NOT treat that
    // as a new repo: it must spawn DIRECTLY (no confirm step) and must NOT seed (no PUT that
    // would clobber a deliberate planGate=off on an existing-but-unloaded repo).
    mockPutRepoConfig.mockResolvedValue({ ...repoConfig(false), automationConfirmed: true });
    await fillAndSubmit();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({ planGateEnabled: null });
    // no confirm step, and crucially no seed PUT
    expect(document.querySelector(".ftac")).toBeNull();
    expect(mockPutRepoConfig).not.toHaveBeenCalled();
  });

  it("first-task confirm replays force from 'Submit anyway' (no silent downgrade to hold)", async () => {
    // Brand-new repo (unconfirmed, no row) that ALSO hits a likely usage hold. Clicking
    // "Submit anyway" (force=true) must keep force=true through the confirm step — not get
    // downgraded to force=false (which would silently become "Hold for reset").
    const repoPath = "/repo/force-through-confirm";
    mockGetRepoConfig.mockResolvedValue({
      ...repoConfig(false),
      automationConfirmed: false,
      automationRowExists: false,
    });
    mockPutRepoConfig.mockResolvedValue({ ...repoConfig(false), automationConfirmed: true });
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath, holdLikely: true } });

    const provider = document.querySelector<HTMLSelectElement>("#nt-agent-provider")!;
    provider.value = "claude";
    provider.dispatchEvent(new Event("change", { bubbles: true }));
    await expect.poll(() => provider.value).toBe("claude");

    const promptField = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    promptField.value = "do the thing";
    promptField.dispatchEvent(new Event("input", { bubbles: true }));

    const anyway = () => document.querySelector<HTMLButtonElement>("button.run-anyway")!;
    await expect.poll(() => anyway().disabled).toBe(false);
    anyway().click(); // submit(e, true)

    // first task on this repo → confirm step intercepts before spawning
    await expect.poll(() => document.querySelector(".ftac")).toBeTruthy();
    expect(onsubmit).not.toHaveBeenCalled();

    await page.getByRole("button", { name: m.firsttask_confirm_cta() }).click();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    // force must survive the confirm step
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({ force: true });
  });
});

describe("NewTask autopilot override", () => {
  const autopilotBox = autopilotSwitch;
  const submitBtn = () => document.querySelector<HTMLButtonElement>("button.run")!;

  async function fillAndSubmit() {
    const promptField = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    promptField.value = "do the thing";
    promptField.dispatchEvent(new Event("input", { bubbles: true }));
    await expect.poll(() => submitBtn().disabled).toBe(false);
    submitBtn().click();
  }

  it("submits autopilotEnabled:null when untouched (inherits the repo default)", async () => {
    const repoPath = "/repo/ap-untouched";
    mockGetRepoConfig.mockResolvedValue({ ...repoConfig(false), autopilotEnabled: true });
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    // box mirrors the autopilot-ON default once config settles
    await expect.poll(() => isOn(autopilotBox())).toBe(true);
    await fillAndSubmit();

    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({ autopilotEnabled: null });
  });

  it("submits explicit false when the user unticks an autopilot-ON repo", async () => {
    const repoPath = "/repo/ap-opt-out";
    mockGetRepoConfig.mockResolvedValue({ ...repoConfig(false), autopilotEnabled: true });
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    await expect.poll(() => isOn(autopilotBox())).toBe(true);
    autopilotBox().click(); // untick → explicit opt-out for this task
    await expect.poll(() => isOn(autopilotBox())).toBe(false);
    await fillAndSubmit();

    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({ autopilotEnabled: false });
  });

  it("shows the checkbox in relaunch mode and submits an explicit override", async () => {
    const repoPath = "/repo/ap-relaunch";
    mockGetRepoConfig.mockResolvedValue({ ...repoConfig(false), autopilotEnabled: true });
    const onsubmit = vi.fn();
    render(NewTask, { props: base({ onsubmit, relaunch: true, initialRepoPath: repoPath }) });

    // An untouched relaunch follows the destination repo's default.
    await expect.poll(() => isOn(autopilotBox())).toBe(true);
    autopilotBox().click();
    await expect.poll(() => isOn(autopilotBox())).toBe(false);
    await fillAndSubmit();

    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({ autopilotEnabled: false });
  });
});

describe("NewTask research mode (segmented control)", () => {
  // The two research/epic checkboxes became the Mode segments; "checking Research"
  // = clicking the Research segment, "unchecking" = returning to Code. The
  // behavioral assertions (mutual exclusion, guard lock, sandbox reset, payload)
  // are preserved verbatim.
  const researchSeg = () => segButton(m.newtask_mode_research());
  const codeSeg = () => segButton(m.newtask_mode_code());
  const planGateBox = planGateSwitch;
  const autopilotBox = autopilotSwitch;
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

  it("renders the Mode segments with Code active", async () => {
    render(NewTask, { props: base() });
    await expect.poll(() => researchSeg()).toBeTruthy();
    expect(segActive(m.newtask_mode_research())).toBe(false);
    expect(segActive(m.newtask_mode_code())).toBe(true);
  });

  it("toggling Research on unchecks plan-gate", async () => {
    const repoPath = "/repo/research-clears-plangate";
    mockGetRepoConfig.mockResolvedValue(repoConfig(true));
    render(NewTask, { props: base({ initialRepoPath: repoPath }) });

    // wait for plan-gate to reflect repo default
    await expect.poll(() => isOn(planGateBox())).toBe(true);

    researchSeg().click();
    await expect.poll(() => segActive(m.newtask_mode_research())).toBe(true);
    await expect.poll(() => isOn(planGateBox())).toBe(false);
  });

  it("toggling Research on unchecks Autopilot", async () => {
    const repoPath = "/repo/research-clears-autopilot";
    mockGetRepoConfig.mockResolvedValue({ ...repoConfig(false), autopilotEnabled: true });
    render(NewTask, { props: base({ initialRepoPath: repoPath }) });

    // box mirrors the autopilot-ON default once config settles
    await expect.poll(() => isOn(autopilotBox())).toBe(true);

    researchSeg().click();
    await expect.poll(() => segActive(m.newtask_mode_research())).toBe(true);
    await expect.poll(() => isOn(autopilotBox())).toBe(false);
  });

  it("keeps Autopilot unchecked after a repo switch (touched pin survives)", async () => {
    const repoA: RepoEntry = {
      name: "alpha",
      path: "/repo/ap-switch-a",
      display: "alpha",
      realPath: "/repo/ap-switch-a",
    };
    const repoB: RepoEntry = {
      name: "bravo",
      path: "/repo/ap-switch-b",
      display: "bravo",
      realPath: "/repo/ap-switch-b",
    };
    mockListRepos.mockResolvedValue({ repos: [repoA, repoB], recentWindowDays: 30 });
    // both repos report autopilot ON
    mockGetRepoConfig.mockResolvedValue({ ...repoConfig(false), autopilotEnabled: true });
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: repoA.path } });

    await expect.poll(() => isOn(autopilotBox())).toBe(true);

    researchSeg().click();
    await expect.poll(() => segActive(m.newtask_mode_research())).toBe(true);
    await expect.poll(() => isOn(autopilotBox())).toBe(false);

    // switch to repo B via the RepoSelect combobox
    const trigger = document.querySelector<HTMLButtonElement>(".rs-trigger")!;
    trigger.click();
    await expect
      .poll(() =>
        Array.from(document.querySelectorAll<HTMLLIElement>('[role="option"]')).find((el) =>
          el.textContent?.includes(repoB.name),
        ),
      )
      .toBeTruthy();
    const optB = Array.from(document.querySelectorAll<HTMLLIElement>('[role="option"]')).find(
      (el) => el.textContent?.includes(repoB.name),
    )!;
    optB.click();

    // with autopilotTouched pinned, the re-seed $effect must NOT flip it back on
    await expect.poll(() => segActive(m.newtask_mode_research())).toBe(true);
    await expect.poll(() => isOn(autopilotBox())).toBe(false);

    // backstop: submit carries explicit false (not null) — proves the touched pin held
    await fillAndSubmit();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({ autopilotEnabled: false, research: true });
  });

  it("disables plan-gate and Autopilot while Research is on, re-enables back on Code", async () => {
    render(NewTask, { props: base() });
    await expect.poll(() => researchSeg()).toBeTruthy();

    // Research on → both rows lock (visible exclusivity, not silent re-checkable)
    researchSeg().click();
    await expect.poll(() => segActive(m.newtask_mode_research())).toBe(true);
    await expect.poll(() => planGateBox()?.disabled).toBe(true);
    await expect.poll(() => autopilotBox()?.disabled).toBe(true);

    // back to Code → both rows unlock (values stay pinned off — checkbox parity)
    codeSeg().click();
    await expect.poll(() => segActive(m.newtask_mode_code())).toBe(true);
    await expect.poll(() => planGateBox()?.disabled).toBe(false);
    await expect.poll(() => autopilotBox()?.disabled).toBe(false);
  });

  it("disables the autonomous sandbox option when Research is on", async () => {
    render(NewTask, { props: base() });
    await expect.poll(() => researchSeg()).toBeTruthy();

    expect(autonomousOption().disabled).toBe(false);
    researchSeg().click();
    await expect.poll(() => segActive(m.newtask_mode_research())).toBe(true);
    await expect.poll(() => autonomousOption().disabled).toBe(true);
  });

  it("resets autonomous sandbox to default when Research is toggled on", async () => {
    render(NewTask, { props: base() });
    await expect.poll(() => sandboxSelect()).toBeTruthy();

    // pick autonomous first
    sandboxSelect().value = "autonomous";
    sandboxSelect().dispatchEvent(new Event("change", { bubbles: true }));
    await expect.poll(() => sandboxSelect().value).toBe("autonomous");

    // switch to research → sandbox should reset
    researchSeg().click();
    await expect.poll(() => segActive(m.newtask_mode_research())).toBe(true);
    await expect.poll(() => sandboxSelect().value).toBe("default");
  });

  it("submits research:true when Research is checked", async () => {
    const captured = vi.fn();
    render(NewTask, {
      props: base({ onsubmit: captured, initialRepoPath: "/repo/research-submit" }),
    });
    await expect.poll(() => researchSeg()).toBeTruthy();

    researchSeg().click();
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

describe("NewTask repo shortcuts", () => {
  // Three repos in list order: alpha, bravo, charlie.
  // bravo has the highest recentAgentCount → recents[0]
  // charlie has lower count but a more recent lastUsedAt → recents[1]
  // alpha has no recent activity → excluded from recents entirely
  // So recentRepos order is: bravo, charlie (only 2 have positive counts).
  // Note charlie is list-index 2 but recents-index 1 — proves the digit jump
  // reads the recents ranking, not the list order.
  const repoA: RepoEntry = {
    name: "alpha",
    path: "/repo/alpha",
    display: "alpha",
    realPath: "/repo/alpha",
  };
  const repoB: RepoEntry = {
    name: "bravo",
    path: "/repo/bravo",
    display: "bravo",
    realPath: "/repo/bravo",
    recentAgentCount: 5,
    lastUsedAt: 1000,
  };
  const repoC: RepoEntry = {
    name: "charlie",
    path: "/repo/charlie",
    display: "charlie",
    realPath: "/repo/charlie",
    recentAgentCount: 2,
    lastUsedAt: 2000,
  };
  const repos = [repoA, repoB, repoC];

  function triggerLabel() {
    return document.querySelector<HTMLElement>(".rs-trigger b")?.textContent ?? null;
  }

  function press(code: string, opts: KeyboardEventInit = {}) {
    const ta = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    ta.focus();
    ta.dispatchEvent(
      new KeyboardEvent("keydown", {
        code,
        altKey: true,
        bubbles: true,
        cancelable: true,
        ...opts,
      }),
    );
  }

  beforeEach(() => {
    mockListRepos.mockResolvedValue({ repos, recentWindowDays: 30 });
  });

  it("Alt+] advances to the next repo; wraps from last to first", async () => {
    // start at alpha (index 0); ] → bravo (index 1)
    render(NewTask, { props: base({ initialRepoPath: repoA.path }) });
    await expect.poll(() => triggerLabel()).toBe(repoA.name);

    press("BracketRight");
    await expect.poll(() => triggerLabel()).toBe(repoB.name);

    // advance to charlie (index 2)
    press("BracketRight");
    await expect.poll(() => triggerLabel()).toBe(repoC.name);

    // wrap from last → first
    press("BracketRight");
    await expect.poll(() => triggerLabel()).toBe(repoA.name);
  });

  it("Alt+[ moves to the previous repo; wraps from first to last", async () => {
    // start at alpha (index 0); [ → wrap to charlie (index 2)
    render(NewTask, { props: base({ initialRepoPath: repoA.path }) });
    await expect.poll(() => triggerLabel()).toBe(repoA.name);

    press("BracketLeft");
    await expect.poll(() => triggerLabel()).toBe(repoC.name);

    // previous from charlie → bravo
    press("BracketLeft");
    await expect.poll(() => triggerLabel()).toBe(repoB.name);
  });

  it("Alt+2 selects the 2nd recent repo (charlie, differs from list order)", async () => {
    // list order: alpha, bravo, charlie
    // recents order: bravo (count=5), charlie (count=2, more recent lastUsedAt)
    // Digit2 → charlie (index 1 in recents)
    render(NewTask, { props: base({ initialRepoPath: repoA.path }) });
    await expect.poll(() => triggerLabel()).toBe(repoA.name);

    press("Digit2");
    await expect.poll(() => triggerLabel()).toBe(repoC.name);
  });

  it("Alt+3 is a silent no-op when only 2 recents exist", async () => {
    // only repoB and repoC have recentAgentCount > 0, so recents has 2 entries
    render(NewTask, { props: base({ initialRepoPath: repoA.path }) });
    await expect.poll(() => triggerLabel()).toBe(repoA.name);

    press("Digit3");
    // label stays unchanged
    await expect.poll(() => triggerLabel()).toBe(repoA.name);
  });

  it("Alt+R opens the picker and focuses the filter input", async () => {
    render(NewTask, { props: base({ initialRepoPath: repoA.path }) });
    await expect.poll(() => triggerLabel()).toBe(repoA.name);

    press("KeyR");
    await expect.poll(() => document.querySelector(".rs-panel")).toBeTruthy();
    await expect
      .poll(() => document.activeElement === document.querySelector(".rs-filter"))
      .toBe(true);
  });

  it("Enter after filtering a repo closes the picker and focuses the prompt", async () => {
    render(NewTask, { props: base({ initialRepoPath: repoA.path }) });
    await expect.poll(() => triggerLabel()).toBe(repoA.name);

    press("KeyR");
    await expect.poll(() => document.querySelector(".rs-filter")).toBeTruthy();
    const filter = document.querySelector<HTMLInputElement>(".rs-filter")!;
    await expect.poll(() => document.activeElement).toBe(filter);

    filter.value = "char";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    await expect
      .poll(
        () =>
          document.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.textContent,
      )
      .toContain(repoC.name);

    filter.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );

    await expect.poll(() => triggerLabel()).toBe(repoC.name);
    await expect.poll(() => document.querySelector(".rs-panel")).toBeFalsy();
    expect(document.activeElement).toBe(document.querySelector("#nt-prompt"));
  });

  it("Escape in open picker closes dropdown but not the modal, refocuses prompt", async () => {
    const onclose = vi.fn();
    render(NewTask, { props: base({ initialRepoPath: repoA.path, onclose }) });
    await expect.poll(() => triggerLabel()).toBe(repoA.name);

    // Open the picker via Alt+R
    press("KeyR");
    await expect.poll(() => document.querySelector(".rs-panel")).toBeTruthy();

    // Dispatch Escape from inside .rs-root (mirroring real focus on the filter input)
    const filter = document.querySelector<HTMLInputElement>(".rs-filter")!;
    filter.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );

    // Dropdown closes
    await expect.poll(() => document.querySelector(".rs-panel")).toBeFalsy();
    // Modal stays mounted (onclose did NOT fire)
    expect(document.querySelector("#nt-prompt")).toBeTruthy();
    expect(onclose).not.toHaveBeenCalled();
    // Prompt is refocused
    expect(document.activeElement).toBe(document.querySelector("#nt-prompt"));
  });

  it("bare ] without Alt does NOT change the selected repo", async () => {
    render(NewTask, { props: base({ initialRepoPath: repoA.path }) });
    await expect.poll(() => triggerLabel()).toBe(repoA.name);

    // fire without altKey
    press("BracketRight", { altKey: false });
    // label must remain unchanged
    expect(triggerLabel()).toBe(repoA.name);
  });
});

describe("NewTask upstream status hint", () => {
  it("renders behind hint when branch is behind origin and not diverged", async () => {
    mockBranchStatus.mockResolvedValue({
      behind: 4,
      ahead: 0,
      diverged: false,
      hasUpstream: true,
      localExists: true,
    });
    render(NewTask, { props: base({ initialRepoPath: "/repo/upstream-behind" }) });
    // The effect debounces 300ms then resolves; poll until the hint appears
    await expect
      .poll(() => document.querySelector(".nt-upstream")?.textContent, { timeout: 2000 })
      .toContain("4");
    expect(document.querySelector(".nt-upstream-warn")).toBeNull();
  });

  it("renders diverged hint (with warn styling) when branch has diverged", async () => {
    mockBranchStatus.mockResolvedValue({
      behind: 2,
      ahead: 3,
      diverged: true,
      hasUpstream: true,
      localExists: true,
    });
    render(NewTask, { props: base({ initialRepoPath: "/repo/upstream-diverged" }) });
    await expect
      .poll(() => document.querySelector(".nt-upstream-warn")?.textContent, { timeout: 2000 })
      .toBeTruthy();
    const hint = document.querySelector(".nt-upstream-warn")!;
    expect(hint.textContent).toContain("2");
    expect(hint.textContent).toContain("3");
  });

  it("renders nothing when branch is up to date (behind:0, diverged:false)", async () => {
    mockBranchStatus.mockResolvedValue({
      behind: 0,
      ahead: 0,
      diverged: false,
      hasUpstream: true,
      localExists: true,
    });
    render(NewTask, { props: base({ initialRepoPath: "/repo/upstream-utd" }) });
    // Give the debounce time to fire and resolve
    await new Promise((r) => setTimeout(r, 600));
    expect(document.querySelector(".nt-upstream")).toBeNull();
  });

  it("blocks an unborn base branch and repairs it with an initial commit", async () => {
    mockListBranches
      .mockResolvedValueOnce({ current: null, branches: [], default: null })
      .mockResolvedValue({ current: "main", branches: ["main"], default: null });
    mockBranchStatus
      .mockResolvedValueOnce({
        behind: 0,
        ahead: 0,
        diverged: false,
        hasUpstream: false,
        localExists: false,
      })
      .mockResolvedValue({
        behind: 0,
        ahead: 0,
        diverged: false,
        hasUpstream: false,
        localExists: true,
      });
    mockInitEmptyCommit.mockResolvedValue({ branch: "main" });
    const onsubmit = vi.fn();
    render(NewTask, { props: base({ initialRepoPath: "/repo/unborn", onsubmit }) });

    await expect
      .poll(() => document.querySelector(".nt-base-repair")?.textContent, { timeout: 2000 })
      .toContain("initial commit");
    const run = document.querySelector<HTMLButtonElement>("button.run")!;
    expect(run.disabled).toBe(true);

    document.querySelector<HTMLButtonElement>(".nt-base-repair button")!.click();
    await expect.poll(() => mockInitEmptyCommit.mock.calls.length).toBe(1);
    expect(mockInitEmptyCommit).toHaveBeenCalledWith("/repo/unborn", "main");
    await expect.poll(() => document.querySelector(".nt-base-repair")).toBeNull();

    // The CTA stays disabled until the prompt is non-empty (readiness rule) — the
    // base_missing blocker itself is cleared, which typing proves:
    const promptField = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    promptField.value = "do the thing";
    promptField.dispatchEvent(new Event("input", { bubbles: true }));
    await expect.poll(() => run.disabled).toBe(false);
    run.click();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
  });
});

describe("NewTask base branch default", () => {
  const submitBtn = () => document.querySelector<HTMLButtonElement>("button.run")!;
  const baseSelect = () => document.querySelector<HTMLSelectElement>("#nt-base")!;

  async function fillAndSubmit() {
    const promptField = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    promptField.value = "do the thing";
    promptField.dispatchEvent(new Event("input", { bubbles: true }));
    await expect.poll(() => submitBtn().disabled).toBe(false);
    submitBtn().click();
  }

  // Regression: the base must prefer the repo default branch (origin/HEAD) over the
  // currently-checked-out branch. flowagent sits on `main` but defaults to `dev`; basing
  // on `main` is what made the plan reviewer ground on a stale branch (TASK-581).
  it("preselects the repo default branch over the current checkout", async () => {
    mockListBranches.mockResolvedValue({
      current: "main",
      branches: ["main", "dev"],
      default: "dev",
    });
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: "/repo/default-pref" } });

    await expect.poll(() => baseSelect().value).toBe("dev");
    await fillAndSubmit();

    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({ baseBranch: "dev" });
  });

  // The default branch (origin/HEAD) need not exist locally — surface it as an option so
  // the dropdown's shown value matches the submitted base (not a silently-mismatched first
  // option). Here `dev` is the default but only `main` exists locally.
  it("includes a non-local default branch as a selectable option", async () => {
    mockListBranches.mockResolvedValue({
      current: "main",
      branches: ["main"],
      default: "dev",
    });
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: "/repo/nonlocal-default" } });

    await expect.poll(() => baseSelect().value).toBe("dev");
    const options = Array.from(baseSelect().options).map((o) => o.value);
    expect(options).toContain("dev");
    await fillAndSubmit();

    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({ baseBranch: "dev" });
  });
});

describe("NewTask fableAvailable prop", () => {
  const modelSelect = () => document.querySelector<HTMLSelectElement>("#nt-model")!;

  it("hides the fable option and does not preselect it when fableAvailable=false", async () => {
    render(NewTask, { props: base({ fableAvailable: false }) });

    // fable option must not be present in the select
    const options = Array.from(modelSelect().options).map((o) => o.value);
    expect(options).not.toContain("fable");

    // selected value must not be "fable"
    expect(modelSelect().value).not.toBe("fable");
  });

  it("shows the fable option when fableAvailable=true (default)", async () => {
    render(NewTask, { props: base({ fableAvailable: true }) });

    const options = Array.from(modelSelect().options).map((o) => o.value);
    expect(options).toContain("fable");
  });

  it("shows the fable option when fableAvailable is omitted (defaults to true)", async () => {
    render(NewTask, { props: base() });

    const options = Array.from(modelSelect().options).map((o) => o.value);
    expect(options).toContain("fable");
  });

  it("falls back from fable to default when initialModel=fable and fableAvailable=false", async () => {
    render(NewTask, { props: base({ initialModel: "fable", fableAvailable: false }) });

    expect(modelSelect().value).toBe("default");
  });

  it("shows the unavailability hint when fableAvailable=false", async () => {
    render(NewTask, { props: base({ fableAvailable: false }) });

    const hint = document.querySelector(".field .field-note");
    expect(hint?.textContent).toContain(m.newtask_fable_unavailable());
  });

  it("does not show the unavailability hint when fableAvailable=true", async () => {
    render(NewTask, { props: base({ fableAvailable: true }) });

    expect(document.querySelector(".field .field-note")).toBeNull();
  });
});

describe("NewTask Codex model picker", () => {
  const providerSelect = () => document.querySelector<HTMLSelectElement>("#nt-agent-provider")!;
  const modelSelect = () => document.querySelector<HTMLSelectElement>("#nt-model")!;

  it("shows codex models and uses the configured Codex default", async () => {
    render(NewTask, {
      props: base({
        defaultAgentProvider: "codex",
        defaultModel: "opus",
        defaultCodexModel: "gpt-5.4",
      }),
    });

    await expect.poll(() => providerSelect().value).toBe("codex");
    await expect.poll(() => modelSelect().value).toBe("gpt-5.4");
    const options = Array.from(modelSelect().options).map((o) => o.value);
    expect(options).toContain("gpt-5.5");
    expect(options.slice(0, 5)).toEqual([
      "default",
      "gpt-5.5",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(options).not.toContain("gpt-5.6");
    expect(options).not.toContain("opus");
    expect(modelSelect().disabled).toBe(false);
  });

  it("loads commands with the active codex provider", async () => {
    const repoPath = "/repo/codex-commands";
    render(NewTask, {
      props: base({ initialRepoPath: repoPath, defaultAgentProvider: "codex" }),
    });

    await expect
      .poll(() => mockGetCommands.mock.calls.some((call) => call[1]?.provider === "codex"))
      .toBe(true);
  });

  it("switching CLI restores each configured default", async () => {
    render(NewTask, {
      props: base({
        defaultAgentProvider: "claude",
        defaultModel: "opus",
        defaultCodexModel: "gpt-5.4",
      }),
    });

    await expect.poll(() => modelSelect().value).toBe("opus");
    providerSelect().value = "codex";
    providerSelect().dispatchEvent(new Event("change", { bubbles: true }));
    await expect.poll(() => modelSelect().value).toBe("gpt-5.4");
    providerSelect().value = "claude";
    providerSelect().dispatchEvent(new Event("change", { bubbles: true }));
    await expect.poll(() => modelSelect().value).toBe("opus");
  });

  it("submits the selected codex model", async () => {
    const repoPath = "/repo/codex-model";
    mockGetRepoConfig.mockResolvedValue(confirmedRepoConfig());
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, {
      props: { onsubmit, initialRepoPath: repoPath, defaultAgentProvider: "codex" },
    });

    await expect
      .poll(() => Array.from(modelSelect().options).map((o) => o.value))
      .toContain("gpt-5.4");
    modelSelect().value = "gpt-5.4";
    modelSelect().dispatchEvent(new Event("change", { bubbles: true }));

    await fillPromptAndClickRun();

    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]?.[0]).toMatchObject({
      agentProvider: "codex",
      model: "gpt-5.4",
    });
  });

  it("ignores an incompatible repo override and submits the configured Codex default", async () => {
    const repoPath = "/repo/codex-repo-override";
    mockGetRepoConfig.mockResolvedValue({ ...confirmedRepoConfig(), defaultModel: "opus" });
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, {
      props: {
        onsubmit,
        initialRepoPath: repoPath,
        defaultAgentProvider: "codex",
        defaultModel: "sonnet",
        defaultCodexModel: "gpt-5.4",
      },
    });

    await expect.poll(() => modelSelect().value).toBe("gpt-5.4");
    await fillPromptAndClickRun();

    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]?.[0]).toMatchObject({
      agentProvider: "codex",
      model: "gpt-5.4",
    });
  });
});

// ── Helpers shared by the confirm-step test suites ──────────────────────────

/** A RepoConfigResponse for unconfirmed brand-new repos (no row yet). */
function unconfirmedNewRepoConfig(): RepoConfig & {
  automationConfirmed: boolean;
  automationRowExists: boolean;
} {
  return {
    criticEnabled: true,
    criticAllPrs: false,
    criticSmellLensEnabled: false,
    autoAddressEnabled: false,
    learningsEnabled: true,
    autopilotEnabled: false,
    autoDrainEnabled: false,
    autoMergeEnabled: false,
    buildQueueEnabled: false,
    planGateEnabled: false,
    draftMode: false,
    signoffAuthority: "human",
    sandboxProfile: "trusted",
    maxAuto: 1,
    autoLabel: "shepherd:auto",
    usageCeilingPct: 80,
    defaultModel: "inherit",
    defaultEffort: "inherit",
    repoMode: "forge",
    autoOptimizeFlagged: false,
    manualStepsIssueEnabled: false,
    preWarmEpicLandingCi: false,
    hidden: false,
    previewStartScript: null,
    previewStartCommand: null,
    previewOpenMode: "ask",
    automationConfirmed: false,
    automationRowExists: false,
  };
}

/** A RepoConfigResponse for repos that have a row but haven't confirmed yet. */
function unconfirmedExistingRepoConfig(): RepoConfig & {
  automationConfirmed: boolean;
  automationRowExists: boolean;
} {
  return { ...unconfirmedNewRepoConfig(), automationRowExists: true };
}

/** A RepoConfigResponse for confirmed repos. */
function confirmedRepoConfig(): RepoConfig & {
  automationConfirmed: boolean;
  automationRowExists: boolean;
} {
  return { ...unconfirmedNewRepoConfig(), automationConfirmed: true, automationRowExists: true };
}

async function fillPromptAndClickRun() {
  const promptField = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
  promptField.value = "do the thing";
  promptField.dispatchEvent(new Event("input", { bubbles: true }));
  // Wait for the run button to be enabled (prompt filled)
  const runBtn = () => document.querySelector<HTMLButtonElement>("button.run");
  await expect.poll(() => runBtn()?.disabled).toBe(false);
  runBtn()!.click();
}

describe("NewTask first-task confirm step", () => {
  it("usage hold keeps the operator's Claude default and offers a manual handoff", async () => {
    const repoPath = "/repo/hold-keeps-claude";
    mockGetRepoConfig.mockResolvedValue(confirmedRepoConfig());
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    // Default CLI is Claude; a usage hold must NOT silently switch it to Codex.
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath, holdLikely: true } });

    const provider = () => document.querySelector<HTMLSelectElement>("#nt-agent-provider")!;
    await expect.poll(() => provider().value).toBe("claude");
    // Held → the dual Hold-for-reset / Submit-anyway buttons offer the handoff
    // without hijacking the selected CLI.
    await expect.poll(() => document.querySelector("button.run-hold")).toBeTruthy();
    expect(document.querySelector("button.run-anyway")).toBeTruthy();

    // The Codex hold note only appears once the operator picks Codex by hand.
    provider().value = "codex";
    provider().dispatchEvent(new Event("change", { bubbles: true }));
    await expect.poll(() => provider().value).toBe("codex");
    // The full Codex notes (incl. the hold note) live behind the one-line alpha
    // caution's "details" expander in the redesign.
    await expect
      .poll(() => document.querySelector<HTMLButtonElement>(".alpha-details"))
      .toBeTruthy();
    document.querySelector<HTMLButtonElement>(".alpha-details")!.click();
    await expect
      .element(page.getByText(m.newtask_agent_provider_codex_suggested_for_hold()))
      .toBeInTheDocument();
  });

  it("plan-gate stays available (live, not forced off) across Codex↔Claude flips — TASK-413", async () => {
    const repoPath = "/repo/codex-restore";
    // Repo defaults both automation toggles ON.
    mockGetRepoConfig.mockResolvedValue({
      ...confirmedRepoConfig(),
      planGateEnabled: true,
      autopilotEnabled: true,
    });
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    const provider = () => document.querySelector<HTMLSelectElement>("#nt-agent-provider")!;
    const planGateBox = planGateSwitch;
    const autopilotBox = autopilotSwitch;

    // Seeded ON from the repo default.
    await expect.poll(() => isOn(planGateBox())).toBe(true);
    await expect.poll(() => isOn(autopilotBox())).toBe(true);

    // Codex: plan-gate is now available (live + enabled, not forced off); autopilot too.
    provider().value = "codex";
    provider().dispatchEvent(new Event("change", { bubbles: true }));
    await expect.poll(() => planGateBox()?.disabled).toBe(false);
    expect(isOn(planGateBox())).toBe(true);
    await expect.poll(() => isOn(autopilotBox())).toBe(true);
    expect(autopilotBox().disabled).toBe(false);

    // Back to Claude → unchanged, still on/enabled.
    provider().value = "claude";
    provider().dispatchEvent(new Event("change", { bubbles: true }));
    await expect.poll(() => isOn(planGateBox())).toBe(true);
    await expect.poll(() => isOn(autopilotBox())).toBe(true);
    expect(planGateBox().disabled).toBe(false);
    expect(autopilotBox().disabled).toBe(false);
  });

  it("a manual plan-gate override survives a Codex round-trip and the box stays live — TASK-413", async () => {
    const repoPath = "/repo/codex-preserve-override";
    // Repo defaults both automation toggles OFF.
    mockGetRepoConfig.mockResolvedValue(confirmedRepoConfig());
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    const provider = () => document.querySelector<HTMLSelectElement>("#nt-agent-provider")!;
    const planGateBox = planGateSwitch;
    const autopilotBox = autopilotSwitch;

    // Settle, then manually turn BOTH on — differs from the repo default.
    await expect.poll(() => planGateBox()?.disabled).toBe(false);
    planGateBox().click();
    autopilotBox().click();
    await expect.poll(() => isOn(planGateBox())).toBe(true);
    await expect.poll(() => isOn(autopilotBox())).toBe(true);

    // Codex: plan-gate stays ON and the box stays live (no forced-off display anymore); autopilot too.
    provider().value = "codex";
    provider().dispatchEvent(new Event("change", { bubbles: true }));
    await expect.poll(() => isOn(planGateBox())).toBe(true);
    expect(planGateBox().disabled).toBe(false);
    await expect.poll(() => isOn(autopilotBox())).toBe(true);
    expect(autopilotBox().disabled).toBe(false);

    // Back to Claude → the manual override is intact.
    provider().value = "claude";
    provider().dispatchEvent(new Event("change", { bubbles: true }));
    await expect.poll(() => isOn(planGateBox())).toBe(true);
    await expect.poll(() => isOn(autopilotBox())).toBe(true);
  });

  it("confirmed repo: Run calls onsubmit directly, no confirm step shown", async () => {
    const repoPath = "/repo/ftac-confirmed";
    mockGetRepoConfig.mockResolvedValue(confirmedRepoConfig());
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    // Wait for config to settle (plan-gate box becomes enabled)
    await expect.poll(() => planGateSwitch()).toBeTruthy();

    await fillPromptAndClickRun();

    // Confirm step must NOT appear
    expect(document.querySelector(".ftac")).toBeNull();
    // onsubmit must have been called
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
  });

  it("unconfirmed brand-new repo: Run shows confirm step, does NOT call onsubmit, calls seedNewRepoDefaults", async () => {
    const repoPath = "/repo/ftac-new-unconfirmed";
    mockGetRepoConfig.mockResolvedValue(unconfirmedNewRepoConfig());
    // putRepoConfig is called by seedNewRepoDefaults
    mockPutRepoConfig.mockResolvedValue(unconfirmedNewRepoConfig());
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    await expect.poll(() => planGateSwitch()).toBeTruthy();
    await fillPromptAndClickRun();

    // Confirm step appears
    await expect.poll(() => document.querySelector(".ftac")).toBeTruthy();
    // onsubmit must NOT have been called
    expect(onsubmit).not.toHaveBeenCalled();
    // putRepoConfig was called for seedNewRepoDefaults (planGateEnabled: true)
    await expect.poll(() => mockPutRepoConfig.mock.calls.length).toBeGreaterThanOrEqual(1);
    const seedCall = mockPutRepoConfig.mock.calls.find((c) => c[1]?.planGateEnabled === true);
    expect(seedCall).toBeTruthy();
  });

  it("unconfirmed brand-new repo + Codex: skips Claude automation confirm and submits", async () => {
    const repoPath = "/repo/ftac-codex-unconfirmed";
    mockGetRepoConfig.mockResolvedValue(unconfirmedNewRepoConfig());
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, {
      props: { onsubmit, initialRepoPath: repoPath, defaultAgentProvider: "codex" },
    });

    await expect.poll(() => planGateSwitch()).toBeTruthy();
    await fillPromptAndClickRun();

    expect(document.querySelector(".ftac")).toBeNull();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(mockPutRepoConfig).not.toHaveBeenCalled();
    expect(onsubmit.mock.calls[0]?.[0]?.agentProvider).toBe("codex");
  });

  it("unconfirmed but row exists: confirm step appears, seedNewRepoDefaults NOT called", async () => {
    const repoPath = "/repo/ftac-existing-unconfirmed";
    mockGetRepoConfig.mockResolvedValue(unconfirmedExistingRepoConfig());
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    await expect.poll(() => planGateSwitch()).toBeTruthy();
    await fillPromptAndClickRun();

    // Confirm step appears
    await expect.poll(() => document.querySelector(".ftac")).toBeTruthy();
    // putRepoConfig must NOT have been called (no seed)
    expect(mockPutRepoConfig).not.toHaveBeenCalled();
    expect(onsubmit).not.toHaveBeenCalled();
  });

  it("Confirm: calls confirmAutomation (putRepoConfig with automationConfirmed:true) then onsubmit", async () => {
    const repoPath = "/repo/ftac-confirm-action";
    mockGetRepoConfig.mockResolvedValue(unconfirmedNewRepoConfig());
    // seed call
    mockPutRepoConfig.mockResolvedValueOnce(unconfirmedNewRepoConfig());
    // confirm call
    mockPutRepoConfig.mockResolvedValueOnce(confirmedRepoConfig());
    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    await expect.poll(() => planGateSwitch()).toBeTruthy();
    await fillPromptAndClickRun();

    // Wait for confirm step
    await expect.poll(() => document.querySelector(".ftac")).toBeTruthy();

    // Click Confirm
    const confirmBtn = page.getByRole("button", { name: m.firsttask_confirm_cta() });
    await confirmBtn.click();

    // onsubmit must have been called
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    // putRepoConfig was called with automationConfirmed: true
    const confirmCall = mockPutRepoConfig.mock.calls.find(
      (c) => c[1]?.automationConfirmed === true,
    );
    expect(confirmCall).toBeTruthy();
  });

  it("Cancel: hides confirm step and does NOT call onsubmit", async () => {
    const repoPath = "/repo/ftac-cancel";
    mockGetRepoConfig.mockResolvedValue(unconfirmedNewRepoConfig());
    mockPutRepoConfig.mockResolvedValue(unconfirmedNewRepoConfig());
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    await expect.poll(() => planGateSwitch()).toBeTruthy();
    await fillPromptAndClickRun();

    // Wait for confirm step
    await expect.poll(() => document.querySelector(".ftac")).toBeTruthy();

    // Click Cancel
    const cancelBtn = page.getByRole("button", { name: m.common_cancel() });
    await cancelBtn.click();

    // Confirm step is gone; back to form
    await expect.poll(() => document.querySelector(".ftac")).toBeFalsy();
    await expect.poll(() => document.querySelector("#nt-prompt")).toBeTruthy();
    expect(onsubmit).not.toHaveBeenCalled();
  });

  it("confirm PUT fails: onsubmit NOT called, confirm step still shown, error visible", async () => {
    const repoPath = "/repo/ftac-confirm-reject";
    mockGetRepoConfig.mockResolvedValue(unconfirmedNewRepoConfig());
    // seedNewRepoDefaults call (first put)
    mockPutRepoConfig.mockResolvedValueOnce(unconfirmedNewRepoConfig());
    // confirmAutomation call (second put) rejects
    mockPutRepoConfig.mockRejectedValueOnce(new Error("network error"));
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    await expect.poll(() => planGateSwitch()).toBeTruthy();
    await fillPromptAndClickRun();

    // Confirm step appears
    await expect.poll(() => document.querySelector(".ftac")).toBeTruthy();

    // Click Confirm — the PUT will reject
    const confirmBtn = page.getByRole("button", { name: m.firsttask_confirm_cta() });
    await confirmBtn.click();

    // onsubmit must NOT have been called
    expect(onsubmit).not.toHaveBeenCalled();
    // Confirm step must still be shown
    await expect.poll(() => document.querySelector(".ftac")).toBeTruthy();
    // Error must be visible inside the confirm step
    await expect.poll(() => document.querySelector(".ftac .err")).toBeTruthy();
    expect(document.querySelector(".ftac .err")?.textContent).toBeTruthy();
  });

  it("double-click Confirm spawns exactly once (re-entry guard)", async () => {
    const repoPath = "/repo/ftac-double-click";
    mockGetRepoConfig.mockResolvedValue(unconfirmedNewRepoConfig());
    // seedNewRepoDefaults
    mockPutRepoConfig.mockResolvedValueOnce(unconfirmedNewRepoConfig());

    // confirmAutomation: use a deferred promise so both clicks arrive before it resolves
    let resolveConfirm!: (
      v: RepoConfig & { automationConfirmed: boolean; automationRowExists: boolean },
    ) => void;
    const confirmPromise = new Promise<
      RepoConfig & { automationConfirmed: boolean; automationRowExists: boolean }
    >((res) => {
      resolveConfirm = res;
    });
    mockPutRepoConfig.mockReturnValueOnce(confirmPromise);

    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    await expect.poll(() => planGateSwitch()).toBeTruthy();
    await fillPromptAndClickRun();

    // Confirm step must appear
    await expect.poll(() => document.querySelector(".ftac")).toBeTruthy();

    // Find the Confirm button by its text content (it has no aria-label — text node only)
    const confirmBtn = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".ftac button"),
    ).find((b) => b.textContent?.trim() === m.firsttask_confirm_cta())!;
    // Click Confirm twice in rapid succession before the promise resolves
    confirmBtn.click();
    confirmBtn.click();

    // Now resolve the confirm promise
    resolveConfirm(confirmedRepoConfig());

    // onsubmit must be called at most once (not twice)
    await expect.poll(() => onsubmit.mock.calls.length, { timeout: 3000 }).toBe(1);
    expect(onsubmit.mock.calls.length).toBe(1);
  });

  it("settle race: ensure resolving to confirmed repo spawns directly with no spurious step", async () => {
    const repoPath = "/repo/ftac-settle-race";

    let resolveConfig!: (v: RepoConfig) => void;
    const configPromise = new Promise<RepoConfig>((res) => {
      resolveConfig = res;
    });
    mockGetRepoConfig.mockReturnValue(configPromise);

    const onsubmit = vi.fn().mockResolvedValue(undefined);
    render(NewTask, { props: { onsubmit, initialRepoPath: repoPath } });

    // Fill prompt while config is still in flight
    const promptField = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    promptField.value = "do the thing";
    promptField.dispatchEvent(new Event("input", { bubbles: true }));

    // Click Run while config is still loading (submitting guard: not yet enabled, but
    // the submit() gate only checks prompt+repoPath+submitting, so we wait for the
    // store to settle via ensure() before it reads confirmed state — we resolve AFTER click)
    // We need to wait for the run button to NOT be disabled (prompt is filled).
    const runBtn = () => document.querySelector<HTMLButtonElement>("button.run");
    await expect.poll(() => runBtn()?.disabled).toBe(false);
    runBtn()!.click();

    // Before config settles — neither step is active yet (submit is awaiting ensure())
    // Now resolve with a confirmed config
    resolveConfig(confirmedRepoConfig());

    // Because ensure() awaited, reads happen AFTER it resolves → confirmed → spawn directly
    await expect.poll(() => onsubmit.mock.calls.length, { timeout: 3000 }).toBe(1);
    // Confirm step must NOT have appeared
    expect(document.querySelector(".ftac")).toBeNull();
  });
});

// ── FirstTaskAutomationConfirm component tests ──────────────────────────────

describe("FirstTaskAutomationConfirm", () => {
  it("renders title, intro with repo basename, and both buttons", async () => {
    const onconfirm = vi.fn();
    const oncancel = vi.fn();
    render(FirstTaskAutomationConfirm, {
      props: { active: true, repoPath: "/home/user/my-project", onconfirm, oncancel },
    });

    await expect.element(page.getByText(m.firsttask_confirm_title())).toBeInTheDocument();
    // intro interpolates the basename ("my-project")
    const intro = document.querySelector(".ftac-intro");
    expect(intro?.textContent).toContain("my-project");
    await expect
      .element(page.getByRole("button", { name: m.firsttask_confirm_cta() }))
      .toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: m.common_cancel() })).toBeInTheDocument();
  });

  it("Confirm button calls onconfirm", async () => {
    const onconfirm = vi.fn();
    const oncancel = vi.fn();
    render(FirstTaskAutomationConfirm, {
      props: { active: true, repoPath: "/repo/test", onconfirm, oncancel },
    });

    await page.getByRole("button", { name: m.firsttask_confirm_cta() }).click();
    expect(onconfirm).toHaveBeenCalledOnce();
    expect(oncancel).not.toHaveBeenCalled();
  });

  it("Cancel button calls oncancel", async () => {
    const onconfirm = vi.fn();
    const oncancel = vi.fn();
    render(FirstTaskAutomationConfirm, {
      props: { active: true, repoPath: "/repo/test", onconfirm, oncancel },
    });

    await page.getByRole("button", { name: m.common_cancel() }).click();
    expect(oncancel).toHaveBeenCalledOnce();
    expect(onconfirm).not.toHaveBeenCalled();
  });

  it("Confirm button is disabled when submitting=true", async () => {
    const onconfirm = vi.fn();
    const oncancel = vi.fn();
    render(FirstTaskAutomationConfirm, {
      props: { active: true, repoPath: "/repo/test", onconfirm, oncancel, submitting: true },
    });

    const confirmBtn = document.querySelector<HTMLButtonElement>(`button[disabled]`);
    expect(confirmBtn).toBeTruthy();
    expect(confirmBtn?.textContent?.trim()).toContain(m.firsttask_confirm_cta());
  });
});

describe("NewTask — hidden repos excluded from keyboard selection paths", () => {
  // The bold name in the repo picker's trigger reflects the currently-selected repo.
  const selectedRepo = () => document.querySelector(".rs-trigger b")?.textContent ?? "";

  // The repo Alt-tier shortcuts listen on the dialog <form> (keydown bubbles up from the
  // prompt textarea), keyed on physical e.code. Dispatch there to drive them in a test.
  function altChord(code: string) {
    document
      .querySelector("form")!
      .dispatchEvent(new KeyboardEvent("keydown", { code, altKey: true, bubbles: true }));
  }

  it("default selection skips a hidden repo even when it's the most-recently-used", async () => {
    const visible: RepoEntry = {
      name: "visible",
      path: "/repo/hh-default-visible",
      display: "visible",
      realPath: "/repo/hh-default-visible",
      lastUsedAt: 100,
    };
    const secret: RepoEntry = {
      name: "secret",
      path: "/repo/hh-default-secret",
      display: "secret",
      realPath: "/repo/hh-default-secret",
      lastUsedAt: 999, // most-recently-used, but hidden → must not be auto-selected
      hidden: true,
    };
    mockListRepos.mockResolvedValue({ repos: [secret, visible], recentWindowDays: 30 });
    render(NewTask, { props: base() });

    await expect.poll(() => selectedRepo()).toBe("visible");
  });

  it("Alt+] cycle steps over a hidden repo instead of surfacing it", async () => {
    const a: RepoEntry = {
      name: "aaa",
      path: "/repo/hh-cyc-a",
      display: "aaa",
      realPath: "/repo/hh-cyc-a",
    };
    const hidden: RepoEntry = {
      name: "hhh",
      path: "/repo/hh-cyc-hidden",
      display: "hhh",
      realPath: "/repo/hh-cyc-hidden",
      hidden: true,
    };
    const c: RepoEntry = {
      name: "ccc",
      path: "/repo/hh-cyc-c",
      display: "ccc",
      realPath: "/repo/hh-cyc-c",
    };
    mockListRepos.mockResolvedValue({ repos: [a, hidden, c], recentWindowDays: 30 });
    render(NewTask, { props: base({ initialRepoPath: a.path }) });

    await expect.poll(() => selectedRepo()).toBe("aaa");
    altChord("BracketRight");
    // The cycle skips the hidden "hhh" between aaa and ccc and lands on ccc.
    await expect.poll(() => selectedRepo()).toBe("ccc");
  });

  it("Alt+1 digit shortcut never targets a hidden repo", async () => {
    const secret: RepoEntry = {
      name: "secret",
      path: "/repo/hh-dig-secret",
      display: "secret",
      realPath: "/repo/hh-dig-secret",
      recentAgentCount: 9, // would be the #1 recent if not hidden
      hidden: true,
    };
    const realtop: RepoEntry = {
      name: "realtop",
      path: "/repo/hh-dig-top",
      display: "realtop",
      realPath: "/repo/hh-dig-top",
      recentAgentCount: 5,
    };
    const other: RepoEntry = {
      name: "other",
      path: "/repo/hh-dig-other",
      display: "other",
      realPath: "/repo/hh-dig-other",
    };
    mockListRepos.mockResolvedValue({ repos: [secret, realtop, other], recentWindowDays: 30 });
    render(NewTask, { props: base({ initialRepoPath: other.path }) });

    await expect.poll(() => selectedRepo()).toBe("other");
    altChord("Digit1");
    // Alt+1 = first NON-hidden recent (realtop), never the higher-count hidden "secret".
    await expect.poll(() => selectedRepo()).toBe("realtop");
  });

  it("cycle from a hidden current repo enters the visible subset at its boundary", async () => {
    const vis1: RepoEntry = {
      name: "vis1",
      path: "/repo/hh-bnd-1",
      display: "vis1",
      realPath: "/repo/hh-bnd-1",
    };
    const hiddenCur: RepoEntry = {
      name: "hcur",
      path: "/repo/hh-bnd-hidden",
      display: "hcur",
      realPath: "/repo/hh-bnd-hidden",
      hidden: true,
    };
    const vis2: RepoEntry = {
      name: "vis2",
      path: "/repo/hh-bnd-2",
      display: "vis2",
      realPath: "/repo/hh-bnd-2",
    };
    mockListRepos.mockResolvedValue({ repos: [vis1, hiddenCur, vis2], recentWindowDays: 30 });
    // Seeded selection is the hidden repo (still shown in the trigger), so cur === -1 in
    // the visible subset [vis1, vis2].
    render(NewTask, { props: base({ initialRepoPath: hiddenCur.path }) });

    await expect.poll(() => selectedRepo()).toBe("hcur");
    // Forward enters at the FIRST visible repo (not the second).
    altChord("BracketRight");
    await expect.poll(() => selectedRepo()).toBe("vis1");
  });

  it("backward cycle from a hidden current repo enters at the last visible repo", async () => {
    const vis1: RepoEntry = {
      name: "vis1",
      path: "/repo/hh-bnd-b1",
      display: "vis1",
      realPath: "/repo/hh-bnd-b1",
    };
    const hiddenCur: RepoEntry = {
      name: "hcur",
      path: "/repo/hh-bnd-b-hidden",
      display: "hcur",
      realPath: "/repo/hh-bnd-b-hidden",
      hidden: true,
    };
    const vis2: RepoEntry = {
      name: "vis2",
      path: "/repo/hh-bnd-b2",
      display: "vis2",
      realPath: "/repo/hh-bnd-b2",
    };
    mockListRepos.mockResolvedValue({ repos: [vis1, hiddenCur, vis2], recentWindowDays: 30 });
    render(NewTask, { props: base({ initialRepoPath: hiddenCur.path }) });

    await expect.poll(() => selectedRepo()).toBe("hcur");
    // Backward enters at the LAST visible repo.
    altChord("BracketLeft");
    await expect.poll(() => selectedRepo()).toBe("vis2");
  });
});

describe("NewTask issue steer inject (context menu)", () => {
  const issueSteer: Steer = {
    id: "st1",
    label: "Fix it",
    text: "/fix please",
    inSteerBar: false,
    onIssues: true,
  };

  beforeEach(() => {
    steers.list = [issueSteer];
    mockListIssues.mockResolvedValue({
      slug: "o/r",
      webUrl: "https://gh/o/r",
      viewer: null,
      issues: [
        {
          number: 55,
          title: "Add widget",
          body: "the widget body",
          url: "https://gh/o/r/issues/55",
          labels: [],
          createdAt: 0,
          assignees: [],
          author: "bob",
        },
      ],
    });
  });
  afterEach(() => {
    steers.list = [];
  });

  // Right-click the (only) issue row and wait for the context menu to open. A mouse
  // pointerdown first pins lastPointerType away from "touch" so the contextmenu opens.
  async function openIssueMenu() {
    await page.getByRole("button", { name: m.promptsources_issues_tab(), exact: true }).click();
    await expect.poll(() => document.querySelectorAll(".ps-body .issue-source-row").length).toBe(1);
    const row = document.querySelector<HTMLElement>(".ps-body .issue-source-row")!;
    window.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse" }));
    row.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }),
    );
    await expect.poll(() => document.querySelector(".issue-menu")).not.toBeNull();
  }

  it("picking a steer injects its text into an EMPTY prompt (no #N template) and does NOT spawn", async () => {
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: "/repo" } });
    await openIssueMenu();

    await page
      .getByRole("menuitem", { name: m.issuemenu_inject_aria({ label: "Fix it" }) })
      .click();

    const prompt = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    await expect.poll(() => prompt.value).toBe("/fix please");
    // Injected, not launched.
    expect(onsubmit).not.toHaveBeenCalled();
    // The issue got attached as a reference (rides out-of-band, not dumped in the prompt).
    await expect
      .poll(() => document.querySelector(".issue-ref-link")?.textContent?.trim())
      .toBe("#55 Add widget");
  });

  it("picking a steer APPENDS its text to a non-empty prompt", async () => {
    render(NewTask, {
      props: { onsubmit: vi.fn(), initialRepoPath: "/repo", initialPrompt: "draft" },
    });
    await openIssueMenu();

    await page
      .getByRole("menuitem", { name: m.issuemenu_inject_aria({ label: "Fix it" }) })
      .click();

    const prompt = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    await expect.poll(() => prompt.value).toBe("draft\n/fix please");
  });

  it("Show details closes the menu and opens the details popover with the issue body", async () => {
    render(NewTask, { props: { onsubmit: vi.fn(), initialRepoPath: "/repo" } });
    await openIssueMenu();

    await page.getByRole("menuitem", { name: m.issuemenu_details() }).click();

    await expect.poll(() => document.querySelector(".issue-menu")).toBeNull();
    const pop = await vi.waitFor(() => {
      const el = document.querySelector(".issue-details");
      if (!el) throw new Error("popover not yet open");
      return el;
    });
    expect(pop.textContent).toContain("the widget body");
  });

  it("Open issue opens the forge URL in a new tab (no spawn)", async () => {
    const onsubmit = vi.fn();
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    render(NewTask, { props: { onsubmit, initialRepoPath: "/repo" } });
    await openIssueMenu();

    await page.getByRole("menuitem", { name: m.issuemenu_open() }).click();

    expect(openSpy).toHaveBeenCalledWith("https://gh/o/r/issues/55", "_blank", "noopener");
    expect(onsubmit).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });
});

describe("NewTask assigned-to-others notice (#1694)", () => {
  const attachedIssue = (assignees: string[]): Issue => ({
    number: 77,
    title: "Fix the thing",
    body: "",
    url: "https://gh/o/r/issues/77",
    labels: [],
    createdAt: 0,
    assignees,
  });

  const notice = () => document.querySelector(".issue-assigned-notice");

  it("shows the soft notice for an attached issue assigned to someone else", async () => {
    // Cache + listIssues agree on the viewer (PromptSources warms the cache to the same
    // value, so its async write can't clobber the seed).
    viewerCache.set("/repo-notice", "octocat");
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      webUrl: null,
      issues: [],
      viewer: "octocat",
    });
    render(NewTask, {
      props: base({
        initialRepoPath: "/repo-notice",
        initialIssue: attachedIssue(["someone-else"]),
      }),
    });

    await expect.poll(() => notice()).toBeTruthy();
    expect(notice()!.textContent).toContain(m.issuerow_assigned_notice({ who: "someone-else" }));
  });

  it("shows no notice for the viewer's own assigned issue", async () => {
    viewerCache.set("/repo-own", "octocat");
    mockListIssues.mockResolvedValue({
      slug: "owner/repo",
      webUrl: null,
      issues: [],
      viewer: "octocat",
    });
    render(NewTask, {
      props: base({ initialRepoPath: "/repo-own", initialIssue: attachedIssue(["octocat"]) }),
    });

    // The attachment renders; the notice must not (it's mine, not someone else's).
    await expect.poll(() => document.querySelector(".issue-ref-link")).toBeTruthy();
    expect(notice()).toBeNull();
  });

  it("shows no notice when the viewer is unknown (cache cold → fail closed)", async () => {
    // No viewerCache seed and listIssues returns a null viewer → assignedOthers is [].
    mockListIssues.mockResolvedValue({ slug: null, webUrl: null, issues: [], viewer: null });
    render(NewTask, {
      props: base({ initialRepoPath: "/repo-cold", initialIssue: attachedIssue(["someone-else"]) }),
    });

    await expect.poll(() => document.querySelector(".issue-ref-link")).toBeTruthy();
    expect(notice()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Redesign integration coverage (cross-component wiring + payload + geometry).
// Component-level behavior lives in the focused suites (InstrumentToggle,
// EngineCapacityLine, MobileEngineSheet); unit rules live in readiness/run-config/
// issue-trigger/issue-data tests.
// ─────────────────────────────────────────────────────────────────────────────

function typePrompt(text: string) {
  const el = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function pressCmdEnter(target?: HTMLElement) {
  (target ?? document.querySelector<HTMLElement>("form.card")!).dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
  );
}

function seedIssues(issues: Issue[]) {
  mockListIssues.mockResolvedValue({ slug: "owner/repo", webUrl: null, issues, viewer: null });
}

function mkIssue(n: number, title = `Issue ${n}`): Issue {
  return {
    number: n,
    title,
    body: "issue body",
    url: `https://example.com/issues/${n}`,
    labels: [],
    createdAt: 0,
    assignees: [],
  };
}

describe("NewTask form-level ⌘↵ guard (readiness)", () => {
  it("blocks with an empty prompt from outside the textarea, submits once typed", async () => {
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: "/repo/kbd-guard" } });
    await expect.poll(() => document.querySelector("form.card")).toBeTruthy();

    // Focus is NOT in the textarea: dispatch on the form itself. Blocker active →
    // no submission.
    pressCmdEnter();
    await new Promise((r) => setTimeout(r, 150));
    expect(onsubmit).not.toHaveBeenCalled();
    // The footer explains the blocker.
    expect(document.querySelector(".readiness")?.textContent).toContain(
      m.newtask_readiness_empty_prompt(),
    );

    typePrompt("do the thing");
    await expect
      .poll(() => document.querySelector<HTMLButtonElement>("button.run")?.disabled)
      .toBe(false);
    pressCmdEnter();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    // Ready state shows the branch preview line.
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({ prompt: "do the thing" });
  });
});

describe("NewTask issue-seeded submission (repo-aware activeIssue predicate)", () => {
  it("attach issue → clear prompt → CTA enabled, ⌘↵ submits template + issueRef", async () => {
    const issue = mkIssue(42, "Fix the flux capacitor");
    const onsubmit = vi.fn();
    render(NewTask, {
      props: { onsubmit, initialRepoPath: "/repo/seeded", initialIssue: issue },
    });
    // The seeded template prefills the prompt; the user deletes it all.
    await expect
      .poll(() => document.querySelector<HTMLTextAreaElement>("#nt-prompt")?.value ?? "")
      .not.toBe("");
    typePrompt("");
    // CTA stays enabled: the seeded issue satisfies the prompt rule.
    await expect
      .poll(() => document.querySelector<HTMLButtonElement>("button.run")?.disabled)
      .toBe(false);
    pressCmdEnter();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    const payload = onsubmit.mock.calls[0]![0];
    // An empty prompt materializes as the issue template; issueRef rides out-of-band.
    expect(payload.prompt).toBe(
      m.newtask_issue_prompt_template({ number: issue.number, title: issue.title }),
    );
    expect(payload.issueRef).toMatchObject({ number: 42 });
  });

  it("repo A issue → empty prompt → switch to repo B: both submit paths blocked", async () => {
    const repoA: RepoEntry = {
      name: "alpha",
      path: "/repo/seed-a",
      display: "alpha",
      realPath: "/repo/seed-a",
    };
    const repoB: RepoEntry = {
      name: "bravo",
      path: "/repo/seed-b",
      display: "bravo",
      realPath: "/repo/seed-b",
    };
    mockListRepos.mockResolvedValue({ repos: [repoA, repoB], recentWindowDays: 30 });
    const onsubmit = vi.fn();
    render(NewTask, {
      props: { onsubmit, initialRepoPath: repoA.path, initialIssue: mkIssue(7) },
    });
    await expect
      .poll(() => document.querySelector<HTMLTextAreaElement>("#nt-prompt")?.value ?? "")
      .not.toBe("");
    typePrompt("");
    await expect
      .poll(() => document.querySelector<HTMLButtonElement>("button.run")?.disabled)
      .toBe(false);

    // Switch to repo B via ⌥] (mutates repoPath directly).
    document
      .querySelector<HTMLElement>("form.card")!
      .dispatchEvent(
        new KeyboardEvent("keydown", { code: "BracketRight", altKey: true, bubbles: true }),
      );
    // The stale cross-repo attachment no longer satisfies the prompt rule.
    await expect
      .poll(() => document.querySelector<HTMLButtonElement>("button.run")?.disabled)
      .toBe(true);
    // Native form submit: blocked.
    document
      .querySelector<HTMLFormElement>("form.card")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    // Form-level shortcut: blocked.
    pressCmdEnter();
    await new Promise((r) => setTimeout(r, 150));
    expect(onsubmit).not.toHaveBeenCalled();
  });

  it("a non-empty repo-B submission does NOT carry the stale repo-A issueRef", async () => {
    const repoA: RepoEntry = {
      name: "alpha",
      path: "/repo/stale-a",
      display: "alpha",
      realPath: "/repo/stale-a",
    };
    const repoB: RepoEntry = {
      name: "bravo",
      path: "/repo/stale-b",
      display: "bravo",
      realPath: "/repo/stale-b",
    };
    mockListRepos.mockResolvedValue({ repos: [repoA, repoB], recentWindowDays: 30 });
    const onsubmit = vi.fn();
    render(NewTask, {
      props: { onsubmit, initialRepoPath: repoA.path, initialIssue: mkIssue(7) },
    });
    await expect
      .poll(() => document.querySelector<HTMLTextAreaElement>("#nt-prompt")?.value ?? "")
      .not.toBe("");
    document
      .querySelector<HTMLElement>("form.card")!
      .dispatchEvent(
        new KeyboardEvent("keydown", { code: "BracketRight", altKey: true, bubbles: true }),
      );
    typePrompt("ship it in bravo");
    await expect
      .poll(() => document.querySelector<HTMLButtonElement>("button.run")?.disabled)
      .toBe(false);
    pressCmdEnter();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    const payload = onsubmit.mock.calls[0]![0];
    expect(payload.repoPath).toBe(repoB.path);
    expect(payload.issueRef).toBeUndefined();
  });
});

describe("NewTask inline # issue search", () => {
  it("typing #4 filters and Enter attaches the issue + seeds the prompt", async () => {
    seedIssues([mkIssue(42, "Fix the flux capacitor"), mkIssue(7, "Other thing")]);
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: "/repo/hash-pick" } });

    const promptEl = () => document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    await expect.poll(() => promptEl()).toBeTruthy();
    promptEl().focus();
    promptEl().value = "#4";
    promptEl().setSelectionRange(2, 2);
    promptEl().dispatchEvent(new Event("input", { bubbles: true }));

    // The menu opens filtered to #42.
    await expect.poll(() => document.querySelectorAll(".ism-row").length).toBe(1);
    expect(document.querySelector(".ism-row")?.textContent).toContain("#42");

    promptEl().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    // Token removed → prompt empty → the issue template seeds it; issueRef attached.
    await expect
      .poll(() => promptEl().value)
      .toBe(m.newtask_issue_prompt_template({ number: 42, title: "Fix the flux capacitor" }));
    await expect.poll(() => document.querySelector(".issue-ref")).toBeTruthy();
    expect(document.querySelector(".issue-ref")?.textContent).toContain("#42");
  });

  it("relaunch mode: # stays plain text (allowIssues = !relaunch parity)", async () => {
    seedIssues([mkIssue(42)]);
    render(NewTask, {
      props: base({ initialRepoPath: "/repo/hash-relaunch", relaunch: true }),
    });
    const promptEl = () => document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    await expect.poll(() => promptEl()).toBeTruthy();
    promptEl().focus();
    promptEl().value = "#4";
    promptEl().setSelectionRange(2, 2);
    promptEl().dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    expect(document.querySelector(".ism-panel")).toBeNull();
    expect(promptEl().value).toBe("#4");
  });

  it("a non-matching #token submits as plain prompt text", async () => {
    seedIssues([mkIssue(42)]);
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: "/repo/hash-fallback" } });
    const promptEl = () => document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    await expect.poll(() => promptEl()).toBeTruthy();
    typePrompt("tint it color #fff please");
    await expect
      .poll(() => document.querySelector<HTMLButtonElement>("button.run")?.disabled)
      .toBe(false);
    pressCmdEnter();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({ prompt: "tint it color #fff please" });
    expect(onsubmit.mock.calls[0]![0].issueRef).toBeUndefined();
  });
});

describe("NewTask mode segments payload parity", () => {
  it("epic mode submits epicAuthoring:true and back to code resets both flags", async () => {
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: "/repo/mode-epic" } });
    await expect.poll(() => segButton(m.newtask_mode_epic())).toBeTruthy();

    segButton(m.newtask_mode_epic()).click();
    await expect.poll(() => segActive(m.newtask_mode_epic())).toBe(true);
    typePrompt("shape an epic");
    await expect
      .poll(() => document.querySelector<HTMLButtonElement>("button.run")?.disabled)
      .toBe(false);
    pressCmdEnter();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({ epicAuthoring: true, research: false });
  });

  it("research → code leaves the guards pinned off (checkbox parity), payload explicit false", async () => {
    const onsubmit = vi.fn();
    mockGetRepoConfig.mockResolvedValue(repoConfig(true)); // gate-ON repo
    render(NewTask, { props: { onsubmit, initialRepoPath: "/repo/mode-roundtrip" } });
    await expect.poll(() => isOn(planGateSwitch())).toBe(true);

    segButton(m.newtask_mode_research()).click();
    await expect.poll(() => isOn(planGateSwitch())).toBe(false);
    segButton(m.newtask_mode_code()).click();
    await expect.poll(() => segActive(m.newtask_mode_code())).toBe(true);
    // Parity with unchecking the old Research checkbox: the guards stay off + pinned.
    expect(isOn(planGateSwitch())).toBe(false);

    typePrompt("do the thing");
    await expect
      .poll(() => document.querySelector<HTMLButtonElement>("button.run")?.disabled)
      .toBe(false);
    pressCmdEnter();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({
      research: false,
      epicAuthoring: false,
      planGateEnabled: false, // pinned explicit false, not null-inherit
    });
  });
});

describe("NewTask manual provider change (preserved reset semantics)", () => {
  it("resets a touched model to the new provider default on CLI-select change", async () => {
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: "/repo/manual-reset" } });
    const modelSel = () => document.querySelector<HTMLSelectElement>("#nt-model")!;
    const providerSel = () => document.querySelector<HTMLSelectElement>("#nt-agent-provider")!;
    await expect.poll(() => modelSel()).toBeTruthy();

    // Touch the model by hand.
    modelSel().value = "opus";
    modelSel().dispatchEvent(new Event("change", { bubbles: true }));
    await expect.poll(() => modelSel().value).toBe("opus");

    // Manual provider change: unconditional reset to the new provider's default.
    providerSel().value = "codex";
    providerSel().dispatchEvent(new Event("change", { bubbles: true }));
    await expect.poll(() => modelSel().value).toBe("gpt-5.5");
  });
});

describe("NewTask geometry (measurable handoff criteria)", () => {
  // Fixture A (desktop, Claude): autogrow-capped prompt + 8 chips + diverged notice +
  // submit error + hold-likely dual CTA — every state individually realizable together.
  it("fixture A: desktop 1280×800 — card 880, rail 300, surface + no overflow", async () => {
    await page.viewport(1280, 800);
    mockBranchStatus.mockResolvedValue({
      behind: 3,
      ahead: 2,
      diverged: true,
      hasUpstream: true,
      localExists: true,
    });
    const onsubmit = vi.fn().mockRejectedValue(new Error("spawn failed"));
    render(NewTask, {
      props: {
        onsubmit,
        initialRepoPath: "/repo/geo-a",
        holdLikely: true,
        initialImages: Array.from({ length: 8 }, (_, i) => ({
          path: `/staged/f${i}.png`,
          name: `file-with-a-longish-name-${i}.png`,
        })),
      },
    });
    typePrompt(Array.from({ length: 60 }, (_, i) => `long prompt line ${i}`).join("\n"));

    const card = document.querySelector<HTMLElement>("form.card")!;
    // Modal surface: exactly 880 wide, square corners, bright border, brackets, no shadow.
    await expect.poll(() => Math.round(card.getBoundingClientRect().width)).toBe(880);
    const cs = getComputedStyle(card);
    expect(cs.borderRadius).toBe("0px");
    expect(cs.boxShadow).toBe("none");
    const brackets = [getComputedStyle(card, "::before"), getComputedStyle(card, "::after")];
    for (const b of brackets) {
      expect(b.width).toBe("10px");
      expect(b.height).toBe("10px");
    }
    // Two-column grid: right rail exactly 300px.
    expect(
      Math.round(document.querySelector<HTMLElement>(".rail")!.getBoundingClientRect().width),
    ).toBe(300);
    // Prompt hero ≥132px; toolbar buttons 28×28.
    expect(
      document.querySelector<HTMLElement>("#nt-prompt")!.getBoundingClientRect().height,
    ).toBeGreaterThanOrEqual(132);
    const tool = document.querySelector<HTMLElement>(".tool-btn")!.getBoundingClientRect();
    expect(Math.round(tool.width)).toBe(28);
    expect(Math.round(tool.height)).toBe(28);

    // Dual CTA present (hold-likely, Claude) and fully inside the viewport.
    await expect.poll(() => document.querySelector("button.run-hold")).toBeTruthy();
    const foot = document.querySelector<HTMLElement>(".cfoot")!.getBoundingClientRect();
    expect(foot.bottom).toBeLessThanOrEqual(800);
    expect(foot.top).toBeGreaterThanOrEqual(0);
    // No horizontal document overflow.
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(1280);
    // The left column scrolls internally rather than displacing the footer.
    const left = document.querySelector<HTMLElement>(".left")!;
    expect(left.scrollHeight).toBeGreaterThan(left.clientHeight);
  });

  // Fixture B (desktop, Codex relaunch): constraint callout + relaunch note.
  it("fixture B: codex relaunch with constraint callout keeps the footer in-viewport", async () => {
    await page.viewport(1280, 800);
    mockGetCommands.mockResolvedValue({ commands: [slashCommand("codex-skill", ["codex"])] });
    render(NewTask, {
      props: base({ initialRepoPath: "/repo/geo-b", relaunch: true, initialPrompt: "again" }),
    });
    // Relaunch opens the panel on the Commands tab, whose filter autofocuses at first
    // flush (existing behavior) — settle first, then take focus back for the prompt.
    await expect.poll(() => document.querySelector(".cmd-filter")).toBeTruthy();
    const promptEl = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    promptEl.focus();
    promptEl.value = "$cod";
    promptEl.setSelectionRange(4, 4);
    promptEl.dispatchEvent(new Event("input", { bubbles: true }));
    await expect.element(page.getByText("$codex-skill")).toBeVisible();
    await page.getByText("$codex-skill").click();
    // Constraint callout renders in the rail; relaunch note in the left column.
    await expect.element(page.getByText(m.newtask_provider_constraint_title())).toBeVisible();
    expect(document.querySelector(".relaunch-note")).toBeTruthy();
    const foot = document.querySelector<HTMLElement>(".cfoot")!.getBoundingClientRect();
    expect(foot.bottom).toBeLessThanOrEqual(800);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(1280);
  });

  // Fixture C (mobile): the sheet fills the viewport; 44px targets; 16px prompt.
  it("fixture C: mobile 390×844 — sheet fills viewport, safe-area declared, 44px targets", async () => {
    await page.viewport(390, 844);
    const onsubmit = vi.fn();
    render(NewTask, {
      props: {
        onsubmit,
        initialRepoPath: "/repo/geo-c",
        initialImages: [{ path: "/staged/a.png", name: "a.png" }],
      },
    });
    const card = document.querySelector<HTMLElement>("form.card")!;
    await expect.poll(() => Math.round(card.getBoundingClientRect().width)).toBe(390);
    const rect = card.getBoundingClientRect();
    expect(Math.round(rect.height)).toBe(844);
    expect(Math.round(rect.top)).toBe(0);
    expect(Math.round(rect.left)).toBe(0);
    // Footer flush to the viewport bottom; safe-area declared on its padding.
    const foot = document.querySelector<HTMLElement>(".cfoot")!;
    expect(Math.round(foot.getBoundingClientRect().bottom)).toBe(844);
    // env() resolves to 0 in test browsers — assert the declaration carries it.
    const sheet = Array.from(document.styleSheets).some((ss) => {
      try {
        return Array.from(ss.cssRules).some((r) => r.cssText.includes("safe-area-inset-bottom"));
      } catch {
        return false;
      }
    });
    expect(sheet).toBe(true);
    // 44px targets: toolbar buttons, close ✕, mode segments, CTA; 16px prompt.
    expect(
      document.querySelector<HTMLElement>(".tool-btn")!.getBoundingClientRect().height,
    ).toBeGreaterThanOrEqual(44);
    expect(
      document.querySelector<HTMLElement>(".x")!.getBoundingClientRect().height,
    ).toBeGreaterThanOrEqual(44);
    expect(
      document.querySelector<HTMLElement>(".seg-btn")!.getBoundingClientRect().height,
    ).toBeGreaterThanOrEqual(44);
    expect(
      document.querySelector<HTMLElement>("button.run")!.getBoundingClientRect().height,
    ).toBeGreaterThanOrEqual(44);
    expect(getComputedStyle(document.querySelector("#nt-prompt")!).fontSize).toBe("16px");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });
});

describe("NewTask mobile sheets + shortcuts", () => {
  async function renderMobile(extra: Record<string, unknown> = {}) {
    await page.viewport(390, 844);
    const repoA: RepoEntry = {
      name: "alpha",
      path: "/repo/mob-a",
      display: "alpha",
      realPath: "/repo/mob-a",
    };
    const repoB: RepoEntry = {
      name: "bravo",
      path: "/repo/mob-b",
      display: "bravo",
      realPath: "/repo/mob-b",
    };
    mockListRepos.mockResolvedValue({ repos: [repoA, repoB], recentWindowDays: 30 });
    const onsubmit = vi.fn();
    render(NewTask, { props: { onsubmit, initialRepoPath: repoA.path, ...extra } });
    await expect.poll(() => document.querySelector(".ctx-chip")).toBeTruthy();
    return { onsubmit, repoA, repoB };
  }

  it("combined chip names both values, opens the context sheet, edits independently", async () => {
    const { onsubmit, repoB } = await renderMobile();
    const chip = () => document.querySelector<HTMLButtonElement>(".ctx-chip")!;
    await expect.poll(() => chip().textContent).toContain("alpha");
    expect(chip().getAttribute("aria-haspopup")).toBe("dialog");
    expect(chip().getAttribute("aria-expanded")).toBe("false");
    expect(chip().getAttribute("aria-label")).toContain("alpha");
    expect(chip().getAttribute("aria-label")).toContain("main");

    chip().focus();
    chip().click();
    await expect.poll(() => document.querySelector(".ctx-sheet")).toBeTruthy();
    expect(chip().getAttribute("aria-expanded")).toBe("true");

    // Change only the repo: chip + payload repoPath update; base re-derives.
    document.querySelector<HTMLButtonElement>(".ctx-sheet .rs-trigger")!.click();
    await expect
      .poll(() =>
        Array.from(document.querySelectorAll<HTMLLIElement>('[role="option"]')).find((el) =>
          el.textContent?.includes("bravo"),
        ),
      )
      .toBeTruthy();
    Array.from(document.querySelectorAll<HTMLLIElement>('[role="option"]'))
      .find((el) => el.textContent?.includes("bravo"))!
      .click();
    await expect.poll(() => chip().textContent).toContain("bravo");

    // Change only the branch (input fallback or select — the mock lists main only).
    const branchCtl = document.querySelector<HTMLSelectElement | HTMLInputElement>(
      ".ctx-sheet .ctx-branch-select",
    )!;
    branchCtl.value = "main";
    branchCtl.dispatchEvent(new Event("change", { bubbles: true }));

    // Close the sheet: focus returns to the chip.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    // (dispatch on the sheet so the dialog action sees it)
    document
      .querySelector<HTMLElement>('[role="dialog"][aria-modal="true"].sheet')
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await expect.poll(() => document.querySelector(".ctx-sheet")).toBeNull();

    typePrompt("mobile task");
    await expect
      .poll(() => document.querySelector<HTMLButtonElement>("button.run")?.disabled)
      .toBe(false);
    document.querySelector<HTMLButtonElement>("button.run")!.click();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    expect(onsubmit.mock.calls[0]![0]).toMatchObject({ repoPath: repoB.path, baseBranch: "main" });
  });

  it("three-press Escape: repo panel → focus in-sheet trigger; sheet → focus chip", async () => {
    await renderMobile();
    const chip = document.querySelector<HTMLButtonElement>(".ctx-chip")!;
    // A real pointer/keyboard activation focuses the chip; JS .click() alone doesn't.
    chip.focus();
    chip.click();
    await expect.poll(() => document.querySelector(".ctx-sheet")).toBeTruthy();

    const trigger = () => document.querySelector<HTMLButtonElement>(".ctx-sheet .rs-trigger")!;
    trigger().click();
    await expect.poll(() => document.querySelector(".rs-panel")).toBeTruthy();
    const filter = document.querySelector<HTMLInputElement>(".rs-filter")!;
    filter.focus();

    // Esc 1: RepoSelect consumes it (preventDefault) → panel closes, focus lands on
    // the in-sheet trigger, the sheet stays open.
    filter.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await expect.poll(() => document.querySelector(".rs-panel")).toBeNull();
    expect(document.querySelector(".ctx-sheet")).toBeTruthy();
    await expect.poll(() => document.activeElement?.classList.contains("rs-trigger")).toBe(true);

    // Esc 2: the sheet's dialog action consumes it → sheet closes, focus back on chip.
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await expect.poll(() => document.querySelector(".ctx-sheet")).toBeNull();
    await expect.poll(() => document.activeElement?.classList.contains("ctx-chip")).toBe(true);
    // The modal itself is still open (Esc was consumed by the sheet level).
    expect(document.querySelector("form.card")).toBeTruthy();
  });

  it("⌥R opens the context sheet with the repo panel; ⌥] cycles without opening; engine sheet switches", async () => {
    await renderMobile();
    const form = document.querySelector<HTMLElement>("form.card")!;

    // ⌥] cycles the repo with the sheet closed — chip label updates, nothing opens.
    form.dispatchEvent(
      new KeyboardEvent("keydown", { code: "BracketRight", altKey: true, bubbles: true }),
    );
    await expect.poll(() => document.querySelector(".ctx-chip")?.textContent).toContain("bravo");
    expect(document.querySelector(".ctx-sheet")).toBeNull();

    // Open the ENGINE sheet, then ⌥R: single-sheet invariant switches to the context
    // sheet and opens the repo panel once mounted.
    document.querySelector<HTMLButtonElement>(".engine-summary")!.click();
    await expect.poll(() => document.querySelector(".sheet .group")).toBeTruthy();
    form.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyR", altKey: true, bubbles: true }));
    await expect.poll(() => document.querySelector(".ctx-sheet")).toBeTruthy();
    expect(document.querySelector(".sheet .guards")).toBeNull(); // engine sheet closed
    await expect.poll(() => document.querySelector(".rs-panel")).toBeTruthy();
  });

  it("no-sheet normalization: a Codex-only command flips the provider and submits valid values", async () => {
    mockGetCommands.mockResolvedValue({ commands: [slashCommand("codex-skill", ["codex"])] });
    const { onsubmit } = await renderMobile();

    const promptEl = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    promptEl.focus();
    promptEl.value = "$cod";
    promptEl.setSelectionRange(4, 4);
    promptEl.dispatchEvent(new Event("input", { bubbles: true }));
    await expect.element(page.getByText("$codex-skill")).toBeVisible();
    await page.getByText("$codex-skill").click();

    // The engine summary reflects the flip WITHOUT the sheet ever opening.
    await expect
      .poll(() => document.querySelector(".engine-summary")?.textContent)
      .toContain(m.agent_provider_codex());
    await expect
      .poll(() => document.querySelector<HTMLButtonElement>("button.run")?.disabled)
      .toBe(false);
    document.querySelector<HTMLButtonElement>("button.run")!.click();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
    const payload = onsubmit.mock.calls[0]![0];
    expect(payload.agentProvider).toBe("codex");
    // Normalized: never a Claude-only model on a codex submission.
    expect(payload.model === null || payload.model.startsWith("gpt")).toBe(true);
  });

  it("breakpoint change with the engine sheet open: sheet closes, rail takes over, values survive", async () => {
    await renderMobile();
    document.querySelector<HTMLButtonElement>(".engine-summary")!.click();
    await expect.poll(() => document.querySelector(".sheet .guards")).toBeTruthy();

    // Toggle plan gate ON inside the sheet.
    planGateSwitch().click();
    await expect.poll(() => isOn(planGateSwitch())).toBe(true);

    // Cross to desktop: the sheet closes, the rail renders, the toggled value survives.
    await page.viewport(1280, 900);
    await expect.poll(() => document.querySelector(".sheet")).toBeNull();
    await expect.poll(() => document.querySelector(".rail")).toBeTruthy();
    expect(isOn(planGateSwitch())).toBe(true);
  });
});
