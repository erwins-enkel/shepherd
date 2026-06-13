import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalizeAuthModeSetting,
  isAuthMode,
  AUTH_MODES,
  writeApiKeyHelper,
  readApiKeyHelperPath,
  clearApiKeyHelper,
  spawnAuthSettings,
  redactKey,
  API_KEY_HELPER_FILE,
} from "../src/auth-mode";

// ── normalizeAuthModeSetting ──────────────────────────────────────────────────

describe("normalizeAuthModeSetting", () => {
  test("accepts 'subscription'", () => {
    expect(normalizeAuthModeSetting("subscription")).toBe("subscription");
  });

  test("accepts 'api-key'", () => {
    expect(normalizeAuthModeSetting("api-key")).toBe("api-key");
  });

  test("returns null for unknown string", () => {
    expect(normalizeAuthModeSetting("oauth")).toBeNull();
    expect(normalizeAuthModeSetting("")).toBeNull();
    expect(normalizeAuthModeSetting("API-KEY")).toBeNull();
  });

  test("returns null for null", () => {
    expect(normalizeAuthModeSetting(null)).toBeNull();
  });

  test("returns null for undefined", () => {
    expect(normalizeAuthModeSetting(undefined)).toBeNull();
  });

  test("returns null for number", () => {
    expect(normalizeAuthModeSetting(42)).toBeNull();
  });

  test("returns null for object", () => {
    expect(normalizeAuthModeSetting({})).toBeNull();
  });
});

// ── isAuthMode ────────────────────────────────────────────────────────────────

describe("isAuthMode", () => {
  test("returns true for each AUTH_MODES entry", () => {
    for (const mode of AUTH_MODES) {
      expect(isAuthMode(mode)).toBe(true);
    }
  });

  test("returns false for unknown string", () => {
    expect(isAuthMode("oauth")).toBe(false);
    expect(isAuthMode("")).toBe(false);
  });

  test("returns false for non-string", () => {
    expect(isAuthMode(null)).toBe(false);
    expect(isAuthMode(undefined)).toBe(false);
    expect(isAuthMode(42)).toBe(false);
    expect(isAuthMode({})).toBe(false);
  });
});

// ── apiKeyHelper filesystem lifecycle ─────────────────────────────────────────

let tmpDir: string | null = null;

function makeTmp(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "auth-mode-test-"));
  return tmpDir;
}

afterEach(() => {
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    tmpDir = null;
  }
});

