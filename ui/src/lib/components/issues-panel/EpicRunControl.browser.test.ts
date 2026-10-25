import { describe, it, expect, vi, beforeEach } from "vitest";
import { tick } from "svelte";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../../app.css";
import EpicRunControl from "./EpicRunControl.svelte";
import type {
  DrainRunSummary,
  DrainStatus,
  Epic,
  EpicChild,
  EpicSummary,
  GitState,
  Session,
} from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";
import { formatReset } from "#lib/format.js";
import { toasts } from "#lib/toasts.svelte.js";
import { ApiError } from "#lib/api.js";

const api = vi.hoisted(() => ({
  updateEpic: vi.fn(async () => ({})),
  queueEpic: vi.fn(async () => ({})),
  unqueueEpic: vi.fn(async () => ({})),
  approveEpicNext: vi.fn(async () => ({})),
  getEpic: vi.fn(async () => {
    throw new Error("not needed");
  }),
  getDrain: vi.fn(async (): Promise<DrainStatus[]> => []),
  reworkEpicBase: vi.fn(async (): Promise<void> => {}),
  overrideEpicBaseHold: vi.fn(async (): Promise<void> => {}),
  getRepoConfig: vi.fn<(repo: string) => Promise<unknown>>(async () => {
    throw new Error("offline");
  }),
}));

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
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
  api.queueEpic.mockClear();
  api.unqueueEpic.mockClear();
  api.approveEpicNext.mockClear();
  api.getEpic.mockClear();
  api.getDrain.mockReset();
  api.getDrain.mockResolvedValue([]);
  api.reworkEpicBase.mockReset();
  api.overrideEpicBaseHold.mockReset();
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

    // The file's first click: the pointer still sits where the previous test file left it and
    // may hover the state label open — whose explanation would cover the button.
    await userEvent.keyboard("{Escape}");
    // B leads, so leading again supersedes B — asked first (#2623).
    await page.getByRole("button", { name: m.epic_run_rejoin() }).click();
    await expect
      .element(page.getByRole("dialog", { name: m.epic_supersede_title({ epic: A }) }))
      .toBeInTheDocument();
    expect(api.updateEpic).not.toHaveBeenCalled();
    await page.getByRole("button", { name: m.epic_supersede_confirm() }).click();
    expect(api.updateEpic).toHaveBeenCalledWith(
      "/repo",
      A,
      { status: "running" },
      { requeueLeader: true },
    );
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

  it("landing toggle switches integration → incremental (#3191)", async () => {
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: B,
      epic: { ...epic(B, { status: "idle" }), landingLocked: false },
      drain: drain(),
      titleFor,
    });

    const toggle = page.getByRole("button", {
      name: m.epic_landing_aria({ landing: m.epic_landing_integration() }),
    });
    await expect.element(toggle).toHaveTextContent(m.epic_landing_integration());
    await expect.element(toggle).not.toHaveAttribute("aria-disabled", "true");
    await toggle.click();
    expect(api.updateEpic).toHaveBeenCalledWith("/repo", B, { landing: "incremental" });
  });

  it("landing toggle is locked once the epic has run, explaining why (#3191)", async () => {
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: B,
      epic: { ...epic(B, { landing: "incremental" }), landingLocked: true },
      drain: drain(),
      titleFor,
    });

    const toggle = page.getByRole("button", {
      name: m.epic_landing_aria({ landing: m.epic_landing_incremental() }),
    });
    await expect.element(toggle).toHaveAttribute("aria-disabled", "true");
    expect(toggle.element().getAttribute("aria-description")).toContain(
      m.tooltip_epic_landing_locked_body(),
    );
    // Playwright refuses to click an aria-disabled control; the DOM click still reaches the handler.
    (toggle.element() as HTMLButtonElement).click();
    await tick();
    expect(api.updateEpic).not.toHaveBeenCalled();
  });

  it("a 409 landing change toasts the lock (#3191)", async () => {
    api.updateEpic.mockRejectedValueOnce(new ApiError(409, "landing locked"));
    toasts.dismissKey("epic-update-fail");
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: B,
      epic: epic(B, { status: "idle" }),
      drain: drain(),
      titleFor,
    });

    await page
      .getByRole("button", { name: m.epic_landing_aria({ landing: m.epic_landing_integration() }) })
      .click();
    await vi.waitFor(() =>
      expect(toasts.items.some((t) => t.text === m.epic_landing_locked_failed())).toBe(true),
    );
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
    expect(api.updateEpic).toHaveBeenCalledWith(
      "/repo",
      99,
      { status: "running" },
      { requeueLeader: true },
    );
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

  it("Stop names the queued epic that starts next (#2973)", async () => {
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: B,
      epic: epic(B),
      drain: drain({ runSummary: summary({ queued: [50, 60] }) }),
      titleFor,
    });

    await page.getByRole("button", { name: m.epic_run_more() }).click();
    await expect
      .element(page.getByRole("menuitem", { name: m.epic_stop() }))
      .toHaveAttribute("title", m.epic_stop_promotes_title({ epic: 50 }));
  });

  it("Stop carries no promote hint with an empty queue", async () => {
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: B,
      epic: epic(B),
      drain: drain(),
      titleFor,
    });

    await page.getByRole("button", { name: m.epic_run_more() }).click();
    await expect
      .element(page.getByRole("menuitem", { name: m.epic_stop() }))
      .not.toHaveAttribute("title");
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

  it("'Open session' calls the host; the Now step offers −/+ for the slots", async () => {
    const onopensession = vi.fn();
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: B,
      epic: epic(B),
      drain: drain(),
      titleFor,
      onopensession,
    });

    await page.getByRole("button", { name: m.epic_run_open_session() }).click();
    expect(onopensession).toHaveBeenCalledWith("sess-11");
    await expect
      .element(page.getByRole("button", { name: m.slotstepper_more() }))
      .toBeInTheDocument();
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

