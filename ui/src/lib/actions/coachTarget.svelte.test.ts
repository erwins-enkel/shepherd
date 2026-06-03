import { test, expect, beforeEach } from "vitest";
import { coachTargets, coachTarget } from "./coachTarget.svelte";

// Vitest runs in Node (no DOM). Cast plain objects as HTMLElement — the action
// only stores the reference in the Map; it never accesses any DOM property.
function fakeNode(): HTMLElement {
  return {} as HTMLElement;
}

beforeEach(() => {
  coachTargets.clear();
});

test("registers a node on mount", () => {
  const node = fakeNode();
  const action = coachTarget(node, "critic");

  expect(coachTargets.get("critic")).toBe(node);

  action.destroy();
});

test("registers multiple nodes with distinct ids", () => {
  const a = fakeNode();
  const b = fakeNode();
  const actionA = coachTarget(a, "critic");
  const actionB = coachTarget(b, "learnings");

  expect(coachTargets.get("critic")).toBe(a);
  expect(coachTargets.get("learnings")).toBe(b);
  expect(coachTargets.size).toBe(2);

  actionA.destroy();
  actionB.destroy();
});

test("destroy removes the entry from the registry", () => {
  const node = fakeNode();
  const action = coachTarget(node, "auto-address");

  expect(coachTargets.has("auto-address")).toBe(true);

  action.destroy();

  expect(coachTargets.has("auto-address")).toBe(false);
});

test("destroy only removes its own entry, not others", () => {
  const a = fakeNode();
  const b = fakeNode();
  const actionA = coachTarget(a, "critic");
  const actionB = coachTarget(b, "learnings");

  actionA.destroy();

  expect(coachTargets.has("critic")).toBe(false);
  expect(coachTargets.get("learnings")).toBe(b);

  actionB.destroy();
});

test("update with a new id moves the entry to the new key", () => {
  const node = fakeNode();
  const action = coachTarget(node, "critic");

  expect(coachTargets.get("critic")).toBe(node);

  action.update("learnings");

  expect(coachTargets.has("critic")).toBe(false);
  expect(coachTargets.get("learnings")).toBe(node);

  action.destroy();
});

test("update with the same id is a no-op", () => {
  const node = fakeNode();
  const action = coachTarget(node, "critic");

  action.update("critic");

  expect(coachTargets.get("critic")).toBe(node);
  expect(coachTargets.size).toBe(1);

  action.destroy();
});

test("update then destroy removes the updated key", () => {
  const node = fakeNode();
  const action = coachTarget(node, "critic");

  action.update("auto-address");
  action.destroy();

  expect(coachTargets.has("critic")).toBe(false);
  expect(coachTargets.has("auto-address")).toBe(false);
});

test("remount after destroy re-registers the node", () => {
  const node = fakeNode();

  const first = coachTarget(node, "critic");
  first.destroy();

  expect(coachTargets.has("critic")).toBe(false);

  const second = coachTarget(node, "critic");

  expect(coachTargets.get("critic")).toBe(node);

  second.destroy();
});
