import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render as rawRender } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import type { GitState, Recap, ReviewVerdict, Session } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";

// The merge row reads the PR from its `git` prop (the WS store), so only the actions are mocked.
const mergePrFn = vi.fn();
const reviewPrFn = vi.fn(async () => "started" as "started" | "skipped" | "error");
const setReadyToMergeFn = vi.fn(async () => {});
const replySessionFn = vi.fn<(id: string, text: string) => Promise<void>>(async () => {});
vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return {
    ...actual,
    mergePr: mergePrFn,
    reviewPr: reviewPrFn,
    setReadyToMerge: setReadyToMergeFn,
    replySession: replySessionFn,
  };
});
const toastsInfo = vi.fn();
vi.mock("#lib/toasts.svelte.js", () => ({ toasts: { info: toastsInfo } }));
vi.mock("#lib/pull-offer.js", () => ({ pullMainAndToast: vi.fn() }));

// Imported AFTER the mocks: the stores import #lib/api.
const { default: PrActionRow } = await import("./PrActionRow.svelte");
const { reviews, repoConfig } = await import("#lib/reviews.svelte.js");
const { recaps } = await import("#lib/recaps.svelte.js");
const { pullMainAndToast } = await import("#lib/pull-offer.js");

const mounted: Array<{ unmount: () => void | Promise<void> }> = [];
async function render(
  ...args: Parameters<typeof rawRender>
): Promise<Awaited<ReturnType<typeof rawRender>>> {
  const result = await rawRender(...args);
  mounted.push(result);
  return result;
}

function session(partial: Partial<Session> = {}): Session {
  return {
    id: "sess-A",
    desig: "TASK-01",
    name: "task one",
    prompt: "p",
    repoPath: "/repo",
    baseBranch: "main",
    branch: "feat/x",
    worktreePath: "/wt",
    isolated: false,
    herdrSession: "h",
    herdrAgentId: "ha",
    claudeSessionId: "cs",
    model: null,
    status: "idle",
    readyToMerge: false,
    mergingSince: null,
    mergingTrainId: null,
    mergeTrainPrs: null,
    autopilotEnabled: null,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotComplete: false,
    autopilotQuestion: null,
    planGateEnabled: null,
    planPhase: null,
    autoMergeEnabled: null,
    autoMergeRebaseCount: 0,
    auto: false,
    sandboxApplied: null,
    sandboxDegraded: false,
    egressApplied: false,
    egressDegraded: false,
    research: false,
    epicAuthoring: false,
    issueNumber: null,
    lastState: "",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    haltReason: null,
    haltedAt: null,
    manualSteps: [],
    manualStepsAckedAt: null,
    experimentId: null,
    experimentRole: null,
    ...partial,
  };
}

const readyGit: GitState = {
  kind: "github",
  state: "open",
  number: 3530,
  url: "https://github.com/acme/shepherd/pull/3530",
  title: "Fix herdr update-entry eligibility",
  mergeable: true,
  mergeStateStatus: "clean",
  checks: "success",
  deployConfigured: false,
  headSha: "17699a1",
  baseRefName: "main",
};

function host(width = 900): HTMLDivElement {
  const h = document.createElement("div");
  h.style.width = `${width}px`;
  document.body.appendChild(h);
  return h;
}

function row(h: HTMLElement): HTMLElement | null {
  return h.querySelector<HTMLElement>("section.pr-row");
}
function mergeBtn(h: HTMLElement): HTMLButtonElement {
  const b = h.querySelector<HTMLButtonElement>("button.merge");
  expect(b, "merge button present").not.toBeNull();
  return b!;
}
function dialog(h: HTMLElement): HTMLElement | null {
  return h.querySelector<HTMLElement>("[role='dialog']");
}