describe("EpicRunControl epic queue (#2624)", () => {
  it("with a leader, a non-queued epic offers Queue beside Start; Queue needs no dialog", async () => {
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: 99,
      epic: epic(99, { status: "idle" }),
      drain: drain(),
      titleFor,
    });

    await expect.element(page.getByRole("button", { name: m.epic_start() })).toBeInTheDocument();
    await page.getByRole("button", { name: m.epic_queue(), exact: true }).click();
    expect(api.queueEpic).toHaveBeenCalledTimes(1);
    expect(api.queueEpic).toHaveBeenCalledWith("/repo", 99);
    expect(api.updateEpic).not.toHaveBeenCalled();
    expect(page.getByRole("dialog").query()).toBeNull();
  });

  it("no Queue for the leading epic itself", async () => {
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: B,
      epic: epic(B),
      drain: drain(),
      titleFor,
    });
    await expect.element(page.getByRole("button", { name: m.epic_pause() })).toBeInTheDocument();
    expect(page.getByRole("button", { name: m.epic_queue(), exact: true }).query()).toBeNull();
  });

  it("no Queue without a leader", async () => {
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: 99,
      epic: epic(99, { status: "idle" }),
      drain: drain({ runSummary: summary({ leadingEpic: null }) }),
      titleFor,
    });
    await expect.element(page.getByRole("button", { name: m.epic_start() })).toBeInTheDocument();
    expect(page.getByRole("button", { name: m.epic_queue(), exact: true }).query()).toBeNull();
  });

  it("Start under a leader supersedes after confirming — no queue choice", async () => {
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: 99,
      epic: epic(99, { status: "idle" }),
      drain: drain(),
      titleFor,
    });

    await page.getByRole("button", { name: m.epic_start() }).click();
    await expect.element(page.getByRole("dialog")).toBeInTheDocument();
    expect(page.getByRole("radio").query()).toBeNull();
    await page.getByRole("button", { name: m.epic_supersede_confirm() }).click();
    expect(api.updateEpic).toHaveBeenCalledWith(
      "/repo",
      99,
      { status: "running" },
      { requeueLeader: true },
    );
    expect(api.queueEpic).not.toHaveBeenCalled();
  });

  it("unticking Requeue supersedes without queueing the leader", async () => {
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: 99,
      epic: epic(99, { status: "idle" }),
      drain: drain(),
      titleFor,
    });

    await page.getByRole("button", { name: m.epic_start() }).click();
    await page.getByRole("checkbox", { name: m.epic_supersede_requeue({ leader: B }) }).click();
    await page.getByRole("button", { name: m.epic_supersede_confirm() }).click();
    expect(api.updateEpic).toHaveBeenCalledWith(
      "/repo",
      99,
      { status: "running" },
      { requeueLeader: false },
    );
  });

  it("a queued epic shows its place, what it waits for, and 'Remove from queue'", async () => {
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: 99,
      epic: epic(99, { status: "idle" }),
      drain: drain({ runSummary: summary({ queued: [50, 99] }) }),
      titleFor,
    });

    await expect
      .element(page.getByText(m.epic_run_state_queued({ position: 2 })))
      .toBeInTheDocument();
    await expect.element(page.getByText(m.epic_run_queued_note({ after: 50 }))).toBeInTheDocument();
    await page.getByRole("button", { name: m.epic_unqueue() }).click();
    expect(api.unqueueEpic).toHaveBeenCalledWith("/repo", 99);

    // Queued already: no Queue button; Start only offers superseding.
    expect(page.getByRole("button", { name: m.epic_queue(), exact: true }).query()).toBeNull();
    await page.getByRole("button", { name: m.epic_start() }).click();
    await expect.element(page.getByRole("dialog")).toBeInTheDocument();
    expect(page.getByRole("radio").query()).toBeNull();
  });
});

