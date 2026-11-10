import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import EpicGroupMenu from "./EpicGroupMenu.svelte";
import type { DrainRunSummary, DrainStatus, Epic, EpicChild } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";
import { toasts } from "#lib/toasts.svelte.js";

const api = vi.hoisted(() => ({
  updateEpic: vi.fn(async () => ({})),
  approveEpicNext: vi.fn(async () => ({})),
  unqueueEpic: vi.fn(async () => ({})),
}));

vi.mock("#lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#lib/api.js")>();
  return { ...actual, ...api };
});

const REPO = "/repo/a";
const child = (number: number, url = `https://github.com/o/r/issues/${number}`): EpicChild => ({
  number,
  title: `child ${number}`,
  url,
  order: number,
  body: "",
  blockedBy: [],
  state: "ready",
  sessionId: null,
  prNumber: null,
  issueClosed: false,
  claimed: false,
});
const epic = (run: Partial<Epic["run"]> = {}): Epic => ({
  repoPath: REPO,
  parentIssueNumber: 10,
  parentTitle: "Epic 10",
  source: "native",
  children: [child(11)],
  warnings: [],
  run: { repoPath: REPO, parentIssueNumber: 10, mode: "auto", status: "running", ...run },
});
const summary = (over: Partial<DrainRunSummary> = {}): DrainRunSummary => ({
  leadingEpic: 10,
  windingDown: [],
  slots: { used: 0, max: 1, holders: [] },
  next: [],
  after: [],
  ...over,
});
const drain = (over: Partial<DrainStatus> = {}): DrainStatus => ({
  repoPath: REPO,
  enabled: true,
  paused: false,
  reason: null,
  detail: null,
  queued: 0,
  inFlight: 0,
  max: 1,
  epicParent: 10,
  runSummary: summary(),
  ...over,
});

let opener: HTMLButtonElement;
beforeEach(() => {
  vi.clearAllMocks();
  opener = document.createElement("button");
  opener.textContent = "opener";
  document.body.appendChild(opener);
});
afterEach(() => {
  opener.remove();
  document.body.innerHTML = "";
});

const props = (extra: Record<string, unknown> = {}) => ({
  epic: epic(),
  drain: drain(),
  x: 10,
  y: 10,
  opener,
  ondiagnose: vi.fn(),
  onclose: vi.fn(),
  ...extra,
});
const item = (name: string) => page.getByRole("menuitem", { name, exact: true });

describe("EpicGroupMenu", () => {
  it("running: pauses in one click and offers no start", async () => {
    const p = props();
    render(EpicGroupMenu, p);
    await expect.element(page.getByRole("menu", { name: m.epicmenu_label() })).toBeVisible();
    expect(item(m.epic_start()).query()).toBeNull();
    expect(item(m.epicmenu_resume()).query()).toBeNull();
    await item(m.epic_pause()).click();
    expect(api.updateEpic).toHaveBeenCalledWith(REPO, 10, { status: "paused" });
    expect(p.onclose).toHaveBeenCalled();
  });

  it("paused: resume takes a second click", async () => {
    render(EpicGroupMenu, props({ epic: epic({ status: "paused" }) }));
    await item(m.epicmenu_resume()).click();
    expect(api.updateEpic).not.toHaveBeenCalled();
    await item(m.hold_cta_epic_resume_arm()).click();
    expect(api.updateEpic).toHaveBeenCalledWith(REPO, 10, { status: "running" });
  });

  it("stop takes a second click and names the queued epic that follows", async () => {
    render(EpicGroupMenu, props({ drain: drain({ runSummary: summary({ queued: [30] }) }) }));
    const stop = item(m.epic_stop());
    await expect.element(stop).toHaveAttribute("title", m.epic_stop_promotes_title({ epic: 30 }));
    await stop.click();
    expect(api.updateEpic).not.toHaveBeenCalled();
    await item(m.epicmenu_stop_confirm()).click();
    expect(api.updateEpic).toHaveBeenCalledWith(REPO, 10, { status: "idle" });
  });

  it("approves the next child while an attended run waits", async () => {
    render(
      EpicGroupMenu,
      props({ epic: epic({ mode: "attended" }), drain: drain({ reason: "awaiting_approval" }) }),
    );
    await expect
      .element(page.getByRole("menuitemcheckbox", { name: m.epicmenu_attended() }))
      .toHaveAttribute("aria-checked", "true");
    await item(m.epic_approve_next()).click();
    expect(api.approveEpicNext).toHaveBeenCalledWith(REPO, 10);
  });

  it("toggles the mode in one click", async () => {
    render(EpicGroupMenu, props());
    await page.getByRole("menuitemcheckbox", { name: m.epicmenu_attended() }).click();
    expect(api.updateEpic).toHaveBeenCalledWith(REPO, 10, { mode: "attended" });
  });

  it("queued: unqueues instead of starting or stopping", async () => {
    const queued = drain({
      epicParent: 20,
      runSummary: summary({ leadingEpic: 20, queued: [10] }),
    });
    render(EpicGroupMenu, props({ epic: epic({ status: "idle" }), drain: queued }));
    expect(item(m.epic_start()).query()).toBeNull();
    expect(item(m.epic_stop()).query()).toBeNull();
    await item(m.epic_unqueue()).click();
    expect(api.unqueueEpic).toHaveBeenCalledWith(REPO, 10);
  });

  it("hands details, the assistant and diagnosis to the host, and opens the issue", async () => {
    const onopen = vi.fn();
    const onask = vi.fn();
    const ondiagnose = vi.fn();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { rerender } = await render(EpicGroupMenu, props({ onopen, onask, ondiagnose }));
    await item(m.epic_sessionless_open()).click();
    expect(onopen).toHaveBeenCalledOnce();
    await item(m.operator_assistant_ask()).click();
    expect(onask).toHaveBeenCalledOnce();
    await item(m.epic_diag_open()).click();
    expect(ondiagnose).toHaveBeenCalledOnce();
    await item(m.issuemenu_open()).click();
    expect(open).toHaveBeenCalledWith(
      "https://github.com/o/r/issues/10",
      "_blank",
      "noopener,noreferrer",
    );
    open.mockRestore();
    // without hosts for details/assistant those items stay away
    await rerender(props({ onopen: undefined, onask: undefined }));
    expect(item(m.epic_sessionless_open()).query()).toBeNull();
    expect(item(m.operator_assistant_ask()).query()).toBeNull();
  });

  it("a failed request surfaces as a toast", async () => {
    api.updateEpic.mockRejectedValueOnce(new Error("offline"));
    const info = vi.spyOn(toasts, "info");
    render(EpicGroupMenu, props());
    await item(m.epic_pause()).click();
    await vi.waitFor(() =>
      expect(info).toHaveBeenCalledWith(m.epic_update_failed(), expect.anything()),
    );
    info.mockRestore();
  });

  it("closes on Escape and moves focus with the arrow keys", async () => {
    const p = props();
    render(EpicGroupMenu, p);
    await expect.element(item(m.epic_pause())).toHaveFocus();
    await userEventKey("ArrowDown");
    await expect.element(item(m.epic_diag_open())).toHaveFocus();
    await userEventKey("Escape");
    expect(p.onclose).toHaveBeenCalled();
  });
});

async function userEventKey(key: string) {
  const { userEvent } = await import("vitest/browser");
  await userEvent.keyboard(`{${key}}`);
}