let fontStyle: HTMLStyleElement;
beforeEach(() => {
  mergePrFn.mockReset();
  reviewPrFn.mockReset().mockResolvedValue("started");
  setReadyToMergeFn.mockClear();
  replySessionFn.mockReset().mockResolvedValue(undefined);
  toastsInfo.mockClear();
  (pullMainAndToast as ReturnType<typeof vi.fn>).mockClear();
  repoConfig.enabled = { ...repoConfig.enabled, "/repo": false };
  fontStyle = document.createElement("style");
  fontStyle.textContent = `:root { --font-mono: ui-monospace, monospace; }
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; }`;
  document.head.appendChild(fontStyle);
});
afterEach(async () => {
  for (const instance of mounted.splice(0).reverse()) await instance.unmount();
  reviews.drop("sess-A");
  recaps.map = {};
  const next = { ...repoConfig.enabled };
  delete next["/repo"];
  repoConfig.enabled = next;
  repoConfig.autopilot = {};
  fontStyle.remove();
  document.body.innerHTML = "";
  await page.viewport(1280, 900);
});

describe("PrActionRow — visibility", () => {
  for (const git of [
    null,
    { ...readyGit, state: "none" as const },
    { ...readyGit, state: "closed" as const },
  ]) {
    it(`renders nothing for ${git?.state ?? "no git"}`, async () => {
      const h = host();
      await render(PrActionRow, { target: h, props: { session: session(), git, status: "idle" } });
      expect(row(h)).toBeNull();
      expect(h.querySelector("button")).toBeNull();
    });
  }
});

describe("PrActionRow — merged", () => {
  const mergedGit: GitState = { ...readyGit, state: "merged" };
  it("offers only Stilllegen: opens the confirmation, sends nothing, no Merge/Ready/Re-review", async () => {
    const h = host();
    const ondecommission = vi.fn();
    repoConfig.enabled = { ...repoConfig.enabled, "/repo": true };
    await render(PrActionRow, {
      target: h,
      props: { session: session(), git: mergedGit, status: "idle", ondecommission },
    });
    expect(row(h)!.classList.contains("merged")).toBe(true);
    expect(row(h)!.textContent).toContain(m.prrow_state_merged());
    expect(h.querySelector("button.merge")).toBeNull();
    expect(h.querySelectorAll(".primary")).toHaveLength(1);
    const b = h.querySelector<HTMLButtonElement>("button.primary")!;
    expect(b.textContent?.trim()).toBe(m.gitrail_decommission_action());
    expect(row(h)!.textContent).not.toContain(m.gitrail_rereview());
    b.click();
    expect(ondecommission).toHaveBeenCalledExactlyOnceWith("sess-A");
    expect(replySessionFn).not.toHaveBeenCalled();
  });
});

