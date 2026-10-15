import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapExitReached,
  bootstrapMissing,
  bootstrapSessionPhase,
  hasProjectManifest,
  phaseAfterBootstrapMerge,
  type RepoBootstrap,
} from "../src/bootstrap";
import { SessionStore } from "../src/store";

const active = (phase: number, overrideAt: number | null = null): RepoBootstrap => ({
  state: "active",
  phase,
  overrideAt,
});

describe("bootstrapMissing", () => {
  test("off and done never gate", () => {
    expect(bootstrapMissing({ state: "off", phase: 1, overrideAt: null }, [])).toBeNull();
    expect(bootstrapMissing({ state: "done", phase: 5, overrideAt: null }, ["ci"])).toBeNull();
  });
  test("an override lifts the gate", () => {
    expect(bootstrapMissing(active(1, 123), [])).toBeNull();
  });
  test("lists the incomplete phases, then the red must-haves", () => {
    expect(bootstrapMissing(active(1), [])).toEqual(["P1", "P2", "P3", "P4"]);
    expect(bootstrapMissing(active(3), ["ci"])).toEqual(["P3", "P4", "ci"]);
    expect(bootstrapMissing(active(5), ["ci"])).toEqual(["ci"]);
  });
});

describe("bootstrapSessionPhase", () => {
  test("P3 only once an active repo reached phase 3", () => {
    expect(bootstrapSessionPhase(active(1))).toBe(1);
    expect(bootstrapSessionPhase(active(2))).toBe(1);
    expect(bootstrapSessionPhase(active(3))).toBe(3);
    expect(bootstrapSessionPhase(active(4))).toBe(3);
    expect(bootstrapSessionPhase({ state: "off", phase: 3, overrideAt: null })).toBe(1);
    expect(bootstrapSessionPhase({ state: "done", phase: 5, overrideAt: null })).toBe(1);
  });
});

describe("phaseAfterBootstrapMerge", () => {
  test("P1+P2 merge → 3, P3 merge → 4", () => {
    expect(phaseAfterBootstrapMerge(active(1), 1)).toBe(3);
    expect(phaseAfterBootstrapMerge(active(2), 1)).toBe(3);
    expect(phaseAfterBootstrapMerge(active(3), 3)).toBe(4);
  });
  test("never lowers the phase; inactive repos are untouched", () => {
    expect(phaseAfterBootstrapMerge(active(3), 1)).toBeNull();
    expect(phaseAfterBootstrapMerge(active(5), 3)).toBeNull();
    expect(phaseAfterBootstrapMerge({ state: "off", phase: 1, overrideAt: null }, 1)).toBeNull();
    expect(phaseAfterBootstrapMerge({ state: "done", phase: 5, overrideAt: null }, 3)).toBeNull();
  });
});

describe("bootstrapExitReached", () => {
  test("needs phase 5 AND no red must-have", () => {
    expect(bootstrapExitReached(active(5), [])).toBe(true);
    expect(bootstrapExitReached(active(5), ["ci"])).toBe(false);
    expect(bootstrapExitReached(active(4), [])).toBe(false);
    expect(bootstrapExitReached({ state: "off", phase: 5, overrideAt: null }, [])).toBe(false);
  });
});

describe("hasProjectManifest", () => {
  test("detects package.json / Cargo.toml, else false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bootstrap-manifest-"));
    try {
      expect(await hasProjectManifest(dir)).toBe(false);
      writeFileSync(join(dir, "Cargo.toml"), "");
      expect(await hasProjectManifest(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SessionStore repo bootstrap", () => {
  test("defaults to off; off deletes the row", () => {
    const s = new SessionStore(":memory:");
    expect(s.getRepoBootstrap("/r")).toEqual({ state: "off", phase: 1, overrideAt: null });
    s.setRepoBootstrap("/r", { state: "active", phase: 2 });
    expect(s.getRepoBootstrap("/r")).toEqual({ state: "active", phase: 2, overrideAt: null });
    s.setRepoBootstrap("/r", { state: "off", phase: 1 });
    expect(s.getRepoBootstrap("/r").state).toBe("off");
  });

  test("bootstrap state never creates a repo_config row", () => {
    const s = new SessionStore(":memory:");
    s.setRepoBootstrap("/r", { state: "active", phase: 1 });
    expect(s.automationRowExists("/r")).toBe(false);
  });

  test("override only applies while active; a phase move keeps it, a state change clears it", () => {
    const s = new SessionStore(":memory:");
    expect(s.setRepoBootstrapOverride("/r", true)).toBe(false);
    s.setRepoBootstrap("/r", { state: "active", phase: 1 });
    expect(s.setRepoBootstrapOverride("/r", true)).toBe(true);
    expect(s.getRepoBootstrap("/r").overrideAt).not.toBeNull();
    s.setRepoBootstrap("/r", { state: "active", phase: 2 });
    expect(s.getRepoBootstrap("/r").overrideAt).not.toBeNull();
    s.setRepoBootstrap("/r", { state: "done", phase: 5 });
    expect(s.getRepoBootstrap("/r").overrideAt).toBeNull();
    expect(s.setRepoBootstrapOverride("/r", true)).toBe(false);
    s.setRepoBootstrap("/r", { state: "active", phase: 1 });
    expect(s.setRepoBootstrapOverride("/r", true)).toBe(true);
    expect(s.setRepoBootstrapOverride("/r", false)).toBe(true);
    expect(s.getRepoBootstrap("/r").overrideAt).toBeNull();
  });
});
