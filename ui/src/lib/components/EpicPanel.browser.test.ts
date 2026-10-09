import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import EpicPanel from "./EpicPanel.svelte";
import type { Epic, EpicChild } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";

function child(over: Partial<EpicChild>): EpicChild {
  return {
    number: 1,
    title: "c",
    url: "u",
    order: 0,
    body: "",
    blockedBy: [],
    state: "ready",
    sessionId: null,
    prNumber: null,
    issueClosed: false,
    claimed: false,
    ...over,
  };
}

const api = vi.hoisted(() => ({
  importEpic: vi.fn(async () => ({})),
}));

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return { ...actual, ...api };
});

function epic(over: Partial<Epic["run"]> = {}): Epic {
  return {
    repoPath: "/repo",
    parentIssueNumber: 327,
    parentTitle: "Epic parent",
    source: "native",
    children: [],
    warnings: [],
    run: {
      repoPath: "/repo",
      parentIssueNumber: 327,
      mode: "auto",
      status: "running",
      agentProvider: null,
      model: null,
      effort: null,
      ...over,
    },
  };
}

beforeEach(() => {
  api.importEpic.mockClear();
});

// The zero-deps warning (driven by epic.noDependencyEdges) stays on the panel; the drain's hold
// reason and every run control moved to the detail's run area (EpicRunControl, #2620).
describe("EpicPanel legibility lines (#1447)", () => {
  it("renders the zero-deps warning when the flag is set", async () => {
    const e: Epic = {
      ...epic(),
      children: [child({ number: 1 }), child({ number: 2 })],
      noDependencyEdges: true,
    };
    render(EpicPanel, { repoPath: "/repo", parent: 327, epic: e });

    await expect.element(page.getByText(m.epic_warn_no_deps({ count: 2 }))).toBeInTheDocument();
  });
});

describe("EpicPanel after the run area (#2620)", () => {
  it("renders no run controls and no hold line", async () => {
    render(EpicPanel, { repoPath: "/repo", parent: 327, epic: epic() });

    await expect
      .element(page.getByText(m.epic_progress({ merged: 0, total: 0 })))
      .toBeInTheDocument();
    expect(page.getByRole("button", { name: m.epic_pause() }).query()).toBeNull();
    expect(page.getByRole("button", { name: m.epic_start() }).query()).toBeNull();
    expect(page.getByLabelText(m.epic_provider_label()).query()).toBeNull();
  });

  it("marks the child holding an agent slot", async () => {
    const e: Epic = {
      ...epic(),
      children: [child({ number: 5, state: "running" }), child({ number: 6 })],
    };
    render(EpicPanel, {
      repoPath: "/repo",
      parent: 327,
      epic: e,
      runSummary: {
        leadingEpic: 327,
        windingDown: [],
        slots: {
          used: 1,
          max: 2,
          holders: [{ sessionId: "s5", desig: "TASK-05", issueNumber: 5, epicParent: 327 }],
        },
        next: [6],
        after: [],
      },
    });

    await expect
      .element(page.getByText(m.epic_slot_held({ index: 1, max: 2 })))
      .toBeInTheDocument();
  });
});

const MIN = 60_000;
const NOW = new Date(2026, 9, 9, 12, 43).getTime();

/** An epic with the clock and a forecast: one step merged, one running, one waiting. */
function timed(): Epic {
  return {
    ...epic(),
    children: [
      child({ number: 160, state: "merged", startedAt: NOW - 142 * MIN, endedAt: NOW - 12 * MIN }),
      child({ number: 161, order: 1, state: "running", startedAt: NOW - 253_000 }),
      child({ number: 159, order: 2, state: "ready" }),
    ],
    timing: {
      startedAt: NOW - 142 * MIN,
      pausedAt: null,
      pausedMs: 0,
      landingStartedAt: null,
      landedAt: null,
      agentMs: 134 * MIN,
      idleMs: 8 * MIN,
    },
    forecast: {
      finishAt: NOW + 230 * MIN,
      finishLow: NOW + 180 * MIN,
      finishHigh: NOW + 300 * MIN,
      remainingMsFromResume: null,
      confidence: "low",
      stepMs: 105 * MIN,
      landingMs: 20 * MIN,
      epicSamples: 1,
      repoSamples: 23,
      firstFinishAt: null,
      fasterWithSlots: null,
      children: [
        {
          number: 161,
          projectedStart: NOW - 253_000,
          projectedEnd: NOW + 100 * MIN,
          overrun: false,
        },
        {
          number: 159,
          projectedStart: NOW + 100 * MIN,
          projectedEnd: NOW + 205 * MIN,
          overrun: false,
        },
      ],
    },
  };
}

