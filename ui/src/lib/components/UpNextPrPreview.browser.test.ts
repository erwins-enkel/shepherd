import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../app.css";
import type { Session, Steer, UpNextPr, UpNextSnapshot } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";
import { upNext } from "#lib/up-next.svelte.js";
import { upNextPrKey, upNextUi } from "#lib/up-next-ui.svelte.js";
import type { UpNextLaunchContext } from "#lib/up-next-start.svelte.js";
import { steers } from "#lib/steers.svelte.js";
import { expectMinPx } from "#lib/test-support/geometry.js";
import { getUpNextPrBody, mergeBacklogPr, startUpNextPrFix } from "#lib/api.js";

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return {
    ...actual,
    getUpNextPrBody: vi.fn<() => Promise<{ body: string }>>(),
    mergeBacklogPr: vi.fn(async () => {}),
    startUpNextPrFix: vi.fn(async () => ({ session: { id: "fix" } })),
    requestDependabotRebase: vi.fn(async () => {}),
    refreshUpNext: vi.fn(async () => ({ ok: true })),
  };
});

const { default: UpNextPrPreview } = await import("./UpNextPrPreview.svelte");

const REPO = "~/projects/manufare-website";
const pr = (number: number, over: Partial<UpNextPr> = {}): UpNextPr => ({
  repoPath: REPO,
  repoSlug: "o/manufare-website",
  repoLabel: "manufare-website",
  number,
  title: `pr ${number}`,
  url: `https://example.test/pull/${number}`,
  author: "kai",
  kind: "regular",
  createdAt: 0,
  checks: "success",
  mergeable: true,
  baseRefName: "main",
  mergeMethod: "squash",
  headRefName: `feat/${number}`,
  headSha: `sha${number}`,
  band: "ready",
  action: "merge",
  ...over,
});
const BLOCKED = pr(985, {
  title: "feat(mcp): Werkstattbericht bedienen",
  mergeable: false,
  mergeStateStatus: "dirty",
  checks: "failure",
  band: "blocked",
  action: "fix",
  blockReason: "conflict",
  closesIssue: 972,
  jobs: [
    { name: "test", state: "failure", url: "https://example.test/job/1" },
    { name: "lint", state: "success" },
  ],
});
const PRS = [pr(911), pr(967, { author: "other", band: "review", action: "review" }), BLOCKED];
const snapshot = (prs: UpNextPr[]): UpNextSnapshot => ({
  generatedAt: 1,
  repoCount: 1,
  fallback: null,
  failedRepoCount: 0,
  sections: [],
  pullRequests: prs,
});
const steer = (id: string, label: string): Steer => ({
  id,
  label,
  text: `run ${label}`,
  inSteerBar: false,
  onIssues: true,
});
const ctx = (over: Partial<UpNextLaunchContext> = {}): UpNextLaunchContext => ({
  store: { diagnostics: null, usageLimits: null, sessions: [] } as UpNextLaunchContext["store"],
  defaultAgentProvider: "claude",
  fableAvailable: true,
  upnextSkipCliPicker: true,
  usageHoldEnabled: false,
  usageHoldPct: 80,
  nowMs: 0,
  onreviewpr: vi.fn(),
  onmanagesteers: vi.fn(),
  ...over,
});
const open = (row: UpNextPr) => {
  upNextUi.previewKey = upNextPrKey(row);
};
const primary = () => document.querySelector<HTMLElement>(".unp-start > :first-child")!;
const fact = (label: string) =>
  Array.from(document.querySelectorAll(".unpr-fact")).find(
    (el) => el.querySelector("dt")?.textContent === label,
  )!;

beforeEach(() => {
  vi.mocked(getUpNextPrBody)
    .mockReset()
    .mockResolvedValue({ body: "## Summary\n\n- **two** fixes" });
  upNextUi.reset();
  steers.list = [];
  upNext.snapshot = snapshot(PRS);
  upNextUi.prOrder = PRS.map(upNextPrKey);
});
afterEach(async () => {
  await userEvent.hover(page.elementLocator(document.documentElement), {
    position: { x: 0, y: 0 },
  });
  upNextUi.reset();
  upNext.snapshot = null;
  steers.list = [];
  vi.clearAllMocks();
  await page.viewport(1024, 768);
});

