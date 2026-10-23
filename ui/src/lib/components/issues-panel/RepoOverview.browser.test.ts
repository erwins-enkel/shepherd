import { describe, it, expect, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import RepoOverview from "./RepoOverview.svelte";
import type { DrainStatus, Epic, EpicSummary, Issue } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";

const B = 20;
const A = 10;

function summaryOf(n: number, merged: number, total: number): EpicSummary {
  return {
    parentIssueNumber: n,
    parentTitle: `Epic ${n}`,
    merged,
    total,
    status: "idle",
    source: "native",
  };
}

function issue(n: number): Issue {
  return {
    number: n,
    title: `Issue ${n}`,
    body: "",
    url: "u",
    labels: [],
    createdAt: 0,
    assignees: [],
  };
}

// B (#20) leads with #21 next, A (#10) winds down with #11 in flight.
function drain(): DrainStatus {
  return {
    repoPath: "/repo",
    enabled: true,
    paused: false,
    reason: null,
    detail: null,
    queued: 1,
    inFlight: 1,
    max: 2,
    epicParent: B,
    runSummary: {
      leadingEpic: B,
      windingDown: [{ epic: A, inFlight: [11] }],
      slots: {
        used: 1,
        max: 2,
        holders: [{ sessionId: "s11", desig: "TASK-11", issueNumber: 11, epicParent: A }],
      },
      next: [21],
      after: [],
    },
  };
}

function leading(): Epic {
  return {
    repoPath: "/repo",
    parentIssueNumber: B,
    parentTitle: "Epic 20",
    source: "native",
    children: [
      {
        number: 21,
        title: "First of B",
        url: "u",
        order: 0,
        body: "",
        blockedBy: [],
        state: "ready",
        sessionId: null,
        prNumber: null,
        issueClosed: false,
        claimed: false,
      },
    ],
    warnings: [],
    run: { repoPath: "/repo", parentIssueNumber: B, mode: "auto", status: "running" },
  };
}

const titleFor = (n: number) => (n === 21 ? "First of B" : null);
// The #2638 sections, empty: a repo with no running work, no labels and no open issues.
const quiet = {
  repoPath: "/repo",
  running: [],
  labels: [],
  labelColors: {},
  stale: { stale: 0, total: 0, oldest: null },
  oldestFirst: false,
  onfilterlabel: vi.fn(),
  ontoggleoldest: vi.fn(),
};
const root = () => document.querySelector<HTMLElement>(".overview")!;
const run = () => root().querySelector<HTMLElement>("[data-repo-run]")!;

describe("RepoOverview (#2622)", () => {
  it("titles the overview, names the leading epic's state and steps, winding epics and the slots", async () => {
    const onopenautomation = vi.fn();
    render(RepoOverview, {
      epics: [summaryOf(A, 1, 3), summaryOf(B, 0, 2)],
      ...quiet,
      drain: drain(),
      leadingRecord: leading(),
      titleFor,
      onselect: vi.fn(),
      onopenautomation,
    });
    expect(root().querySelector("h2")?.textContent).toBe(m.repooverview_title());
    expect(root().getAttribute("aria-label")).toBe(m.repooverview_title());
    expect(run().querySelector(".run-state")?.textContent).toContain(
      m.repooverview_leading({ epic: B, state: m.epic_run_state_running() }),
    );
    expect(run().textContent).toContain("#21 First of B");
    expect(run().textContent).toContain(m.repooverview_winding({ epic: A, inflight: "#11" }));
    // The slot value is visible; the hint lives in the InfoTip's explanation (#2639).
    expect(run().querySelector("[data-slots-value]")?.textContent).toBe(
      m.repooverview_slots_value({ used: 1, max: 2 }),
    );
    // No hint note: the only note is the winding-down line.
    expect(run().querySelectorAll(":scope > .note")).toHaveLength(1);
    expect(
      run().querySelector(`button[aria-label="${m.tooltip_repo_run_title()}"]`),
    ).not.toBeNull();
    [...run().querySelectorAll("button")]
      .find((b) => b.textContent === m.repooverview_change())!
      .click();
    expect(onopenautomation).toHaveBeenCalledOnce();
  });

  it("names landing repairs (no slot) and lists the epic queue in order (#2973)", async () => {
    const onselect = vi.fn();
    const d = drain();
    d.runSummary = {
      ...d.runSummary!,
      queued: [30, 40],
      landingRepairs: [
        { sessionId: "s-land", desig: "TASK-90", issueNumber: null, epicParent: 30 },
        { sessionId: "s-orphan", desig: "TASK-91", issueNumber: null, epicParent: null },
      ],
    };
    render(RepoOverview, {
      epics: [summaryOf(A, 1, 3), summaryOf(B, 0, 2), summaryOf(30, 0, 1)],
      ...quiet,
      drain: d,
      titleFor: (n: number) => (n === 40 ? "Forty from host" : null),
      onselect,
    });
    const repairs = [...run().querySelectorAll("[data-landing-repair]")].map((n) =>
      n.textContent?.trim(),
    );
    expect(repairs).toEqual([
      m.repooverview_landing_repair({ epic: 30 }),
      m.repooverview_landing_repair_desig({ desig: "TASK-91" }),
    ]);
    const rows = [...run().querySelectorAll<HTMLElement>(".queue .row")];
    expect(rows.map((r) => r.dataset.epic)).toEqual(["30", "40"]);
    // Title from the epic list, else from the host's lookup.
    expect(rows[0].textContent).toContain("Epic 30");
    expect(rows[1].textContent).toContain("Forty from host");
    rows[1].querySelector<HTMLButtonElement>(".name")!.click();
    expect(onselect).toHaveBeenCalledWith("e:40");
  });

  it("shows no queue without queued epics", async () => {
    render(RepoOverview, {
      epics: [],
      ...quiet,
      drain: drain(),
      titleFor,
      onselect: vi.fn(),
    });
    expect(run().querySelector(".queue")).toBeNull();
    expect(run().querySelector("[data-landing-repair]")).toBeNull();
  });

  it("lists epics with role and progress (leading first) and selects on click", async () => {
    const onselect = vi.fn();
    render(RepoOverview, {
      epics: [summaryOf(A, 1, 3), summaryOf(B, 0, 2), summaryOf(30, 2, 2)],
      ...quiet,
      drain: drain(),
      titleFor,
      onselect,
    });
    const cards = [...root().querySelectorAll<HTMLButtonElement>("[data-epic-row]")];
    expect(cards.map((c) => c.querySelector(".num")?.textContent)).toEqual(["#20", "#10", "#30"]);
    expect(cards[0].textContent).toContain(m.epic_role_leading());
    expect(cards[1].textContent).toContain(m.epic_role_winding());
    expect(cards[1].textContent).toContain(m.repooverview_progress({ merged: 1, total: 3 }));
    cards[2].click();
    expect(onselect).toHaveBeenCalledWith("e:30");
    // Borderless list rows with a trailing arrow (#2639).
    for (const c of cards) {
      expect(getComputedStyle(c).borderTopWidth).toBe("0px");
      expect(c.querySelector(".arrow[aria-hidden=true]")?.textContent).toBe("›");
    }
    expect(cards[0].getBoundingClientRect().left).toBe(cards[1].getBoundingClientRect().left);
  });

  it("next-step rows are borderless with an arrow (#2639)", async () => {
    render(RepoOverview, {
      epics: [],
      ...quiet,
      titleFor,
      onselect: vi.fn(),
      ondraftepic: vi.fn(),
    });
    const rows = [...root().querySelectorAll<HTMLElement>(".next-row")];
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(getComputedStyle(r).borderTopWidth).toBe("0px");
      expect(r.querySelector(".arrow[aria-hidden=true]")).not.toBeNull();
    }
  });

  describe("run state dot (#2639)", () => {
    const dot = () => run().querySelector<HTMLElement>(".run-state")!;
    const withSlots = (used: number, max: number, over: Partial<DrainStatus> = {}) => {
      const d = drain();
      d.runSummary = {
        ...d.runSummary!,
        leadingEpic: null,
        windingDown: [],
        slots: { ...d.runSummary!.slots, used, max },
      };
      return { ...d, ...over };
    };
    const props = { epics: [], ...quiet, titleFor, onselect: vi.fn() };

    it("idle: ring", async () => {
      render(RepoOverview, { ...props, drain: withSlots(0, 2) });
      expect(dot().dataset.dot).toBe("ring");
      expect(dot().dataset.kind).toBe("idle");
    });

    it("leading: filled", async () => {
      render(RepoOverview, { ...props, drain: drain(), leadingRecord: leading() });
      // drain() has A winding down beside B leading — the leader's own state decides.
      expect(dot().dataset.kind).toBe("leading");
      expect(dot().dataset.dot).toBe("filled");
    });

    it("saturated: filled amber", async () => {
      const d = drain();
      d.runSummary = { ...d.runSummary!, slots: { ...d.runSummary!.slots, used: 2, max: 2 } };
      render(RepoOverview, { ...props, drain: d, leadingRecord: leading() });
      expect(dot().dataset.kind).toBe("saturated");
      expect(dot().dataset.dot).toBe("filled");
      expect(dot().classList.contains("tone-busy")).toBe(true);
    });

    it("winding: half", async () => {
      const d = withSlots(1, 2);
      d.runSummary = { ...d.runSummary!, windingDown: [{ epic: A, inFlight: [11] }] };
      render(RepoOverview, { ...props, drain: d });
      expect(dot().dataset.kind).toBe("winding");
      expect(dot().dataset.dot).toBe("half");
    });
  });

  it("without a leading epic says so, lists no issues and offers the next steps (#2638)", async () => {
    const ondraftepic = vi.fn();
    render(RepoOverview, {
      epics: [],
      ...quiet,
      titleFor,
      onselect: vi.fn(),
      ondraftepic,
    });
    expect(run().querySelector(".run-state")?.textContent).toContain(m.repooverview_none_leading());
    // The list beside it already lists the issues — no second list here.
    expect(root().textContent).not.toContain(m.issuespanel_singles_heading());
    expect(root().querySelector(".facts")).toBeNull();
    expect(root().textContent).toContain(m.repooverview_next_single_title());
    [...root().querySelectorAll("button")]
      .find((b) => b.textContent === m.repooverview_draft_epic())!
      .click();
    expect(ondraftepic).toHaveBeenCalledOnce();
  });

  it("names running issues — also ones the list hides — and opens their session (#2638)", async () => {
    const onopensession = vi.fn();
    render(RepoOverview, {
      epics: [],
      ...quiet,
      running: [
        { issue: issue(160), sessionId: "s160", desig: "TASK-160", hidden: true },
        { issue: issue(7), sessionId: null, desig: null, hidden: false },
      ],
      titleFor,
      onselect: vi.fn(),
      onopensession,
    });
    const rows = [...root().querySelectorAll<HTMLElement>(".run-row")];
    expect(root().textContent).toContain(m.repooverview_running({ count: 2 }));
    // No hairlines between running rows (#2639).
    for (const r of rows) {
      expect(getComputedStyle(r).borderTopWidth).toBe("0px");
      expect(getComputedStyle(r).borderBottomWidth).toBe("0px");
    }
    expect(rows[0].textContent).toContain("#160 Issue 160");
    expect(rows[0].textContent).toContain(`TASK-160 · ${m.repooverview_running_hidden()}`);
    expect(rows[1].textContent).toContain(m.repooverview_running_label_only());
    expect(rows[1].querySelector("button")).toBeNull();
    rows[0].querySelector("button")!.click();
    expect(onopensession).toHaveBeenCalledWith("s160");
  });

  it("labels filter the list; the stale share names the oldest and sorts oldest first (#2638)", async () => {
    const onfilterlabel = vi.fn();
    const ontoggleoldest = vi.fn();
    render(RepoOverview, {
      epics: [],
      ...quiet,
      labels: [
        { label: "bug", count: 3 },
        { label: "docs", count: 1 },
      ],
      labelColors: { bug: "#d73a4a" },
      stale: { stale: 2, total: 3, oldest: { issue: issue(3), days: 152 } },
      oldestFirst: true,
      onfilterlabel,
      ontoggleoldest,
      titleFor,
      onselect: vi.fn(),
    });
    const labels = [...root().querySelectorAll<HTMLButtonElement>(".label-row")];
    expect(labels.map((l) => l.textContent?.replace(/\s+/g, ""))).toEqual(["bug3›", "docs1›"]);
    expect(labels[0].classList.contains("hued")).toBe(true);
    expect(labels[0].querySelector(".arrow[aria-hidden=true]")).not.toBeNull();
    labels[1].click();
    expect(onfilterlabel).toHaveBeenCalledWith("docs");

    expect(root().textContent).toContain(
      m.repooverview_stale_count({ stale: 2, total: 3, days: 90 }),
    );
    expect(root().textContent).toContain(
      m.repooverview_oldest({ number: 3, title: "Issue 3", days: 152 }),
    );
    const oldest = root().querySelector<HTMLButtonElement>(".oldest")!;
    expect(oldest.getAttribute("aria-pressed")).toBe("true");
    oldest.click();
    expect(ontoggleoldest).toHaveBeenCalledOnce();
  });

  describe("the wide reading view (#2950)", () => {
    const facts = {
      running: [{ issue: issue(160), sessionId: "s160", desig: "TASK-160", hidden: false }],
      labels: [
        { label: "bug", count: 3 },
        { label: "docs", count: 1 },
      ],
      stale: { stale: 2, total: 3, oldest: { issue: issue(3), days: 152 } },
    };
    const rect = (el: Element | null) => el!.getBoundingClientRect();

    it("shows Jetzt · Als nächstes · Danach side by side", async () => {
      await page.viewport(1100, 800);
      render(RepoOverview, {
        epics: [summaryOf(A, 1, 3), summaryOf(B, 0, 2)],
        ...quiet,
        drain: drain(),
        leadingRecord: leading(),
        titleFor,
        onselect: vi.fn(),
      });
      const steps = [...run().querySelectorAll<HTMLElement>(".steps > li")];
      expect(steps).toHaveLength(3);
      const [now, next, after] = steps.map(rect);
      expect(Math.abs(now.top - next.top)).toBeLessThan(2);
      expect(Math.abs(next.top - after.top)).toBeLessThan(2);
      expect(now.right).toBeLessThanOrEqual(next.left);
      expect(next.right).toBeLessThanOrEqual(after.left);
    });

    it("below them: running and idle on the left, open-by-label on the right", async () => {
      await page.viewport(1100, 800);
      render(RepoOverview, {
        epics: [],
        ...quiet,
        ...facts,
        titleFor,
        onselect: vi.fn(),
      });
      const [left, right] = [...root().querySelectorAll<HTMLElement>(".facts > .facts-col")];
      expect(left.querySelector(".run-row")).not.toBeNull();
      expect(left.textContent).toContain(
        m.repooverview_stale_count({ stale: 2, total: 3, days: 90 }),
      );
      expect(left.querySelector(".label-row")).toBeNull();
      expect(right.querySelectorAll(".label-row")).toHaveLength(2);
      expect(rect(left).right).toBeLessThanOrEqual(rect(right).left);
      expect(Math.abs(rect(left).top - rect(right).top)).toBeLessThan(2);
    });

    it("stacks the two columns in a narrow reading view", async () => {
      await page.viewport(520, 800);
      render(RepoOverview, {
        epics: [],
        ...quiet,
        ...facts,
        titleFor,
        onselect: vi.fn(),
      });
      const [left, right] = [...root().querySelectorAll<HTMLElement>(".facts > .facts-col")];
      expect(rect(left).bottom).toBeLessThanOrEqual(rect(right).top);
    });

    it("renders the columns for running issues alone", async () => {
      await page.viewport(1100, 800);
      render(RepoOverview, {
        epics: [],
        ...quiet,
        running: facts.running,
        titleFor,
        onselect: vi.fn(),
      });
      expect(root().querySelectorAll(".facts > .facts-col")).toHaveLength(1);
      expect(root().querySelector(".facts .run-row")).not.toBeNull();
    });
  });
});
