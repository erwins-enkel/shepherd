import { test, expect } from "bun:test";
import { mapCheckState, rollupChecks } from "../../src/forge/checks";

test("mapCheckState: incomplete status → pending", () => {
  expect(mapCheckState("in_progress", null)).toBe("pending");
  expect(mapCheckState("queued", null)).toBe("pending");
  expect(mapCheckState("waiting", null)).toBe("pending");
});

test("mapCheckState: completed conclusions", () => {
  expect(mapCheckState("completed", "success")).toBe("success");
  expect(mapCheckState("completed", "failure")).toBe("failure");
  expect(mapCheckState("completed", "cancelled")).toBe("failure");
  expect(mapCheckState("completed", "timed_out")).toBe("failure");
  expect(mapCheckState("completed", "skipped")).toBe("none");
  expect(mapCheckState("completed", "neutral")).toBe("none");
});

test("mapCheckState: case-insensitive + nullish", () => {
  expect(mapCheckState("COMPLETED", "SUCCESS")).toBe("success");
  expect(mapCheckState(null, null)).toBe("none");
});

test("rollupChecks: no checks → none", () => {
  expect(rollupChecks([])).toBe("none");
});

test("rollupChecks: all completed+success → success", () => {
  expect(
    rollupChecks([
      { status: "completed", conclusion: "success" },
      { status: "completed", conclusion: "success" },
    ]),
  ).toBe("success");
});

test("rollupChecks: any incomplete status → pending (over success)", () => {
  expect(
    rollupChecks([
      { status: "completed", conclusion: "success" },
      { status: "in_progress", conclusion: null },
    ]),
  ).toBe("pending");
});

test("rollupChecks: any failure dominates pending and success", () => {
  expect(
    rollupChecks([
      { status: "in_progress", conclusion: null },
      { status: "completed", conclusion: "success" },
      { status: "completed", conclusion: "failure" },
    ]),
  ).toBe("failure");
});

test("rollupChecks: error/cancelled/timed_out count as failure", () => {
  expect(rollupChecks([{ status: "completed", conclusion: "error" }])).toBe("failure");
  expect(rollupChecks([{ status: "completed", conclusion: "cancelled" }])).toBe("failure");
  expect(rollupChecks([{ status: "completed", conclusion: "timed_out" }])).toBe("failure");
});

test("rollupChecks: neutral/skipped are ignored (success if alongside a success)", () => {
  expect(
    rollupChecks([
      { status: "completed", conclusion: "skipped" },
      { status: "completed", conclusion: "success" },
    ]),
  ).toBe("success");
});

test("rollupChecks: only neutral/skipped → none", () => {
  expect(
    rollupChecks([
      { status: "completed", conclusion: "neutral" },
      { status: "completed", conclusion: "skipped" },
    ]),
  ).toBe("none");
});

test("rollupChecks: case-insensitive conclusions", () => {
  expect(rollupChecks([{ status: "COMPLETED", conclusion: "SUCCESS" }])).toBe("success");
  expect(rollupChecks([{ status: "Completed", conclusion: "Failure" }])).toBe("failure");
});
