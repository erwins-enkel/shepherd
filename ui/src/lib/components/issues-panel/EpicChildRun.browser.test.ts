import { describe, it, expect, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../../app.css";
import EpicChildRun from "./EpicChildRun.svelte";
import type { DrainStatus, Epic, EpicChild, GitState, Session } from "$lib/types";
import { m } from "$lib/paraglide/messages";

const P = 30;

function child(number: number, state: EpicChild["state"], blockedBy: number[] = []): EpicChild {
  return {
    number,
    title: `Child ${number}`,
    url: `https://github.com/o/r/issues/${number}`,
    order: number,
    body: "",
    blockedBy,
    state,
    sessionId: null,
    prNumber: null,
    issueClosed: false,
    claimed: false,
  };
}

// #31 merged → #32 running → #33 waits on #32 (and #31) → #34/#35 wait on #33 alone.
function epic(children?: EpicChild[], run: Partial<Epic["run"]> = {}): Epic {
  return {
    repoPath: "/repo",
    parentIssueNumber: P,
    parentTitle: "Epic",
    source: "native",
    children: children ?? [
      child(31, "merged"),
      { ...child(32, "running", [31]), sessionId: "sess-32", prNumber: 132 },
      child(33, "blocked", [31, 32]),
      child(34, "blocked", [33]),
      child(35, "blocked", [33]),
    ],
    warnings: [],
    run: {
      repoPath: "/repo",
      parentIssueNumber: P,
      mode: "auto",
      status: "running",
      agentProvider: "claude",
      model: null,
      effort: null,
      ...run,
    },
  };
}

function drain(next: number[] = [33]): DrainStatus {
  return {
    repoPath: "/repo",
    enabled: true,
    paused: false,
    reason: null,
    detail: null,
    queued: 0,
    inFlight: 1,
    max: 2,
    epicParent: P,
    runSummary: {
      leadingEpic: P,
      windingDown: [],
      slots: {
        used: 1,
        max: 2,
        holders: [{ sessionId: "sess-32", desig: "TASK-32", issueNumber: 32, epicParent: P }],
      },
      next,
      after: [],
    },
  };
}

function session(over: Partial<Session> = {}): Session {
  return {
    id: "sess-32",
    status: "running",
    readyToMerge: false,
    planPhase: "executing",
    agentProvider: "claude",
    model: null,
    effort: null,
    createdAt: Date.now() - 5 * 60_000,
    ...over,
  } as Session;
}

const titleFor = (n: number) => `Child ${n}`;
const region = () => document.querySelector<HTMLElement>("[data-child-run]")!;
const stateEl = () => region().querySelector<HTMLElement>(".run-state")!;

describe("EpicChildRun — standing in the epic", () => {
  it("a blocked child waits on its open blockers and lists needs → this → unlocks", async () => {
    const e = epic();
    render(EpicChildRun, { child: e.children[2], epic: e, drain: drain([]), titleFor });
    expect(stateEl().dataset.kind).toBe("waiting");
    expect(stateEl().textContent).toContain(m.childrun_waiting_on({ deps: "#32" }));
    const text = region().textContent ?? "";
    expect(text).toContain(m.childrun_standing_label());
    expect(text).toContain(m.childrun_step_needs());
    expect(text).toContain("#31");
    expect(text).toContain("#32");
    expect(text).toContain(m.childrun_step_unlocks());
    expect(text).toContain("#34");
    expect(text).toContain(m.childrun_parallel({ count: 2 }));
    expect(text).toContain(
      m.childrun_via({
        parent: P,
        cli: m.agent_provider_claude(),
        model: m.newtask_model_default(),
        effort: m.effort_default(),
      }),
    );
  });

  it("a ready child that the run starts next reads as up next", async () => {
    const e = epic([child(31, "merged"), child(33, "ready", [31])]);
    render(EpicChildRun, { child: e.children[1], epic: e, drain: drain([33]), titleFor });
    expect(stateEl().dataset.kind).toBe("next");
    expect(stateEl().classList.contains("tone-run")).toBe(true);
    expect(stateEl().textContent).toContain(m.childrun_next());
  });

  it("offers start-anyway, a jump to the epic and sibling selection", async () => {
    const e = epic();
    const onstartanyway = vi.fn();
    const onselectepic = vi.fn();
    const onselectchild = vi.fn();
    render(EpicChildRun, {
      child: e.children[2],
      epic: e,
      titleFor,
      onstartanyway,
      onselectepic,
      onselectchild,
    });
    const buttons = [...region().querySelectorAll("button")];
    buttons.find((b) => b.textContent?.includes(m.childrun_start_anyway()))!.click();
    expect(onstartanyway).toHaveBeenCalledOnce();
    buttons.find((b) => b.textContent?.includes(m.childrun_settings_in_epic()))!.click();
    expect(onselectepic).toHaveBeenCalledOnce();
    buttons.find((b) => b.textContent?.includes("#34"))!.click();
    expect(onselectchild).toHaveBeenCalledWith(34);
  });
});

describe("EpicChildRun — session", () => {
  it("shows live status with the held slot, phases, PR link, open session and handover", async () => {
    const e = epic();
    const onopensession = vi.fn();
    const git = { state: "open", url: "https://github.com/o/r/pull/132" } as GitState;
    render(EpicChildRun, {
      child: e.children[1],
      epic: e,
      drain: drain([33]),
      live: { session: session(), git },
      titleFor,
      onopensession,
    });
    expect(stateEl().dataset.kind).toBe("session");
    expect(stateEl().textContent).toContain(
      m.childrun_holds_slot({ status: m.childrun_status_running(), index: 1, max: 2 }),
    );
    const current = region().querySelector('[aria-current="step"]');
    expect(current?.textContent).toContain(m.activity_stage_pr());
    const link = region().querySelector<HTMLAnchorElement>("a")!;
    expect(link.href).toBe("https://github.com/o/r/pull/132");
    expect(region().textContent).toContain(m.agent_provider_claude());
    expect(region().textContent).toContain(
      m.childrun_then({ handover: m.epic_run_handover({ issue: 33, epic: P }) }),
    );
    [...region().querySelectorAll("button")]
      .find((b) => b.textContent?.includes(m.epic_run_open_session()))!
      .click();
    expect(onopensession).toHaveBeenCalledWith("sess-32");
  });

  it("falls back to the child state without a live session", async () => {
    const e = epic();
    const c = { ...e.children[1], state: "in-review" as const };
    render(EpicChildRun, { child: c, epic: e, titleFor });
    expect(stateEl().textContent).toContain(m.childrun_state_in_review());
    expect(region().querySelector('[aria-current="step"]')).toBeNull();
    expect(region().querySelector<HTMLAnchorElement>("a")!.href).toBe(
      "https://github.com/o/r/issues/132",
    );
  });
});

describe("EpicChildRun — merged", () => {
  it("shows the merged state with the PR link", async () => {
    const e = epic();
    const c = { ...e.children[0], prNumber: 131 };
    render(EpicChildRun, { child: c, epic: e, titleFor });
    expect(stateEl().dataset.kind).toBe("merged");
    expect(stateEl().textContent).toContain(m.childrun_merged());
    expect(region().querySelector<HTMLAnchorElement>("a")!.textContent).toContain("PR #131");
  });
});
