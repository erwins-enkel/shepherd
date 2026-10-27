import { describe, it, expect, vi, beforeEach } from "vitest";
import { tick } from "svelte";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../app.css";
import type { EpicDraft } from "#lib/types.js";
import { epicDrafts } from "#lib/epic-draft.svelte.js";
import { expectMinPx } from "#lib/test-support/geometry.js";
import { THEMES, expectQuietLegible } from "#lib/test-support/contrast.js";
import { m } from "#lib/paraglide/messages.js";
import EpicDraftModal from "./EpicDraftModal.svelte";

const approve = vi.hoisted(() => ({ approveEpic: vi.fn(async () => {}) }));
vi.mock("#lib/epic-approve.js", () => approve);
const api = vi.hoisted(() => ({
  getRepoConfig: vi.fn<(repo: string) => Promise<unknown>>(async () => {
    throw new Error("offline");
  }),
}));
vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return { ...actual, ...api };
});

function longDraft(sessionId: string): EpicDraft {
  return {
    sessionId,
    parent: {
      title: "Keep long epic drafts reviewable",
      body: Array.from(
        { length: 80 },
        (_, i) =>
          `Section ${i + 1}\nDetailed research finding that must remain readable before approval.`,
      ).join("\n\n"),
      acceptanceCriteria: ["The complete draft can be reviewed."],
      nonGoals: ["Collapsible sections"],
    },
    children: Array.from({ length: 12 }, (_, i) => ({
      key: `child-${i + 1}`,
      title: `Child issue ${i + 1}`,
      body: "A concrete vertical slice with enough detail to wrap on a narrow screen.",
      acceptanceCriteria: ["The slice is independently verifiable."],
      blockedBy: i === 0 ? [] : [`child-${i}`],
    })),
    status: "draft",
    revision: 1,
    materializedChildren: {},
    parentNumber: null,
    parentUrl: null,
  };
}

/** Is the element the one that would actually receive a click at its own center? */
function hitTestable(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return el.contains(top) || el === top;
}

describe.each([
  ["desktop", 1000],
  ["narrow", 390],
])("EpicDraftModal long-draft layout — %s", (label, width) => {
  it("scrolls the draft while the review actions stay pinned and clickable", async () => {
    const sessionId = `epic-draft-modal-${label}`;
    epicDrafts.upsert(longDraft(sessionId));

    const { container, unmount } = await render(EpicDraftModal, {
      sessionId,
      repoPath: "/repo/draft",
      sessionLive: true,
      onclose: () => {},
    });
    const card = container.querySelector<HTMLElement>(".card");
    if (card) card.style.width = `${width}px`;

    const body = container.querySelector<HTMLElement>(".body");
    const approve = container.querySelector<HTMLElement>(".approve");
    const abort = container.querySelector<HTMLElement>(".abort");
    const list = container.querySelector<HTMLElement>(".list");

    expect(body, "the body owns the only scroll").not.toBeNull();
    expect(approve, "approve must render while awaiting").not.toBeNull();
    expect(abort, "abort must render while awaiting").not.toBeNull();
    expect(list, "child list should render").not.toBeNull();
    if (!body || !approve || !abort || !list) {
      unmount();
      return;
    }

    expect(getComputedStyle(body).overflowY).toBe("auto");
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
    expect(getComputedStyle(list).overflowY).not.toBe("auto");

    // a11y sizing floor on the actions that commit or discard a whole epic.
    expectMinPx(approve.getBoundingClientRect().height, 44, "approve tap-target");
    expectMinPx(abort.getBoundingClientRect().height, 44, "abort tap-target");

    // Pinned means pinned: reachable at the top of the draft AND at the very bottom of it.
    expect(hitTestable(approve), "approve clickable at scroll-top").toBe(true);
    expect(hitTestable(abort), "abort clickable at scroll-top").toBe(true);

    body.scrollTop = body.scrollHeight;
    await tick();

    expect(body.scrollTop).toBeGreaterThan(0);
    expect(hitTestable(approve), "approve clickable at scroll-bottom").toBe(true);
    expect(hitTestable(abort), "abort clickable at scroll-bottom").toBe(true);

    unmount();
  });

  it("uses readable text measures and standard-sized review controls", async () => {
    const sessionId = `epic-draft-modal-readability-${label}`;
    epicDrafts.upsert(longDraft(sessionId));

    const { container, unmount } = await render(EpicDraftModal, {
      sessionId,
      repoPath: "/repo/draft",
      sessionLive: true,
      onclose: () => {},
    });
    const card = container.querySelector<HTMLElement>(".card");
    if (card) card.style.width = `${width}px`;

    const parentBody = container.querySelector<HTMLElement>(".parent-body")!;
    const criteria = container.querySelector<HTMLElement>(".crit")!;
    const childTitle = container.querySelector<HTMLElement>(".edp-child-title")!;
    const childBody = container.querySelector<HTMLElement>(".edp-child-body")!;
    const input = container.querySelector<HTMLInputElement>(".amend-input")!;
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".btn")];
    const bodyFontSize = parseFloat(getComputedStyle(document.body).fontSize);

    for (const element of [parentBody, criteria, childTitle, childBody]) {
      expect(parseFloat(getComputedStyle(element).fontSize)).toBe(bodyFontSize);
    }
    for (const element of [parentBody, criteria, childBody]) {
      const style = getComputedStyle(element);
      expect(parseFloat(style.lineHeight) / parseFloat(style.fontSize)).toBeGreaterThanOrEqual(
        1.45,
      );
      expect(style.maxWidth).not.toBe("none");
    }

    expect(parseFloat(getComputedStyle(input).fontSize)).toBeGreaterThanOrEqual(bodyFontSize);
    expectMinPx(input.getBoundingClientRect().height, 44, "input tap-target");
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(parseFloat(getComputedStyle(button).fontSize)).toBe(bodyFontSize);
      expectMinPx(button.getBoundingClientRect().height, 44, "button tap-target");
    }

    unmount();
  });
});