// #2972: Start without a loaded runSummary never supersedes blind.
describe("EpicRunControl — Start before the run picture loads (#2972)", () => {
  const unloaded = () => ({
    repoPath: "/repo",
    parent: 99,
    epic: epic(99, { status: "idle" }),
    drain: null,
    titleFor,
  });

  it("asks the server first; another leader opens the dialog instead of starting", async () => {
    api.getDrain.mockResolvedValue([drain()]);
    render(EpicRunControl, unloaded());

    await page.getByRole("button", { name: m.epic_start() }).click();
    await expect
      .element(page.getByRole("dialog", { name: m.epic_supersede_title({ epic: 99 }) }))
      .toBeInTheDocument();
    expect(api.getDrain).toHaveBeenCalledTimes(1);
    expect(api.updateEpic).not.toHaveBeenCalled();
    await page.getByRole("button", { name: m.epic_supersede_confirm() }).click();
    expect(api.updateEpic).toHaveBeenCalledWith(
      "/repo",
      99,
      { status: "running" },
      { requeueLeader: true },
    );
  });

  it("starts directly when the repo has no drain status (nothing leads)", async () => {
    api.getDrain.mockResolvedValue([drain({ repoPath: "/other" })]);
    render(EpicRunControl, unloaded());

    await page.getByRole("button", { name: m.epic_start() }).click();
    await vi.waitFor(() =>
      expect(api.updateEpic).toHaveBeenCalledWith("/repo", 99, { status: "running" }),
    );
    expect(page.getByRole("dialog").query()).toBeNull();
  });

  it("a failed check sends nothing and says so", async () => {
    api.getDrain.mockRejectedValue(new Error("down"));
    render(EpicRunControl, unloaded());

    await page.getByRole("button", { name: m.epic_start() }).click();
    await vi.waitFor(() => expect(api.getDrain).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(toasts.items.some((t) => t.text === m.epic_update_failed())).toBe(true),
    );
    expect(api.updateEpic).not.toHaveBeenCalled();
    expect(page.getByRole("dialog").query()).toBeNull();
  });

  it("Start is disabled while the check is pending", async () => {
    let resolve!: (v: DrainStatus[]) => void;
    api.getDrain.mockReturnValue(new Promise<DrainStatus[]>((r) => (resolve = r)));
    render(EpicRunControl, unloaded());

    const startBtn = page.getByRole("button", { name: m.epic_start() });
    await startBtn.click();
    await expect.element(startBtn).toBeDisabled();
    expect(api.updateEpic).not.toHaveBeenCalled();
    resolve([drain()]);
    await expect.element(page.getByRole("dialog")).toBeInTheDocument();
    await expect.element(startBtn).toBeEnabled();
    expect(api.updateEpic).not.toHaveBeenCalled();
  });
});