describe("writeApiKeyHelper", () => {
  test("returns an absolute path ending in the known filename", () => {
    const dir = makeTmp();
    const path = writeApiKeyHelper("sk-ant-test123", dir);
    expect(path).toMatch(new RegExp(`${API_KEY_HELPER_FILE}$`));
    expect(path.startsWith("/")).toBe(true);
  });

  test("file has mode 0o700 set", () => {
    const dir = makeTmp();
    const path = writeApiKeyHelper("sk-ant-test123", dir);
    const s = statSync(path);
    expect(s.mode & 0o700).toBe(0o700);
  });

  test("executing the script prints exactly the key", () => {
    const dir = makeTmp();
    const key = "sk-ant-api03-hello";
    const path = writeApiKeyHelper(key, dir);
    const result = Bun.spawnSync([path]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(key);
  });

  test("handles key with shell metacharacters safely", () => {
    const dir = makeTmp();
    // Key containing single quote, dollar sign, double quote, semicolon, space
    const key = "a'b$c\"d ;e";
    const path = writeApiKeyHelper(key, dir);
    const result = Bun.spawnSync([path]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(key);
  });

  test("handles key with multiple single quotes", () => {
    const dir = makeTmp();
    const key = "sk-ant-it's'tricky";
    const path = writeApiKeyHelper(key, dir);
    const result = Bun.spawnSync([path]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(key);
  });

  test("creates dir if it does not exist", () => {
    const dir = makeTmp();
    const nested = join(dir, "subdir", "deeper");
    const path = writeApiKeyHelper("sk-ant-x", nested);
    expect(existsSync(path)).toBe(true);
  });

  test("throws on empty key", () => {
    const dir = makeTmp();
    expect(() => writeApiKeyHelper("", dir)).toThrow();
  });

  test("throws on whitespace-only key", () => {
    const dir = makeTmp();
    expect(() => writeApiKeyHelper("   ", dir)).toThrow();
  });
});

describe("readApiKeyHelperPath", () => {
  test("returns path when helper exists", () => {
    const dir = makeTmp();
    writeApiKeyHelper("sk-ant-exists", dir);
    const result = readApiKeyHelperPath(dir);
    expect(result).not.toBeNull();
    expect(result).toMatch(new RegExp(`${API_KEY_HELPER_FILE}$`));
  });

  test("returns null when helper does not exist", () => {
    const dir = makeTmp();
    expect(readApiKeyHelperPath(dir)).toBeNull();
  });

  test("returns null when dir does not exist", () => {
    expect(readApiKeyHelperPath("/nonexistent/path/that/does/not/exist")).toBeNull();
  });
});

describe("clearApiKeyHelper", () => {
  test("removes the helper script", () => {
    const dir = makeTmp();
    writeApiKeyHelper("sk-ant-remove-me", dir);
    expect(readApiKeyHelperPath(dir)).not.toBeNull();
    clearApiKeyHelper(dir);
    expect(readApiKeyHelperPath(dir)).toBeNull();
  });

  test("is idempotent — no throw when already gone", () => {
    const dir = makeTmp();
    expect(() => clearApiKeyHelper(dir)).not.toThrow();
    expect(() => clearApiKeyHelper(dir)).not.toThrow();
  });

  test("is idempotent — no throw when dir does not exist", () => {
    expect(() => clearApiKeyHelper("/nonexistent/path")).not.toThrow();
  });
});

// ── spawnAuthSettings ─────────────────────────────────────────────────────────

describe("spawnAuthSettings", () => {
  test("api-key mode with a path returns { apiKeyHelper: path }", () => {
    const result = spawnAuthSettings("api-key", "/some/path/helper.sh");
    expect(result).toEqual({ apiKeyHelper: "/some/path/helper.sh" });
  });

  test("subscription mode returns empty object regardless of path", () => {
    expect(spawnAuthSettings("subscription", "/some/path/helper.sh")).toEqual({});
    expect(spawnAuthSettings("subscription", null)).toEqual({});
  });

  test("api-key mode with null path returns empty object", () => {
    expect(spawnAuthSettings("api-key", null)).toEqual({});
  });

  test("api-key mode with empty string path returns empty object", () => {
    expect(spawnAuthSettings("api-key", "")).toEqual({});
  });

  test("spread into an object is safe and produces no extra keys in subscription mode", () => {
    const settings = { model: "sonnet", ...spawnAuthSettings("subscription", null) };
    expect(Object.keys(settings)).toEqual(["model"]);
  });
});

// ── redactKey ─────────────────────────────────────────────────────────────────

describe("redactKey", () => {
  test("redacts a sample Anthropic API key", () => {
    const s = "using key sk-ant-api03-abc123XYZ in request";
    const out = redactKey(s);
    expect(out).not.toContain("abc123XYZ");
    expect(out).toContain("sk-ant-***");
    expect(out).toContain("in request");
  });

  test("leaves non-key text intact", () => {
    const s = "no secrets here";
    expect(redactKey(s)).toBe(s);
  });

  test("redacts multiple occurrences", () => {
    const s = "key1=sk-ant-api03-AAA key2=sk-ant-api03-BBB";
    const out = redactKey(s);
    expect(out).not.toContain("AAA");
    expect(out).not.toContain("BBB");
    expect((out.match(/sk-ant-\*\*\*/g) ?? []).length).toBe(2);
  });
});
