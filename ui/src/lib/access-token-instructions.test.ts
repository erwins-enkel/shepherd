import { describe, it, expect } from "vitest";
import { buildAccessTokenInstructions, normalizeAgentServerUrl } from "./access-token-instructions";
import { overwriteGetLocale } from "./paraglide/runtime";
import type { AccessToken } from "./types";
const entry: AccessToken = {
  id: "token-id",
  name: "remote",
  hint: "abcd",
  createdAt: 1,
  lastUsedAt: null,
  expiresAt: null,
  scope: "read",
  repoPaths: ["/repos/a"],
};

describe("agent instructions", () => {
  it("rejects local-only and credential-bearing URLs for a remote handoff", () => {
    for (const url of [
      "",
      "ftp://host",
      "http://localhost:7330",
      "http://127.3.4.5",
      "http://[::1]",
      "http://0.0.0.0",
      "http://[::]",
      "http://[::ffff:127.0.0.1]",
      "http://[::ffff:0.0.0.0]",
      "https://user:pw@host",
      "https://host?q=secret",
      "https://host/#token",
    ])
      expect(normalizeAgentServerUrl(url)).toBeNull();
    expect(normalizeAgentServerUrl(" https://shepherd.example.ts.net/ ")).toBe(
      "https://shepherd.example.ts.net",
    );
    expect(normalizeAgentServerUrl("http://100.64.1.2:7330")).toBe("http://100.64.1.2:7330");
  });
  it("includes only the permitted action examples and preserves minted metadata", () => {
    overwriteGetLocale(() => "en");
    const read = buildAccessTokenInstructions("https://host", "shp_test", entry);
    expect(read).toContain("/api/me");
    expect(read).toContain("shp_test");
    expect(read).not.toContain("POST /api/sessions");
    expect(read).not.toContain("/reply");
    const submit = buildAccessTokenInstructions("https://host", "shp_test", {
      ...entry,
      scope: "submit",
    });
    expect(submit).toContain("POST /api/sessions");
    expect(submit).not.toContain("/reply");
    const full = buildAccessTokenInstructions("https://host", "shp_test", {
      ...entry,
      scope: "full",
    });
    expect(full).toContain("/reply");
    expect(full).toContain("/interrupt");
    expect(full).toContain("/go");
    expect(full).toContain('"repoPaths": [');
    expect(full).toContain("/repos/a");
  });
  it("keeps untrusted paths inside JSON and localizes the surrounding instructions", () => {
    const path = '/repos/`command`\n"quoted"';
    overwriteGetLocale(() => "de");
    const text = buildAccessTokenInstructions("https://host", "shp_test", {
      ...entry,
      scope: "submit",
      repoPaths: [path],
    });
    expect(text).toContain("Tailnet");
    expect(text).toContain("Arbeitsauftrag");
    const blocks = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
      JSON.parse(match[1]!),
    );
    expect(blocks[0].repoPaths).toEqual([path]);
    expect(blocks[1].repoPath).toBe(path);
    expect(text).not.toContain("`command`");
    overwriteGetLocale(() => "en");
  });
});