describe("PrActionRow — ready", () => {
  it("shows status, number, title, facts and exactly one primary Merge", async () => {
    const h = host();
    const screen = await render(PrActionRow, {
      target: h,
      props: { session: session(), git: readyGit, status: "idle" },
    });
    await expect
      .element(screen.getByRole("region", { name: m.prrow_aria({ number: 3530 }) }))
      .toBeVisible();
    expect(row(h)!.classList.contains("ready")).toBe(true);
    expect(row(h)!.textContent).toContain(m.gitrail_ready_to_merge());
    expect(row(h)!.textContent).toContain("#3530");
    expect(row(h)!.textContent).toContain("Fix herdr update-entry eligibility");
    expect(row(h)!.textContent).toContain(m.prrow_fact_ci_passing());
    expect(row(h)!.textContent).toContain(m.prrow_fact_base_current({ base: "main" }));
    expect(h.querySelectorAll(".primary")).toHaveLength(1);
    expect(mergeBtn(h).textContent?.trim()).toBe(m.gitrail_merge());
    expect(mergeBtn(h).getAttribute("aria-disabled")).toBeNull();
    const link = screen.getByRole("link", { name: m.prbadge_open_pr() });
    await expect.element(link).toHaveAttribute("href", readyGit.url!);
  });

  // #3597: the row's label, title and buttons read in the body face; the PR number stays mono.
  it("sets label, title and buttons in the body face and keeps the PR number mono", async () => {
    const h = host();
    await render(PrActionRow, {
      target: h,
      props: { session: session(), git: readyGit, status: "idle" },
    });
    await expect.poll(() => row(h)).not.toBeNull();

    const family = (el: Element) => getComputedStyle(el).fontFamily;
    const sans = getComputedStyle(document.body).fontFamily;
    const probe = document.body.appendChild(document.createElement("span"));
    probe.style.fontFamily = "var(--font-mono)";
    const mono = getComputedStyle(probe).fontFamily;
    probe.remove();
    expect(sans).not.toBe(mono);

    expect(family(row(h)!), ".pr-row").toBe(sans);
    for (const sel of [".pr-label", ".pr-title"]) {
      expect(family(row(h)!.querySelector(sel)!), sel).toBe(sans);
    }
    expect(family(mergeBtn(h)), ".gbtn.merge").toBe(sans);
    expect(family(row(h)!.querySelector(".pr-num")!), ".pr-num").toBe(mono);
  });

  it("Merge opens the existing confirmation — no inline merge", async () => {
    mergePrFn.mockResolvedValue({ ...readyGit, state: "merged" });
    const h = host();
    await render(PrActionRow, {
      target: h,
      props: { session: session(), git: readyGit, status: "idle" },
    });
    mergeBtn(h).click();
    await vi.waitFor(() => expect(dialog(h), "confirmation open").not.toBeNull());
    expect(mergePrFn, "nothing merges before the answer").not.toHaveBeenCalled();
    const confirm = await vi.waitFor(() => {
      const b = h.querySelector<HTMLButtonElement>("[role='dialog'] button.run");
      expect(b!.disabled, "confirm armed").toBe(false);
      return b!;
    });
    confirm.click();
    await vi.waitFor(() => expect(mergePrFn).toHaveBeenCalledTimes(1));
    expect(mergePrFn).toHaveBeenCalledWith(
      "sess-A",
      expect.objectContaining({
        deleteBranch: true,
        confirm: expect.objectContaining({ headSha: "17699a1" }),
      }),
    );
  });

  it("local forge and epic child relabel Merge", async () => {
    const h = host();
    const screen = await render(PrActionRow, {
      target: h,
      props: {
        session: session(),
        git: { ...readyGit, kind: "local", url: undefined },
        status: "idle",
      },
    });
    expect(mergeBtn(h).textContent?.trim()).toBe(m.gitrail_merge_locally());
    await screen.rerender({
      session: session({ epicParent: 67, baseBranch: "epic/67-x" }),
      git: readyGit,
      status: "idle",
    });
    await vi.waitFor(() =>
      expect(mergeBtn(h).textContent?.trim()).toBe(m.gitrail_merge_into_epic()),
    );
  });
});

describe("PrActionRow — locked states", () => {
  const cases: Array<[string, Partial<GitState>, string, string]> = [
    [
      "ci_running",
      { checks: "pending", mergeStateStatus: "unstable" },
      m.prrow_state_ci_running(),
      m.gitrail_merge_blocked_pending(),
    ],
    [
      "draft",
      { isDraft: true, mergeStateStatus: "draft" },
      m.prrow_state_draft(),
      m.gitrail_merge_blocked_draft(),
    ],
    [
      "protected",
      { mergeStateStatus: "blocked" },
      m.prrow_state_protected(),
      m.gitrail_merge_blocked_protected(),
    ],
  ];
  for (const [kind, over, label, reason] of cases) {
    it(`${kind}: Merge aria-disabled, focusable, names its reason, opens nothing`, async () => {
      const h = host();
      await render(PrActionRow, {
        target: h,
        props: { session: session(), git: { ...readyGit, ...over }, status: "idle" },
      });
      expect(row(h)!.classList.contains(kind)).toBe(true);
      expect(row(h)!.textContent).toContain(label);
      const b = mergeBtn(h);
      expect(b.getAttribute("aria-disabled")).toBe("true");
      expect(b.disabled, "not bare-disabled — stays focusable").toBe(false);
      b.focus();
      expect(document.activeElement).toBe(b);
      expect(b.getAttribute("aria-description") ?? "").toContain(reason);
      b.click();
      await new Promise((r) => setTimeout(r, 30));
      expect(dialog(h), "a locked Merge opens no confirmation").toBeNull();
    });
  }

  it("a PR in the merge queue reads as merging", async () => {
    const h = host();
    await render(PrActionRow, {
      target: h,
      props: { session: session(), git: { ...readyGit, inMergeQueue: true }, status: "idle" },
    });
    expect(row(h)!.classList.contains("merging")).toBe(true);
    expect(mergeBtn(h).getAttribute("aria-busy")).toBe("true");
    expect(mergeBtn(h).textContent?.trim()).toBe(m.prrow_merging());
  });
});