describe("UpNextPrPreview", () => {
  it("reads the PR: tagline, title, facts and its rendered description", async () => {
    open(BLOCKED);
    render(UpNextPrPreview, { launchContext: ctx() });
    await expect
      .element(page.getByRole("heading", { name: "feat(mcp): Werkstattbericht bedienen" }))
      .toBeVisible();
    expect(document.body.textContent).toContain(m.upnext_pr_tag({ repo: "manufare-website" }));
    expect(document.body.textContent).toContain("#985");
    await expect.element(page.getByRole("heading", { name: "Summary" })).toBeVisible();
    expect(vi.mocked(getUpNextPrBody)).toHaveBeenCalledWith(REPO, 985);
    expect(fact(m.upnext_pr_fact_mergeability()).textContent).toContain(
      m.upnext_pr_merge_conflict({ base: "main" }),
    );
    expect(fact(m.upnext_pr_fact_review()).textContent).toContain(m.upnext_pr_review_none());
    expect(fact(m.upnext_pr_fact_target()).textContent).toContain("main · squash");
    expect(fact(m.upnext_pr_fact_closes()).textContent).toContain("#972");
    expect(fact(m.upnext_pr_fact_session()).textContent).toContain(m.upnext_pr_session_none());
  });

  it("expands the CI fact into the head's jobs", async () => {
    open(BLOCKED);
    render(UpNextPrPreview, { launchContext: ctx() });
    const toggle = page.getByRole("button", { name: m.prspanel_jobs_show() });
    await expect.element(toggle).toBeVisible();
    await toggle.click();
    const jobs = Array.from(document.querySelectorAll(".unpr-jobs li")).map((li) =>
      li.textContent?.trim(),
    );
    expect(jobs).toEqual(["test", "lint"]);
    expect(document.querySelector<HTMLAnchorElement>(".unpr-jobs a")!.href).toBe(
      "https://example.test/job/1",
    );
  });

  it("leads with the fix, keeps Merge locked with the reason, and starts the fix", async () => {
    open(BLOCKED);
    render(UpNextPrPreview, { launchContext: ctx() });
    await expect.element(page.getByText(m.upnext_pr_action_fix())).toBeVisible();
    expect(primary().textContent).toBe(m.upnext_pr_action_fix());
    await expect
      .element(page.getByRole("button", { name: m.prspanel_merge_button() }))
      .toBeDisabled();
    expect(document.querySelector(".unpr-why")!.textContent).toContain(
      m.upnext_pr_why_conflict({ base: "main" }),
    );
    // No steers configured → no ▾.
    expect(document.querySelector(".unp-more")).toBeNull();
    primary().click();
    await expect.poll(() => vi.mocked(startUpNextPrFix).mock.calls.length).toBe(1);
    expect(vi.mocked(startUpNextPrFix).mock.calls[0]).toEqual([REPO, 985, undefined]);
    // The fixed PR reads as gone until the server's snapshot drops it.
    await expect.element(page.getByText(m.upnext_preview_empty())).toBeVisible();
  });

  it("offers the repo's steers on a fix's ▾ and runs the fix with the chosen one", async () => {
    steers.list = [steer("tdd", "TDD")];
    open(BLOCKED);
    render(UpNextPrPreview, { launchContext: ctx() });
    const more = page.getByRole("button", { name: m.upnext_preview_more() });
    await expect.element(more).toBeVisible();
    await more.click();
    await page.getByRole("menuitem", { name: m.issuespanel_action_aria({ label: "TDD" }) }).click();
    await expect.poll(() => vi.mocked(startUpNextPrFix).mock.calls.length).toBe(1);
    expect(vi.mocked(startUpNextPrFix).mock.calls[0]).toEqual([REPO, 985, "run TDD"]);
  });

  it("shows no ▾ beside a merge, which starts no session", async () => {
    steers.list = [steer("tdd", "TDD")];
    open(PRS[0]!);
    render(UpNextPrPreview, { launchContext: ctx() });
    await expect.element(page.getByRole("heading", { name: "pr 911" })).toBeVisible();
    expect(document.querySelector(".unp-more")).toBeNull();
    expect(document.querySelector(".unpr-why")).toBeNull();
  });

  it("merges through the confirmation from the primary action", async () => {
    open(PRS[0]!);
    render(UpNextPrPreview, { launchContext: ctx() });
    await expect.element(page.getByRole("heading", { name: "pr 911" })).toBeVisible();
    primary().click();
    const confirm = page.getByRole("button", { name: m.mergeconfirm_confirm() });
    await expect.element(confirm).toBeEnabled();
    await confirm.click();
    await expect.poll(() => vi.mocked(mergeBacklogPr).mock.calls.length).toBe(1);
    expect(vi.mocked(mergeBacklogPr).mock.calls[0]).toMatchObject([
      REPO,
      911,
      { deleteBranch: true, confirm: { headSha: "sha911" } },
    ]);
  });

  it("hands + Review to the page's review path and ticks the PR for a merge train", async () => {
    const launchContext = ctx();
    open(BLOCKED);
    render(UpNextPrPreview, { launchContext });
    await page.getByRole("button", { name: m.prspanel_review_button() }).click();
    expect(launchContext.onreviewpr).toHaveBeenCalledWith(REPO, BLOCKED);
    await page.getByRole("checkbox", { name: m.upnext_pr_select_train() }).click();
    expect(upNextUi.selected.has(upNextPrKey(BLOCKED))).toBe(true);
  });

  it("names the session working on the PR", async () => {
    const session = {
      desig: "TASK-12",
      repoPath: "/real/manufare-website",
      branch: "shepherd/fix",
      baseBranch: "feat/985",
    } as Session;
    open(BLOCKED);
    render(UpNextPrPreview, {
      launchContext: ctx({
        store: { diagnostics: null, usageLimits: null, sessions: [session] } as never,
      }),
    });
    await expect.element(page.getByText("TASK-12")).toBeVisible();
  });

  it("steps through the PRs only, with the position among them", async () => {
    open(PRS[0]!);
    render(UpNextPrPreview, { launchContext: ctx() });
    await expect
      .element(page.getByText(m.upnext_preview_position({ index: 1, total: 3 })))
      .toBeVisible();
    await page.getByRole("button", { name: m.upnext_pr_next() }).click();
    expect(upNextUi.previewKey).toBe(upNextPrKey(PRS[1]!));
    await page.getByRole("button", { name: m.upnext_pr_prev() }).click();
    await page.getByRole("button", { name: m.upnext_pr_prev() }).click();
    expect(upNextUi.previewKey).toBe(upNextPrKey(BLOCKED));
    await page.getByRole("button", { name: m.common_close() }).click();
    expect(upNextUi.previewKey).toBeNull();
  });

  it("on the phone: back to the list, stacked actions and full touch targets", async () => {
    await page.viewport(390, 844);
    const onback = vi.fn();
    open(BLOCKED);
    render(UpNextPrPreview, { launchContext: ctx(), onback });
    await expect.element(page.getByText(m.upnext_pr_action_fix())).toBeVisible();
    const hit = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--mobile-actionbar-hit"),
    );
    const buttons = [
      primary(),
      ...document.querySelectorAll<HTMLElement>(".unp-actions > .gbtn"),
      document.querySelector<HTMLElement>(".unp-pick")!,
      ...document.querySelectorAll<HTMLElement>(".unp-icon"),
    ];
    for (const el of buttons) expectMinPx(el.getBoundingClientRect().height, hit, el.className);
    // Stacked: each action spans the action row.
    const row = document.querySelector<HTMLElement>(".unp-actions")!.getBoundingClientRect();
    for (const el of document.querySelectorAll<HTMLElement>(".unp-actions > .gbtn"))
      expect(el.getBoundingClientRect().width).toBeCloseTo(row.width, 0);
    await page.getByRole("button", { name: `← ${m.issuedetail_back()}` }).click();
    expect(onback).toHaveBeenCalled();
  });
});
