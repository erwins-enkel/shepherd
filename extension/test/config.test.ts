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
      signals: { screenshot: true, console: true, network: false, a11y: true },
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
});