// Why an epic that stopped leading does not run — the calendar #67 case and its siblings.
describe("EpicRunControl — why a stopped epic does not run", () => {
  const AT = new Date(2026, 9, 4, 23, 41).getTime();
  const noLeader = () =>
    drain({
      epicParent: null,
      reason: null,
      runSummary: summary({ leadingEpic: null, next: [], after: [] }),
    });
  const summaryOf = (parent: number): EpicSummary | undefined =>
    parent === B
      ? {
          parentIssueNumber: B,
          parentTitle: "Autotask",
          total: 12,
          merged: 5,
          status: "running",
          source: "native",
        }
      : undefined;

  it("winding down with no leader: says it was ended and that nothing leads; restarts directly", async () => {
    const a = {
      ...epic(A, { status: "idle" }, [child(11, "running"), child(12, "ready")]),
      runEnd: { cause: "ended" as const, successor: null, at: AT, via: "ci-bot" },
    };
    render(EpicRunControl, { repoPath: "/repo", parent: A, epic: a, drain: noLeader(), titleFor });

    await expect
      .element(page.getByText(m.epic_run_no_leader(), { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(m.epic_run_why_via({ name: "ci-bot" }), { exact: false }))
      .toBeInTheDocument();
    expect(page.getByRole("button", { name: m.epic_run_rejoin() }).query()).toBeNull();
    await page.getByRole("button", { name: m.epic_run_restart() }).click();
    expect(api.updateEpic).toHaveBeenCalledWith("/repo", A, { status: "running" });
    expect(page.getByRole("dialog").query()).toBeNull();
  });

  it("winding down under a leader: names it and links it with its progress", async () => {
    const onselectepic = vi.fn();
    const a = {
      ...epic(A, { status: "idle" }, [child(11, "running"), child(12, "ready")]),
      runEnd: { cause: "superseded" as const, successor: B, at: AT, via: null },
    };
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: A,
      epic: a,
      drain: drain(),
      titleFor,
      epicSummaryFor: summaryOf,
      onselectepic,
    });

    const when = formatReset(AT, Date.now(), { withTime: true });
    await expect
      .element(page.getByText(m.epic_run_why_superseded_leads({ successor: B, when })))
      .toBeInTheDocument();
    const link = page.getByRole("button", {
      name: `#${B} Autotask · ${m.epicflow_merged({ merged: 5, total: 12 })}`,
    });
    await link.click();
    expect(onselectepic).toHaveBeenCalledWith(B);
    await expect
      .element(page.getByRole("button", { name: m.epic_run_rejoin() }))
      .toBeInTheDocument();
  });

  it("superseded and idle: 'Superseded', what waits, and Start asks before replacing the leader", async () => {
    const a = {
      ...epic(A, { status: "idle" }, [child(12, "ready"), child(13, "blocked", [12])]),
      runEnd: { cause: "superseded" as const, successor: B, at: AT, via: null },
    };
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: A,
      epic: a,
      drain: drain({ runSummary: summary({ windingDown: [] }) }),
      titleFor,
    });

    await expect
      .element(page.getByText(m.epic_run_state_superseded(), { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(m.epic_run_idle_waiting({ count: 2 }), { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(m.epic_run_idle_waiting_hint({ leader: B }), { exact: false }))
      .toBeInTheDocument();
    // without a host route the leader still shows, just not as a link
    expect(page.getByRole("button", { name: `#${B}`, exact: false }).query()).toBeNull();
    await page.getByRole("button", { name: m.epic_start() }).click();
    await expect
      .element(page.getByRole("dialog", { name: m.epic_supersede_title({ epic: A }) }))
      .toBeInTheDocument();
    expect(api.updateEpic).not.toHaveBeenCalled();
  });

  it("ended and idle with nothing leading: 'Ended' and why nothing starts", async () => {
    const a = {
      ...epic(A, { status: "idle" }, [child(12, "ready")]),
      runEnd: { cause: "ended" as const, successor: null, at: AT, via: null },
    };
    const idleRepo = drain({
      epicParent: null,
      reason: null,
      runSummary: summary({
        leadingEpic: null,
        windingDown: [],
        slots: { used: 0, max: 1, holders: [] },
        next: [],
        after: [],
      }),
    });
    render(EpicRunControl, { repoPath: "/repo", parent: A, epic: a, drain: idleRepo, titleFor });

    await expect
      .element(page.getByText(m.epic_run_state_ended(), { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(m.epic_run_no_leader(), { exact: false }))
      .toBeInTheDocument();
    expect(page.getByText(m.epic_run_state_idle()).query()).toBeNull();
  });
});

describe("EpicRunControl usage ceiling override", () => {
  const usageHold = () =>
    drain({ paused: true, reason: "usage", detail: "81", usageCeilingPct: 80 });

  it("a run halted on the usage ceiling offers lifting it for this run", async () => {
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: B,
      epic: epic(B),
      drain: usageHold(),
      titleFor,
    });

    await expect
      .element(page.getByText(m.drain_paused_usage_ceiling({ pct: "81", ceiling: 80 })))
      .toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await page.getByRole("button", { name: m.epic_usage_ignore() }).click();
    expect(api.updateEpic).toHaveBeenCalledWith("/repo", B, { ignoreUsageCeiling: true });
  });

  it("a run with the ceiling lifted says so and offers respecting it again", async () => {
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: B,
      epic: epic(B, { ignoreUsageCeiling: true }),
      drain: drain({ usageCeilingIgnored: true }),
      titleFor,
    });

    await expect.element(page.getByText(m.epic_usage_ignored_note())).toBeInTheDocument();
    expect(page.getByRole("button", { name: m.epic_usage_ignore() }).query()).toBeNull();
    await userEvent.keyboard("{Escape}");
    await page.getByRole("button", { name: m.epic_usage_respect() }).click();
    expect(api.updateEpic).toHaveBeenCalledWith("/repo", B, { ignoreUsageCeiling: false });
  });

  it("no override control for another hold", async () => {
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: B,
      epic: epic(B),
      drain: drain({ paused: true, reason: "credits" }),
      titleFor,
    });

    await expect.element(page.getByText(m.epic_run_state_halted())).toBeInTheDocument();
    expect(page.getByRole("button", { name: m.epic_usage_ignore() }).query()).toBeNull();
  });
});

