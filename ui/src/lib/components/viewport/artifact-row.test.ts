import { describe, expect, test } from "vitest";
import type { SessionArtifact } from "#lib/types.js";
import { artifactsHidden, latestArtifact, publishToolIds, rowArtifacts } from "./artifact-row";

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

  test("a malformed entry (a mirrored machine's relayed list) is skipped, never thrown on", () => {
    const noTime: Partial<SessionArtifact> = a(B, 9);
    delete noTime.updatedAt;
    const list: unknown[] = [
      null,
      "x",
      noTime,
      { ...a(B, 9), updatedAt: Number.NaN },
      { ...a(B, 9), versions: "3" },
      { ...a(B, 9), title: null },
      a(A, 1),
    ];
    expect(latestArtifact(list)?.url).toBe(A);
    expect(latestArtifact({ length: 1, 0: a(A, 1) })).toBeNull();
  });
});

describe("hidden for this session (#3877)", () => {
  const hidden = (x: SessionArtifact, at = 50): SessionArtifact => ({ ...x, hiddenAt: at });

  test("hidden only while every showable entry carries a hide stamp", () => {
    expect(artifactsHidden([])).toBe(false);
    expect(artifactsHidden(undefined)).toBe(false);
    expect(artifactsHidden([hidden(a(A, 1)), hidden(a(B, 2))])).toBe(true);
    // a new url arrives without a stamp: the row shows again
    expect(artifactsHidden([hidden(a(A, 1)), a(B, 2)])).toBe(false);
    // malformed entries neither hide nor show the row
    expect(artifactsHidden([hidden(a(A, 1)), null, { ...a(B, 2), title: null }])).toBe(true);
  });

  test("the rows show nothing while hidden", () => {
    const list = [hidden(a(A, 1)), hidden(a(B, 2))];
    expect(rowArtifacts(list)).toEqual([]);
    expect(latestArtifact(list)).toBeNull();
  });
});

describe("rowArtifacts (#3877)", () => {
  test("newest first, a later entry winning a tie, malformed entries skipped", () => {
    const C = "https://claude.ai/artifact/CCCCCCCCCCCCCCCCCCCCC3";
    expect(rowArtifacts([a(A, 5), a(B, 9), null, a(C, 7)]).map((x) => x.url)).toEqual([B, C, A]);
    expect(rowArtifacts([a(A, 4), a(B, 4)]).map((x) => x.url)).toEqual([B, A]);
  });
});

describe("publishToolIds (#3877)", () => {
  test("two versions of one url mark both calls; hiding the row clears every mark", () => {
    const two: SessionArtifact = { ...a(A, 2), toolUseId: "t2", toolUseIds: ["t1", "t2"] };
    const other: SessionArtifact = { ...a(B, 1), toolUseId: "t3", toolUseIds: ["t3"] };
    expect([...publishToolIds([two, other])].sort()).toEqual(["t1", "t2", "t3"]);
    expect(
      publishToolIds([
        { ...two, hiddenAt: 9 },
        { ...other, hiddenAt: 9 },
      ]).size,
    ).toBe(0);
  });

  test("an entry from a server before #3877 contributes its toolUseId", () => {
    expect([...publishToolIds([{ ...a(A, 1), toolUseId: "t9" }])]).toEqual(["t9"]);
    expect(publishToolIds([a(A, 1)]).size).toBe(0);
  });
});
