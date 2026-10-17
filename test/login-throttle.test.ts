import { test, expect } from "bun:test";
import { LoginThrottle, FREE_FAILURES, MAX_COOLDOWN_MS } from "../src/login-throttle";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function fail(th: LoginThrottle, peer: string, times: number) {
  for (let i = 0; i < times; i++) {
    expect(th.begin(peer).ok).toBe(true);
    th.settle(peer, false);
  }
}

test("the first FREE_FAILURES wrong passwords are never throttled", () => {
  const th = new LoginThrottle(clock().now);
  fail(th, "a", FREE_FAILURES - 1);
  expect(th.begin("a").ok).toBe(true);
});

test("after FREE_FAILURES failures the cooldown grows exponentially and is capped", () => {
  const c = clock();
  const th = new LoginThrottle(c.now);
  fail(th, "a", FREE_FAILURES);
  expect(th.begin("a")).toEqual({ ok: false, retryAfterSec: 1 });
  c.advance(1_000);
  fail(th, "a", 1); // 6th failure → 2s
  expect(th.begin("a")).toEqual({ ok: false, retryAfterSec: 2 });
  c.advance(2_000);
  fail(th, "a", 1); // 7th → 4s
  expect(th.begin("a")).toEqual({ ok: false, retryAfterSec: 4 });
  for (let i = 0; i < 20; i++) {
    c.advance(MAX_COOLDOWN_MS);
    fail(th, "a", 1);
  }
  expect(th.begin("a")).toEqual({ ok: false, retryAfterSec: MAX_COOLDOWN_MS / 1000 });
});

test("a concurrent attempt from the same peer is refused while one verify is in flight", () => {
  const th = new LoginThrottle(clock().now);
  expect(th.begin("a").ok).toBe(true);
  expect(th.begin("a").ok).toBe(false);
  expect(th.begin("b").ok).toBe(true); // other peers are independent
  th.settle("a", false);
  expect(th.begin("a").ok).toBe(true);
});

test("a success clears the peer's failure history", () => {
  const th = new LoginThrottle(clock().now);
  fail(th, "a", FREE_FAILURES - 1);
  expect(th.begin("a").ok).toBe(true);
  th.settle("a", true);
  fail(th, "a", FREE_FAILURES - 1);
  expect(th.begin("a").ok).toBe(true);
});

test("release frees the in-flight slot without counting a failure", () => {
  const th = new LoginThrottle(clock().now);
  for (let i = 0; i < FREE_FAILURES * 2; i++) {
    expect(th.begin("a").ok).toBe(true);
    th.release("a");
  }
});

test("failures are forgotten an hour after the last one", () => {
  const c = clock();
  const th = new LoginThrottle(c.now);
  fail(th, "a", FREE_FAILURES);
  c.advance(60 * 60_000);
  fail(th, "a", FREE_FAILURES - 1); // a fresh allowance, not an instant cooldown
  expect(th.begin("a").ok).toBe(true);
});
