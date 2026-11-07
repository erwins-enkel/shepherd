import { describe, expect, it } from "bun:test";
import { BucketRateLimit } from "../src/forge/rate-limit";
import { createRateLimitSteer, rateLimitSteer } from "../src/rate-limit-steer";
import type { Session } from "../src/types";

const T0 = Date.parse("2026-11-07T12:00:00.000Z");

const session = (id: string, extra: Partial<Session> = {}) =>
  ({ id, status: "running", agentProvider: "claude", ...extra }) as Session;

function harness(initial: Session[]) {
  let now = T0;
  const clock = () => now;
  const graphql = new BucketRateLimit({ now: clock, maxCooldownMs: 15 * 60_000 });
  const idle = new BucketRateLimit({ now: clock });
  const list = { sessions: initial };
  const sent: { id: string; text: string }[] = [];
  const steer = createRateLimitSteer({
    backoff: () => ({
      graphql: graphql.snapshot(),
      restRead: idle.snapshot(),
      restWrite: idle.snapshot(),
    }),
    sessions: () => list.sessions,
    reply: async (id, text) => {
      sent.push({ id, text });
      return true;
    },
    now: clock,
  });
  /** Empty bucket after a limit error: held until just past `resetAt`. */
  const drain = (resetInMs: number) =>
    graphql.noteLimitError(undefined, "test", { remaining: 0, resetAt: now + resetInMs });
  const advance = (ms: number) => {
    now += ms;
  };
  return { graphql, list, sent, steer, drain, advance, ids: () => sent.map((s) => s.id) };
}

describe("rateLimitSteer", () => {
  it("names the reset and keeps git push allowed", () => {
    const t = rateLimitSteer("2026-11-07T12:30:05.000Z");
    expect(t).toContain("2026-11-07T12:30:05.000Z");
    expect(t).toContain("no `gh` calls");
    expect(t).toContain("`git push`");
    expect(t).toContain("self_status");
  });
});

describe("createRateLimitSteer", () => {
  it("steers each working session once per window with the real reset", () => {
    const h = harness([session("a"), session("b")]);
    h.drain(30 * 60_000);
    h.steer.tick();
    h.steer.tick();
    h.advance(15_000);
    h.steer.tick();
    expect(h.ids()).toEqual(["a", "b"]);
    expect(h.sent[0]!.text).toContain(new Date(T0 + 30 * 60_000 + 5_000).toISOString());
  });

  it("skips idle, blocked, codex, plain, terminal, assistant and shelved sessions", () => {
    const h = harness([
      session("idle", { status: "idle" }),
      session("blocked", { status: "blocked" }),
      session("codex", { agentProvider: "codex" }),
      session("plain", { plain: true }),
      session("term", { terminal: true }),
      session("assistant", { operatorAssistant: true }),
      session("shelved", { shelved: true }),
      session("ok"),
    ]);
    h.drain(30 * 60_000);
    h.steer.tick();
    expect(h.ids()).toEqual(["ok"]);
  });

  it("steers a session that starts working mid-window, once", () => {
    const h = harness([session("a"), session("late", { status: "idle" })]);
    h.drain(30 * 60_000);
    h.steer.tick();
    h.list.sessions = [session("a"), session("late")];
    h.advance(15_000);
    h.steer.tick();
    h.steer.tick();
    expect(h.ids()).toEqual(["a", "late"]);
  });

  it("stays quiet while the reset is under a minute away, then steers once it is extended", () => {
    const h = harness([session("a")]);
    h.graphql.noteLimitError(undefined, "no reading"); // 60s cooldown
    h.advance(1_000);
    h.steer.tick();
    expect(h.sent).toHaveLength(0);
    h.drain(20 * 60_000); // same window, now held to resetAt
    h.steer.tick();
    expect(h.ids()).toEqual(["a"]);
  });

  it("steers again once the told reset is five minutes past", () => {
    const h = harness([session("a")]);
    h.drain(5 * 60_000);
    h.steer.tick();
    h.advance(6 * 60_000);
    h.steer.tick(); // window lifted
    h.drain(10 * 60_000); // re-engaged 55s after the told reset: same outage
    h.steer.tick();
    expect(h.ids()).toEqual(["a"]);
    h.advance(20 * 60_000);
    h.steer.tick(); // lifted
    h.drain(10 * 60_000);
    h.steer.tick();
    expect(h.ids()).toEqual(["a", "a"]);
  });

  it("steers an escalating cooldown at 120s, stays quiet inside the gap, re-steers at 15m", () => {
    const h = harness([session("a")]);
    for (const cooldownMs of [60_000, 120_000, 240_000, 480_000, 900_000]) {
      h.graphql.noteLimitError(undefined, "no reading");
      h.advance(1_000);
      h.steer.tick();
      h.advance(cooldownMs); // lapses before the next strike
      h.steer.tick();
    }
    expect(h.ids()).toEqual(["a", "a"]);
    expect(h.sent[0]!.text).toContain(new Date(T0 + 61_000 + 120_000).toISOString());
    // The 900s strike lands at T0+904s, past the told reset (T0+181s) + 5 min.
    expect(h.sent[1]!.text).toContain(new Date(T0 + 904_000 + 900_000).toISOString());
  });

  it("does not re-steer a re-engagement to the same reset", () => {
    const h = harness([session("a")]);
    const resetAt = T0 + 20 * 60_000;
    h.graphql.note({ remaining: 50, resetAt });
    h.steer.tick();
    h.graphql.noteSuccess(); // cleared…
    h.advance(15_000);
    h.graphql.note({ remaining: 40, resetAt }); // …and engaged again: a new window, same reset
    h.steer.tick();
    expect(h.ids()).toEqual(["a"]);
  });

  it("treats Shepherd's own floor engagement like a limit error", () => {
    const h = harness([session("a")]);
    h.graphql.note({ remaining: 50, resetAt: T0 + 20 * 60_000 });
    h.steer.tick();
    expect(h.ids()).toEqual(["a"]);
  });

  it("does nothing while GraphQL is not blocked", () => {
    const h = harness([session("a")]);
    h.graphql.note({ remaining: 4_000, resetAt: T0 + 20 * 60_000 });
    h.steer.tick();
    expect(h.sent).toHaveLength(0);
  });
});