describe("EpicDraftModal — dialog behavior", () => {
  it("closes on Escape", async () => {
    const sessionId = "epic-draft-modal-esc";
    epicDrafts.upsert(longDraft(sessionId));
    const onclose = vi.fn();

    const { unmount } = await render(EpicDraftModal, {
      sessionId,
      repoPath: "/repo/draft",
      sessionLive: true,
      onclose,
    });

    await userEvent.keyboard("{Escape}");
    expect(onclose).toHaveBeenCalledTimes(1);

    unmount();
  });

  // After Approve the draft walks draft → materializing → approved under the dialog. It must STAY
  // OPEN: auto-closing would yank the just-created parent link away the instant it appears.
  it("stays open across materializing → approved and surfaces the parent link", async () => {
    const sessionId = "epic-draft-modal-approve";
    const base = longDraft(sessionId);
    epicDrafts.upsert(base);

    const { container, unmount } = await render(EpicDraftModal, {
      sessionId,
      repoPath: "/repo/draft",
      sessionLive: true,
      onclose: () => {},
    });

    expect(container.querySelector(".approve")).not.toBeNull();

    epicDrafts.upsert({ ...base, status: "materializing" });
    await tick();

    expect(container.querySelector(".card"), "dialog stays open while creating").not.toBeNull();
    expect(container.querySelector(".approve"), "actions retire once approved").toBeNull();
    expect(container.querySelector(".note")).not.toBeNull();

    epicDrafts.upsert({
      ...base,
      status: "approved",
      parentNumber: 4242,
      parentUrl: "https://example.invalid/issues/4242",
    });
    await tick();

    const link = container.querySelector<HTMLAnchorElement>(".link");
    expect(container.querySelector(".card"), "dialog stays open once created").not.toBeNull();
    expect(link, "the created epic's parent link must be reachable").not.toBeNull();
    expect(link!.href).toBe("https://example.invalid/issues/4242");

    unmount();
  });
});

function shapedDraft(sessionId: string): EpicDraft {
  return {
    sessionId,
    parent: {
      title: "Distribute tasks across Shepherd hosts",
      body: "Intro paragraph.\n\n## Goal\n\nRun each task on the **right** host.\n\n## Decisions\n\n- **Roles:** Linux coordinates.",
      acceptanceCriteria: ["An iOS task starts on the MacBook."],
      nonGoals: ["Live migration"],
    },
    children: [
      { key: "c1", title: "Pair hosts", body: "", acceptanceCriteria: [], blockedBy: [] },
      { key: "c2", title: "Derive needs", body: "", acceptanceCriteria: [], blockedBy: [] },
      { key: "c3", title: "Report abilities", body: "", acceptanceCriteria: [], blockedBy: ["c1"] },
      {
        key: "c4",
        title: "Pick the host",
        body: "Uses the **preference order**.",
        acceptanceCriteria: ["Starts without asking."],
        blockedBy: ["c2", "c3"],
      },
    ],
    status: "draft",
    revision: 1,
    materializedChildren: {},
    parentNumber: null,
    parentUrl: null,
  };
}

