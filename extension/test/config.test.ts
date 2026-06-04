import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, isConfigured, loadConfig, saveConfig } from "../src/lib/config";

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
          store = { ...store, ...obj };
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
    });
    const cfg = await loadConfig();
    expect(cfg.repoPath).toBe("~/Work/x");
    expect(cfg.model).toBe("sonnet");
  });

  it("isConfigured is false until baseUrl + repoPath are set", async () => {
    expect(isConfigured(DEFAULT_CONFIG)).toBe(false);
    expect(
      isConfigured({ ...DEFAULT_CONFIG, baseUrl: "http://localhost:7330", repoPath: "~/Work/x" }),
    ).toBe(true);
  });
});
