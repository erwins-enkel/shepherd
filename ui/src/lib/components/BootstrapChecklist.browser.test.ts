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
    expect(onbootstrapstep).toHaveBeenCalledWith("/repo-p1", "bootstrap");
  });

  it("P4 drafts the epic; a running session is opened instead", async () => {
    mockApi({ ...ACTIVE, phase: 4, next: { kind: "epic", phase: 4, sessionId: null } });
    const onbootstrapstep = vi.fn();
    render(BootstrapChecklist, { repoPath: "/repo-p4", onbootstrapstep });
    await page.getByRole("button", { name: m.bootstrap_checklist_start_epic() }).click();
    expect(onbootstrapstep).toHaveBeenCalledWith("/repo-p4", "epic");
  });

  it("opens a running session", async () => {
    mockApi({ ...ACTIVE, phase: 3, next: { kind: "bootstrap", phase: 3, sessionId: "s-9" } });
    const onopensession = vi.fn();
    render(BootstrapChecklist, { repoPath: "/repo-p3", onopensession });
    await page.getByRole("button", { name: m.bootstrap_checklist_open_session() }).click();
    expect(onopensession).toHaveBeenCalledWith("s-9");
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
