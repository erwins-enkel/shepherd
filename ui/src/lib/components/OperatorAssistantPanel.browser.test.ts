import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ComponentProps } from "svelte";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import { m } from "#lib/paraglide/messages.js";
import type { Session } from "#lib/types.js";
import type { connectPty } from "#lib/pty.js";

// The live state mounts a real assistant Viewport; give it a fake PTY like the Viewport tests do.
const ptyIds: string[] = [];
vi.mock("#lib/pty.js", () => ({
  connectPty: vi.fn((...args: Parameters<typeof connectPty>) => {
    ptyIds.push(args[0]);
    return { send: vi.fn(), resize: vi.fn(), close: vi.fn(), poke: vi.fn(), takeover: vi.fn() };
  }),
}));
const { default: OperatorAssistantPanel } = await import("./OperatorAssistantPanel.svelte");
type Props = ComponentProps<typeof OperatorAssistantPanel>;

const assistantRow = {
  id: "oa",
  desig: "TASK-90",
  name: "operator assistant",
  prompt: "",
  repoPath: "/home/op/.shepherd/assistant",
  baseBranch: "",
  branch: null,
  worktreePath: "/home/op/.shepherd/assistant",
  isolated: false,
  herdrSession: "h",
  herdrAgentId: "ha",
  claudeSessionId: "cs",
  model: "claude-opus-5-5",
  status: "idle",
  operatorAssistant: true,
  manualSteps: [],
  archivedAt: null,
} as unknown as Session;

const READ_ONLY = {
  shell: "read",
  steer: "off",
  sessions: "off",
  approve: "off",
  automation: "off",
} as const;

function props(over: Partial<Props> = {}): Props {
  return {
    session: null,
    available: true,
    reason: null,
    pending: null,
    failed: null,
    onretry: vi.fn(),
    onresume: vi.fn(async () => {}),
    onreset: vi.fn(),
    onclose: vi.fn(),
    ondiagnose: vi.fn(),
    ...over,
  };
}

async function mount(over: Partial<Props> = {}) {
  const target = document.createElement("div");
  target.style.cssText = "height: 640px; width: 420px; display: flex; flex-direction: column";
  document.body.append(target);
  const all = props(over);
  const view = await render(OperatorAssistantPanel, { target, props: all });
  return { ...view, props: all };
}

