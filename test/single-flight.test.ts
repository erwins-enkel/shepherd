import { test, expect } from "bun:test";
import { singleFlight } from "../src/single-flight";

const defer = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

test("concurrent calls coalesce onto one run and share its result", async () => {
  let runs = 0;
  const d = defer<number>();
  const wrapped = singleFlight(async () => {
    runs++;
    return d.promise;
  });

  const a = wrapped();
  const b = wrapped(); // arrives while the first run is still in flight
  expect(runs).toBe(1); // only ONE underlying run

  d.resolve(42);
  expect(await a).toBe(42);
  expect(await b).toBe(42); // the in-flight caller awaits the real result, not a pre-run value
  expect(runs).toBe(1);
});

test("a call after the prior run settles starts a fresh run", async () => {
  let runs = 0;
  const wrapped = singleFlight(async () => {
    runs++;
    return runs;
  });

  expect(await wrapped()).toBe(1);
  expect(await wrapped()).toBe(2); // slot cleared → new run
  expect(runs).toBe(2);
});

test("the slot clears after a rejection so the next call retries", async () => {
  let runs = 0;
  const wrapped = singleFlight(async () => {
    runs++;
    if (runs === 1) throw new Error("boom");
    return "ok";
  });

  await expect(wrapped()).rejects.toThrow("boom");
  expect(await wrapped()).toBe("ok"); // not wedged on the failed promise
  expect(runs).toBe(2);
});
