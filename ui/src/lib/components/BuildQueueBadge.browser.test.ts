import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { BuildQueue, BuildStep, BuildStepStatus, GitState, Session } from "$lib/types";
import { m } from "$lib/paraglide/messages";

const { default: BuildQueueBadge } = await import("./BuildQueueBadge.svelte");
const { buildQueues } = await import("$lib/buildQueues.svelte");
const { buildQueueCollapse } = await import("$lib/build-queue-collapse.svelte");

type BadgeProps = {
  sessionId: string;
  planPhase: Session["planPhase"];
  git?: GitState;
  tip?: boolean;
  selected?: boolean;
  onselect?: (id: string) => void;
};

function renderBadge(props: BadgeProps) {
  return render(BuildQueueBadge, {
    selected: true,
    onselect: () => {},
    ...props,
  });
}

const step = (status: BuildStepStatus, id: string): BuildStep => ({
  id,
  title: `Step ${id}`,
  status,
  position: parseInt(id),
});

const queue = (approved: boolean, steps: BuildStep[], sessionId = "s1"): BuildQueue => ({
  sessionId,
  approved,
  steps,
});

// Minimal GitState literal — only `state` matters for the drift predicate;
// the rest are required fields filled with harmless placeholders.
const git = (state: GitState["state"]): GitState => ({
  kind: "github",
  state,
  checks: "none",
  deployConfigured: false,
});