describe("EpicDraftModal — document view", () => {
  beforeEach(async () => {
    await page.viewport(1280, 900);
  });

  it("renders the Markdown body in sections with a table of contents on a wide card", async () => {
    const sessionId = "epic-draft-modal-document";
    epicDrafts.upsert(shapedDraft(sessionId));
    const { container, unmount } = await render(EpicDraftModal, {
      sessionId,
      repoPath: "/repo/draft",
      sessionLive: true,
      onclose: () => {},
    });
    const card = container.querySelector<HTMLElement>(".card")!;
    card.style.width = "1100px";

    await vi.waitFor(() => expect(container.querySelector(".parent-body strong")).not.toBeNull());
    const doc = container.querySelector<HTMLElement>(".doc")!;
    expect(doc.textContent).not.toContain("**");
    expect(doc.textContent).not.toContain("## ");
    expect([...container.querySelectorAll(".part-title")].map((h) => h.textContent)).toEqual(
      expect.arrayContaining(["Goal", "Decisions"]),
    );

    const toc = container.querySelector<HTMLElement>(".toc")!;
    expect(getComputedStyle(toc).display).not.toBe("none");
    expect([...toc.querySelectorAll(".toc-item")].map((b) => b.textContent?.trim())).toEqual([
      m.epicdraft_toc_overview(),
      "Goal",
      "Decisions",
      m.epicdraft_acceptance_label(),
      m.epicdraft_nongoals_label(),
      m.epicdraft_children_label({ count: 4 }),
    ]);
    expect(container.querySelector(".outcome")?.textContent).toContain("1, 2");

    card.style.width = "390px";
    await tick();
    expect(getComputedStyle(toc).display, "no table of contents on a narrow card").toBe("none");

    unmount();
  });

  it("labels each child with its wave and jumps to a blocker", async () => {
    const sessionId = "epic-draft-modal-waves";
    epicDrafts.upsert(longDraft(sessionId));
    const { container, unmount } = await render(EpicDraftModal, {
      sessionId,
      repoPath: "/repo/draft",
      sessionLive: true,
      onclose: () => {},
    });
    container.querySelector<HTMLElement>(".card")!.style.width = "1100px";

    const waves = [...container.querySelectorAll(".edp-wave")].map((w) => w.textContent);
    expect(waves.slice(0, 3)).toEqual([1, 2, 3].map((n) => m.epicdraft_wave({ n })));
    expect(container.querySelector(".approve")?.textContent).toContain(
      m.epicdraft_approve_count({ count: 13 }),
    );

    const body = container.querySelector<HTMLElement>(".body")!;
    const secondRow = container.querySelector<HTMLElement>('[data-child-key="child-2"]')!;
    secondRow.querySelector<HTMLButtonElement>(".edp-dep")!.click();
    await tick();

    const target = container.querySelector<HTMLElement>('[data-child-key="child-1"]')!;
    const offset = target.getBoundingClientRect().top - body.getBoundingClientRect().top;
    expect(Math.abs(offset), "the blocker row lands at the top of the draft").toBeLessThan(16);

    // Rows on screen count as seen after a short dwell, not on first paint.
    expect(container.querySelector(".seen-progress")?.textContent).toBe(
      m.epicdraft_seen_progress({ seen: 0, total: 12 }),
    );
    await vi.waitFor(
      () =>
        expect(container.querySelector(".seen-progress")?.textContent).not.toBe(
          m.epicdraft_seen_progress({ seen: 0, total: 12 }),
        ),
      { timeout: 3000 },
    );

    unmount();
  });
});