describe("EpicRunControl base conflict hold (#3101)", () => {
  const conflictHold = () =>
    drain({ paused: true, reason: "epic_base_conflict", detail: "epic/20-x" });

  function renderHeld() {
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: B,
      epic: epic(B),
      drain: conflictHold(),
      titleFor,
    });
  }

  async function expectToast(text: string) {
    await vi.waitFor(() => expect(toasts.items.some((t) => t.text === text)).toBe(true));
  }

  it("Resolve conflict dispatches the rework for this epic", async () => {
    renderHeld();
    await userEvent.keyboard("{Escape}");
    await page.getByRole("button", { name: m.epic_base_resolve() }).click();
    expect(api.reworkEpicBase).toHaveBeenCalledWith("/repo", B);
  });

  it.each([
    ["busy", () => m.epic_base_resolve_busy()],
    ["not-conflicting", () => m.epic_base_resolve_not_conflicting()],
    ["spawn-failed", () => m.epic_base_resolve_failed()],
  ])("a %s refusal names why the rework did not start", async (reason, text) => {
    toasts.dismissKey("epic-base-fail");
    api.reworkEpicBase.mockRejectedValueOnce(new ApiError(409, "x", reason));
    renderHeld();
    await userEvent.keyboard("{Escape}");
    await page.getByRole("button", { name: m.epic_base_resolve() }).click();
    await expectToast(text());
  });

  it("a failed Continue anyway keeps the hold message", async () => {
    toasts.dismissKey("epic-base-fail");
    api.overrideEpicBaseHold.mockRejectedValueOnce(new ApiError(502, "x", "transient"));
    renderHeld();
    await userEvent.keyboard("{Escape}");
    await page.getByRole("button", { name: m.epic_base_continue() }).click();
    expect(api.overrideEpicBaseHold).toHaveBeenCalledWith("/repo", B, "base");
    await expectToast(m.epic_base_action_failed());
  });
});