describe("PrActionRow — merge outcome", () => {
  async function mergeThroughDialog(h: HTMLElement) {
    mergeBtn(h).click();
    const confirm = await vi.waitFor(() => {
      const b = h.querySelector<HTMLButtonElement>("[role='dialog'] button.run");
      expect(b, "confirmation open").not.toBeNull();
      expect(b!.disabled, "confirm armed").toBe(false);
      return b!;
    });
    confirm.click();
  }

  it("remote merge offers decommission with the captured session id", async () => {
    mergePrFn.mockResolvedValue({ ...readyGit, state: "merged" });
    const ondecommission = vi.fn();
    const h = host();
    await render(PrActionRow, {
      target: h,
      props: { session: session(), git: readyGit, status: "idle", ondecommission },
    });
    await mergeThroughDialog(h);
    await vi.waitFor(() => expect(toastsInfo).toHaveBeenCalledTimes(1));
    const [, opts] = toastsInfo.mock.calls[0] as [
      string,
      { action?: { label: string; run: () => void }; duration?: number; key?: string },
    ];
    expect(opts.action?.label).toBe(m.gitrail_decommission_action());
    expect(opts.duration).toBe(15_000);
    expect(opts.key).toBe("decommission-offer:sess-A");
    opts.action!.run();
    expect(ondecommission).toHaveBeenCalledWith("sess-A");
    expect(pullMainAndToast).not.toHaveBeenCalled();
  });

  it("isolated merge: the combo action keeps the values captured when the dialog opened", async () => {
    mergePrFn.mockResolvedValue({ ...readyGit, state: "merged" });
    const ondecommission = vi.fn();
    const h = host();
    const screen = await render(PrActionRow, {
      target: h,
      props: {
        session: session({ isolated: true }),
        git: readyGit,
        status: "idle",
        ondecommission,
      },
    });
    await mergeThroughDialog(h);
    await vi.waitFor(() => expect(toastsInfo).toHaveBeenCalledTimes(1));
    const [, opts] = toastsInfo.mock.calls[0] as [
      string,
      { action?: { label: string; run: () => void } },
    ];
    expect(opts.action?.label).toBe(m.gitrail_decommission_update_action());
    // The Viewport rebinds to another (non-isolated) session before the toast is clicked.
    await screen.rerender({
      session: session({
        id: "sess-B",
        repoPath: "/other",
        baseBranch: "release",
        isolated: false,
      }),
      git: readyGit,
      status: "idle",
      ondecommission,
    });
    opts.action!.run();
    expect(ondecommission).toHaveBeenCalledWith("sess-A");
    expect(pullMainAndToast).toHaveBeenCalledWith("/repo", "main");
  });

  it("local merge confirms without a decommission offer", async () => {
    mergePrFn.mockResolvedValue({ ...readyGit, kind: "local", state: "merged" });
    const ondecommission = vi.fn();
    const h = host();
    await render(PrActionRow, {
      target: h,
      props: {
        session: session(),
        git: { ...readyGit, kind: "local" },
        status: "idle",
        ondecommission,
      },
    });
    await mergeThroughDialog(h);
    await vi.waitFor(() => expect(toastsInfo).toHaveBeenCalledTimes(1));
    const opts = (toastsInfo.mock.calls[0] as [string, { action?: unknown }?])[1];
    expect(opts?.action).toBeUndefined();
  });

  it("a failed merge shows its reason in the row instead of the facts", async () => {
    mergePrFn.mockRejectedValue(new Error("host said no"));
    const h = host();
    await render(PrActionRow, {
      target: h,
      props: { session: session(), git: readyGit, status: "idle" },
    });
    await mergeThroughDialog(h);
    await vi.waitFor(() =>
      expect(h.querySelector("[role='alert']")?.textContent).toBe(
        m.gitrail_merge_failed({ reason: "host said no" }),
      ),
    );
    expect(h.querySelector(".pr-facts")).toBeNull();
  });

  it("a session switch closes an unanswered confirmation", async () => {
    const h = host();
    const screen = await render(PrActionRow, {
      target: h,
      props: { session: session(), git: readyGit, status: "idle" },
    });
    mergeBtn(h).click();
    await vi.waitFor(() => expect(dialog(h)).not.toBeNull());
    await screen.rerender({ session: session({ id: "sess-B" }), git: readyGit, status: "idle" });
    await vi.waitFor(() => expect(dialog(h)).toBeNull());
  });
});

