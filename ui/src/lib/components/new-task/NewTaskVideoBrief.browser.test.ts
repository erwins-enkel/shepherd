import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import type { Issue, RepoConfig, RepoEntry, SlashCommand } from "$lib/types";
import { m } from "$lib/paraglide/messages";
import { expectMinPx } from "$lib/test-support/geometry";
import {
  listIssues,
  getEpics,
  getTodo,
  listBranches,
  getRepoConfig,
  putRepoConfig,
  listRepos,
  branchStatus,
  getCommands,
} from "$lib/api";
import { VIDEO_BRIEF_SKILL_NAME } from "./video-skill.svelte";

/** Pinned here, beside the anchor assertion — the component owns the literal. */
const VIDEO_BRIEF_SKILL_URL = "https://github.com/erwins-enkel/skills/tree/main/skills/video-brief";

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
    getCommands: vi.fn(),
  };
});

const { default: NewTask } = await import("../NewTask.svelte");

function cfg(): RepoConfig & { automationConfirmed: boolean; automationRowExists: boolean } {
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
    automationConfirmed: true,
    automationRowExists: true,
  } as never;
}

const repo: RepoEntry = {
  name: "demo",
  path: "/repo/demo",
  display: "demo",
  realPath: "/repo/demo",
};

/** An inventory entry. Defaults to a skill that is NOT video-brief. */
function cmd(over: Partial<SlashCommand> = {}): SlashCommand {
  return {
    id: "x",
    name: "something-else",
    displayName: "something-else",
    description: "",
    scope: "user",
    kind: "skill",
    invocationName: "something-else",
    sourceNamespace: "claude:user",
    providers: ["claude"],
    invocations: {},
    ...over,
  } as SlashCommand;
}

const videoBrief = () => cmd({ name: VIDEO_BRIEF_SKILL_NAME, kind: "skill" });

const VIDEO = { path: "/staged/rec.mov", name: "IMG_4821.MOV" };
const IMAGE = { path: "/staged/a.png", name: "a.png" };

/** The recommendation row, or null. Identified by its own class, not by copy. */
const notice = () => document.querySelector<HTMLElement>(".nt-video-brief");
const noticeLink = () => notice()?.querySelector<HTMLAnchorElement>("a") ?? null;

const mockGetCommands = vi.mocked(getCommands);

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  await page.viewport(1280, 900);
  vi.mocked(getTodo).mockResolvedValue({ exists: false, content: "" });
  vi.mocked(listIssues).mockResolvedValue({
    slug: "owner/repo",
    webUrl: null,
    issues: [] as Issue[],
    viewer: null,
  } as never);
  vi.mocked(getEpics).mockResolvedValue({ epics: [], subIssues: [] } as never);
  vi.mocked(listBranches).mockResolvedValue({
    current: "main",
    branches: ["main"],
    default: null,
  } as never);
  vi.mocked(getRepoConfig).mockResolvedValue(cfg());
  vi.mocked(putRepoConfig).mockResolvedValue(cfg());
  vi.mocked(listRepos).mockResolvedValue({ repos: [repo], recentWindowDays: 30 } as never);
  vi.mocked(branchStatus).mockResolvedValue({ ahead: 0, behind: 0, diverged: false } as never);
  mockGetCommands.mockResolvedValue({ commands: [] });
});

afterEach(() => {
  document.body.innerHTML = "";
});

function open(props: Record<string, unknown> = {}) {
  render(NewTask, {
    props: { onsubmit: vi.fn(), initialRepoPath: repo.path, ...props },
  });
}

describe("known-missing vs installed", () => {
  it("recommends the skill when the provider's inventory proves it is absent", async () => {
    mockGetCommands.mockResolvedValue({ commands: [cmd()] });
    open({ initialImages: [VIDEO] });
    await vi.waitFor(() => expect(notice()).toBeTruthy());
    expect(notice()!.textContent).toContain(
      m.newtask_video_brief_tip({ provider: m.agent_provider_claude() }),
    );
  });

  it("stays silent when the skill IS installed", async () => {
    mockGetCommands.mockResolvedValue({ commands: [cmd(), videoBrief()] });
    open({ initialImages: [VIDEO] });
    // Give the inventory time to land, then assert absence (a bare check could pass vacuously).
    await vi.waitFor(() => expect(mockGetCommands).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 80));
    expect(notice()).toBeNull();
  });

  it("shows nothing while the inventory is still loading", async () => {
    const d = deferred<{ commands: SlashCommand[] }>();
    mockGetCommands.mockReturnValue(d.promise);
    open({ initialImages: [VIDEO] });
    await vi.waitFor(() => expect(mockGetCommands).toHaveBeenCalled());
    expect(notice()).toBeNull();
    d.resolve({ commands: [] });
    await vi.waitFor(() => expect(notice()).toBeTruthy());
  });

  it("shows nothing when the inventory FAILS, and never blocks submitting", async () => {
    mockGetCommands.mockRejectedValue(new Error("offline"));
    const onsubmit = vi.fn();
    open({ onsubmit, initialImages: [VIDEO] });
    await vi.waitFor(() => expect(mockGetCommands).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 80));
    expect(notice()).toBeNull();

    const prompt = document.querySelector<HTMLTextAreaElement>("#nt-prompt")!;
    prompt.value = "fix the crash in the recording";
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    const run = () => document.querySelector<HTMLButtonElement>("button.run")!;
    await expect.poll(() => run().disabled).toBe(false);
    run().click();
    await expect.poll(() => onsubmit.mock.calls.length).toBe(1);
  });
});