describe("EpicRunControl narrow layout", () => {
  const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
  const mount = () =>
    render(EpicRunControl, {
      repoPath: "/repo",
      parent: B,
      epic: epic(B),
      drain: drain(),
      titleFor,
    });

  it("phone: state alone, commands row above settings row, each full width", async () => {
    await page.viewport(360, 800);
    mount();
    await expect.element(page.getByRole("button", { name: m.epic_pause() })).toBeInTheDocument();

    const actions = box("[data-epic-run] .run-actions");
    const commands = box('[data-group="commands"]');
    const settings = box('[data-group="settings"]');
    expect(box("[data-epic-run] .run-state").bottom).toBeLessThanOrEqual(commands.top);
    expect(commands.top).toBeLessThan(settings.top);
    expect(Math.abs(commands.width - actions.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(settings.width - actions.width)).toBeLessThanOrEqual(2);
    // The row is filled: the last button ends at the row's edge and Pause takes the slack.
    const buttons = [...document.querySelectorAll('[data-group="commands"] > button')];
    const last = buttons.at(-1)!.getBoundingClientRect();
    expect(Math.abs(last.right - commands.right)).toBeLessThanOrEqual(2);
    const pause = page.getByRole("button", { name: m.epic_pause() }).element();
    expect(pause.getBoundingClientRect().width).toBeGreaterThan(commands.width / 2);
  });

  it("desktop: state and every action share one row", async () => {
    await page.viewport(1100, 800);
    mount();
    await expect.element(page.getByRole("button", { name: m.epic_pause() })).toBeInTheDocument();

    const mid = (r: DOMRect) => r.top + r.height / 2;
    const state = mid(box("[data-epic-run] .run-state"));
    const pause = page.getByRole("button", { name: m.epic_pause() }).element();
    const auto = page.getByRole("button", { name: m.epic_mode_auto_aria() }).element();
    expect(Math.abs(mid(pause.getBoundingClientRect()) - state)).toBeLessThanOrEqual(4);
    expect(Math.abs(mid(auto.getBoundingClientRect()) - state)).toBeLessThanOrEqual(4);
  });
});

// #3423: an incremental chain nobody merges — warn, and name the PR it waits on.
describe("EpicRunControl incremental merge gate", () => {
  let n = 0;
  const repo = () => `/repo/merge-gate-${++n}`;
  const cfg = (over: Record<string, boolean> = {}) => ({
    autoMergeEnabled: false,
    autopilotEnabled: true,
    draftMode: false,
    epicStacksEnabled: false,
    ...over,
  });
  const incremental = (children: EpicChild[]) => ({
    ...epic(B, { landing: "incremental" }, children),
  });
  const reviewChild = { ...child(21, "in-review"), sessionId: "s21", prNumber: 14 };
  const chain = [reviewChild, child(22, "blocked", [21]), child(23, "blocked", [21])];
  const sessionInfo = (checks: GitState["checks"]) => (id: string) =>
    id === "s21"
      ? {
          session: {} as Session,
          git: { checks, url: "https://example.test/pull/14" } as GitState,
        }
      : null;
  const warning = () => page.getByText(m.epic_incremental_stall_warning());
  const wait = () =>
    page.getByRole("link", { name: m.epic_merge_wait({ pr: 14, issues: "#22, #23" }) });

  it("warns and names the green PR when nothing merges child PRs", async () => {
    const repoPath = repo();
    api.getRepoConfig.mockImplementation(async () => cfg());
    render(EpicRunControl, {
      repoPath,
      parent: B,
      epic: incremental(chain),
      drain: drain({ reason: "empty" }),
      titleFor,
      sessionInfo: sessionInfo("success"),
    });
    await expect.element(warning()).toBeInTheDocument();
    await expect.element(wait()).toHaveAttribute("href", "https://example.test/pull/14");
  });

  it("names the PR of a child the drain retired (no live session)", async () => {
    const repoPath = repo();
    api.getRepoConfig.mockImplementation(async () => cfg());
    const retired = {
      ...child(21, "in-review"),
      url: "https://example.test/issues/21",
      claimed: true,
      retiredPrNumber: 14,
    };
    render(EpicRunControl, {
      repoPath,
      parent: B,
      epic: incremental([retired, child(22, "blocked", [21]), child(23, "blocked", [21])]),
      drain: drain({ reason: "empty" }),
      titleFor,
    });
    await expect.element(wait()).toHaveAttribute("href", "https://example.test/issues/14");
  });

  it("stays quiet when autopilot and auto-merge carry the PRs", async () => {
    const repoPath = repo();
    api.getRepoConfig.mockImplementation(async () => cfg({ autoMergeEnabled: true }));
    render(EpicRunControl, {
      repoPath,
      parent: B,
      epic: incremental(chain),
      drain: drain({ reason: "empty" }),
      titleFor,
      sessionInfo: sessionInfo("success"),
    });
    await expect.poll(() => api.getRepoConfig.mock.calls.some(([r]) => r === repoPath)).toBe(true);
    await tick();
    expect(warning().query()).toBeNull();
    expect(wait().query()).toBeNull();
  });

  it("warns without a wait line while the blocker's checks still run", async () => {
    const repoPath = repo();
    api.getRepoConfig.mockImplementation(async () =>
      cfg({ autopilotEnabled: false, autoMergeEnabled: true }),
    );
    render(EpicRunControl, {
      repoPath,
      parent: B,
      epic: incremental(chain),
      drain: drain({ reason: "empty" }),
      titleFor,
      sessionInfo: sessionInfo("pending"),
    });
    await expect.element(warning()).toBeInTheDocument();
    expect(wait().query()).toBeNull();
  });
});