describe("PrActionRow — critic re-review (moved from the git strip)", () => {
  function reviewBtn(h: HTMLElement): HTMLButtonElement | null {
    return (
      [
        ...h.querySelectorAll<HTMLButtonElement>(
          "section.pr-row button.gbtn:not(.merge):not(.more)",
        ),
      ][0] ?? null
    );
  }
  beforeEach(() => {
    repoConfig.enabled = { ...repoConfig.enabled, "/repo": true };
  });

  it("shows only with cleared CI and the critic on", async () => {
    const h = host();
    const screen = await render(PrActionRow, {
      target: h,
      props: { session: session(), git: readyGit, status: "idle" },
    });
    await vi.waitFor(() => expect(reviewBtn(h)?.textContent?.trim()).toBe(m.gitrail_review()));
    await screen.rerender({
      session: session(),
      git: { ...readyGit, checks: "pending" },
      status: "idle",
    });
    await vi.waitFor(() => expect(reviewBtn(h)).toBeNull());
    repoConfig.enabled = { ...repoConfig.enabled, "/repo": false };
    await screen.rerender({ session: session(), git: readyGit, status: "idle" });
    await vi.waitFor(() => expect(reviewBtn(h)).toBeNull());
  });

  it("labels Re-review once a verdict exists", async () => {
    const verdict: ReviewVerdict = {
      sessionId: "sess-A",
      headSha: "17699a1",
      decision: "commented",
      summary: "ok",
      body: "fine",
      findings: [],
      addressRound: 0,
      addressCap: 2,
      finalRoundPending: false,
      finalRoundTimeoutMs: 900000,
      updatedAt: Date.now(),
    };
    reviews.apply({ id: "sess-A", review: verdict });
    const h = host();
    await render(PrActionRow, {
      target: h,
      props: { session: session(), git: readyGit, status: "idle" },
    });
    await vi.waitFor(() => expect(reviewBtn(h)?.textContent?.trim()).toBe(m.gitrail_rereview()));
    expect(row(h)!.textContent).toContain(m.prrow_fact_critic_reviewed());
  });

  it("first click arms, second calls reviewPr once", async () => {
    const h = host();
    await render(PrActionRow, {
      target: h,
      props: { session: session(), git: readyGit, status: "idle" },
    });
    await vi.waitFor(() => expect(reviewBtn(h)).not.toBeNull());
    reviewBtn(h)!.click();
    await vi.waitFor(() =>
      expect(reviewBtn(h)!.textContent?.trim()).toBe(m.gitrail_confirm_review()),
    );
    expect(reviewPrFn).not.toHaveBeenCalled();
    reviewBtn(h)!.click();
    await vi.waitFor(() => expect(reviewPrFn).toHaveBeenCalledWith("sess-A"));
  });

  for (const [res, expected] of [
    ["skipped", () => [m.gitrail_review_skipped()]],
    [
      "error",
      () => [
        m.gitrail_review_failed(),
        expect.objectContaining({ alert: true, key: "review-pr:sess-A" }),
      ],
    ],
  ] as const) {
    it(`'${res}' raises its toast`, async () => {
      reviewPrFn.mockResolvedValue(res);
      const h = host();
      await render(PrActionRow, {
        target: h,
        props: { session: session(), git: readyGit, status: "idle" },
      });
      await vi.waitFor(() => expect(reviewBtn(h)).not.toBeNull());
      reviewBtn(h)!.click();
      await vi.waitFor(() =>
        expect(reviewBtn(h)!.textContent?.trim()).toBe(m.gitrail_confirm_review()),
      );
      reviewBtn(h)!.click();
      await vi.waitFor(() => expect(toastsInfo).toHaveBeenCalledWith(...expected()));
    });
  }
});

