import { expect, test } from "bun:test";
import { SessionActivityPublisher } from "../src/activity-publisher";
import type { SessionActivity } from "../src/activity-signal";
import { activityClock } from "./helpers/activity-clock";

const activity = (ts: number, over: Partial<SessionActivity> = {}): SessionActivity => ({
  lastActivityTs: ts,
  summary: "Read",
  recentTs: [ts],
  recentErrTs: [],
  ...over,
});

function harness() {
  const clock = activityClock();
  const live = new Set(["a", "b"]);
  const frames: { id: string; activity: SessionActivity; at: number }[] = [];
  const publisher = new SessionActivityPublisher(
    (id, activity) => {
      frames.push({ id, activity, at: clock.now() });
    },
    (id) => live.has(id),
    clock,
  );
  return { clock, live, frames, publisher };
}

test("activity publisher sends the first immediately and the last burst state within 2 s", () => {
  const { publisher, clock, frames } = harness();
  publisher.publish("a", activity(1));
  expect(frames).toHaveLength(1);
  for (let i = 1; i <= 10; i++) {
    clock.advance(100);
    publisher.publish("a", activity(i + 1, { runtimeModel: "model", runtimeEffort: "high" }));
  }
  expect(frames).toHaveLength(1);
  clock.advance(999);
  expect(frames).toHaveLength(1);
  clock.advance(1);
  expect(frames.at(-1)).toEqual({
    id: "a",
    activity: activity(11, { runtimeModel: "model", runtimeEffort: "high" }),
    at: 2000,
  });
  expect(clock.size()).toBe(0);
  for (let i = 1; i <= 40; i++) {
    clock.advance(100);
    publisher.publish("a", activity(i + 11));
  }
  clock.advance(2000);
  const times = frames.map((f) => f.at);
  expect(times).toEqual([0, 2000, 4000, 6000, 8000]);
  expect(frames.at(-1)?.activity.lastActivityTs).toBe(51);
});

test("activity publisher handles independent sessions and A-B-A without redundant trailing sends", () => {
  const { publisher, clock, frames } = harness();
  publisher.publish("a", activity(1));
  clock.advance(100);
  publisher.publish("a", activity(2));
  publisher.publish("b", activity(3));
  publisher.publish("a", activity(1));
  clock.advance(1900);
  expect(frames.map((f) => f.id)).toEqual(["a", "b"]);
  publisher.publish("a", activity(4));
  expect(frames.at(-1)?.activity).toEqual(activity(4));
});

test("activity publisher preserves error ticks, all tick counts and newest runtime identity", () => {
  const { publisher, clock, frames } = harness();
  publisher.publish("a", activity(1));
  clock.advance(100);
  publisher.publish("a", activity(2, { recentTs: [1, 2], recentErrTs: [2] }));
  clock.advance(100);
  publisher.publish("a", activity(3, { recentTs: [1, 2, 3], runtimeEffort: "high" }));
  clock.advance(1800);
  expect(frames.at(-1)?.activity).toEqual(
    activity(3, { recentTs: [1, 2, 3], recentErrTs: [2], runtimeEffort: "high" }),
  );
  publisher.publish("a", activity(4));
  clock.advance(2000);
  expect(frames.at(-1)?.activity.recentErrTs).toEqual([]);
});

test("activity publisher forget, prune, archive and stop cancel pending frames", () => {
  const { publisher, clock, frames, live } = harness();
  publisher.publish("a", activity(1));
  publisher.publish("a", activity(2));
  publisher.forget("a");
  expect(clock.size()).toBe(0);
  publisher.publish("a", activity(3));
  expect(frames).toHaveLength(2);
  publisher.publish("a", activity(4));
  publisher.prune(new Set());
  expect(clock.size()).toBe(0);
  publisher.publish("a", activity(5));
  publisher.publish("a", activity(6));
  live.delete("a");
  clock.advance(2000);
  publisher.publish("a", activity(7));
  expect(frames).toHaveLength(3);
  publisher.publish("b", activity(8));
  publisher.publish("b", activity(9));
  publisher.stop();
  expect(clock.size()).toBe(0);
  clock.advance(2000);
  publisher.publish("b", activity(10));
  expect(frames).toHaveLength(4);
});
