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
