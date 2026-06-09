import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CONFIG,
  isConfigured,
  loadConfig,
  saveConfig,
  saveSignals,
} from "../src/lib/config";
import { persistConfig } from "../src/lib/config-persist.svelte";
import { reactiveConfig } from "./fixtures/reactive-config.svelte";

// Minimal in-memory chrome.storage.local stub.
//
// `serialize` (default true) deep-clones via structuredClone, mirroring real
// chrome.storage's serialization boundary so the stub catches values that don't
// survive it. Pass `serialize: false` to store by reference — used to assert a
// caller handed storage a detached snapshot, not a live $state proxy.
function installChromeStub(
  initial: Record<string, unknown> = {},
  { serialize = true }: { serialize?: boolean } = {},
) {
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
          store = { ...store, ...(serialize ? structuredClone(obj) : obj) };
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

  describe("persistConfig (routing-rule persistence regression)", () => {
    // Both tests drive the REAL production persistConfig with a genuine $state
    // proxy, so they fail if its $state.snapshot is removed — not a tautology
    // that snapshots in the test itself.

    it("round-trips routingRules saved from a $state proxy", async () => {
      const rules = [{ pattern: "https://app.example.com/*", repoPath: "~/Work/app" }];
      await persistConfig(reactiveConfig(rules));
      const loaded = await loadConfig();
      expect(Array.isArray(loaded.routingRules)).toBe(true);
      expect(loaded.routingRules).toEqual(rules);
    });

    it("hands storage a detached snapshot, not the live $state proxy", async () => {
      // The actual bug is Chrome-specific (its serializer degrades a proxied
      // array to a non-array; Node's structuredClone preserves array-ness, so a
      // raw-proxy round-trip can't reproduce it here). What IS verifiable in Node
      // is the property that prevents it: persistConfig must store a snapshot
      // detached from live reactive state. With a by-reference store, mutating
      // the proxy AFTER persisting must not change what was stored — which only
      // holds if persistConfig snapshotted. Drop the snapshot and this fails.
      const getStore = installChromeStub({}, { serialize: false });
      const live = reactiveConfig([
        { pattern: "https://app.example.com/*", repoPath: "~/Work/app" },
      ]);
      await persistConfig(live);
      live.routingRules[0].pattern = "MUTATED";
      const stored = getStore().captureConfig as typeof DEFAULT_CONFIG;
      expect(stored.routingRules).toEqual([
        { pattern: "https://app.example.com/*", repoPath: "~/Work/app" },
      ]);
    });
  });
});
