import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { parseCodexAuthMode, readCodexAuthMode } from "../src/codex-auth";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function tempDirWithAuth(auth: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-auth-"));
  dirs.push(dir);
  writeFileSync(join(dir, "auth.json"), JSON.stringify(auth));
  return dir;
}

describe("parseCodexAuthMode", () => {
  test("tokens.access_token present + no OPENAI_API_KEY ⇒ chatgpt (even with NO auth_mode field)", () => {
    // The load-bearing case: a real ChatGPT-account auth.json may omit auth_mode; structural
    // detection must still resolve chatgpt, else the clamp silently no-ops for its target operator.
    expect(parseCodexAuthMode({ tokens: { access_token: "abc" }, OPENAI_API_KEY: null })).toBe(
      "chatgpt",
    );
  });

  test("non-empty OPENAI_API_KEY ⇒ apikey (takes precedence over tokens)", () => {
    expect(parseCodexAuthMode({ OPENAI_API_KEY: "sk-xxx", tokens: { access_token: "abc" } })).toBe(
      "apikey",
    );
  });

  test("explicit auth_mode corroborates when no key and no tokens", () => {
    expect(parseCodexAuthMode({ auth_mode: "chatgpt" })).toBe("chatgpt");
    expect(parseCodexAuthMode({ auth_mode: "apikey" })).toBe("apikey");
  });

  test("empty-string OPENAI_API_KEY is not apikey", () => {
    expect(parseCodexAuthMode({ OPENAI_API_KEY: "   ", tokens: { access_token: "abc" } })).toBe(
      "chatgpt",
    );
  });

  test("garbage / missing signals ⇒ unknown", () => {
    expect(parseCodexAuthMode(null)).toBe("unknown");
    expect(parseCodexAuthMode("nope")).toBe("unknown");
    expect(parseCodexAuthMode({})).toBe("unknown");
    expect(parseCodexAuthMode({ tokens: {} })).toBe("unknown");
    expect(parseCodexAuthMode({ auth_mode: "weird" })).toBe("unknown");
  });
});

describe("readCodexAuthMode", () => {
  test("reads and structurally detects chatgpt from a fixture dir", () => {
    const dir = tempDirWithAuth({ tokens: { access_token: "abc" }, OPENAI_API_KEY: null });
    expect(readCodexAuthMode(dir)).toBe("chatgpt");
  });

  test("missing auth.json ⇒ unknown (fail-open)", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-auth-empty-"));
    dirs.push(dir);
    expect(readCodexAuthMode(dir)).toBe("unknown");
  });

  test("unreadable / invalid JSON ⇒ unknown (fail-open)", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-auth-bad-"));
    dirs.push(dir);
    writeFileSync(join(dir, "auth.json"), "{ not json");
    expect(readCodexAuthMode(dir)).toBe("unknown");
  });
});