describe("EpicDraftModal — resumed draft", () => {
  beforeEach(async () => {
    await page.viewport(1280, 900);
  });

  // A failed materialize returns the draft to `draft` but keeps what it created; the retry skips
  // those, so the counts must too.
  it("counts only the issues approving will still create", async () => {
    const sessionId = "epic-draft-modal-resume";
    epicDrafts.upsert({
      ...shapedDraft(sessionId),
      revision: 1,
      materializedChildren: { c1: 101, c2: 102 },
      parentNumber: 4242,
      parentUrl: "https://example.invalid/issues/4242",
    });
    const { container, unmount } = await render(EpicDraftModal, {
      sessionId,
      repoPath: "/repo/draft",
      sessionLive: true,
      onclose: () => {},
    });
    container.querySelector<HTMLElement>(".card")!.style.width = "1100px";
    await tick();

    expect(container.querySelector(".approve")?.textContent).toContain(
      m.epicdraft_approve_count({ count: 2 }),
    );
    const issuesRow = [...container.querySelectorAll(".outcome dd")].find((dd) =>
      dd.textContent?.includes(m.epicdraft_outcome_issues()),
    );
    expect(issuesRow?.textContent).toContain("2");

    unmount();
  });
});

describe("EpicDraftModal — seen marks", () => {
  beforeEach(async () => {
    await page.viewport(1280, 900);
  });

  it("keeps seen marks while the review scrolls on and adds new ones", async () => {
    const sessionId = "epic-draft-modal-seen";
    epicDrafts.upsert(longDraft(sessionId));
    const { container, unmount } = await render(EpicDraftModal, {
      sessionId,
      repoPath: "/repo/draft",
      sessionLive: true,
      onclose: () => {},
    });
    container.querySelector<HTMLElement>(".card")!.style.width = "1100px";
    const body = container.querySelector<HTMLElement>(".body")!;
    const ticks = () => container.querySelectorAll(".toc-seen").length;
    const firstChildTicked = () =>
      container.querySelector(".toc-children li:first-child .toc-seen") !== null;

    container
      .querySelector<HTMLElement>('[data-child-key="child-1"]')!
      .scrollIntoView({ block: "start" });
    await vi.waitFor(() => expect(firstChildTicked()).toBe(true), { timeout: 3000 });
    const firstBatch = ticks();

    // Further dwell timers must not wipe what is already marked.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(ticks(), "marks survive later dwell timers").toBe(firstBatch);

    body.scrollTop = body.scrollHeight;
    await vi.waitFor(() => expect(ticks()).toBeGreaterThan(firstBatch), { timeout: 3000 });
    expect(firstChildTicked(), "earlier marks stay after scrolling on").toBe(true);
    expect(container.querySelector(".seen-progress")?.textContent).toBe(
      m.epicdraft_seen_progress({ seen: ticks(), total: 12 }),
    );

    unmount();
  });
});

describe("EpicDraftModal landing choice (#3191)", () => {
  beforeEach(() => approve.approveEpic.mockClear());

  it("defaults to the integration branch and sends no landing", async () => {
    const sessionId = "epic-draft-landing-default";
    epicDrafts.upsert(longDraft(sessionId));
    const { unmount } = await render(EpicDraftModal, {
      sessionId,
      repoPath: "/repo/draft",
      sessionLive: true,
      onclose: () => {},
    });

    await expect
      .element(page.getByRole("radio", { name: m.epic_landing_integration() }))
      .toBeChecked();
    await page.getByRole("button", { name: m.epicdraft_approve_count({ count: 13 }) }).click();
    expect(approve.approveEpic).toHaveBeenCalledWith(sessionId, 1, undefined);
    unmount();
  });

  it("passes incremental through to approveEpic", async () => {
    const sessionId = "epic-draft-landing-incremental";
    epicDrafts.upsert(longDraft(sessionId));
    const { unmount } = await render(EpicDraftModal, {
      sessionId,
      repoPath: "/repo/draft",
      sessionLive: true,
      onclose: () => {},
    });

    await page.getByRole("radio", { name: m.epic_landing_incremental() }).click();
    await page.getByRole("button", { name: m.epicdraft_approve_count({ count: 13 }) }).click();
    expect(approve.approveEpic).toHaveBeenCalledWith(sessionId, 1, "incremental");
    unmount();
  });
});

