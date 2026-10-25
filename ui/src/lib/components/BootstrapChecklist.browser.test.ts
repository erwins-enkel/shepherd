import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import BootstrapChecklist from "./BootstrapChecklist.svelte";
import { m } from "#lib/paraglide/messages.js";
import type { RepoBootstrapView } from "#lib/api.js";

const ACTIVE: RepoBootstrapView = {
  state: "active",
  phase: 1,
  overrideAt: null,
  missing: ["P1", "P2", "P3", "P4"],
  suggested: false,
  next: { kind: "bootstrap", phase: 1, sessionId: null },
};

function mockApi(view: RepoBootstrapView) {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response(JSON.stringify(view), { status: 200 }),
  );
}

afterEach(() => vi.restoreAllMocks());

describe("BootstrapChecklist (#3112)", () => {
  it("shows the current phase and starts the bootstrap step with one click", async () => {
    mockApi(ACTIVE);
    const onbootstrapstep = vi.fn();
    render(BootstrapChecklist, { repoPath: "/repo-p1", onbootstrapstep });
    await expect.element(page.getByText(m.bootstrap_checklist_next_scaffold())).toBeVisible();
    const current = page
      .getByRole("listitem")
      .filter({ hasText: m.bootstrap_checklist_step_scaffold() });
    await expect.element(current).toHaveAttribute("aria-current", "step");
    await page.getByRole("button", { name: m.bootstrap_checklist_start_scaffold() }).click();
    expect(onbootstrapstep).toHaveBeenCalledWith("/repo-p1", "scaffold", false);
  });

  it("P4 drafts the epic; a running session is opened instead", async () => {
    mockApi({ ...ACTIVE, phase: 4, next: { kind: "epic", phase: 4, sessionId: null } });
    const onbootstrapstep = vi.fn();
    render(BootstrapChecklist, { repoPath: "/repo-p4", onbootstrapstep });
    await page.getByRole("button", { name: m.bootstrap_checklist_start_epic() }).click();
    expect(onbootstrapstep).toHaveBeenCalledWith("/repo-p4", "epic", false);
  });

  it("P3 starts the gap sweep", async () => {
    mockApi({ ...ACTIVE, phase: 3, next: { kind: "bootstrap", phase: 3, sessionId: null } });
    const onbootstrapstep = vi.fn();
    render(BootstrapChecklist, { repoPath: "/repo-p3-gaps", onbootstrapstep });
    await page.getByRole("button", { name: m.bootstrap_checklist_start_gaps() }).click();
    expect(onbootstrapstep).toHaveBeenCalledWith("/repo-p3-gaps", "gaps", false);
  });

  it("opens a running session", async () => {
    mockApi({ ...ACTIVE, phase: 3, next: { kind: "bootstrap", phase: 3, sessionId: "s-9" } });
    const onopensession = vi.fn();
    render(BootstrapChecklist, { repoPath: "/repo-p3", onopensession });
    await page.getByRole("button", { name: m.bootstrap_checklist_open_session() }).click();
    expect(onopensession).toHaveBeenCalledWith("s-9");
    await expect
      .element(page.getByRole("button", { name: m.bootstrap_checklist_adjust() }))
      .not.toBeInTheDocument();
  });

  // #3421: the primary button starts the step (adjust=false, asserted above); "Adjust first" opens
  // the seeded composer without starting.
  it.each([
    {
      path: "/repo-adjust-p1",
      view: ACTIVE,
      start: m.bootstrap_checklist_start_scaffold(),
      kind: "scaffold",
    },
    {
      path: "/repo-adjust-p3",
      view: { ...ACTIVE, phase: 3, next: { kind: "bootstrap", phase: 3, sessionId: null } },
      start: m.bootstrap_checklist_start_gaps(),
      kind: "gaps",
    },
    {
      path: "/repo-adjust-p4",
      view: { ...ACTIVE, phase: 4, next: { kind: "epic", phase: 4, sessionId: null } },
      start: m.bootstrap_checklist_start_epic(),
      kind: "epic",
    },
    {
      path: "/repo-adjust-ci",
      view: { ...ACTIVE, ciHold: "failed" },
      start: m.bootstrap_checklist_start_fixci(),
      kind: "fix-ci",
    },
  ] satisfies { path: string; view: RepoBootstrapView; start: string; kind: string }[])(
    "Adjust first opens the $kind step without starting it",
    async ({ path, view, start, kind }) => {
      mockApi(view);
      const onbootstrapstep = vi.fn();
      render(BootstrapChecklist, { repoPath: path, onbootstrapstep });
      await expect.element(page.getByRole("button", { name: start })).toBeVisible();
      await page.getByRole("button", { name: m.bootstrap_checklist_adjust() }).click();
      expect(onbootstrapstep).toHaveBeenCalledExactlyOnceWith(path, kind, true);
    },
  );

  it("a held merge waiting on CI shows the note, no button — even with the session live (#3411)", async () => {
    mockApi({
      ...ACTIVE,
      ciHold: "waiting",
      next: { kind: "bootstrap", phase: 1, sessionId: "s-1" },
    });
    render(BootstrapChecklist, { repoPath: "/repo-ci-wait" });
    await expect.element(page.getByText(m.bootstrap_checklist_next_ci_waiting())).toBeVisible();
    await expect
      .element(page.getByText(m.bootstrap_checklist_next_running()))
      .not.toBeInTheDocument();
    for (const name of [
      m.bootstrap_checklist_open_session(),
      m.bootstrap_checklist_start_scaffold(),
      m.bootstrap_checklist_start_fixci(),
      m.bootstrap_checklist_adjust(),
    ])
      await expect.element(page.getByRole("button", { name })).not.toBeInTheDocument();
  });

  it("failed CI after the merge offers a fix session — even with the session live (#3411)", async () => {
    mockApi({
      ...ACTIVE,
      ciHold: "failed",
      next: { kind: "bootstrap", phase: 1, sessionId: "s-1" },
    });
    const onbootstrapstep = vi.fn();
    render(BootstrapChecklist, { repoPath: "/repo-ci-red", onbootstrapstep });
    await expect.element(page.getByText(m.bootstrap_checklist_next_ci_failed())).toBeVisible();
    await expect
      .element(page.getByText(m.bootstrap_checklist_next_running()))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: m.bootstrap_checklist_start_fixci() }).click();
    expect(onbootstrapstep).toHaveBeenCalledWith("/repo-ci-red", "fix-ci", false);
  });

  it("renders nothing for a repo that is not bootstrapping", async () => {
    mockApi({ ...ACTIVE, state: "off", next: null });
    render(BootstrapChecklist, { repoPath: "/repo-off" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await expect
      .element(page.getByRole("region", { name: m.bootstrap_checklist_title() }))
      .not.toBeInTheDocument();
  });
});
