import { expect, test } from "bun:test";
import { AttemptBudget } from "../src/attempt-budget";

test("allows 10 attempts per peer per window, then refuses", () => {
  const budget = new AttemptBudget(() => 0);
  for (let i = 0; i < 10; i++) expect(budget.allowAttempt("a")).toBe(true);
  expect(budget.allowAttempt("a")).toBe(false);
  expect(budget.allowAttempt("b")).toBe(true); // buckets are per peer
});

test("window expiry resets the bucket", () => {
  let now = 0;
  const budget = new AttemptBudget(() => now);
  for (let i = 0; i < 11; i++) budget.allowAttempt("a");
  expect(budget.allowAttempt("a")).toBe(false);
  now = 60_000;
  expect(budget.allowAttempt("a")).toBe(true);
});

test("peer table saturation fails closed for new peers", () => {
  const budget = new AttemptBudget(() => 0);
  for (let i = 0; i < 1024; i++) expect(budget.allowAttempt(`p${i}`)).toBe(true);
  expect(budget.allowAttempt("new")).toBe(false);
  expect(budget.allowAttempt("p0")).toBe(true); // existing buckets still count normally
});

test("a global cap bounds every peer together, and resets with its window (#3338)", () => {
  let now = 0;
  const budget = new AttemptBudget(() => now, 25);
  for (let i = 0; i < 25; i++) expect(budget.allowAttempt(`p${i}`)).toBe(true);
  expect(budget.allowAttempt("fresh")).toBe(false);
  now = 60_000;
  expect(budget.allowAttempt("fresh")).toBe(true);
});

test("a peer over its own limit does not drain the global pool (#3338)", () => {
  const budget = new AttemptBudget(() => 0, 25);
  for (let i = 0; i < 100; i++) budget.allowAttempt("noisy");
  // noisy got 10 through; 15 remain for everyone else
  for (let i = 0; i < 15; i++) expect(budget.allowAttempt(`p${i}`)).toBe(true);
  expect(budget.allowAttempt("late")).toBe(false);
});
