import { test, expect } from "bun:test";
import {
  jobsFromRollup,
  mapCheckState,
  mapGiteaActionStatus,
  mapStatusState,
  rollupChecks,
} from "../../src/forge/checks";

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

test("rollupChecks: folds in legacy StatusContext entries (not 'none')", () => {
  // A repo running only commit statuses (no Actions) — must still roll up to a
  // real state so the PRs-tab dot (and its expand) appear.
  expect(
    rollupChecks([{ __typename: "StatusContext", context: "ci/circleci", state: "SUCCESS" }]),
  ).toBe("success");
  expect(
    rollupChecks([
      { __typename: "StatusContext", context: "ci/circleci", state: "SUCCESS" },
      { __typename: "StatusContext", context: "netlify", state: "FAILURE" },
    ]),
  ).toBe("failure");
});

test("mapStatusState: maps the coarse StatusContext/Gitea vocab", () => {
  expect(mapStatusState("SUCCESS")).toBe("success");
  expect(mapStatusState("pending")).toBe("pending");
  expect(mapStatusState("expected")).toBe("pending");
  expect(mapStatusState("running")).toBe("pending");
  expect(mapStatusState("failure")).toBe("failure");
  expect(mapStatusState("error")).toBe("failure");
  expect(mapStatusState("")).toBe("none");
  expect(mapStatusState(null)).toBe("none");
});

test("mapGiteaActionStatus: maps the native Actions tasks enum", () => {
  expect(mapGiteaActionStatus("success")).toBe("success");
  expect(mapGiteaActionStatus("failure")).toBe("failure");
  expect(mapGiteaActionStatus("cancelled")).toBe("failure");
  expect(mapGiteaActionStatus("canceled")).toBe("failure");
  expect(mapGiteaActionStatus("running")).toBe("pending");
  expect(mapGiteaActionStatus("waiting")).toBe("pending");
  expect(mapGiteaActionStatus("blocked")).toBe("pending");
  expect(mapGiteaActionStatus("cancelling")).toBe("pending");
  expect(mapGiteaActionStatus("skipped")).toBe("none");
  expect(mapGiteaActionStatus("unknown")).toBe("none");
});

test("mapGiteaActionStatus: case-insensitive + empty/nullish/unrecognized → none", () => {
  expect(mapGiteaActionStatus("SUCCESS")).toBe("success");
  expect(mapGiteaActionStatus("Failure")).toBe("failure");
  expect(mapGiteaActionStatus("RUNNING")).toBe("pending");
  expect(mapGiteaActionStatus("")).toBe("none");
  expect(mapGiteaActionStatus(null)).toBe("none");
  expect(mapGiteaActionStatus(undefined)).toBe("none");
  expect(mapGiteaActionStatus("bogus")).toBe("none");
});

test("jobsFromRollup: CheckRun entries are qualified with their workflow name", () => {
  expect(
    jobsFromRollup([
      {
        __typename: "CheckRun",
        name: "lint",
        workflowName: "CI",
        status: "completed",
        conclusion: "success",
        detailsUrl: "https://gh/a",
      },
      {
        __typename: "CheckRun",
        name: "build",
        status: "in_progress",
        conclusion: null,
      },
    ]),
  ).toEqual([
    { name: "CI / lint", state: "success", url: "https://gh/a" },
    { name: "build", state: "pending", url: undefined },
  ]);
});

test("jobsFromRollup: legacy StatusContext entries map context + state + targetUrl", () => {
  expect(
    jobsFromRollup([
      { __typename: "StatusContext", context: "netlify", state: "FAILURE", targetUrl: "https://n" },
    ]),
  ).toEqual([{ name: "netlify", state: "failure", url: "https://n" }]);
});

test("jobsFromRollup: entries without a usable label are dropped", () => {
  expect(
    jobsFromRollup([{ __typename: "CheckRun", status: "completed", conclusion: "success" }]),
  ).toEqual([]);
});
