import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import "../../../app.css";
import EpicHeaderRow from "./EpicHeaderRow.svelte";
import EpicRunControl from "./EpicRunControl.svelte";
import type {
  DrainRunSummary,
  DrainStatus,
  Epic,
  EpicAutoBlockers,
  EpicAutoFixResult,
  EpicChild,
  Issue,
} from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";
import { haltSummary, issueList } from "../epic-auto-fix";
import { expectQuietLegible } from "#lib/test-support/contrast.js";
import { expectMinPx } from "#lib/test-support/geometry.js";

const api = vi.hoisted(() => ({
  updateEpic: vi.fn(async () => ({})),
  getDrain: vi.fn(async (): Promise<DrainStatus[]> => []),
  getRepoConfig: vi.fn<(repo: string) => Promise<unknown>>(async () => {
    throw new Error("offline");
  }),
  getEpicAutoFix: vi.fn<(repo: string, parent: number) => Promise<EpicAutoBlockers>>(),
  applyEpicAutoFix:
    vi.fn<(repo: string, parent: number, body: unknown) => Promise<EpicAutoFixResult>>(),
}));

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return { ...actual, ...api };
});

const B = 35;
const ok = (id: string) => ({ id, ok: true });
// "Behebung" Fall A: the repo on Standard, the epic on Codex.
const FALL_A: EpicAutoBlockers = {
  causes: [
    { code: "sandbox_interactive", scope: "repo", detail: "standard" },
    { code: "sandbox_provider_unconfined", scope: "epic", detail: "codex" },
  ],
  options: [
    {
      id: "autonomous_claude",
      changes: { sandboxProfile: "autonomous", agentProvider: "claude" },
      enabled: true,
      checks: [ok("bwrap"), ok("egress"), ok("remote_https")],
    },
    { id: "trusted", changes: { sandboxProfile: "trusted" }, enabled: true, checks: [] },
    {
      id: "autonomous",
      changes: { sandboxProfile: "autonomous" },
      enabled: false,
      why: "cli",
      checks: [{ id: "cli", ok: false }, ok("bwrap"), ok("egress"), ok("remote_https")],
    },
  ],
  preselect: "autonomous_claude",
};
const CLEAR: EpicAutoBlockers = { causes: [], options: [], preselect: null };
const PREVIOUS = { sandboxProfile: "inherit" as const, agentProvider: "codex" as const };

let n = 0;
const repo = () => `/repo/row-${++n}`;

const ISSUE: Issue = {
  number: B,
  title: "Hundesport-MVP",
  body: "",
  url: "u",
  labels: [],
  createdAt: 0,
  assignees: [],
};

function child(number: number, state: EpicChild["state"]): EpicChild {
  return {
    number,
    title: `c${number}`,
    url: "u",
    order: number,
    body: "",
    blockedBy: [],
    state,
    sessionId: null,
    prNumber: null,
    issueClosed: false,
    claimed: false,
  };
}

function epic(repoPath: string): Epic {
  return {
    repoPath,
    parentIssueNumber: B,
    parentTitle: ISSUE.title,
    source: "native",
    children: [child(21, "ready"), child(22, "ready"), child(23, "blocked")],
    warnings: [],
    run: {
      repoPath,
      parentIssueNumber: B,
      mode: "auto",
      status: "running",
      agentProvider: "codex",
      model: null,
      effort: null,
    },
  };
}

function summary(): DrainRunSummary {
  return {
    leadingEpic: B,
    windingDown: [],
    slots: { used: 0, max: 2, holders: [] },
    next: [21, 22],
    after: [23],
  };
}

function drain(repoPath: string, over: Partial<DrainStatus> = {}): DrainStatus {
  return {
    repoPath,
    enabled: true,
    paused: true,
    reason: "sandbox_provider_unconfined",
    detail: "codex",
    queued: 2,
    inFlight: 0,
    max: 2,
    epicParent: B,
    runSummary: summary(),
    ...over,
  };
}

async function mountRow(repoPath: string, over: Record<string, unknown> = {}) {
  const onselect = vi.fn();
  const view = await render(EpicHeaderRow, {
    issue: ISSUE,
    epic: epic(repoPath),
    drain: drain(repoPath),
    expanded: false,
    selected: false,
    optionId: "opt-35",
    onselect,
    ontoggle: vi.fn(),
    ...over,
  });
  return { ...view, onselect };
}

