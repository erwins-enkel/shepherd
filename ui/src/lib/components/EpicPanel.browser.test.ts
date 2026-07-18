import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import EpicPanel from "./EpicPanel.svelte";
import type { DrainStatus, Epic, EpicChild } from "$lib/types";
import { m } from "$lib/paraglide/messages";

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

function drain(over: Partial<DrainStatus>): DrainStatus {
  return {
    repoPath: "/repo",
    enabled: true,
    paused: false,
    reason: null,
    detail: null,
    queued: 0,
    inFlight: 0,
    max: 3,
    epicParent: 327,
    ...over,
  };
}

const api = vi.hoisted(() => ({
  updateEpic: vi.fn(async () => ({})),
  approveEpicNext: vi.fn(async () => ({})),
  importEpic: vi.fn(async () => ({})),
}));

vi.mock("$lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("$lib/api")>();
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

function changeSelect(label: string, value: string) {
  const select = page.getByLabelText(label).element() as HTMLSelectElement;
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  api.updateEpic.mockClear();
  api.approveEpicNext.mockClear();
  api.importEpic.mockClear();
});

describe("EpicPanel provider settings", () => {
  it("renders inherited CLI state and persists provider selection", async () => {
    render(EpicPanel, { repoPath: "/repo", parent: 327, epic: epic() });

    expect(
      (page.getByLabelText(m.epic_provider_label()).element() as HTMLSelectElement).value,
    ).toBe("inherit");
    changeSelect(m.epic_provider_label(), "codex");

    expect(api.updateEpic).toHaveBeenCalledWith("/repo", 327, {
      agentProvider: "codex",
      model: null,
      effort: null,
    });
  });

  it("persists model changes for an explicit provider", async () => {
    render(EpicPanel, {
      repoPath: "/repo",
      parent: 327,
      epic: epic({ agentProvider: "codex", model: null, effort: null }),
    });

    changeSelect(m.epic_model_label(), "gpt-5.5");

    expect(api.updateEpic).toHaveBeenCalledWith("/repo", 327, { model: "gpt-5.5" });
  });
});

// The zero-deps warning (driven by epic.noDependencyEdges) and the hold line (driven by the
// drain reason) are independent — asserted in SEPARATE scenarios, never inferred from each other.
describe("EpicPanel legibility lines (#1447)", () => {
  it("renders the zero-deps warning when the flag is set (no drain → no hold line)", async () => {
    const e: Epic = {
      ...epic(),
      children: [child({ number: 1 }), child({ number: 2 })],
      noDependencyEdges: true,
    };
    render(EpicPanel, { repoPath: "/repo", parent: 327, epic: e });

    await expect.element(page.getByText(m.epic_warn_no_deps({ count: 2 }))).toBeInTheDocument();
    expect(page.getByText(m.epic_hold_cap({ inFlight: 3, max: 3 })).query()).toBeNull();
  });

  it("renders the drain hold reason for a held epic (cap), matched by epicParent", async () => {
    const e: Epic = {
      ...epic(),
      children: [child({ number: 1, state: "running" }), child({ number: 2, state: "blocked" })],
    };
    render(EpicPanel, {
      repoPath: "/repo",
      parent: 327,
      epic: e,
      drain: drain({ reason: "cap", inFlight: 3, max: 3 }),
    });

    await expect
      .element(page.getByText(m.epic_hold_cap({ inFlight: 3, max: 3 })))
      .toBeInTheDocument();
    expect(page.getByText(m.epic_warn_no_deps({ count: 2 })).query()).toBeNull();
  });

  it("empty is progress-aware: an in-flight child reads as 'waiting', not 'nothing eligible'", async () => {
    const e: Epic = {
      ...epic(),
      children: [child({ number: 1, state: "in-review" }), child({ number: 2, state: "blocked" })],
    };
    render(EpicPanel, {
      repoPath: "/repo",
      parent: 327,
      epic: e,
      drain: drain({ reason: "empty" }),
    });

    await expect.element(page.getByText(m.epic_hold_waiting_inflight())).toBeInTheDocument();
    expect(page.getByText(m.epic_hold_empty()).query()).toBeNull();
  });

  it("does not surface a hold line for a drain belonging to a different epic", async () => {
    render(EpicPanel, {
      repoPath: "/repo",
      parent: 327,
      epic: epic(),
      drain: drain({ reason: "cap", inFlight: 3, max: 3, epicParent: 999 }),
    });

    expect(page.getByText(m.epic_hold_cap({ inFlight: 3, max: 3 })).query()).toBeNull();
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
    let captured: string | null = null;
    const onRejection = (ev: PromiseRejectionEvent) => {
      const msg = String((ev.reason as Error)?.message ?? ev.reason ?? "");
      if (msg.includes("each_key_duplicate")) {
        captured = msg;
        ev.preventDefault();
      }
    };
    window.addEventListener("unhandledrejection", onRejection);
    try {
      const e: Epic = { ...epic(), children: [child({ number: 709 }), child({ number: 709 })] };
      render(EpicPanel, { repoPath: "/repo", parent: 327, epic: e });
      await new Promise((r) => setTimeout(r, 50));
      expect(captured).toMatch(/each_key_duplicate/);
    } finally {
      window.removeEventListener("unhandledrejection", onRejection);
    }
  });
});