describe("PrActionRow — ⋯ menu", () => {
  function recap(): Recap {
    return {
      sessionId: "sess-A",
      state: "ready",
      headSha: "abc",
      verdict: "ready",
      headline: "All done",
      body: "body",
      openItems: [],
      changedFiles: [],
      spawnSessionId: "sess-A",
      cwd: "/repo",
      model: null,
      spawnedAt: 0,
      generatedAt: 1000,
      updatedAt: 1000,
    } as Recap;
  }

  it("offers Ready, Issue and Summary when each applies", async () => {
    recaps.map = { "sess-A": recap() };
    const onsummary = vi.fn();
    const h = host();
    const screen = await render(PrActionRow, {
      target: h,
      props: {
        session: session({ issueNumber: 855 }),
        git: { ...readyGit, issueUrl: "https://github.com/acme/shepherd/issues/855" },
        status: "idle",
        onsummary,
      },
    });
    await screen.getByRole("button", { name: m.prrow_more_aria() }).click();
    await expect
      .element(page.getByRole("menuitemcheckbox", { name: m.prrow_menu_mark_ready() }))
      .toBeVisible();
    await expect
      .element(page.getByRole("menuitem", { name: m.gitrail_open_issue() }))
      .toHaveAttribute("href", "https://github.com/acme/shepherd/issues/855");
    await page.getByRole("menuitem", { name: m.prrow_menu_summary() }).click();
    expect(onsummary).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(document.querySelector("[role='menu']")).toBeNull());
  });

  it("Mark ready toggles the session flag", async () => {
    const h = host();
    const screen = await render(PrActionRow, {
      target: h,
      props: { session: session({ readyToMerge: true }), git: readyGit, status: "idle" },
    });
    await screen.getByRole("button", { name: m.prrow_more_aria() }).click();
    const item = page.getByRole("menuitemcheckbox", { name: m.prrow_menu_mark_ready() });
    await expect.element(item).toHaveAttribute("aria-checked", "true");
    await item.click();
    expect(setReadyToMergeFn).toHaveBeenCalledWith("sess-A", false);
  });

  it("no Ready while the agent runs, no Summary without a recap, no ⋯ when empty", async () => {
    const h = host();
    await render(PrActionRow, {
      target: h,
      props: { session: session(), git: readyGit, status: "running", onsummary: vi.fn() },
    });
    expect(h.querySelector("button.more"), "no menu items → no ⋯").toBeNull();
  });
});

describe("PrActionRow — phone", () => {
  beforeEach(() => {
    repoConfig.enabled = { ...repoConfig.enabled, "/repo": true };
  });

  it("360px: stacked, ⋯ · PR ↗ · Merge, every target ≥ 44px, no horizontal overflow", async () => {
    await page.viewport(360, 800);
    const h = host(360);
    await render(PrActionRow, {
      target: h,
      props: { session: session(), git: readyGit, status: "idle", mobile: true, touch: true },
    });
    const r = row(h)!;
    expect(r.scrollWidth, "no horizontal overflow").toBeLessThanOrEqual(r.clientWidth);
    const hit = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--mobile-actionbar-hit"),
    );
    const targets = [...r.querySelectorAll<HTMLElement>("button, a[href]")];
    expect(targets.map((t) => t.textContent?.trim())).toEqual([
      "⋯",
      m.prrow_pr_link(),
      m.gitrail_merge(),
    ]);
    for (const t of targets) {
      const rect = t.getBoundingClientRect();
      expect(rect.height, `${t.textContent} height`).toBeGreaterThanOrEqual(hit);
      expect(rect.width, `${t.textContent} width`).toBeGreaterThanOrEqual(hit);
      expect(rect.right, `${t.textContent} inside the row`).toBeLessThanOrEqual(
        r.getBoundingClientRect().right + 1,
      );
    }
    // ⋯ leads the action row visually, Merge takes the rest
    const [more, , merge] = targets;
    expect(more.getBoundingClientRect().left).toBeLessThan(merge.getBoundingClientRect().left);
  });

  it("the critic trigger moves into the ⋯ menu and fires without the arm step", async () => {
    await page.viewport(360, 800);
    const h = host(360);
    const screen = await render(PrActionRow, {
      target: h,
      props: { session: session(), git: readyGit, status: "idle", mobile: true, touch: true },
    });
    await screen.getByRole("button", { name: m.prrow_more_aria() }).click();
    await page.getByRole("menuitem", { name: m.gitrail_review() }).click();
    await vi.waitFor(() => expect(reviewPrFn).toHaveBeenCalledWith("sess-A"));
  });
});