const fixButton = () => page.getByRole("button", { name: m.epic_row_fix() });
const fixDialog = () => page.getByRole("dialog", { name: m.epic_row_fix_title({ parent: B }) });
const line = () => document.querySelector<HTMLElement>("[data-epic-row-halt]");

beforeEach(() => {
  api.getEpicAutoFix.mockReset();
  api.applyEpicAutoFix.mockReset();
  api.getEpicAutoFix.mockResolvedValue(FALL_A);
});

afterEach(async () => {
  await page.viewport(1280, 900);
});

describe("EpicHeaderRow halt (#3455)", () => {
  it("without a sandbox halt the row reads as before: no line, no request", async () => {
    const r = repo();
    await mountRow(r, { drain: drain(r, { reason: "cap", detail: null }) });
    await expect.element(page.getByText(ISSUE.title)).toBeVisible();
    expect(line()).toBeNull();
    expect(api.getEpicAutoFix).not.toHaveBeenCalled();
  });

  it("a halted epic says nothing starts, why, and offers Fix", async () => {
    const r = repo();
    await mountRow(r);
    await expect.element(page.getByText(m.epic_row_halt_lead())).toBeVisible();
    await expect.element(page.getByText(haltSummary(FALL_A.causes))).toBeVisible();
    await expect.element(fixButton()).toBeVisible();
    expect(api.getEpicAutoFix).toHaveBeenCalledWith(r, B);
  });

  it("names the drain's cause while the model can't be loaded, without Fix", async () => {
    api.getEpicAutoFix.mockRejectedValue(new Error("503"));
    await mountRow(repo());
    await expect
      .element(
        page.getByText(haltSummary([{ code: "sandbox_provider_unconfined", detail: "codex" }])),
      )
      .toBeVisible();
    expect(fixButton().query()).toBeNull();
  });

  it("desktop: Fix opens a non-modal popover; Esc closes it back onto Fix", async () => {
    const { onselect } = await mountRow(repo());
    await fixButton().click();
    const dialog = fixDialog();
    await expect.element(dialog).toBeVisible();
    expect(dialog.element().getAttribute("aria-modal")).toBeNull();
    expect(document.querySelector(".scrim")).toBeNull();
    expect(fixButton().element().getAttribute("aria-expanded")).toBe("true");
    // The chosen way has the focus; the row itself wasn't selected.
    await vi.waitFor(() =>
      expect((document.activeElement as HTMLInputElement).value).toBe("autonomous_claude"),
    );
    expect(onselect).not.toHaveBeenCalled();
    // Arrow keys move the choice, not the list.
    await userEvent.keyboard("{ArrowDown}");
    expect((document.activeElement as HTMLInputElement).value).toBe("trusted");

    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).not.toBeInTheDocument();
    expect(document.activeElement).toBe(fixButton().element());
  });

  it("desktop: Cancel and ✕ close back onto Fix; a press outside just closes", async () => {
    await mountRow(repo());
    await fixButton().click();
    await page.getByRole("button", { name: m.common_cancel() }).click();
    await expect.element(fixDialog()).not.toBeInTheDocument();
    await vi.waitFor(() => expect(document.activeElement).toBe(fixButton().element()));

    await fixButton().click();
    await page.getByRole("button", { name: m.common_close() }).click();
    await expect.element(fixDialog()).not.toBeInTheDocument();
    await vi.waitFor(() => expect(document.activeElement).toBe(fixButton().element()));

    const outside = document.createElement("button");
    outside.textContent = "outside";
    outside.style.cssText = "position: fixed; top: 0; right: 0";
    document.body.appendChild(outside);
    try {
      await fixButton().click();
      await expect.element(fixDialog()).toBeVisible();
      await userEvent.click(outside);
      await expect.element(fixDialog()).not.toBeInTheDocument();
    } finally {
      outside.remove();
    }
  });

  it("desktop: Apply fixes the halt and the line goes", async () => {
    api.applyEpicAutoFix.mockResolvedValueOnce({ previous: PREVIOUS, blockers: CLEAR });
    const r = repo();
    await mountRow(r);
    await fixButton().click();
    await page.getByRole("button", { name: m.epic_autofix_apply(), exact: true }).click();
    expect(api.applyEpicAutoFix).toHaveBeenCalledWith(r, B, { option: "autonomous_claude" });
    await vi.waitFor(() => expect(line()).toBeNull());
    expect(fixDialog().query()).toBeNull();
  });

  it("phone: a modal sheet over the scrim, touch-sized, full-width apply, no sideways scroll", async () => {
    await page.viewport(390, 844);
    await mountRow(repo(), { mobile: true });
    const fix = fixButton();
    await expect.element(fix).toBeVisible();
    expectMinPx(fix.element().getBoundingClientRect().height, 44, "Fix");
    await fix.click();
    const sheet = fixDialog();
    await expect.element(sheet).toBeVisible();
    expect(sheet.element().getAttribute("aria-modal")).toBe("true");
    const scrim = document.querySelector<HTMLElement>(".scrim");
    expect(scrim).not.toBeNull();
    expect(getComputedStyle(scrim!).backdropFilter).toContain("blur");

    const apply = page.getByRole("button", {
      name: m.epic_autofix_apply_start({ issues: issueList([21, 22]) }),
    });
    await expect.element(apply).toBeVisible();
    const box = sheet.element().getBoundingClientRect();
    const applyBox = apply.element().getBoundingClientRect();
    expect(applyBox.width).toBeGreaterThanOrEqual(box.width - 2 * 16 - 1);
    expectMinPx(applyBox.height, 44, "apply");
    const close = page.getByRole("button", { name: m.common_close() }).element();
    expectMinPx(close.getBoundingClientRect().height, 44, "close");
    expectMinPx(close.getBoundingClientRect().width, 44, "close");
    for (const label of sheet.element().querySelectorAll<HTMLElement>("label")) {
      expectMinPx(label.getBoundingClientRect().height, 44, label.textContent ?? "");
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);

    await page.getByRole("button", { name: m.common_close() }).click();
    await expect.element(sheet).not.toBeInTheDocument();
    expect(document.querySelector(".scrim")).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(fixButton().element()));
  });

  it("phone: Apply from the sheet starts the ready children and the line goes", async () => {
    await page.viewport(390, 844);
    api.applyEpicAutoFix.mockResolvedValueOnce({ previous: PREVIOUS, blockers: CLEAR });
    const r = repo();
    await mountRow(r, { mobile: true });
    await fixButton().click();
    await page
      .getByRole("button", { name: m.epic_autofix_apply_start({ issues: issueList([21, 22]) }) })
      .click();
    expect(api.applyEpicAutoFix).toHaveBeenCalledWith(r, B, { option: "autonomous_claude" });
    await vi.waitFor(() => expect(line()).toBeNull());
    expect(document.querySelector(".scrim")).toBeNull();
  });

  it("the popover and the run area share the pick and the applied fix", async () => {
    api.applyEpicAutoFix.mockResolvedValueOnce({ previous: PREVIOUS, blockers: CLEAR });
    const r = repo();
    const repoName = r.split("/").pop()!;
    const row = await mountRow(r);
    const run = await render(EpicRunControl, {
      repoPath: r,
      parent: B,
      epic: epic(r),
      drain: drain(r),
      titleFor: () => null,
    });
    const card = () => document.querySelector<HTMLElement>("[data-epic-halt-card]");
    const cardRadio = (id: string) =>
      card()?.querySelector<HTMLInputElement>(`input[value="${id}"]`);
    await vi.waitFor(() => expect(cardRadio("autonomous_claude")?.checked).toBe(true));

    await fixButton().click();
    const trusted = fixDialog()
      .element()
      .querySelector<HTMLInputElement>('input[value="trusted"]')!;
    await userEvent.click(trusted);
    await vi.waitFor(() => expect(cardRadio("trusted")?.checked).toBe(true));

    await page.getByRole("button", { name: m.epic_autofix_apply(), exact: true }).click();
    expect(api.applyEpicAutoFix).toHaveBeenCalledWith(r, B, { option: "trusted" });
    await vi.waitFor(() => expect(line()).toBeNull());
    const done = m.epic_autofix_done_sandbox({
      repo: repoName,
      profile: m.epic_autofix_profile_trusted(),
    });
    await expect.element(page.getByText(done)).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: m.epic_autofix_undo() })).toBeVisible();

    // The drain starts the children: the run area reads "running", the row stays clear.
    const running = drain(r, { reason: null, detail: null, paused: false });
    await row.rerender({ drain: running });
    await run.rerender({ drain: running });
    await expect.element(page.getByText(m.epic_run_state_running())).toBeInTheDocument();
    expect(line()).toBeNull();
  });

  for (const theme of ["light", "dark"] as const) {
    it(`keeps the halt line's text at AA contrast: ${theme}`, async () => {
      document.documentElement.dataset.theme = theme;
      try {
        await mountRow(repo());
        await expect.element(fixButton()).toBeVisible();
        for (const sel of [".lead", ".text", ".fix"]) {
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
});
