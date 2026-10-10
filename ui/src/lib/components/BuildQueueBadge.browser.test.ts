import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { BuildQueue, BuildStep, BuildStepStatus, GitState, Session } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";

const { default: BuildQueueBadge } = await import("./BuildQueueBadge.svelte");
const { buildQueues } = await import("#lib/buildQueues.svelte.js");
const { buildQueueCollapse } = await import("#lib/build-queue-collapse.svelte.js");

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

  it("meter lights one cell per resolved step", async () => {
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
    expect(document.querySelectorAll(".queue-cells i")).toHaveLength(5);
    expect(document.querySelectorAll(".queue-cells i.on")).toHaveLength(4);
  });

  it("all resolved (all done) → shows 5/5 with every cell lit", async () => {
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
    expect(document.querySelectorAll(".queue-cells i.on")).toHaveLength(5);
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

  it("past a dozen steps the cells give way to one proportional bar", async () => {
    const steps = Array.from({ length: 16 }, (_, i) =>
      step(i < 4 ? "done" : "pending", String(i + 1)),
    );
    buildQueues.map = { s1: queue(true, steps) };
    renderBadge({ sessionId: "s1", planPhase: "executing" });
    await expect.element(page.getByText("4/16")).toBeInTheDocument();
    expect(document.querySelector(".queue-cells")).toBeNull();
    const fill = document.querySelector<HTMLElement>(".queue-bar i")!;
    expect(fill.style.width).toBe("25%");
  });

  it("hideWhenStepLive hides a reporting queue — the activity line already shows the step", async () => {
    buildQueues.map = { s1: queue(true, [step("done", "1"), step("active", "2")]) };
    render(BuildQueueBadge, {
      sessionId: "s1",
      planPhase: "executing",
      selected: false,
      onselect: () => {},
      hideWhenStepLive: true,
    });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.querySelector(".queue-badge")).toBeNull();
  });

  it("hideWhenStepLive still shows a drifted queue — the one state the line can't show", async () => {
    buildQueues.map = { s1: queue(true, [step("pending", "1"), step("pending", "2")]) };
    render(BuildQueueBadge, {
      sessionId: "s1",
      planPhase: "executing",
      selected: false,
      onselect: () => {},
      hideWhenStepLive: true,
    });
    await expect.element(page.getByText("⚠ 2")).toBeInTheDocument();
    expect(document.querySelector(".queue-badge--stale")).not.toBeNull();
  });
});
