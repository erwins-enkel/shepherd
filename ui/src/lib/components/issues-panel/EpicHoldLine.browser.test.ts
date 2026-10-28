import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../../app.css";
import EpicHeaderRow from "./EpicHeaderRow.svelte";
import type { DrainRunSummary, DrainStatus, Issue } from "#lib/types.js";
import type { RepoBootstrapView } from "#lib/api.js";
import { ApiError } from "#lib/api.js";
import { m } from "#lib/paraglide/messages.js";
import { toasts } from "#lib/toasts.svelte.js";
import { expectQuietLegible } from "#lib/test-support/contrast.js";
import { expectMinPx } from "#lib/test-support/geometry.js";

const api = vi.hoisted(() => ({
  updateEpic: vi.fn(async () => ({})),
  overrideEpicBaseHold: vi.fn(async () => {}),
  reworkEpicBase: vi.fn<() => Promise<void>>(async () => {}),
  approveEpicNext: vi.fn(async () => ({})),
  overrideRepoBootstrap: vi.fn(
    async (): Promise<RepoBootstrapView> => ({}) as unknown as RepoBootstrapView,
  ),
  getEpicAutoFix: vi.fn(async () => {
    throw new Error("offline");
  }),
}));

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return { ...actual, ...api };
});

const B = 35;
let n = 0;
const repo = () => `/repo/hold-${++n}`;

const ISSUE: Issue = {
  number: B,
  title: "Hundesport-MVP",
  body: "",
  url: "u",
  labels: [],
  createdAt: 0,
  assignees: [],
};

function summary(): DrainRunSummary {
  return {
    leadingEpic: B,
    windingDown: [],
    slots: {
      used: 1,
      max: 2,
      holders: [{ sessionId: "s-17", desig: "TASK-17", issueNumber: 17, epicParent: B }],
    },
    next: [18],
    after: [],
  };
}

function drain(repoPath: string, over: Partial<DrainStatus>): DrainStatus {
  return {
    repoPath,
    enabled: true,
    paused: true,
    reason: null,
    detail: null,
    queued: 1,
    inFlight: 1,
    max: 2,
    epicParent: B,
    runSummary: summary(),
    ...over,
  };
}

async function mountRow(over: Partial<DrainStatus>, props: Record<string, unknown> = {}) {
  const r = repo();
  const onselect = vi.fn();
  const onopensession = vi.fn();
  const onopenautomation = vi.fn();
  const view = await render(EpicHeaderRow, {
    issue: ISSUE,
    drain: drain(r, over),
    expanded: false,
    selected: false,
    optionId: "opt-35",
    onselect,
    ontoggle: vi.fn(),
    onopensession,
    onopenautomation,
    ...props,
  });
  return { ...view, r, onselect, onopensession, onopenautomation };
}

const line = () => document.querySelector<HTMLElement>("[data-epic-hold]");
const action = (name: string) => page.getByRole("button", { name, exact: true });

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockClear();
  toasts.items = [];
});

afterEach(async () => {
  await page.viewport(1280, 900);
});

