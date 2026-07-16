import { describe, expect, it } from "bun:test";
import { classifyLiveness, isAutoRevivable, isStranded, type StrandFields } from "../src/herdr";

// A default-account session with a verified spawn on terminal "spawn-1".
const base: StrandFields = {
  status: "running",
  readyToMerge: false,
  autopilotComplete: false,
  spawnTerminalId: "spawn-1",
  spawnAccountDir: null,
};

const restored = { terminalId: "restored-9" }; // herdr-restored pane (id differs from spawn)
const ownPane = { terminalId: "spawn-1" }; // same pane it spawned on

describe("isStranded", () => {
  it("flags a herdr-restored husk (fingerprint) on an active default session", () => {
    expect(isStranded(base, restored, false)).toBe(true);
  });

  it("does NOT flag a live agent (claudeAlive true)", () => {
    expect(isStranded(base, restored, true)).toBe(false);
  });

  it("does NOT flag a normal Codex exit at its OWN pane (terminalId === spawnTerminalId)", () => {
    expect(isStranded(base, ownPane, false)).toBe(false);
  });

  it("flags a legacy null-spawnTerminalId husk (fingerprint-free fallback)", () => {
    expect(isStranded({ ...base, spawnTerminalId: null }, ownPane, false)).toBe(true);
  });

  it("does NOT flag a session with no matched pane this tick (about to be reaped)", () => {
    expect(isStranded(base, null, false)).toBe(false);
  });

  it("does NOT flag an operator/auto-concluded session", () => {
    expect(isStranded({ ...base, readyToMerge: true }, restored, false)).toBe(false);
    expect(isStranded({ ...base, autopilotComplete: true }, restored, false)).toBe(false);
  });

  it("does NOT flag an archived session", () => {
    expect(isStranded({ ...base, status: "archived" }, restored, false)).toBe(false);
  });
});

describe("classifyLiveness", () => {
  it("alive when the process lives", () => {
    expect(classifyLiveness(base, restored, true)).toBe("alive");
  });

  it("alive when not yet swept (claudeAlive undefined)", () => {
    expect(classifyLiveness(base, restored, undefined)).toBe("alive");
  });

  it("stranded for a restored husk", () => {
    expect(classifyLiveness(base, restored, false)).toBe("stranded");
  });

  it("husk (not stranded) for a normal Codex exit at its own pane", () => {
    expect(classifyLiveness(base, ownPane, false)).toBe("husk");
  });

  it("husk for a concluded session whose agent is gone", () => {
    expect(classifyLiveness({ ...base, readyToMerge: true }, restored, false)).toBe("husk");
  });
});

describe("isAutoRevivable", () => {
  it("true only for a positively default-account session (spawnTerminalId set, spawnAccountDir null)", () => {
    expect(isAutoRevivable({ spawnTerminalId: "spawn-1", spawnAccountDir: null })).toBe(true);
  });

  it("false for an account/plugin session (spawnAccountDir set) — reDriveAccount owns it", () => {
    expect(isAutoRevivable({ spawnTerminalId: "spawn-1", spawnAccountDir: "/cfg/acct" })).toBe(
      false,
    );
  });

  it("false for a legacy row (spawnTerminalId null) — account unknown, operator-initiated only", () => {
    expect(isAutoRevivable({ spawnTerminalId: null, spawnAccountDir: null })).toBe(false);
  });
});
