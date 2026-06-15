import { describe, it, expect, afterEach } from "vitest";
import { render } from "vitest-browser-svelte";
import "../../app.css";
import type { SubagentEntry } from "$lib/types";

const { default: SubagentFanout } = await import("./SubagentFanout.svelte");

const now = Date.now();
const entry = (p: Partial<SubagentEntry> & { agentId: string }): SubagentEntry => ({
  agentType: "Explore",
  startedAt: now - 90_000,
  ...p,
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("SubagentFanout", () => {
  it("renders nothing when the roster is empty", () => {
    render(SubagentFanout, { sessionId: "s1", subagents: {} });
    expect(document.querySelector(".fanout"), "no section when roster empty").toBeNull();
  });

  it("renders nothing when the session has no entry in the map", () => {
    render(SubagentFanout, { sessionId: "s1", subagents: { other: [entry({ agentId: "a" })] } });
    expect(document.querySelector(".fanout"), "no section for absent session").toBeNull();
  });

  it("renders one row per entry with the verbatim agentType", () => {
    render(SubagentFanout, {
      sessionId: "s1",
      subagents: {
        s1: [
          entry({ agentId: "a", agentType: "Explore" }),
          entry({ agentId: "b", agentType: "Plan", endedAt: now }),
        ],
      },
    });
    expect(document.querySelector(".fanout"), "section present").not.toBeNull();
    expect(document.querySelectorAll(".fanout li").length).toBe(2);
    expect(document.querySelector(".fanout")?.textContent).toContain("Explore");
    expect(document.querySelector(".fanout")?.textContent).toContain("Plan");
  });

  it("labels live vs done entries", async () => {
    render(SubagentFanout, {
      sessionId: "s1",
      subagents: {
        s1: [
          entry({ agentId: "a", agentType: "Explore" }), // live (no endedAt)
          entry({ agentId: "b", agentType: "Plan", endedAt: now }), // done
        ],
      },
    });
    const statuses = [...document.querySelectorAll(".status")].map((n) => n.textContent);
    expect(statuses).toContain("live");
    expect(statuses).toContain("done");
  });

  it("shows the live count (entries with no endedAt)", async () => {
    render(SubagentFanout, {
      sessionId: "s1",
      subagents: {
        s1: [
          entry({ agentId: "a" }), // live
          entry({ agentId: "b" }), // live
          entry({ agentId: "c", endedAt: now }), // done
        ],
      },
    });
    expect(document.querySelector(".count")?.textContent).toContain("2");
  });
});