describe("PrActionRow — next step (#3541)", () => {
  const red: GitState = {
    ...readyGit,
    checks: "failure",
    mergeStateStatus: "unstable",
    jobs: [
      { name: "lint", state: "failure", url: "https://github.com/acme/shepherd/actions/runs/9" },
      { name: "test (1/2)", state: "failure" },
      { name: "build", state: "success" },
    ],
  };
  const behind: GitState = { ...readyGit, mergeStateStatus: "behind" };
  const conflict: GitState = { ...readyGit, mergeStateStatus: "dirty", mergeable: false };
  const primary = (h: HTMLElement) => h.querySelector<HTMLButtonElement>("button.primary")!;
  const setAutopilot = (on: boolean) => {
    repoConfig.autopilot = { ...repoConfig.autopilot, "/repo": on };
  };

  it("red CI: one click steers the live agent once with the failing checks, then shows Sent", async () => {
    const h = host();
    const onsent = vi.fn();
    await render(PrActionRow, {
      target: h,
      props: { session: session(), git: red, status: "idle", liveness: "alive", onsent },
    });
    expect(row(h)!.classList.contains("ci_failed")).toBe(true);
    expect(h.querySelector("button.merge")).toBeNull();
    expect(primary(h).textContent?.trim()).toBe(m.prrow_fix_ci());
    primary(h).click();
    primary(h).click(); // double click: still one steer
    await expect.poll(() => primary(h).textContent?.trim()).toBe(m.prrow_sent());
    expect(replySessionFn).toHaveBeenCalledExactlyOnceWith("sess-A", expect.any(String));
    const text = replySessionFn.mock.calls[0][1];
    expect(text).toContain("lint, test (1/2)");
    expect(text).not.toContain("build");
    expect(onsent).toHaveBeenCalledExactlyOnceWith(text, expect.any(Promise));
    expect(primary(h).getAttribute("aria-disabled")).toBe("true");
  });

  it("red CI: Logs ↗ links the failing check; without a job URL, the PR's checks tab", async () => {
    const h = host();
    const screen = await render(PrActionRow, {
      target: h,
      props: { session: session(), git: red, status: "idle" },
    });
    await expect
      .element(screen.getByRole("link", { name: m.prrow_logs_aria() }))
      .toHaveAttribute("href", "https://github.com/acme/shepherd/actions/runs/9");
    expect(h.textContent).not.toContain(m.prrow_pr_link());
    await screen.unmount();
    const h2 = host();
    const s2 = await render(PrActionRow, {
      target: h2,
      props: { session: session(), git: { ...red, jobs: [] }, status: "idle" },
    });
    await expect
      .element(s2.getByRole("link", { name: m.prrow_logs_aria() }))
      .toHaveAttribute("href", `${readyGit.url}/checks`);
  });

  it("behind and conflict: Rebase steers the rebase", async () => {
    for (const [git, needle] of [
      [behind, "behind main"],
      [conflict, "resolve the conflicts"],
    ] as const) {
      replySessionFn.mockClear();
      const h = host();
      const screen = await render(PrActionRow, {
        target: h,
        props: { session: session(), git, status: "idle" },
      });
      expect(primary(h).textContent?.trim()).toBe(m.prrow_rebase());
      primary(h).click();
      await expect.poll(() => replySessionFn.mock.calls.length).toBe(1);
      expect(replySessionFn.mock.calls[0][1]).toContain(needle);
      expect(replySessionFn.mock.calls[0][1]).toContain("origin/main");
      await screen.unmount();
    }
  });

  it("effective autopilot (repo default or override): a hint, no button, no steer", async () => {
    for (const git of [red, behind, conflict]) {
      setAutopilot(true);
      const h = host();
      const screen = await render(PrActionRow, {
        target: h,
        props: { session: session(), git, status: "idle" },
      });
      expect(h.querySelector("button.primary")).toBeNull();
      const hint = h.querySelector<HTMLElement>(".pr-passive")!;
      expect(hint.textContent).toBe(git === red ? m.prrow_passive_ci() : m.prrow_passive_rebase());
      hint.click();
      expect(replySessionFn).not.toHaveBeenCalled();
      await screen.unmount();
    }
    // an explicit per-session opt-out beats the repo default
    setAutopilot(true);
    const h = host();
    await render(PrActionRow, {
      target: h,
      props: { session: session({ autopilotEnabled: false }), git: red, status: "idle" },
    });
    expect(primary(h).textContent?.trim()).toBe(m.prrow_fix_ci());
  });

  it("a reviewing critic holds the CI fix, with its reason; the rebase stays free", async () => {
    reviews.setReviewing("sess-A", true);
    const h = host();
    const screen = await render(PrActionRow, {
      target: h,
      props: { session: session(), git: red, status: "idle" },
    });
    const b = primary(h);
    expect(b.getAttribute("aria-disabled")).toBe("true");
    expect(b.disabled).toBe(false);
    expect(b.getAttribute("aria-description") ?? "").toContain(m.prrow_locked_critic());
    b.click();
    await new Promise((r) => setTimeout(r, 30));
    expect(replySessionFn).not.toHaveBeenCalled();
    await screen.unmount();
    const h2 = host();
    await render(PrActionRow, {
      target: h2,
      props: { session: session(), git: behind, status: "idle" },
    });
    expect(primary(h2).getAttribute("aria-disabled")).toBeNull();
  });

  it("agent not live (husk, shelved, done): locked with its reason, nothing sent", async () => {
    for (const [s, liveness] of [
      [session(), "husk"],
      [session({ shelved: true }), undefined],
      [session({ status: "done" }), undefined],
    ] as const) {
      const h = host();
      const screen = await render(PrActionRow, {
        target: h,
        props: { session: s, git: red, status: s.status, liveness },
      });
      const b = primary(h);
      expect(b.getAttribute("aria-disabled")).toBe("true");
      expect(b.getAttribute("aria-description") ?? "").toContain(m.prrow_locked_not_live());
      b.click();
      await new Promise((r) => setTimeout(r, 30));
      expect(replySessionFn).not.toHaveBeenCalled();
      await screen.unmount();
    }
  });

  it("a failed send toasts with Retry and re-enables the button", async () => {
    replySessionFn.mockRejectedValueOnce(new Error("boom"));
    const h = host();
    await render(PrActionRow, {
      target: h,
      props: { session: session(), git: behind, status: "idle" },
    });
    primary(h).click();
    await expect.poll(() => toastsInfo.mock.calls.length).toBe(1);
    const [msg, opts] = toastsInfo.mock.calls[0];
    expect(msg).toBe(m.steerbar_send_failed());
    expect(opts.action?.label).toBe(m.common_retry());
    expect(primary(h).textContent?.trim()).toBe(m.prrow_rebase());
    expect(primary(h).getAttribute("aria-disabled")).toBeNull();
    opts.action.run();
    await expect.poll(() => replySessionFn.mock.calls.length).toBe(2);
  });

  it("Sent ✓ gives way to the git state again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const h = host();
      await render(PrActionRow, {
        target: h,
        props: { session: session(), git: behind, status: "idle" },
      });
      primary(h).click();
      await vi.waitFor(() => expect(primary(h).textContent?.trim()).toBe(m.prrow_sent()));
      vi.advanceTimersByTime(2600);
      await vi.waitFor(() => expect(primary(h).textContent?.trim()).toBe(m.prrow_rebase()));
    } finally {
      vi.useRealTimers();
    }
  });
});
