import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../../app.css";
import RepoOverview from "./RepoOverview.svelte";
import type {
  DrainStatus,
  Epic,
  EpicAutoBlockerCause,
  EpicAutoBlockers,
  EpicAutoFixResult,
  EpicSummary,
  Issue,
} from "#lib/types.js";
import type { RepoBootstrapView } from "#lib/api.js";
import { m } from "#lib/paraglide/messages.js";
import { causeView } from "../epic-auto-fix";
import { expectMinPx } from "#lib/test-support/geometry.js";

// #3456: the overview asks every listed epic's auto-fix model; offline unless a test serves one.
const api = vi.hoisted(() => ({
  getRepoConfig: vi.fn<(repo: string) => Promise<unknown>>(async () => {
    throw new Error("offline");
  }),
  getRepoBootstrap: vi.fn<(repo: string) => Promise<RepoBootstrapView>>(async () => {
    throw new Error("offline");
  }),
  getEpicAutoFix: vi.fn<(repo: string, parent: number) => Promise<EpicAutoBlockers>>(async () => {
    throw new Error("offline");
  }),
  applyEpicAutoFix:
    vi.fn<(repo: string, parent: number, body: unknown) => Promise<EpicAutoFixResult>>(),
}));

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return { ...actual, ...api };
});

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

  it("next-step rows are borderless, with no arrow or hover (not click targets) (#2639)", async () => {
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
      expect(r.querySelector(".arrow")).toBeNull();
      expect(r.tagName).toBe("LI");
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

describe("repo halt (#3456)", () => {
  const ok = (id: string) => ({ id, ok: true });
  const INTERACTIVE: EpicAutoBlockerCause = {
    code: "sandbox_interactive",
    scope: "repo",
    detail: "standard",
    fix: {
      changes: { sandboxProfile: "autonomous" },
      enabled: true,
      checks: [ok("bwrap"), ok("egress"), ok("remote_https")],
    },
  };
  const CODEX: EpicAutoBlockerCause = {
    code: "sandbox_provider_unconfined",
    scope: "epic",
    detail: "codex",
    fix: { changes: { agentProvider: "claude" }, enabled: true, checks: [] },
  };
  // "Behebung" Fall A — Standard + Codex — with its ways, for the chooser.
  const STD_CODEX: EpicAutoBlockers = {
    agentProvider: "codex",
    causes: [INTERACTIVE, CODEX],
    options: [
      {
        id: "autonomous_claude",
        changes: { sandboxProfile: "autonomous", agentProvider: "claude" },
        enabled: true,
        checks: [ok("bwrap"), ok("egress"), ok("remote_https")],
      },
      { id: "trusted", changes: { sandboxProfile: "trusted" }, enabled: true, checks: [] },
    ],
    preselect: "autonomous_claude",
  };
  const STD_CLAUDE: EpicAutoBlockers = {
    agentProvider: "claude",
    causes: [INTERACTIVE],
    options: [
      {
        id: "autonomous",
        changes: { sandboxProfile: "autonomous" },
        enabled: true,
        checks: [ok("cli"), ok("bwrap"), ok("egress"), ok("remote_https")],
      },
      { id: "trusted", changes: { sandboxProfile: "trusted" }, enabled: true, checks: [] },
    ],
    preselect: "autonomous",
  };
  const AUTO_CODEX: EpicAutoBlockers = {
    agentProvider: "codex",
    causes: [CODEX],
    options: [
      {
        id: "autonomous_claude",
        changes: { agentProvider: "claude" },
        enabled: true,
        checks: [ok("bwrap"), ok("egress"), ok("remote_https")],
      },
      { id: "trusted", changes: { sandboxProfile: "trusted" }, enabled: true, checks: [] },
    ],
    preselect: "autonomous_claude",
  };
  const clear = (agentProvider: "claude" | "codex"): EpicAutoBlockers => ({
    agentProvider,
    causes: [],
    options: [],
    preselect: null,
  });

  // hundesport: #35 leads on Codex, #40 queued on Claude Code, #41 not started on Codex.
  let served: Record<number, EpicAutoBlockers> = {};
  let n = 0;
  let repo = "";
  const name = () => repo.split("/").pop()!;

  beforeEach(() => {
    repo = `/repo/hundesport-${++n}`;
    served = { 35: STD_CODEX, 40: STD_CLAUDE, 41: STD_CODEX };
    api.getEpicAutoFix.mockReset();
    api.getEpicAutoFix.mockImplementation(async (_r, parent) => {
      const b = served[parent];
      if (!b) throw new Error("503");
      return b;
    });
    api.applyEpicAutoFix.mockReset();
    api.getRepoBootstrap.mockReset();
    api.getRepoBootstrap.mockResolvedValue({
      state: "done",
      phase: 5,
      overrideAt: null,
      missing: [],
      suggested: false,
    });
  });

  function haltDrain(): DrainStatus {
    return {
      repoPath: repo,
      enabled: true,
      paused: false,
      reason: "sandbox_provider_unconfined",
      detail: "codex",
      queued: 1,
      inFlight: 0,
      max: 2,
      epicParent: 35,
      runSummary: {
        leadingEpic: 35,
        windingDown: [],
        slots: { used: 0, max: 2, holders: [] },
        next: [17, 18],
        after: [],
        queued: [40],
      },
    };
  }

  function leader(): Epic {
    return {
      ...leading(),
      repoPath: repo,
      parentIssueNumber: 35,
      parentTitle: "Hundesport-MVP",
      run: { repoPath: repo, parentIssueNumber: 35, mode: "auto", status: "running" },
    };
  }

  function show(over: Record<string, unknown> = {}) {
    return render(RepoOverview, {
      epics: [summaryOf(35, 0, 18), summaryOf(40, 0, 4), summaryOf(41, 0, 3)],
      ...quiet,
      repoPath: repo,
      drain: haltDrain(),
      leadingRecord: leader(),
      titleFor,
      onselect: vi.fn(),
      ...over,
    });
  }

  const banners = () => root().querySelectorAll<HTMLElement>("[data-repo-halt]");
  const card = (parent: number) =>
    [
      ...root().querySelectorAll<HTMLElement>(
        `section[aria-label="${m.repooverview_epics()}"] .rows > li`,
      ),
    ].find((li) => li.querySelector(".num")?.textContent === `#${parent}`)!;
  const halt = (parent: number) => card(parent).querySelector<HTMLElement>("[data-epic-card-halt]");
  const button = (el: ParentNode, text: string) =>
    [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);
  const loaded = () => vi.waitFor(() => expect(banners()).toHaveLength(1));

  it("names the repo halt once on top and each epic's own cause or pre-check at its card", async () => {
    show();
    await loaded();
    const state = run().querySelector<HTMLElement>(".run-state")!;
    expect(state.textContent).toContain(
      m.repooverview_leading({ epic: 35, state: m.epic_run_state_halted_sandbox() }),
    );
    expect(state.classList.contains("tone-halt")).toBe(true);

    const banner = banners()[0]!;
    expect(run().contains(banner)).toBe(true);
    expect(banner.textContent).toContain(m.repooverview_halt_title({ repo: name() }));
    expect(banner.textContent).toContain(m.epic_autofix_short_interactive());
    expect(banner.textContent).toContain(m.repooverview_halt_affects_many({ count: 3 }));
    expect(banner.querySelector(".hc-chip")?.textContent).toBe(m.epic_autofix_scope_repo());
    expect(button(banner, m.repooverview_halt_autonomous())).toBeDefined();
    expect(button(banner, m.repooverview_halt_other())).toBeDefined();
    // The repo's reason is said once, not per epic.
    expect(root().textContent!.split(m.epic_autofix_short_interactive()).length - 1).toBe(1);

    // The leader: the repo's cause only points up, its CLI cause carries its own fix.
    const held = halt(35)!;
    expect(held.dataset.epicCardHalt).toBe("halted");
    const lines = [...held.querySelectorAll(".line")];
    expect(lines).toHaveLength(2);
    expect(lines[0]!.textContent).toContain(
      `${causeView(INTERACTIVE).what} ${m.repooverview_halt_see_above()}`,
    );
    expect(lines[0]!.querySelector("button")).toBeNull();
    expect(lines[1]!.textContent).toContain(`${causeView(CODEX).what} ${causeView(CODEX).why}`);
    expect(button(lines[1]!, m.repooverview_cli_switch({ cli: "Claude Code" }))).toBeDefined();

    // Queued on Claude Code: waits on the repo, otherwise ready.
    const queued = halt(40)!;
    expect(queued.dataset.epicCardHalt).toBe("waits");
    await vi.waitFor(() =>
      expect(queued.textContent).toContain(
        `${m.repooverview_precheck_waits()} ${m.repooverview_precheck_ready()} ✓ ${m.epic_autofix_cli({ cli: "Claude Code" })} · ✓ ${m.repooverview_precheck_bootstrap_done()}`,
      ),
    );

    // Not started on Codex: what would hold it on start, its own cause only.
    const idle = halt(41)!;
    expect(idle.dataset.epicCardHalt).toBe("precheck");
    expect(idle.textContent).toContain(
      m.repooverview_precheck_would_halt({
        reason: m.epic_autofix_short_provider({ cli: "Codex" }),
      }),
    );
    expect(idle.textContent).not.toContain(m.epic_autofix_scope_repo());

    const legend = root().querySelector("[data-halt-legend]")!;
    expect(legend.querySelectorAll("li")).toHaveLength(3);
    expect(legend.textContent).toContain(m.repooverview_legend_repo());
    // Nothing started: the pre-check only asked.
    expect(api.applyEpicAutoFix).not.toHaveBeenCalled();
  });

  it("Switch to Autonomous lifts the repo halt; the Codex epics keep their own with its fix", async () => {
    show();
    await loaded();
    api.applyEpicAutoFix.mockResolvedValueOnce({
      previous: { sandboxProfile: "inherit" },
      blockers: AUTO_CODEX,
    });
    served = { 35: AUTO_CODEX, 40: clear("claude"), 41: AUTO_CODEX };
    button(banners()[0]!, m.repooverview_halt_autonomous())!.click();

    await vi.waitFor(() => expect(banners()).toHaveLength(0));
    expect(api.applyEpicAutoFix).toHaveBeenCalledWith(repo, 35, { cause: "sandbox_interactive" });
    const done = run().querySelector<HTMLElement>("[data-repo-halt-done]")!;
    expect(done.getAttribute("role")).toBe("status");
    expect(done.textContent).toContain(
      m.epic_autofix_done_sandbox({ repo: name(), profile: m.epic_autofix_profile_autonomous() }),
    );
    const undo = button(done, m.epic_autofix_undo())!;
    await vi.waitFor(() => expect(document.activeElement).toBe(undo));

    for (const parent of [35, 41]) {
      const lines = [...halt(parent)!.querySelectorAll(".line")];
      expect(lines).toHaveLength(1);
      expect(lines[0]!.textContent).not.toContain(m.repooverview_halt_see_above());
      expect(button(lines[0]!, m.repooverview_cli_switch({ cli: "Claude Code" }))).toBeDefined();
    }
    expect(halt(40)).toBeNull();

    api.applyEpicAutoFix.mockResolvedValueOnce({ previous: {}, blockers: STD_CODEX });
    undo.click();
    await vi.waitFor(() =>
      expect(api.applyEpicAutoFix).toHaveBeenLastCalledWith(repo, 35, {
        restore: { sandboxProfile: "inherit" },
      }),
    );
  });

  it("offers no Autonomous where this host can't confine", async () => {
    const cannot: EpicAutoBlockerCause = {
      ...INTERACTIVE,
      fix: { ...INTERACTIVE.fix!, enabled: false, why: "bwrap" },
    };
    const noBwrap: EpicAutoBlockerCause = {
      code: "sandbox_backend_unavailable",
      scope: "host",
      detail: "standard",
    };
    const model = { ...STD_CLAUDE, causes: [cannot, noBwrap] };
    served = { 35: model, 40: model, 41: model };
    show();
    await loaded();
    const banner = banners()[0]!;
    expect(button(banner, m.repooverview_halt_autonomous())).toBeUndefined();
    expect(button(banner, m.repooverview_halt_other())).toBeDefined();
    expect(banner.textContent).toContain(m.epic_autofix_short_backend());
  });

  it("Other choice … opens the held epic's ways inline; Escape closes back onto it", async () => {
    show();
    await loaded();
    const other = button(banners()[0]!, m.repooverview_halt_other())!;
    other.click();
    const group = await vi.waitFor(() => {
      const g = banners()[0]!.querySelector<HTMLElement>("[role=group]");
      expect(g).not.toBeNull();
      return g!;
    });
    expect(other.getAttribute("aria-expanded")).toBe("true");
    expect(group.textContent).toContain(m.epic_row_fix_title({ parent: 35 }));
    group.querySelector<HTMLInputElement>("input[type=radio]")!.focus();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(banners()[0]!.querySelector("[role=group]")).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(other));

    other.click();
    api.applyEpicAutoFix.mockResolvedValueOnce({
      previous: { sandboxProfile: "inherit", agentProvider: "codex", model: null, effort: null },
      blockers: clear("claude"),
    });
    const apply = await vi.waitFor(() => {
      const b = button(banners()[0]!, m.epic_autofix_apply());
      expect(b).toBeDefined();
      return b!;
    });
    apply.click();
    await vi.waitFor(() =>
      expect(api.applyEpicAutoFix).toHaveBeenCalledWith(repo, 35, { option: "autonomous_claude" }),
    );
  });

  it("CLI to Claude Code at a card switches only that epic and confirms there", async () => {
    show();
    await loaded();
    api.applyEpicAutoFix.mockResolvedValueOnce({
      previous: { agentProvider: "codex", model: null, effort: null },
      blockers: STD_CLAUDE,
    });
    served = { ...served, 41: STD_CLAUDE };
    button(halt(41)!, m.repooverview_cli_switch({ cli: "Claude Code" }))!.click();
    await vi.waitFor(() =>
      expect(api.applyEpicAutoFix).toHaveBeenCalledWith(repo, 41, {
        cause: "sandbox_provider_unconfined",
      }),
    );
    const done = await vi.waitFor(() => {
      const d = card(41).querySelector<HTMLElement>("[data-epic-card-done]");
      expect(d).not.toBeNull();
      return d!;
    });
    expect(done.textContent).toContain(m.repooverview_done_cli({ epic: 41, cli: "Claude Code" }));
    await vi.waitFor(() => expect(halt(41)?.dataset.epicCardHalt).toBe("waits"));
    // The repo's halt stays: only the epic changed.
    expect(banners()).toHaveLength(1);
    expect(run().querySelector("[data-repo-halt-done]")).toBeNull();
  });

  it("a healthy repo shows no banner, no card lines and no legend", async () => {
    served = { 35: clear("claude"), 40: clear("claude"), 41: clear("claude") };
    show({ drain: { ...haltDrain(), reason: null, detail: null } });
    await vi.waitFor(() => expect(api.getEpicAutoFix).toHaveBeenCalledTimes(3));
    await new Promise((r) => setTimeout(r, 0));
    expect(banners()).toHaveLength(0);
    expect(root().querySelector("[data-epic-card-halt]")).toBeNull();
    expect(root().querySelector("[data-halt-legend]")).toBeNull();
  });

  it("asks no model for an epic winding down or finished", async () => {
    const d = haltDrain();
    d.runSummary = { ...d.runSummary!, windingDown: [{ epic: 50, inFlight: [51] }] };
    show({
      epics: [summaryOf(35, 0, 18), summaryOf(50, 1, 3), summaryOf(60, 2, 2)],
      drain: d,
    });
    await loaded();
    expect(api.getEpicAutoFix.mock.calls.map(([, p]) => p)).toEqual([35]);
    expect(banners()[0]!.textContent).toContain(m.repooverview_halt_affects_one());
  });

  it("fits a phone: no sideways scroll, touch-sized controls", async () => {
    await page.viewport(390, 844);
    show();
    await loaded();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    const banner = banners()[0]!;
    for (const b of [
      button(banner, m.repooverview_halt_autonomous())!,
      button(banner, m.repooverview_halt_other())!,
      button(halt(41)!, m.repooverview_cli_switch({ cli: "Claude Code" }))!,
    ])
      expectMinPx(b.getBoundingClientRect().height, 44, b.textContent ?? "");
  });
});
