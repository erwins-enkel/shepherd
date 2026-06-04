import { test, expect } from "bun:test";
import { maintenance } from "../src/maintenance";

test("starts inactive", () => {
  expect(maintenance.active).toBe(false);
});

test("begin() activates, end() deactivates", () => {
  maintenance.begin();
  expect(maintenance.active).toBe(true);
  maintenance.end();
  expect(maintenance.active).toBe(false);
});

test("begin()/end() are idempotent", () => {
  maintenance.begin();
  maintenance.begin();
  expect(maintenance.active).toBe(true);
  maintenance.end();
  maintenance.end();
  expect(maintenance.active).toBe(false);
});
