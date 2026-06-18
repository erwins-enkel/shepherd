import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import { page } from "vitest/browser";
import "../../app.css";
import type { BuildQueue, BuildStep, BuildStepStatus } from "$lib/types";

const { default: BuildQueueBadge } = await import("./BuildQueueBadge.svelte");
const { buildQueues } = await import("$lib/buildQueues.svelte");

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

beforeEach(() => {
  buildQueues.map = {};
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("BuildQueueBadge", () => {
  it("renders nothing when queue is unapproved (approved=false) even with steps", async () => {
    buildQueues.map = {
      s1: queue(false, [step("done", "1"), step("pending", "2")]),
    };
    render(BuildQueueBadge, { sessionId: "s1" });
    expect(document.querySelector(".queue-badge")).toBeNull();
  });

  it("renders nothing when there is no queue for the session", async () => {
    render(BuildQueueBadge, { sessionId: "s1" });
    expect(document.querySelector(".queue-badge")).toBeNull();
  });

  it("renders nothing when approved but steps array is empty", async () => {
    buildQueues.map = {
      s1: queue(true, []),
    };
    render(BuildQueueBadge, { sessionId: "s1" });
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
    render(BuildQueueBadge, { sessionId: "s1" });
    await expect.element(page.getByText("4/5")).toBeInTheDocument();
  });

  it("meter fill width reflects resolved/total via --queue-pct", async () => {
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
    render(BuildQueueBadge, { sessionId: "s1" });
    const badge = document.querySelector(".queue-badge") as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.style.getPropertyValue("--queue-pct")).toBe("80%");
  });

  it("all resolved (all done) → shows 5/5 with 100% meter", async () => {
    buildQueues.map = {
      s1: queue(true, [
        step("done", "1"),
        step("done", "2"),
        step("done", "3"),
        step("done", "4"),
        step("done", "5"),
      ]),
    };
    render(BuildQueueBadge, { sessionId: "s1" });
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
    render(BuildQueueBadge, { sessionId: "s1" });
    await expect.element(page.getByText("5/5")).toBeInTheDocument();
  });
});