const row = (n: number) =>
  page.getByRole("listitem").filter({ has: page.getByRole("link", { name: `#${n}` }) });

describe("EpicPanel DAUER column (#2939)", () => {
  it("shows each step's duration: measured, live, forecast", async () => {
    render(EpicPanel, { repoPath: "/repo", parent: 327, epic: timed(), nowMs: NOW });

    await expect.element(page.getByText(m.epicdetail_col_duration())).toBeVisible();
    await expect.element(row(160).getByText("2 h 10 min")).toBeVisible();
    await expect.element(row(161).getByText("04:13")).toBeVisible();
    await expect.element(row(161).getByText(/· ~1 h 40 min left/)).toBeVisible();
    await expect.element(row(159).getByText("~1 h 45 min · forecast")).toBeVisible();
  });

  it("has no column without the epic clock", async () => {
    render(EpicPanel, {
      repoPath: "/repo",
      parent: 327,
      epic: { ...timed(), timing: undefined },
      nowMs: NOW,
    });

    await expect.element(page.getByRole("link", { name: "#160" })).toBeVisible();
    expect(page.getByText(m.epicdetail_col_duration()).query()).toBeNull();
    expect(document.querySelector(".dur")).toBeNull();
  });
});

// The "epic not loading" bug: a duplicate child (an epic-dag node listed on two `<-` lines) reaches
// EpicPanel's `{#each epic.children as c (c.number)}`, whose duplicate key throws each_key_duplicate
// and crashes the panel on mount. The data-layer fix (parser + assembleEpic dedup) guarantees unique
// children; these cases pin the user-visible outcome. The clean-mount case runs first — the throwing
// render can leak a partially-mounted subtree, so the throw assertion is kept last.
describe("EpicPanel duplicate-child guard", () => {
  it("mounts and renders each child row when numbers are unique", async () => {
    const e: Epic = {
      ...epic(),
      children: [child({ number: 707 }), child({ number: 708 }), child({ number: 709 })],
    };
    render(EpicPanel, { repoPath: "/repo", parent: 327, epic: e });

    await expect.element(page.getByRole("link", { name: "#709" })).toBeInTheDocument();
  });

  it("crashes the child list with each_key_duplicate on a duplicate child number", async () => {
    // The each block's effect throws asynchronously (Svelte schedules it), surfacing as an
    // unhandled rejection rather than a synchronous throw from render() — capture it here and
    // preventDefault so it's asserted, not leaked into the run as a false failure.
    //
    // Wait on the event, never on a timer (#2028). A fixed sleep is a deadline, not a guarantee:
    // under a loaded full-suite run the listener came off before the rejection was dispatched, so
    // it escaped to vitest — every test green, process exit 1. `landed` holds the listener in
    // place until the rejection actually arrives. vitest's per-test timeout bounds the wait, so a
    // Svelte that stops validating keys fails this case rather than hanging the run.
    let captured: string | null = null;
    let onLanded!: () => void;
    const landed = new Promise<void>((resolve) => (onLanded = resolve));
    const onRejection = (ev: PromiseRejectionEvent) => {
      const msg = String((ev.reason as Error)?.message ?? ev.reason ?? "");
      if (msg.includes("each_key_duplicate")) {
        captured = msg;
        ev.preventDefault();
        onLanded();
      }
    };
    window.addEventListener("unhandledrejection", onRejection);
    try {
      const e: Epic = { ...epic(), children: [child({ number: 709 }), child({ number: 709 })] };
      render(EpicPanel, { repoPath: "/repo", parent: 327, epic: e });
      await landed;
      expect(captured).toMatch(/each_key_duplicate/);
    } finally {
      window.removeEventListener("unhandledrejection", onRejection);
    }
  });
});

describe("EpicPanel headActions (#2617)", () => {
  it("hides Import + Diagnose when the host offers them itself", async () => {
    const md: Epic = { ...epic({ status: "idle" }), source: "markdown" };
    const { unmount } = await render(EpicPanel, { repoPath: "/repo", parent: 327, epic: md });
    await expect.element(page.getByRole("button", { name: m.epic_import() })).toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: m.epic_diag_open() }))
      .toBeInTheDocument();
    unmount();

    await render(EpicPanel, { repoPath: "/repo", parent: 327, epic: md, headActions: false });
    await expect
      .element(page.getByText(m.epic_progress({ merged: 0, total: 0 })))
      .toBeInTheDocument();
    expect(page.getByRole("button", { name: m.epic_import() }).query()).toBeNull();
    expect(page.getByRole("button", { name: m.epic_diag_open() }).query()).toBeNull();
  });
});