beforeEach(() => {
  buildQueues.map = {};
  buildQueueCollapse.set(false);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("BuildQueueBadge", () => {
  it("renders progress when queue is unapproved (approved=false) with pending steps", async () => {
    buildQueues.map = {
      s1: queue(false, [step("pending", "1"), step("pending", "2")]),
    };
    renderBadge({ sessionId: "s1", planPhase: "executing" });
    await expect.element(page.getByText("0/2")).toBeInTheDocument();
  });

  it("renders nothing when there is no queue for the session", async () => {
    renderBadge({ sessionId: "s1", planPhase: "executing" });
    expect(document.querySelector(".queue-badge")).toBeNull();
  });

  it("renders nothing when approved but steps array is empty", async () => {
    buildQueues.map = {
      s1: queue(true, []),
    };
    renderBadge({ sessionId: "s1", planPhase: "executing" });
    expect(document.querySelector(".queue-badge")).toBeNull();
  });

  it("shows resolved/total — done+skipped count as resolved, pending does not", async () => {
    // 3 done + 1 skipped + 1 pending of 5 → resolved=4, total=5 → "4/5"
    buildQueues.map = {
      s1: queue(true, [
        step("done", "1"),
        step("done", "2"),
        step("done", "3"),
        step("skipped", "4"),
        step("pending", "5"),
      ]),
    };
    renderBadge({ sessionId: "s1", planPhase: "executing" });
    await expect.element(page.getByText("4/5")).toBeInTheDocument();
  });

  it("background fill reflects resolved/total via --queue-pct", async () => {
    // 4/5 = 80%
    buildQueues.map = {
      s1: queue(true, [
        step("done", "1"),
        step("done", "2"),
        step("done", "3"),
        step("skipped", "4"),
        step("pending", "5"),
      ]),
    };
    renderBadge({ sessionId: "s1", planPhase: "executing" });
    const badge = document.querySelector(".queue-badge") as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.style.getPropertyValue("--queue-pct")).toBe("80%");
  });

  it("all resolved (all done) → shows 5/5 with 100% fill", async () => {
    buildQueues.map = {
      s1: queue(true, [
        step("done", "1"),
        step("done", "2"),
        step("done", "3"),
        step("done", "4"),
        step("done", "5"),
      ]),
    };
    renderBadge({ sessionId: "s1", planPhase: "executing" });
    await expect.element(page.getByText("5/5")).toBeInTheDocument();
    const badge = document.querySelector(".queue-badge") as HTMLElement;
    expect(badge.style.getPropertyValue("--queue-pct")).toBe("100%");
  });

  it("all resolved via mix of done+skipped → shows 5/5", async () => {
    buildQueues.map = {
      s1: queue(true, [
        step("done", "1"),
        step("done", "2"),
        step("skipped", "3"),
        step("skipped", "4"),
        step("done", "5"),
      ]),
    };
    renderBadge({ sessionId: "s1", planPhase: "executing" });
    await expect.element(page.getByText("5/5")).toBeInTheDocument();
  });

  it("selected badge toggles the queue while the styled tooltip is enabled", async () => {
    buildQueues.map = {
      s1: queue(true, [step("done", "1"), step("pending", "2")]),
    };
    const onselect = vi.fn();
    const toggle = vi.spyOn(buildQueueCollapse, "toggle");
    renderBadge({
      sessionId: "s1",
      planPhase: "executing",
      selected: true,
      onselect,
      tip: true,
    });

    const progressAria = m.queuebadge_aria({ resolved: 1, total: 2 });
    const collapseName = `${m.buildqueue_collapse_aria()}. ${progressAria}`;
    const expandName = `${m.buildqueue_expand_aria()}. ${progressAria}`;

    const expandedButton = page.getByRole("button", { name: collapseName });
    await expect.element(expandedButton).toHaveAttribute("aria-expanded", "true");
    await expect.element(expandedButton).toHaveAttribute("aria-controls", "bqp-content-s1");
    await expandedButton.click();
    expect(toggle).toHaveBeenCalledOnce();
    expect(buildQueueCollapse.collapsed).toBe(true);

    const collapsedButton = page.getByRole("button", { name: expandName });
    await expect.element(collapsedButton).toHaveAttribute("aria-expanded", "false");
    await collapsedButton.click();
    expect(buildQueueCollapse.collapsed).toBe(false);
    expect(onselect).not.toHaveBeenCalled();
  });

  it("unselected badge selects its session and forces the queue open", async () => {
    buildQueues.map = {
      s1: queue(true, [step("done", "1"), step("pending", "2")]),
    };
    buildQueueCollapse.set(true);
    const onselect = vi.fn();
    renderBadge({ sessionId: "s1", planPhase: "executing", selected: false, onselect });

    const name = `${m.buildqueue_expand_aria()}. ${m.queuebadge_aria({ resolved: 1, total: 2 })}`;
    const button = page.getByRole("button", { name });
    await expect.element(button).not.toHaveAttribute("aria-controls");
    await button.click();

    expect(onselect).toHaveBeenCalledOnce();
    expect(onselect).toHaveBeenCalledWith("s1");
    expect(buildQueueCollapse.collapsed).toBe(false);
  });
});

describe("BuildQueueBadge — drifted (working but unreported)", () => {
  const allPending = [step("pending", "1"), step("pending", "2"), step("pending", "3")];

  const expectDrifted = async () => {
    await expect.element(page.getByText("⚠ 3")).toBeInTheDocument();
    expect(document.querySelector(".queue-badge--stale")).not.toBeNull();
  };

  const expectNotDrifted = async () => {
    expect(document.querySelector(".queue-badge--stale")).toBeNull();
    expect(document.querySelector(".queue-badge")).not.toBeNull();
  };

  it("executing + no git + all pending → drifted (git not consulted)", async () => {
    buildQueues.map = { s1: queue(true, allPending) };
    renderBadge({ sessionId: "s1", planPhase: "executing" });
    await expectDrifted();
  });

  it("drifted badge uses the same toggle interaction", async () => {
    buildQueues.map = { s1: queue(true, allPending) };
    renderBadge({ sessionId: "s1", planPhase: "executing", selected: true });

    const name = `${m.buildqueue_collapse_aria()}. ${m.queuebadge_stale_aria({ total: 3 })}`;
    await page.getByRole("button", { name }).click();

    expect(buildQueueCollapse.collapsed).toBe(true);
  });

  it("planPhase null (gate off) + no git + all pending → drifted", async () => {
    buildQueues.map = { s1: queue(true, allPending) };
    renderBadge({ sessionId: "s1", planPhase: null });
    await expectDrifted();
  });

  it("planning + open PR + all pending → drifted", async () => {
    buildQueues.map = { s1: queue(true, allPending) };
    renderBadge({ sessionId: "s1", planPhase: "planning", git: git("open") });
    await expectDrifted();
  });

  it("planning + merged PR + all pending → NOT drifted (resolved PR)", async () => {
    buildQueues.map = { s1: queue(true, allPending) };
    renderBadge({ sessionId: "s1", planPhase: "planning", git: git("merged") });
    await expectNotDrifted();
  });

  it("planning + closed PR + all pending → NOT drifted", async () => {
    buildQueues.map = { s1: queue(true, allPending) };
    renderBadge({ sessionId: "s1", planPhase: "planning", git: git("closed") });
    await expectNotDrifted();
  });

  it("planning + no git + all pending → NOT drifted (degrade closed)", async () => {
    buildQueues.map = { s1: queue(true, allPending) };
    renderBadge({ sessionId: "s1", planPhase: "planning" });
    await expectNotDrifted();
  });

  it('planning + git state "none" + all pending → NOT drifted', async () => {
    buildQueues.map = { s1: queue(true, allPending) };
    renderBadge({ sessionId: "s1", planPhase: "planning", git: git("none") });
    await expectNotDrifted();
  });

  it("executing + no git + one active, rest pending → NOT drifted (has active)", async () => {
    buildQueues.map = {
      s1: queue(true, [step("active", "1"), step("pending", "2"), step("pending", "3")]),
    };
    renderBadge({ sessionId: "s1", planPhase: "executing" });
    await expectNotDrifted();
  });

  it("executing + no git + one done, rest pending → NOT drifted (normal progress)", async () => {
    buildQueues.map = {
      s1: queue(true, [step("done", "1"), step("pending", "2"), step("pending", "3")]),
    };
    renderBadge({ sessionId: "s1", planPhase: "executing" });
    await expectNotDrifted();
    await expect.element(page.getByText("1/3")).toBeInTheDocument();
  });

  it("clears automatically once a step becomes active", async () => {
    buildQueues.map = { s1: queue(true, allPending) };
    renderBadge({ sessionId: "s1", planPhase: "executing" });
    await expectDrifted();

    buildQueues.map = {
      s1: queue(true, [step("active", "1"), step("pending", "2"), step("pending", "3")]),
    };
    // Reactivity is async (Svelte flushes on a microtask) — poll for the
    // resolved/total label rather than asserting synchronously.
    await expect.element(page.getByText("0/3")).toBeInTheDocument();
    expect(document.querySelector(".queue-badge--stale")).toBeNull();
  });
});