// #3283: slate (--status-done) is 3.0:1 on the panel — the approved chip and note read muted.
describe("EpicDraftModal approved contrast", () => {
  for (const theme of THEMES) {
    it(`keeps the approved chip and note legible and un-green: ${theme}`, async () => {
      document.documentElement.dataset.theme = theme;
      const sessionId = `epic-draft-modal-approved-${theme}`;
      epicDrafts.upsert({ ...longDraft(sessionId), status: "approved" });
      const { unmount } = await render(EpicDraftModal, {
        sessionId,
        repoPath: "/repo/draft",
        sessionLive: true,
        onclose: () => {},
      });
      expectQuietLegible(document.querySelector<HTMLElement>(".chip-done")!);
      expectQuietLegible(document.querySelector<HTMLElement>(".note-done")!);
      unmount();
      document.documentElement.removeAttribute("data-theme");
    });
  }
});

// #3423: incremental landing in a repo nobody merges in, and siblings that overlap.
describe("EpicDraftModal — merge gate and overlap", () => {
  it("warns once incremental is picked for a dependent draft nobody merges", async () => {
    const sessionId = "epic-draft-modal-stall";
    api.getRepoConfig.mockImplementation(async () => ({
      autoMergeEnabled: false,
      autopilotEnabled: false,
      draftMode: false,
      epicStacksEnabled: false,
    }));
    epicDrafts.upsert(longDraft(sessionId));
    const { unmount } = await render(EpicDraftModal, {
      sessionId,
      repoPath: "/repo/draft-stall",
      sessionLive: true,
      onclose: () => {},
    });
    const warning = () => page.getByText(m.epic_incremental_stall_warning());
    await expect.poll(() => api.getRepoConfig.mock.calls.length).toBeGreaterThan(0);
    expect(warning().query()).toBeNull();
    await page.getByRole("radio", { name: m.epic_landing_incremental() }).click();
    await expect.element(warning()).toBeInTheDocument();
    unmount();
  });

  it("flags unordered children that touch the same anchor", async () => {
    const sessionId = "epic-draft-modal-overlap";
    const base = longDraft(sessionId);
    epicDrafts.upsert({
      ...base,
      children: [
        { ...base.children[0], touches: ["ui/messages/*.json"] },
        { ...base.children[1], blockedBy: [], touches: ["ui/messages/*.json"] },
      ],
    });
    const { container, unmount } = await render(EpicDraftModal, {
      sessionId,
      repoPath: "/repo/draft-overlap",
      sessionLive: true,
      onclose: () => {},
    });
    const hint = container.querySelector("[data-overlap-hint]");
    expect(hint?.textContent).toBe(
      m.epicdraft_overlap_hint({
        a: "1 · Child issue 1",
        b: "2 · Child issue 2",
        anchors: "ui/messages/*.json",
      }),
    );
    unmount();
  });

  // A 10+ issue approve takes a while: the footer shows a live determinate bar, not a frozen note.
  it("renders live materialize progress as a bar with count and phase", async () => {
    const sessionId = "epic-draft-modal-progress";
    const base = longDraft(sessionId);
    epicDrafts.upsert({
      ...base,
      status: "materializing",
      progress: { done: 4, total: 26, phase: "issues" },
    });

    const { container, unmount } = await render(EpicDraftModal, {
      sessionId,
      repoPath: "/repo/draft",
      sessionLive: true,
      onclose: () => {},
    });

    const bar = container.querySelector<HTMLProgressElement>("progress.materialize-bar");
    expect(bar, "progress bar renders while materializing").not.toBeNull();
    expect(bar!.value).toBe(4);
    expect(bar!.max).toBe(26);
    expect(bar!.getAttribute("aria-label")).toBeTruthy();
    const block = container.querySelector("[data-epic-materialize-progress]")!;
    expect(block.textContent).toContain("4 / 26");
    expect(block.textContent).toContain("Creating the issues");

    epicDrafts.upsert({
      ...base,
      status: "materializing",
      progress: { done: 20, total: 26, phase: "links" },
    });
    await tick();
    expect(bar!.value).toBe(20);
    expect(block.textContent).toContain("Linking");

    // No progress (older server / lost event) → the plain note, no bar.
    epicDrafts.upsert({ ...base, status: "materializing" });
    await tick();
    expect(container.querySelector("progress.materialize-bar")).toBeNull();
    expect(container.querySelector(".note")).not.toBeNull();

    unmount();
  });
});