describe("EpicHeaderRow drain hold (#3457)", () => {
  it("without a hold the row reads as before: no line", async () => {
    await mountRow({ reason: null, paused: false });
    await expect.element(page.getByText(ISSUE.title)).toBeVisible();
    expect(line()).toBeNull();
  });

  it("a hold of another epic, a cap or a sandbox gate draws no hold line here", async () => {
    const other = await mountRow({ reason: "usage", detail: "91", epicParent: 99 });
    expect(line()).toBeNull();
    await other.unmount();
    const cap = await mountRow({ reason: "cap", detail: "2" });
    expect(line()).toBeNull();
    await cap.unmount();
    // The sandbox gates keep their own line with Fix (#3455).
    await mountRow({ reason: "sandbox_interactive", detail: "standard" });
    await expect.element(page.getByText(m.epic_row_halt_lead())).toBeVisible();
    expect(line()).toBeNull();
  });

  it("project bootstrap: REPO, View bootstrap opens Automation, Override hold overrides in one click", async () => {
    const { r, onselect, onopenautomation } = await mountRow({
      reason: "bootstrap_incomplete",
      detail: "p2",
    });
    await expect.element(page.getByText(m.epic_rowhold_bootstrap_what())).toBeVisible();
    expect(line()!.dataset.scope).toBe("repo");
    expect(line()!.textContent).toContain(m.epic_autofix_scope_repo());
    await action(m.epic_rowhold_bootstrap_view()).click();
    expect(onopenautomation).toHaveBeenCalledOnce();
    await action(m.automation_bootstrap_override()).click();
    await vi.waitFor(() => expect(api.overrideRepoBootstrap).toHaveBeenCalledWith(r, true));
    expect(onselect).not.toHaveBeenCalled();
  });

  it("usage: RUN, Lift for this run lifts the ceiling for this epic's run", async () => {
    const { r, onselect } = await mountRow({ reason: "usage", detail: "91" });
    await expect.element(page.getByText(m.epic_rowhold_usage_what())).toBeVisible();
    expect(line()!.dataset.scope).toBe("run");
    expect(line()!.textContent).toContain(m.epic_autofix_scope_run());
    await action(m.epic_rowhold_usage_lift()).click();
    await vi.waitFor(() =>
      expect(api.updateEpic).toHaveBeenCalledWith(r, B, { ignoreUsageCeiling: true }),
    );
    expect(onselect).not.toHaveBeenCalled();
  });

  it("base conflict: Get the conflict resolved and Continue anyway", async () => {
    const { r } = await mountRow({ reason: "epic_base_conflict", detail: "epic/35-mvp" });
    await expect
      .element(page.getByText(m.epic_rowhold_conflict_text({ branch: "epic/35-mvp" })))
      .toBeVisible();
    await action(m.epic_rowhold_resolve()).click();
    await vi.waitFor(() => expect(api.reworkEpicBase).toHaveBeenCalledWith(r, B));
    await action(m.epic_base_continue()).click();
    await vi.waitFor(() => expect(api.overrideEpicBaseHold).toHaveBeenCalledWith(r, B, "base"));
  });

  it("a failed rework says why, as the run area does", async () => {
    api.reworkEpicBase.mockRejectedValueOnce(new ApiError(409, "busy", "busy"));
    await mountRow({ reason: "epic_base_conflict", detail: "epic/35-mvp" });
    await action(m.epic_rowhold_resolve()).click();
    await vi.waitFor(() =>
      expect(toasts.items.map((t) => t.text)).toContain(m.epic_base_resolve_busy()),
    );
  });

  it("stale base: only Continue anyway; unlanded predecessor: Continue anyway past it", async () => {
    const stale = await mountRow({ reason: "epic_base_stale", detail: "epic/35-mvp" });
    expect(action(m.epic_rowhold_resolve()).query()).toBeNull();
    await action(m.epic_base_continue()).click();
    await vi.waitFor(() =>
      expect(api.overrideEpicBaseHold).toHaveBeenCalledWith(stale.r, B, "base"),
    );
    await stale.unmount();
    const pred = await mountRow({ reason: "epic_predecessor_unlanded", detail: "#12" });
    await expect.element(page.getByText(m.epic_rowhold_predecessor_what())).toBeVisible();
    await action(m.epic_base_continue()).click();
    await vi.waitFor(() =>
      expect(api.overrideEpicBaseHold).toHaveBeenCalledWith(pred.r, B, "predecessor"),
    );
  });

  for (const reason of ["blocked", "changes_requested", "error"]) {
    it(`${reason}: Open session opens the stuck agent's session`, async () => {
      const { onopensession, onselect } = await mountRow({ reason, detail: "TASK-17" });
      await expect.element(page.getByText(m.epic_rowhold_agent_what())).toBeVisible();
      await action(m.epic_run_open_session()).click();
      expect(onopensession).toHaveBeenCalledWith("s-17");
      expect(onselect).not.toHaveBeenCalled();
    });
  }

  it("names a stuck agent it can't open without the button", async () => {
    await mountRow({ reason: "blocked", detail: "TASK-99" });
    await expect.element(page.getByText(m.epic_rowhold_agent_what())).toBeVisible();
    expect(action(m.epic_run_open_session()).query()).toBeNull();
  });

  it("awaiting approval: amber, not red, and Approve approves the next child", async () => {
    const { r } = await mountRow({ reason: "awaiting_approval", detail: "18" });
    await expect.element(page.getByText(m.epic_rowhold_approval_what())).toBeVisible();
    expect(line()!.dataset.tone).toBe("wait");
    await action(m.epic_rowhold_approve()).click();
    await vi.waitFor(() => expect(api.approveEpicNext).toHaveBeenCalledWith(r, B));
  });

  it("keys on an action stay with it — Enter doesn't select the row", async () => {
    const { onselect } = await mountRow({ reason: "usage", detail: "91" });
    const btn = action(m.epic_rowhold_usage_lift()).element() as HTMLButtonElement;
    btn.focus();
    btn.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onselect).not.toHaveBeenCalled();
  });

  for (const theme of ["light", "dark"] as const) {
    for (const reason of ["usage", "awaiting_approval"]) {
      it(`keeps the ${reason} line at AA contrast: ${theme}`, async () => {
        document.documentElement.dataset.theme = theme;
        try {
          await mountRow({ reason, detail: "18" });
          await expect.element(page.getByRole("button").last()).toBeVisible();
          for (const sel of [".hc-chip", ".text", ".what", ".hc-gbtn"]) {
            const el = line()!.querySelector<HTMLElement>(sel);
            expect(el, sel).not.toBeNull();
            try {
              expectQuietLegible(el!);
            } catch (e) {
              throw new Error(`${sel}: ${e}`, { cause: e });
            }
          }
        } finally {
          document.documentElement.removeAttribute("data-theme");
        }
      });
    }
  }

  it("phone: touch-sized actions, no sideways scroll", async () => {
    await page.viewport(390, 844);
    await mountRow({ reason: "epic_base_conflict", detail: "epic/35-mvp" }, { mobile: true });
    for (const name of [m.epic_rowhold_resolve(), m.epic_base_continue()]) {
      const btn = action(name);
      await expect.element(btn).toBeVisible();
      expectMinPx(btn.element().getBoundingClientRect().height, 44, name);
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });
});
