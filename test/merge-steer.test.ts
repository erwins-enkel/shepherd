import { describe, expect, it } from "bun:test";
import { attachMergeSteer, mergedSteer } from "../src/merge-steer";
import { EventHub } from "../src/events";
import type { GitState } from "../src/forge/types";
import type { Session } from "../src/types";

const git = (state: GitState["state"], extra: Partial<GitState> = {}) =>
  ({
    kind: "github",
    state,
    number: 12,
    checks: "success",
    headSha: "abc",
    baseRefName: "main",
    ...extra,
  }) as GitState;

const session = (extra: Partial<Session> = {}) =>
  ({ id: "s1", status: "idle", auto: false, ...extra }) as Session;

function harness(s: Session | null = session(), seed?: Record<string, GitState>) {
  const events = new EventHub();
  const sent: string[] = [];
  attachMergeSteer(events, { get: () => s ?? undefined } as never, {
    reply: async (_id, text) => {
      sent.push(text);
      return true;
    },
    seed,
  });
  const emit = (g: GitState) => events.emit("session:git", { id: "s1", git: g });
  return { events, sent, emit };
}

describe("mergedSteer", () => {
  it("names PR, base and the stop instruction", () => {
    const t = mergedSteer(git("merged"));
    expect(t).toContain("PR #12 merged into main");
    expect(t).toContain("don't push");
    expect(t).toContain("origin/main");
  });

  it("falls back without a base", () => {
    const t = mergedSteer(git("merged", { baseRefName: undefined }));
    expect(t).toContain("PR #12 merged.");
    expect(t).toContain("the PR's base");
  });
});

describe("attachMergeSteer", () => {
  it("steers once on open→merged", () => {
    const h = harness();
    h.emit(git("open"));
    h.emit(git("merged"));
    h.emit(git("merged"));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain("PR #12 merged into main");
  });

  it("only primes on a first-sighting merge", () => {
    const h = harness();
    h.emit(git("merged"));
    expect(h.sent).toHaveLength(0);
  });

  it("uses the seed: open→merged steers, merged→merged does not", () => {
    const a = harness(session(), { s1: git("open") });
    a.emit(git("merged"));
    expect(a.sent).toHaveLength(1);
    const b = harness(session(), { s1: git("merged") });
    b.emit(git("merged"));
    expect(b.sent).toHaveLength(0);
  });

  for (const [name, extra] of [
    ["auto", { auto: true }],
    ["archived", { status: "archived" }],
    ["terminal", { terminal: true }],
    ["shelved", { shelved: true }],
    ["operator assistant", { operatorAssistant: true }],
  ] as [string, Partial<Session>][]) {
    it(`skips ${name} sessions`, () => {
      const h = harness(session(extra));
      h.emit(git("open"));
      h.emit(git("merged"));
      expect(h.sent).toHaveLength(0);
    });
  }

  it("session:archived clears state", () => {
    const h = harness();
    h.emit(git("open"));
    h.emit(git("merged"));
    h.events.emit("session:archived", { id: "s1" });
    h.emit(git("open"));
    h.emit(git("merged"));
    expect(h.sent).toHaveLength(2);
  });
});
