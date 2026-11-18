import { describe, expect, test } from "bun:test";
import { isArtifactUrl, shortArtifactUrl } from "../shared/artifact-url";

describe("isArtifactUrl", () => {
  test("accepts the two private claude.ai forms", () => {
    expect(isArtifactUrl("https://claude.ai/artifact/GEQx5QVP82WzdTBfcxx313")).toBe(true);
    expect(isArtifactUrl("https://claude.ai/code/artifact/GEQx5QVP82WzdTBfcxx313")).toBe(true);
  });

  test.each([
    "https://claude.ai/public/artifacts/GEQx5QVP82WzdTBfcxx313",
    "https://claude.site/artifacts/GEQx5QVP82WzdTBfcxx313",
    "http://claude.ai/artifact/GEQx5QVP82WzdTBfcxx313",
    "https://claude.ai/artifact/GEQx5QVP82WzdTBfcxx313?x=1",
    "https://claude.ai/artifact/GEQx5QVP82WzdTBfcxx313#top",
    "https://claude.ai/artifact/GEQx5QVP82WzdTBfcxx313/",
    "https://claude.ai:443/artifact/GEQx5QVP82WzdTBfcxx313",
    "https://user@claude.ai/artifact/GEQx5QVP82WzdTBfcxx313",
    "https://evil.example/artifact/GEQx5QVP82WzdTBfcxx313",
    "https://claude.ai.evil.example/artifact/GEQx5QVP82WzdTBfcxx313",
    "https://claude.ai/artifact/",
    "https://claude.ai/artifact/../x",
    " https://claude.ai/artifact/GEQx5QVP82WzdTBfcxx313",
    `https://claude.ai/artifact/${"a".repeat(65)}`,
  ])("rejects %s", (url) => {
    expect(isArtifactUrl(url)).toBe(false);
  });

  test("rejects non-strings", () => {
    expect(isArtifactUrl(undefined)).toBe(false);
    expect(isArtifactUrl(42)).toBe(false);
  });
});

describe("shortArtifactUrl", () => {
  test("drops the scheme and cuts a long id in the middle", () => {
    expect(shortArtifactUrl("https://claude.ai/artifact/GEQx5QVP82WzdTBfcxx313")).toBe(
      "claude.ai/artifact/GEQx…313",
    );
    expect(shortArtifactUrl("https://claude.ai/code/artifact/GEQx5QVP82WzdTBfcxx313")).toBe(
      "claude.ai/code/artifact/GEQx…313",
    );
  });

  test("keeps a short id whole and leaves a foreign value alone", () => {
    expect(shortArtifactUrl("https://claude.ai/artifact/abc123")).toBe("claude.ai/artifact/abc123");
    expect(shortArtifactUrl("https://example.com/x")).toBe("https://example.com/x");
  });
});
