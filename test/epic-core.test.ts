import { test, expect, describe } from "bun:test";
import { deriveChildState, selectEpicCandidates, type EpicChild } from "../src/epic-core";

function child(over: Partial<EpicChild> = {}): EpicChild {
  return {
    number: 1,
    title: "t",
    url: "u",
    order: 0,
    body: "",
    blockedBy: [],
    state: "blocked",
    sessionId: null,
    prNumber: null,
    issueClosed: false,
    claimed: false,
    ...over,
  };
}

describe("deriveChildState", () => {
  test("closed → merged", () =>
    expect(deriveChildState(child({ issueClosed: true }), new Set())).toBe("merged"));
  test("session+PR → in-review", () =>
    expect(deriveChildState(child({ sessionId: "s", prNumber: 9 }), new Set())).toBe("in-review"));
  test("session no PR → running", () =>
    expect(deriveChildState(child({ sessionId: "s" }), new Set())).toBe("running"));
  test("blockers closed → ready", () =>
    expect(deriveChildState(child({ blockedBy: [2] }), new Set([2]))).toBe("ready"));
  test("blocker open → blocked", () =>
    expect(deriveChildState(child({ blockedBy: [2] }), new Set())).toBe("blocked"));
  test("claimed, no session, issue open → in-review (retired/in-flight, PR awaiting merge)", () =>
    expect(
      deriveChildState(
        child({ claimed: true, sessionId: null, issueClosed: false, blockedBy: [] }),
        new Set(),
      ),
    ).toBe("in-review"));
});

describe("selectEpicCandidates", () => {
  test("ready, unclaimed, unspawned, in order → Issue[]", () => {
    const kids = [
      child({ number: 320, order: 0, issueClosed: true }), // merged
      child({ number: 322, order: 1, blockedBy: [320] }), // ready (320 closed)
      child({ number: 326, order: 2 }), // ready root
      child({ number: 323, order: 3, blockedBy: [321] }), // blocked (321 open)
      child({ number: 321, order: 4, claimed: true }), // claimed → skip
      child({ number: 999, order: 5, sessionId: "s" }), // running → skip
    ];
    expect(selectEpicCandidates(kids).map((i) => i.number)).toEqual([322, 326]);
  });
  test("ties on order break by number ascending", () => {
    const kids = [child({ number: 30, order: 0 }), child({ number: 12, order: 0 })];
    expect(selectEpicCandidates(kids).map((i) => i.number)).toEqual([12, 30]);
  });
  test("returns Issue-shaped objects carrying the real body", () => {
    const [i] = selectEpicCandidates([
      child({ number: 5, title: "x", url: "ux", body: "full Notion body" }),
    ]);
    expect(i).toEqual({
      number: 5,
      title: "x",
      body: "full Notion body",
      url: "ux",
      labels: [],
      createdAt: 0,
    });
  });
});
