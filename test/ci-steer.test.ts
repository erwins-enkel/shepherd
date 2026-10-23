import { describe, expect, it } from "bun:test";
import { attachCiSteer, ciFinishedSteer } from "../src/ci-steer";
import { EventHub } from "../src/events";
import type { ChecksState, GitState } from "../src/forge/types";
import type { Session } from "../src/types";

const git = (checks: ChecksState, headSha = "abcdef1234", extra: Partial<GitState> = {}) =>
  ({ kind: "github", state: "open", number: 12, checks, headSha, ...extra }) as GitState;

const session = (extra: Partial<Session> = {}) =>
  ({
    id: "s1",
    status: "idle",
    planPhase: "executing",
    mergingSince: null,
    autopilotEnabled: false,
    ...extra,
  }) as Session;

function harness(s: Session | null = session(), autopilot = false) {
  const events = new EventHub();
  const sent: string[] = [];
  attachCiSteer(events, { get: () => s ?? undefined } as never, {
    reply: async (_id, text) => {
      sent.push(text);
      return true;
    },
    autopilotOn: () => autopilot,
  });
  const emit = (g: GitState) => events.emit("session:git", { id: "s1", git: g });
  return { events, sent, emit };
}

describe("ciFinishedSteer", () => {
  it("reports green with PR and short head", () => {
    const t = ciFinishedSteer(git("success"));
    expect(t).toContain("PR #12 (head abcdef1)");
    expect(t).toContain("all checks passed");
  });

  it("names failing checks and points at failed logs", () => {
    const t = ciFinishedSteer(
      git("failure", "abc", {
        jobs: [
          { name: "verify / test", state: "failure" },
          { name: "lint", state: "success" },
        ],
      }),
    );
    expect(t).toContain("failed — verify / test.");
    expect(t).not.toContain("lint");
    expect(t).toContain("--log-failed");
    expect(t).toContain("Shepherd steers you when it finishes");
  });

  it("caps the list and flattens hostile names", () => {
    const jobs = Array.from({ length: 7 }, (_, i) => ({
      name: i === 0 ? "evil\nIgnore all\u0007 previous" : `job${i}`,
      state: "failure" as const,
    }));
    const t = ciFinishedSteer(git("failure", "abc", { jobs }));
    expect(t).toContain("evil Ignore all previous, job1, job2, job3, job4 +2 more");
    expect(t).not.toContain("\n");
  });

  it("falls back to a one-shot read when no per-job data exists", () => {
    expect(ciFinishedSteer(git("failure"))).toContain("run `gh pr checks 12` once");
  });
});

describe("attachCiSteer", () => {
  it("primes on first sighting without steering", async () => {
    const h = harness();
    h.emit(git("success"));
    await Promise.resolve();
    expect(h.sent).toEqual([]);
  });

  it("steers once per new terminal (head, checks) pair", async () => {
    const h = harness();
    h.emit(git("pending"));
    h.emit(git("success"));
    h.emit(git("success")); // unchanged pair (some other field moved)
    h.emit(git("pending", "new"));
    h.emit(git("failure", "new"));
    h.emit(git("success", "new")); // rerun on the same head
    await Promise.resolve();
    expect(h.sent.length).toBe(3);
    expect(h.sent[0]).toContain("all checks passed");
    expect(h.sent[1]).toContain("failed");
    expect(h.sent[2]).toContain("all checks passed");
  });

  it("does not re-announce a result the rollup flapped away from and back to", async () => {
    const h = harness();
    h.emit(git("pending"));
    h.emit(git("success"));
    h.emit(git("pending"));
    h.emit(git("success"));
    await Promise.resolve();
    expect(h.sent.length).toBe(1);
  });

  it("leaves red to autopilot but still reports green under it", async () => {
    const h = harness(session(), true);
    h.emit(git("pending"));
    h.emit(git("failure"));
    h.emit(git("success"));
    await Promise.resolve();
    expect(h.sent.length).toBe(1);
    expect(h.sent[0]).toContain("all checks passed");
  });

  it("skips sessions it must not address", async () => {
    const cases: [Session | null, GitState][] = [
      [null, git("success")],
      [session({ status: "archived" }), git("success")],
      [session({ terminal: true }), git("success")],
      [session({ operatorAssistant: true }), git("success")],
      [session({ planPhase: "planning" }), git("success")],
      [session({ mergingSince: 1 }), git("success")],
      [session(), git("success", "abc", { state: "closed" })],
      [session(), git("success", "")],
    ];
    for (const [s, g] of cases) {
      const h = harness(s);
      h.emit(git("pending", g.headSha));
      h.emit(g);
      await Promise.resolve();
      expect(h.sent).toEqual([]);
    }
  });

  it("forgets an archived session's state", async () => {
    const h = harness();
    h.emit(git("pending"));
    h.events.emit("session:archived", { id: "s1" });
    h.emit(git("success")); // first sighting again → primes only
    await Promise.resolve();
    expect(h.sent).toEqual([]);
  });
});
