import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import EpicRunControl from "./EpicRunControl.svelte";
import type { DrainRunSummary, DrainStatus, Epic, EpicChild } from "$lib/types";
import { m } from "$lib/paraglide/messages";

const api = vi.hoisted(() => ({
  updateEpic: vi.fn(async () => ({})),
  approveEpicNext: vi.fn(async () => ({})),
  getEpic: vi.fn(async () => {
    throw new Error("not needed");
  }),
}));

vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
  return { ...actual, ...api };
});

// The issue's acceptance scenario (#2620): maxAuto = 1, epic B (#20) leads and waits for the
// slot, epic A's (#10) child #11 holds it — A winds down.
const B = 20;
const A = 10;
const TITLES: Record<number, string> = {
  11: "Child of A",
  21: "First ready child of B",
  22: "Successor one",
  23: "Successor two",
};
const titleFor = (n: number) => TITLES[n] ?? null;

function child(number: number, state: EpicChild["state"], blockedBy: number[] = []): EpicChild {
  return {
    number,
    title: TITLES[number] ?? `c${number}`,
    url: "u",
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

function summary(over: Partial<DrainRunSummary> = {}): DrainRunSummary {
  return {
    leadingEpic: B,
    windingDown: [{ epic: A, inFlight: [11] }],
    slots: {
      used: 1,
      max: 1,
      holders: [{ sessionId: "sess-11", desig: "TASK-11", issueNumber: 11, epicParent: A }],
    },
    next: [21],
    after: [22, 23],
    ...over,
  };
}

function drain(over: Partial<DrainStatus> = {}): DrainStatus {
  return {
    repoPath: "/repo",
    enabled: true,
    paused: false,
    reason: "cap",
    detail: null,
    queued: 1,
    inFlight: 1,
    max: 1,
    epicParent: B,
    runSummary: summary(),
    ...over,
  };
}

function epic(parent: number, over: Partial<Epic["run"]> = {}, children?: EpicChild[]): Epic {
  return {
    repoPath: "/repo",
    parentIssueNumber: parent,
    parentTitle: `Epic ${parent}`,
    source: "native",
    children: children ?? [
      child(21, "ready"),
      child(22, "blocked", [21]),
      child(23, "blocked", [21]),
    ],
    warnings: [],
    run: {
      repoPath: "/repo",
      parentIssueNumber: parent,
      mode: "auto",
      status: "running",
      agentProvider: null,
      model: null,
      effort: null,
      ...over,
    },
  };
}

function changeSelect(label: string, value: string) {
  const select = page.getByLabelText(label).element() as HTMLSelectElement;
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  api.updateEpic.mockClear();
  api.approveEpicNext.mockClear();
  api.getEpic.mockClear();
});

describe("EpicRunControl — acceptance scenario (#2620)", () => {
  it("the leading epic waits for a slot: Now = A's child, Next = B's first ready child, After = its successors", async () => {
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: B,
      epic: epic(B),
      drain: drain(),
      titleFor,
    });

    await expect.element(page.getByText(m.epic_run_state_waiting_slot())).toBeInTheDocument();
    await expect
      .element(page.getByText(m.epic_run_step_now({ used: 1, max: 1 })))
      .toBeInTheDocument();
    await expect.element(page.getByText("Child of A")).toBeInTheDocument();
    await expect.element(page.getByText(m.epic_run_holder_epic({ parent: A }))).toBeInTheDocument();
    await expect.element(page.getByText(m.epic_role_winding())).toBeInTheDocument();
    await expect.element(page.getByText("#21 First ready child of B")).toBeInTheDocument();
    await expect
      .element(page.getByText(m.epic_run_next_after_slot({ holder: "#11" })))
      .toBeInTheDocument();
    await expect.element(page.getByText("#22, #23")).toBeInTheDocument();
    await expect
      .element(page.getByText(m.epic_run_after_parallel({ count: 2 })))
      .toBeInTheDocument();
  });

  it("the winding-down epic explains the handover and offers 'lead again' with today's start", async () => {
    const a = epic(A, { status: "idle" }, [child(11, "running"), child(12, "ready")]);
    render(EpicRunControl, { repoPath: "/repo", parent: A, epic: a, drain: drain(), titleFor });

    await expect
      .element(page.getByText(m.epic_run_state_winding({ inflight: "#11" })))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(m.epic_run_winding_leader({ leader: B }), { exact: false }))
      .toBeInTheDocument();
    await expect.element(page.getByText(m.epic_run_winding_left({ count: 1 }))).toBeInTheDocument();
    await expect
      .element(page.getByText(m.epic_run_handover({ issue: 21, epic: B })))
      .toBeInTheDocument();

    // B leads, so leading again supersedes B — asked first (#2623).
    await page.getByRole("button", { name: m.epic_run_rejoin() }).click();
    await expect
      .element(page.getByRole("dialog", { name: m.epic_supersede_title({ epic: A }) }))
      .toBeInTheDocument();
    expect(api.updateEpic).not.toHaveBeenCalled();
    await page.getByRole("button", { name: m.epic_supersede_confirm() }).click();
    expect(api.updateEpic).toHaveBeenCalledWith("/repo", A, { status: "running" });
    expect(page.getByRole("dialog").query()).toBeNull();
    expect(page.getByRole("button", { name: m.epic_start() }).query()).toBeNull();
  });
});

