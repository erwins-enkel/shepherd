import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CONFIG,
  isConfigured,
  loadConfig,
  saveConfig,
  saveSignals,
} from "../src/lib/config";
import { reactiveConfig, snapshotConfig } from "./fixtures/reactive-config.svelte";

// Minimal in-memory chrome.storage.local stub.
function installChromeStub(initial: Record<string, unknown> = {}) {
  let store = { ...initial };
  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn(async (keys: string[] | string) => {
          const ks = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const k of ks) if (k in store) out[k] = store[k];
          return out;
        }),
        set: vi.fn(async (obj: Record<string, unknown>) => {
          // Real chrome.storage serializes across a structured-clone boundary; clone
          // here so the stub catches values that don't survive it (e.g. a Svelte
          // $state proxy array that deserializes as a non-array).
          store = { ...store, ...structuredClone(obj) };
        }),
      },
    },
  };
  return () => store;
}

describe("config", () => {
  beforeEach(() => installChromeStub());

  it("returns defaults merged when storage is empty", async () => {
    const cfg = await loadConfig();
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  it("round-trips a saved config", async () => {
    await saveConfig({
      baseUrl: "http://localhost:7330",
      token: "t",
      repoPath: "~/Work/x",
      baseBranch: "main",
      model: "sonnet",
      signals: { screenshot: true, console: true, network: false, a11y: true },
      routingRules: [],
    });
    const cfg = await loadConfig();
    expect(cfg.repoPath).toBe("~/Work/x");
    expect(cfg.model).toBe("sonnet");
  });

  it("defaults routingRules to an empty array and round-trips stored rules", async () => {
    expect((await loadConfig()).routingRules).toEqual([]);
    installChromeStub({
      captureConfig: { routingRules: [{ pattern: "https://x/*", repoPath: "~/Work/x" }] },
    });
    expect((await loadConfig()).routingRules).toEqual([
      { pattern: "https://x/*", repoPath: "~/Work/x" },
    ]);
  });

  it("isConfigured is false until baseUrl + repoPath are set", async () => {
    expect(isConfigured(DEFAULT_CONFIG)).toBe(false);
    expect(
      isConfigured({ ...DEFAULT_CONFIG, baseUrl: "http://localhost:7330", repoPath: "~/Work/x" }),
    ).toBe(true);
  });

  it("defaults all four signal toggles (screenshot on, rest off)", async () => {
    const cfg = await loadConfig();
    expect(cfg.signals).toEqual({
      screenshot: true,
      console: false,
      network: false,
      a11y: false,
    });
  });

  it("deep-merges a legacy stored config that has no signals field", async () => {
    installChromeStub({
      captureConfig: { baseUrl: "http://localhost:7330", repoPath: "~/Work/x" },
    });
    const cfg = await loadConfig();
    expect(cfg.signals).toEqual(DEFAULT_CONFIG.signals);
    expect(cfg.repoPath).toBe("~/Work/x");
  });

  it("merges a partial stored signals object over the defaults", async () => {
    installChromeStub({ captureConfig: { signals: { a11y: true } } });
    const cfg = await loadConfig();
    expect(cfg.signals).toEqual({ screenshot: true, console: false, network: false, a11y: true });
  });

  it("coerces a non-array stored routingRules to an empty array", async () => {
    // A stored non-array (corrupt/legacy data) must not reach consumers that
    // iterate it (resolveRepo, the options `{#each}`) — `??` only catches
    // null/undefined, so a truthy non-array would otherwise slip through.
    installChromeStub({ captureConfig: { routingRules: { 0: { pattern: "*", repoPath: "x" } } } });
    const cfg = await loadConfig();
    expect(cfg.routingRules).toEqual([]);
  });

  it("ignores a non-object stored signals, falling back to the defaults", async () => {
    // A non-object can't throw but would spread garbage keys (a string →
    // {0:"…"}); coerce to {} so the toggles stay the clean default shape.
    installChromeStub({ captureConfig: { signals: "screenshot" } });
    const cfg = await loadConfig();
    expect(cfg.signals).toEqual(DEFAULT_CONFIG.signals);
  });

  it("preserves a valid stored routingRules array", async () => {
    const rules = [{ pattern: "https://github.com/*", repoPath: "~/Work/gh" }];
    installChromeStub({ captureConfig: { routingRules: rules } });
    const cfg = await loadConfig();
    expect(cfg.routingRules).toEqual(rules);
  });

  it("saveSignals persists signals only, leaving other stored fields untouched", async () => {
    await saveConfig({
      baseUrl: "http://localhost:7330",
      token: "tok",
      repoPath: "~/Work/x",
      baseBranch: "dev",
      model: "opus",
      signals: { screenshot: true, console: false, network: false, a11y: false },
      routingRules: [],
    });
    await saveSignals({ screenshot: false, console: true, network: true, a11y: true });
    const cfg = await loadConfig();
    expect(cfg.signals).toEqual({ screenshot: false, console: true, network: true, a11y: true });
    expect(cfg.token).toBe("tok");
    expect(cfg.baseBranch).toBe("dev");
    expect(cfg.model).toBe("opus");
  });

  describe("$state proxy persistence (routing-rule regression)", () => {
    it("round-trips routingRules when the $state config is snapshotted before saving", async () => {
      // Options.svelte holds the settings form in a deeply-reactive $state proxy
      // and snapshots it before persisting. Verify the snapshot is plain,
      // clone-safe data whose routingRules survives the structured-clone boundary
      // (the hardened stub mimics chrome.storage) as a real Array.
      //
      // Note: the FAILURE this guards against — a raw $state proxy whose array
      // degrades to a non-array through chrome.storage's serializer, tripping
      // loadConfig's Array.isArray guard — is Chrome-specific and cannot be
      // reproduced under Node's structuredClone (which preserves array-ness), so
      // it is verified manually in-browser, not here.
      const rules = [{ pattern: "https://app.example.com/*", repoPath: "~/Work/app" }];
      await saveConfig(snapshotConfig(reactiveConfig(rules)));
      const loaded = await loadConfig();
      expect(Array.isArray(loaded.routingRules)).toBe(true);
      expect(loaded.routingRules).toEqual(rules);
    });
  });
});
