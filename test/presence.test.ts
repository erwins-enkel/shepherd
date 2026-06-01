import { test, expect } from "bun:test";
import { Presence } from "../src/presence";

test("a fresh tracker reports no active client", () => {
  expect(new Presence().isActive()).toBe(false);
});

test("set(client, true) makes the tracker active; false clears it", () => {
  const p = new Presence();
  const a = {};
  p.set(a, true);
  expect(p.isActive()).toBe(true);
  p.set(a, false);
  expect(p.isActive()).toBe(false);
});

test("isActive is true while ANY client is active", () => {
  const p = new Presence();
  const a = {};
  const b = {};
  p.set(a, true);
  p.set(b, false);
  expect(p.isActive()).toBe(true); // a still active
  p.set(a, false);
  expect(p.isActive()).toBe(false); // both inactive now
});

test("drop removes a client even if it was active (disconnect)", () => {
  const p = new Presence();
  const a = {};
  p.set(a, true);
  p.drop(a);
  expect(p.isActive()).toBe(false);
});
