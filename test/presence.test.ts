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

test("connect makes hasClients() true; drop clears it", () => {
  const p = new Presence();
  const a = {};
  expect(p.hasClients()).toBe(false);
  p.connect(a);
  expect(p.hasClients()).toBe(true);
  p.drop(a);
  expect(p.hasClients()).toBe(false);
});

test("connected and active are distinct sets — connect does not mark active", () => {
  const p = new Presence();
  const a = {};
  p.connect(a);
  expect(p.hasClients()).toBe(true);
  expect(p.isActive()).toBe(false); // a connection is not yet a focused window
});

test("drop removes from BOTH connected and active", () => {
  const p = new Presence();
  const a = {};
  p.connect(a);
  p.set(a, true);
  expect(p.hasClients()).toBe(true);
  expect(p.isActive()).toBe(true);
  p.drop(a);
  expect(p.hasClients()).toBe(false);
  expect(p.isActive()).toBe(false);
});

test("onActivate fires exactly once on the 0→1 transition, not on a second connect", () => {
  let fires = 0;
  const p = new Presence(() => fires++);
  const a = {};
  const b = {};
  p.connect(a);
  expect(fires).toBe(1);
  p.connect(b); // 1→2, not an empty→non-empty edge
  expect(fires).toBe(1);
});

test("onActivate re-arms after connected empties and a new connect arrives", () => {
  let fires = 0;
  const p = new Presence(() => fires++);
  const a = {};
  const b = {};
  p.connect(a);
  expect(fires).toBe(1);
  p.drop(a); // connected now empty → re-armed
  p.connect(b); // empty→non-empty again
  expect(fires).toBe(2);
});