describe("attachment lifecycle", () => {
  it("stays silent for a non-video attachment", async () => {
    // The skill is genuinely absent from the inventory — only the attachment kind rules it out.
    mockGetCommands.mockResolvedValue({ commands: [] });
    open({ initialImages: [IMAGE] });
    await vi.waitFor(() => expect(document.querySelector("form.card")).toBeTruthy());
    await new Promise((r) => setTimeout(r, 80));
    expect(notice()).toBeNull();
  });

  it("removes the recommendation when the last video is removed", async () => {
    mockGetCommands.mockResolvedValue({ commands: [] });
    open({ initialImages: [VIDEO, IMAGE] });
    await vi.waitFor(() => expect(notice()).toBeTruthy());

    // Remove the video chip (the image chip stays — the row must still go).
    const remove = Array.from(document.querySelectorAll<HTMLElement>(".chip"))
      .find((chip) => chip.textContent?.includes(VIDEO.name))!
      .querySelector<HTMLButtonElement>(".chip-x")!;
    remove.click();
    await vi.waitFor(() => expect(notice()).toBeNull());
  });
});

describe("re-evaluation", () => {
  it("re-reads the inventory for the newly selected provider", async () => {
    // Installed for Claude, missing for Codex: the row must appear only after the switch.
    mockGetCommands.mockImplementation(async (_repo, opts) =>
      opts?.provider === "codex" ? { commands: [] } : { commands: [videoBrief()] },
    );
    open({ initialImages: [VIDEO] });
    await vi.waitFor(() =>
      expect(mockGetCommands).toHaveBeenCalledWith(repo.path, { provider: "claude" }),
    );
    await new Promise((r) => setTimeout(r, 80));
    expect(notice()).toBeNull();

    const select = document.querySelector<HTMLSelectElement>(
      `select[aria-label="${m.newtask_agent_provider_label()}"]`,
    )!;
    select.value = "codex";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(notice()).toBeTruthy());
    expect(notice()!.textContent).toContain(
      m.newtask_video_brief_tip({ provider: m.agent_provider_codex() }),
    );
  });

  it("refreshes on window focus, so an install in another terminal is picked up", async () => {
    mockGetCommands.mockResolvedValue({ commands: [] });
    open({ initialImages: [VIDEO] });
    await vi.waitFor(() => expect(notice()).toBeTruthy());

    // The operator installs the skill elsewhere, then comes back to the tab.
    mockGetCommands.mockResolvedValue({ commands: [videoBrief()] });
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(notice()).toBeNull());
  });

  it("does not poll on focus when no video is attached", async () => {
    open({ initialImages: [IMAGE] });
    await vi.waitFor(() => expect(document.querySelector("form.card")).toBeTruthy());
    const before = mockGetCommands.mock.calls.length;
    window.dispatchEvent(new Event("focus"));
    await new Promise((r) => setTimeout(r, 80));
    expect(mockGetCommands.mock.calls.length).toBe(before);
  });
});

describe("the link", () => {
  beforeEach(() => {
    mockGetCommands.mockResolvedValue({ commands: [] });
  });

  it("points at the public skill page, opens a new tab, and is named", async () => {
    open({ initialImages: [VIDEO] });
    await vi.waitFor(() => expect(noticeLink()).toBeTruthy());
    const link = noticeLink()!;
    expect(link.getAttribute("href")).toBe(VIDEO_BRIEF_SKILL_URL);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("aria-label")).toBe(m.newtask_video_brief_link_aria());
    // WCAG 2.5.3 Label in Name: the accessible name must contain the visible label, or a
    // speech-input user cannot activate the link by saying what they see.
    expect(m.newtask_video_brief_link_aria()).toContain(m.newtask_video_brief_link());
  });

  it("offers no install, copy or dismiss affordance", async () => {
    open({ initialImages: [VIDEO] });
    await vi.waitFor(() => expect(notice()).toBeTruthy());
    expect(notice()!.querySelectorAll("button")).toHaveLength(0);
    expect(notice()!.textContent).not.toContain("npx");
  });
});

describe("mobile", () => {
  it("keeps the submit control reachable with the recommendation present", async () => {
    await page.viewport(390, 844);
    mockGetCommands.mockResolvedValue({ commands: [] });
    open({ initialImages: [VIDEO] });
    await vi.waitFor(() => expect(notice()).toBeTruthy());

    const foot = document.querySelector<HTMLElement>(".cfoot")!.getBoundingClientRect();
    expect(Math.round(foot.bottom)).toBe(844);
    expectMinPx(
      document.querySelector<HTMLElement>("button.run")!.getBoundingClientRect().height,
      44,
      "CTA tap-target",
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });
});
