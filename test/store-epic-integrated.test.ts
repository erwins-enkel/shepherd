import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";

test("records and lists integration-merged children per epic parent", () => {
  const s = new SessionStore(":memory:");
  expect([...s.listEpicIntegrated("/r", 327)]).toEqual([]);
  s.recordEpicIntegrated("/r", 327, 320);
  s.recordEpicIntegrated("/r", 327, 320); // idempotent
  s.recordEpicIntegrated("/r", 327, 322);
  expect([...s.listEpicIntegrated("/r", 327)].sort((a, b) => a - b)).toEqual([320, 322]);
  expect([...s.listEpicIntegrated("/r", 999)]).toEqual([]); // scoped by parent
  expect([...s.listEpicIntegrated("/other", 327)]).toEqual([]); // scoped by repo
});

test("recordEpicIntegrated persists prNumber/prUrl; listEpicIntegratedDetails returns them", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicIntegrated("/r", 100, 10, { number: 42, url: "https://github.com/r/pull/42" });
  const details = s.listEpicIntegratedDetails("/r", 100);
  expect(details).toHaveLength(1);
  expect(details[0]!.childNumber).toBe(10);
  expect(details[0]!.prNumber).toBe(42);
  expect(details[0]!.prUrl).toBe("https://github.com/r/pull/42");
  expect(typeof details[0]!.mergedAt).toBe("number");
});

test("re-observe with no pr does not clobber previously-recorded prNumber/prUrl", () => {
  const s = new SessionStore(":memory:");
  const before = Date.now();
  s.recordEpicIntegrated("/r", 100, 10, { number: 42, url: "https://github.com/r/pull/42" });
  const firstDetails = s.listEpicIntegratedDetails("/r", 100);
  const firstMergedAt = firstDetails[0]!.mergedAt;
  expect(firstMergedAt).toBeGreaterThanOrEqual(before);

  // re-observe without PR — should not clobber
  s.recordEpicIntegrated("/r", 100, 10);
  const details = s.listEpicIntegratedDetails("/r", 100);
  expect(details[0]!.prNumber).toBe(42);
  expect(details[0]!.prUrl).toBe("https://github.com/r/pull/42");
  // createdAt/mergedAt must be preserved (first observation wins)
  expect(details[0]!.mergedAt).toBe(firstMergedAt);
});

test("re-observe with empty url does not clobber previously-recorded prUrl", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicIntegrated("/r", 100, 10, { number: 42, url: "https://github.com/r/pull/42" });
  // re-observe with a pr carrying empty url
  s.recordEpicIntegrated("/r", 100, 10, { number: 42, url: "" });
  const details = s.listEpicIntegratedDetails("/r", 100);
  expect(details[0]!.prUrl).toBe("https://github.com/r/pull/42");
});

test("first observation stamps createdAt; later conflicting insert preserves it", () => {
  const s = new SessionStore(":memory:");
  const t0 = Date.now();
  s.recordEpicIntegrated("/r", 100, 10);
  const first = s.listEpicIntegratedDetails("/r", 100)[0]!;
  expect(first.mergedAt).toBeGreaterThanOrEqual(t0);
  // wait a tick then re-record — createdAt must not change, but PR columns must fill in
  s.recordEpicIntegrated("/r", 100, 10, { number: 99, url: "https://github.com/r/pull/99" });
  const after = s.listEpicIntegratedDetails("/r", 100)[0]!;
  expect(after.mergedAt).toBe(first.mergedAt);
  // COALESCE null→value: the second call must have filled in prNumber + prUrl
  expect(after.prNumber).toBe(99);
  expect(after.prUrl).toBe("https://github.com/r/pull/99");
});

test("3-arg recordEpicIntegrated + listEpicIntegrated Set behavior unchanged", () => {
  const s = new SessionStore(":memory:");
  s.recordEpicIntegrated("/r", 200, 11);
  s.recordEpicIntegrated("/r", 200, 12);
  s.recordEpicIntegrated("/r", 200, 11); // idempotent
  const set = s.listEpicIntegrated("/r", 200);
  expect(set instanceof Set).toBe(true);
  expect([...set].sort((a, b) => a - b)).toEqual([11, 12]);
  const details = s.listEpicIntegratedDetails("/r", 200);
  expect(details[0]!.prNumber).toBeNull();
  expect(details[0]!.prUrl).toBeNull();
});