describe("EpicRunControl state tone", () => {
  // Resolve a token to the browser's computed color string, so a selector typo that leaves the
  // indicator muted fails here instead of shipping silently.
  function tokenColor(token: string): string {
    const probe = document.createElement("span");
    probe.style.color = `var(${token})`;
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }
  const stateEl = () => document.querySelector<HTMLElement>(".run-state")!;

  it("a running / waiting state is amber, a halted one blocked-red", async () => {
    const { unmount } = await render(EpicRunControl, {
      repoPath: "/repo",
      parent: B,
      epic: epic(B),
      drain: drain(),
      titleFor,
    });
    await expect.element(page.getByText(m.epic_run_state_waiting_slot())).toBeInTheDocument();
    expect(getComputedStyle(stateEl()).color).toBe(tokenColor("--status-running"));
    unmount();

    render(EpicRunControl, {
      repoPath: "/repo",
      parent: B,
      epic: epic(B),
      drain: drain({ reason: "blocked", detail: "TASK-07" }),
      titleFor,
    });
    await expect.element(page.getByText(m.epic_run_state_halted())).toBeInTheDocument();
    expect(getComputedStyle(stateEl()).color).toBe(tokenColor("--status-blocked"));
  });
});

describe("EpicRunControl actions", () => {
  it("pause and mode keep today's payloads", async () => {
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: B,
      epic: epic(B),
      drain: drain(),
      titleFor,
    });

    await page.getByRole("button", { name: m.epic_pause() }).click();
    expect(api.updateEpic).toHaveBeenCalledWith("/repo", B, { status: "paused" });
    await page.getByRole("button", { name: m.epic_mode_auto_aria() }).click();
    expect(api.updateEpic).toHaveBeenCalledWith("/repo", B, { mode: "attended" });
  });

  it("an idle epic outside the run shows Start and no steps", async () => {
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: 99,
      epic: epic(99, { status: "idle" }),
      drain: drain(),
      titleFor,
    });

    await expect.element(page.getByText(m.epic_run_state_idle())).toBeInTheDocument();
    expect(page.getByText(m.epic_run_step_next()).query()).toBeNull();
    expect(page.getByRole("button", { name: m.epic_run_more() }).query()).toBeNull();
    await page.getByRole("button", { name: m.epic_start() }).click();
    await page.getByRole("button", { name: m.epic_supersede_confirm() }).click();
    expect(api.updateEpic).toHaveBeenCalledWith("/repo", 99, { status: "running" });
  });

  it("⋯ ends the epic and — attended — approves the next task", async () => {
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: B,
      epic: epic(B, { mode: "attended" }),
      drain: drain(),
      titleFor,
    });

    await page.getByRole("button", { name: m.epic_run_more() }).click();
    await page.getByRole("menuitem", { name: m.epic_approve_next() }).click();
    expect(api.approveEpicNext).toHaveBeenCalledWith("/repo", B);

    await page.getByRole("button", { name: m.epic_run_more() }).click();
    await page.getByRole("menuitem", { name: m.epic_stop() }).click();
    expect(api.updateEpic).toHaveBeenCalledWith("/repo", B, { status: "idle" });
  });

  it("waiting for approval offers an inline approve on the next step", async () => {
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: B,
      epic: epic(B, { mode: "attended" }),
      drain: drain({ reason: "awaiting_approval", detail: "21" }),
      titleFor,
    });

    await expect.element(page.getByText(m.epic_run_state_awaiting_approval())).toBeInTheDocument();
    await page.getByRole("button", { name: m.epic_run_approve_inline() }).click();
    expect(api.approveEpicNext).toHaveBeenCalledWith("/repo", B);
  });

  it("a halted run names the reason (the former hold line)", async () => {
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: B,
      epic: epic(B),
      drain: drain({ reason: "blocked", detail: "TASK-07" }),
      titleFor,
    });

    await expect.element(page.getByText(m.epic_run_state_halted())).toBeInTheDocument();
    await expect
      .element(page.getByText(m.epic_hold_blocked({ desig: "TASK-07" })))
      .toBeInTheDocument();
  });

  it("'Open session' and 'More slots' call the host", async () => {
    const onopensession = vi.fn();
    const onopenautomation = vi.fn();
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: B,
      epic: epic(B),
      drain: drain(),
      titleFor,
      onopensession,
      onopenautomation,
    });

    await page.getByRole("button", { name: m.epic_run_open_session() }).click();
    expect(onopensession).toHaveBeenCalledWith("sess-11");
    await page.getByRole("button", { name: m.epic_run_more_slots() }).click();
    expect(onopenautomation).toHaveBeenCalled();
  });

  it("hides the links when the host offers no route", async () => {
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: B,
      epic: epic(B),
      drain: drain(),
      titleFor,
    });
    await expect.element(page.getByText("Child of A")).toBeInTheDocument();
    expect(page.getByRole("button", { name: m.epic_run_open_session() }).query()).toBeNull();
    expect(page.getByRole("button", { name: m.epic_run_more_slots() }).query()).toBeNull();
  });

  it("without a runSummary it still controls the epic, just without steps", async () => {
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: B,
      epic: epic(B),
      drain: drain({ runSummary: undefined }),
      titleFor,
    });
    await expect.element(page.getByText(m.epic_run_state_waiting_slot())).toBeInTheDocument();
    expect(page.getByText(m.epic_run_step_next()).query()).toBeNull();
    await expect.element(page.getByRole("button", { name: m.epic_pause() })).toBeInTheDocument();
  });
});

