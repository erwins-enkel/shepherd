import { describe, expect, test } from "vitest";
import type { SessionArtifact } from "#lib/types.js";
import { latestArtifact } from "./artifact-row";

const a = (url: string, updatedAt: number): SessionArtifact => ({
  url,
  title: url,
  versions: 1,
  firstSeenAt: 0,
  updatedAt,
  toolUseId: null,
});
const A = "https://claude.ai/artifact/AAAAAAAAAAAAAAAAAAAAA1";
const B = "https://claude.ai/code/artifact/BBBBBBBBBBBBBBBBBBBBB2";

describe("latestArtifact", () => {
  test("none for a session without artifacts", () => {
    expect(latestArtifact(undefined)).toBeNull();
    expect(latestArtifact([])).toBeNull();
  });

  test("the most recently updated one, a later entry winning a tie", () => {
    expect(latestArtifact([a(A, 5), a(B, 3)])?.url).toBe(A);
    expect(latestArtifact([a(A, 3), a(B, 5)])?.url).toBe(B);
    expect(latestArtifact([a(A, 4), a(B, 4)])?.url).toBe(B);
  });

  test("an entry whose url is no claude.ai artifact is never shown", () => {
    expect(latestArtifact([a(A, 1), a("javascript:alert(1)", 9)])?.url).toBe(A);
    expect(latestArtifact([a("https://evil.example/artifact/x", 9)])).toBeNull();
  });
});
