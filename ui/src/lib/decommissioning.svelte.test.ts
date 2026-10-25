import { test, expect } from "vitest";
import {
  clearDecommissioning,
  isDecommissioning,
  markDecommissioning,
} from "./decommissioning.svelte";

test("marking holds an id until it is cleared", () => {
  expect(isDecommissioning("d1")).toBe(false);
  markDecommissioning("d1");
  expect(isDecommissioning("d1")).toBe(true);
  expect(isDecommissioning("d2")).toBe(false);
  clearDecommissioning("d1");
  expect(isDecommissioning("d1")).toBe(false);
});