describe("EpicRunControl run settings footer", () => {
  it("renders inherited CLI state and persists provider selection", async () => {
    render(EpicRunControl, { repoPath: "/repo", parent: B, epic: epic(B), titleFor });

    expect(
      (page.getByLabelText(m.epic_provider_label()).element() as HTMLSelectElement).value,
    ).toBe("inherit");
    changeSelect(m.epic_provider_label(), "codex");
    expect(api.updateEpic).toHaveBeenCalledWith("/repo", B, {
      agentProvider: "codex",
      model: null,
      effort: null,
    });
  });

  it("persists model changes for an explicit provider", async () => {
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: B,
      epic: epic(B, { agentProvider: "codex" }),
      titleFor,
    });
    changeSelect(m.epic_model_label(), "gpt-5.5");
    expect(api.updateEpic).toHaveBeenCalledWith("/repo", B, { model: "gpt-5.5", effort: null });
  });

  it("saves Codex Astra ultra", async () => {
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: B,
      epic: epic(B, { agentProvider: "codex", model: "gpt-6-astra" }),
      titleFor,
    });
    const select = page.getByLabelText(m.epic_effort_label()).element() as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toContain("ultra");
    changeSelect(m.epic_effort_label(), "ultra");
    expect(api.updateEpic).toHaveBeenCalledWith("/repo", B, { effort: "ultra" });
  });

  it.each([
    ["ultra", null],
    ["max", "max"],
  ])("switching to Luna handles %s in one patch", (effort, expected) => {
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: B,
      epic: epic(B, { agentProvider: "codex", model: "gpt-6-astra", effort }),
      titleFor,
    });
    changeSelect(m.epic_model_label(), "gpt-5.6-luna");
    expect(api.updateEpic).toHaveBeenCalledWith("/repo", B, {
      model: "gpt-5.6-luna",
      effort: expected,
    });
  });
});

describe("EpicRunControl supersede confirmation (#2623)", () => {
  it("Start while another epic leads asks first; Cancel sends nothing", async () => {
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: 99,
      epic: epic(99, { status: "idle" }),
      drain: drain(),
      titleFor,
    });

    await page.getByRole("button", { name: m.epic_start() }).click();
    await expect
      .element(page.getByRole("dialog", { name: m.epic_supersede_title({ epic: 99 }) }))
      .toBeInTheDocument();
    expect(api.getEpic).toHaveBeenCalledWith("/repo", B);
    await page.getByRole("button", { name: m.common_cancel() }).click();
    expect(page.getByRole("dialog").query()).toBeNull();
    expect(api.updateEpic).not.toHaveBeenCalled();
  });

  it("'Change agent slots' in the dialog reaches the host", async () => {
    const onopenautomation = vi.fn();
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: 99,
      epic: epic(99, { status: "idle" }),
      drain: drain(),
      titleFor,
      onopenautomation,
    });

    await page.getByRole("button", { name: m.epic_start() }).click();
    await page.getByRole("button", { name: m.epic_supersede_slots() }).click();
    expect(onopenautomation).toHaveBeenCalled();
    expect(page.getByRole("dialog").query()).toBeNull();
    expect(api.updateEpic).not.toHaveBeenCalled();
  });

  it("the paused leader resumes directly", async () => {
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: B,
      epic: epic(B, { status: "paused" }),
      drain: drain({ reason: "paused" }),
      titleFor,
    });

    await page.getByRole("button", { name: m.epic_start() }).click();
    expect(api.updateEpic).toHaveBeenCalledWith("/repo", B, { status: "running" });
    expect(page.getByRole("dialog").query()).toBeNull();
  });

  it("with no epic leading, Start starts directly", async () => {
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: 99,
      epic: epic(99, { status: "idle" }),
      drain: drain({
        epicParent: null,
        runSummary: summary({ leadingEpic: null, windingDown: [], next: [], after: [] }),
      }),
      titleFor,
    });

    await page.getByRole("button", { name: m.epic_start() }).click();
    expect(api.updateEpic).toHaveBeenCalledWith("/repo", 99, { status: "running" });
    expect(page.getByRole("dialog").query()).toBeNull();
  });
});