beforeEach(async () => {
  ptyIds.length = 0;
  await page.viewport(1280, 900);
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("OperatorAssistantPanel", () => {
  it("is a labelled, non-modal landmark the page never reads as an overlay", async () => {
    const { container } = await mount();
    const aside = page.getByRole("complementary", { name: m.operator_assistant_title() });
    await expect.element(aside).toBeInTheDocument();
    expect(aside.element().getAttribute("aria-modal")).toBeNull();
    expect(container.querySelector(".overlay, .drawer, .scrim")).toBeNull();
  });

  it("shows the spawning state while the first ensure is in flight", async () => {
    await mount({ pending: "ensure" });
    await expect.element(page.getByText(m.operator_assistant_spawning())).toBeInTheDocument();
    expect(ptyIds).toEqual([]);
  });

  it.each([
    ["claude_missing", m.operator_assistant_unavailable_claude_missing()],
    ["herdr_unreachable", m.operator_assistant_unavailable_herdr_unreachable()],
  ] as const)("explains the %s reason and offers Diagnose and a re-check", async (reason, copy) => {
    const ondiagnose = vi.fn();
    const onretry = vi.fn();
    await mount({ available: false, reason, ondiagnose, onretry });
    await expect.element(page.getByText(m.operator_assistant_unavailable_title())).toBeVisible();
    await expect.element(page.getByText(copy)).toBeVisible();
    await page.getByRole("button", { name: m.operator_assistant_open_diagnose() }).click();
    expect(ondiagnose).toHaveBeenCalledOnce();
    await page.getByRole("button", { name: m.operator_assistant_check_again() }).click();
    expect(onretry).toHaveBeenCalledOnce();
  });

  it("falls back to generic copy without a reason (the demo), with Diagnose but no re-check", async () => {
    await mount({ available: false, reason: null });
    await expect.element(page.getByText(m.operator_assistant_unavailable_generic())).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: m.operator_assistant_open_diagnose() }))
      .toBeVisible();
    expect(
      page.getByRole("button", { name: m.operator_assistant_check_again() }).query(),
    ).toBeNull();
  });

  it("reports a failed ensure or reset with a Retry", async () => {
    const onretry = vi.fn();
    const view = await mount({ failed: "ensure", onretry });
    const alert = page.getByRole("alert");
    await expect.element(alert.getByText(m.operator_assistant_error_ensure())).toBeVisible();
    await page.getByRole("button", { name: m.common_retry() }).click();
    expect(onretry).toHaveBeenCalledOnce();

    await view.rerender({ ...view.props, session: assistantRow, failed: "reset" });
    await expect.element(alert.getByText(m.operator_assistant_error_reset())).toBeVisible();
  });

  it("renders the assistant terminal once live, with the mode chip and the model badge", async () => {
    const { container } = await mount({ session: assistantRow, permissions: READ_ONLY });
    await vi.waitFor(() => expect(ptyIds).toEqual(["oa"]));
    expect(container.querySelector(".term-mount")).not.toBeNull();
    // the assistant variant: no session-console header or tab bar
    expect(container.querySelector(".vp-head")).toBeNull();
    expect(container.querySelector("[role=tablist]")).toBeNull();
    await expect.element(page.getByText(m.operator_assistant_readonly())).toBeVisible();
    await expect.element(page.getByText(m.model_label_opus_5_5())).toBeVisible();
  });

  it("the mode chip names what Settings → Assistant allows and opens that section", async () => {
    const onpermissions = vi.fn();
    const view = await mount({
      session: assistantRow,
      permissions: { ...READ_ONLY, steer: "ask" },
      onpermissions,
    });
    const chip = page.getByRole("button", { name: m.operator_assistant_mode_asks() });
    await chip.click();
    expect(onpermissions).toHaveBeenCalledOnce();

    await view.rerender({ ...view.props, permissions: { ...READ_ONLY, approve: "allow" } });
    await expect
      .element(page.getByRole("button", { name: m.operator_assistant_mode_acts() }))
      .toBeVisible();
  });

  it("shows no mode chip before the permissions are known", async () => {
    await mount({ session: assistantRow });
    await vi.waitFor(() => expect(ptyIds).toContain("oa"));
    expect(page.getByText(m.operator_assistant_readonly()).query()).toBeNull();
  });

  it("New conversation needs a second click to reset, and disarms on its own", async () => {
    vi.useFakeTimers();
    const onreset = vi.fn();
    await mount({ session: assistantRow, onreset });
    await page.getByRole("button", { name: m.operator_assistant_new() }).click();
    expect(onreset).not.toHaveBeenCalled();
    const confirm = page.getByRole("button", { name: m.operator_assistant_new_confirm() });
    await expect.element(confirm).toBeInTheDocument();

    vi.advanceTimersByTime(3500);
    await expect
      .element(page.getByRole("button", { name: m.operator_assistant_new() }))
      .toBeInTheDocument();
    expect(onreset).not.toHaveBeenCalled();

    await page.getByRole("button", { name: m.operator_assistant_new() }).click();
    await page.getByRole("button", { name: m.operator_assistant_new_confirm() }).click();
    expect(onreset).toHaveBeenCalledOnce();
  });

  it("offers New conversation only while a conversation is live", async () => {
    await mount({ pending: "ensure" });
    await expect
      .element(page.getByRole("button", { name: m.operator_assistant_new() }))
      .toBeDisabled();
  });

  it("closes from the header on desktop", async () => {
    const onclose = vi.fn();
    await mount({ onclose });
    expect(page.getByRole("button", { name: m.operator_assistant_back() }).query()).toBeNull();
    await page.getByRole("button", { name: m.operator_assistant_close() }).click();
    expect(onclose).toHaveBeenCalledOnce();
  });

  it("goes Back from the header on a phone, with thumb-sized controls", async () => {
    await page.viewport(390, 844);
    const onclose = vi.fn();
    await mount({ mobile: true, onclose, available: false, reason: "herdr_unreachable" });
    expect(page.getByRole("button", { name: m.operator_assistant_close() }).query()).toBeNull();
    const back = page.getByRole("button", { name: m.operator_assistant_back() });
    const box = back.element().getBoundingClientRect();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    for (const name of [m.operator_assistant_open_diagnose(), m.operator_assistant_new()]) {
      expect(
        page.getByRole("button", { name }).element().getBoundingClientRect().height,
      ).toBeGreaterThanOrEqual(44);
    }
    await back.click();
    expect(onclose).toHaveBeenCalledOnce();
  });
});

describe("OperatorAssistantPanel as a repo assistant", () => {
  const REPO = "/home/op/src/shepherd";
  const repoRow = { ...assistantRow, id: "oa-r", assistantRepo: REPO } as Session;

  it("is named for its repo and says what it sees", async () => {
    await mount({ repo: REPO, stacked: true, session: repoRow });
    await expect
      .element(
        page.getByRole("complementary", {
          name: m.operator_assistant_repo_aria({ repo: "shepherd" }),
        }),
      )
      .toBeInTheDocument();
    await expect.element(page.getByRole("heading", { name: "shepherd" })).toBeVisible();
    await expect.element(page.getByText(m.operator_assistant_repo_kind())).toBeVisible();
    await expect
      .element(page.getByText(m.operator_assistant_scope_badge({ repo: "shepherd" })))
      .toBeVisible();
  });

  it("leaves Close to the dock's strip when stacked", async () => {
    await mount({ stacked: true, session: assistantRow });
    expect(page.getByRole("button", { name: m.operator_assistant_close() }).query()).toBeNull();
    await expect.element(page.getByText(m.assistant_dock_all_repos())).toBeVisible();
  });

  it("End needs a second click, and only a repo assistant offers it", async () => {
    const onend = vi.fn();
    await mount({ repo: REPO, stacked: true, session: repoRow, onend });
    await page.getByRole("button", { name: m.operator_assistant_end() }).click();
    expect(onend).not.toHaveBeenCalled();
    await page.getByRole("button", { name: m.operator_assistant_end_confirm() }).click();
    expect(onend).toHaveBeenCalledOnce();
  });

  it("the global assistant has no End", async () => {
    await mount({ stacked: true, session: assistantRow, onend: vi.fn() });
    expect(page.getByRole("button", { name: m.operator_assistant_end() }).query()).toBeNull();
  });

  it("reports a failed end", async () => {
    await mount({ repo: REPO, stacked: true, session: repoRow, failed: "close" });
    await expect.element(page.getByText(m.operator_assistant_error_close())).toBeVisible();
  });
});
