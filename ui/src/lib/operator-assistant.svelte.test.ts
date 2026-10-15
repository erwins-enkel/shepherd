import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "./types";

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, ensureOperatorAssistant: vi.fn(), resetOperatorAssistant: vi.fn() };
});

const { ApiError, ensureOperatorAssistant, resetOperatorAssistant } = await import("./api");
const { AssistantLifecycle, assistantMode, assistantPanelView } =
  await import("./operator-assistant.svelte");

const row = { id: "oa-1", desig: "TASK-90", operatorAssistant: true } as Session;

function sink() {
  return { setAssistant: vi.fn(), setAssistantUnavailable: vi.fn() };
}

beforeEach(() => {
  vi.mocked(ensureOperatorAssistant).mockReset();
  vi.mocked(resetOperatorAssistant).mockReset();
});

describe("AssistantLifecycle", () => {
  it("lands an ensured row in the store and clears pending", async () => {
    vi.mocked(ensureOperatorAssistant).mockResolvedValue({ session: row });
    const s = sink();
    const life = new AssistantLifecycle(s);
    const run = life.ensure();
    expect(life.pending).toBe("ensure");
    await run;
    expect(s.setAssistant).toHaveBeenCalledWith(row);
    expect(life.pending).toBeNull();
    expect(life.failed).toBeNull();
  });

  it("runs one request at a time: a second ensure or a reset mid-flight is dropped", async () => {
    let finish!: (v: { session: Session }) => void;
    vi.mocked(ensureOperatorAssistant).mockReturnValue(new Promise((r) => (finish = r)));
    const life = new AssistantLifecycle(sink());
    const first = life.ensure();
    await life.ensure();
    await life.reset();
    finish({ session: row });
    await first;
    expect(ensureOperatorAssistant).toHaveBeenCalledTimes(1);
    expect(resetOperatorAssistant).not.toHaveBeenCalled();
  });

  it("marks the assistant unavailable on a 503 that carries a known reason", async () => {
    vi.mocked(ensureOperatorAssistant).mockRejectedValue(
      new ApiError(503, "unavailable", "herdr_unreachable", true),
    );
    const s = sink();
    const life = new AssistantLifecycle(s);
    await life.ensure();
    expect(s.setAssistantUnavailable).toHaveBeenCalledWith("herdr_unreachable");
    expect(life.failed).toBeNull();
  });

  it("keeps any other failure, and Retry re-runs the action that failed", async () => {
    vi.mocked(resetOperatorAssistant).mockRejectedValueOnce(new ApiError(500, "boom"));
    vi.mocked(resetOperatorAssistant).mockResolvedValueOnce({ session: row });
    const s = sink();
    const life = new AssistantLifecycle(s);
    await life.reset();
    expect(life.failed).toBe("reset");
    expect(s.setAssistantUnavailable).not.toHaveBeenCalled();

    await life.retry();
    expect(resetOperatorAssistant).toHaveBeenCalledTimes(2);
    expect(ensureOperatorAssistant).not.toHaveBeenCalled();
    expect(s.setAssistant).toHaveBeenCalledWith(row);
    expect(life.failed).toBeNull();
  });
});

describe("assistantPanelView", () => {
  const base = { session: row, available: true, pending: null, failed: null } as const;

  it("is live once a row exists and nothing replaces it", () => {
    expect(assistantPanelView(base)).toBe("live");
    // A background ensure keeps the terminal usable.
    expect(assistantPanelView({ ...base, pending: "ensure" })).toBe("live");
  });

  it("spawns while no row exists yet, and while a reset replaces the current one", () => {
    expect(assistantPanelView({ ...base, session: null, available: null })).toBe("spawning");
    expect(assistantPanelView({ ...base, session: null, pending: "ensure" })).toBe("spawning");
    expect(assistantPanelView({ ...base, pending: "reset" })).toBe("spawning");
  });

  it("shows a failure over a spawn, and unavailability over everything", () => {
    expect(assistantPanelView({ ...base, session: null, failed: "ensure" })).toBe("error");
    expect(assistantPanelView({ ...base, available: false, failed: "ensure" })).toBe("unavailable");
    expect(assistantPanelView({ ...base, available: false })).toBe("unavailable");
  });
});

describe("assistantMode", () => {
  const off = {
    shell: "ask",
    steer: "off",
    sessions: "off",
    approve: "off",
    automation: "off",
  } as const;
  it("is readonly while no action group is on, whatever the read shell", () => {
    expect(assistantMode(off)).toBe("readonly");
    expect(assistantMode({ ...off, shell: "read" })).toBe("readonly");
  });
  it("asks when a group asks and nothing runs unasked", () => {
    expect(assistantMode({ ...off, shell: "read", steer: "ask" })).toBe("asks");
  });
  it("acts when a group is allowed or the whole shell runs", () => {
    expect(assistantMode({ ...off, automation: "allow" })).toBe("acts");
    expect(assistantMode({ ...off, shell: "all" })).toBe("acts");
  });
});
