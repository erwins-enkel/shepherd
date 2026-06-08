import { test, expect } from "bun:test";
import { validateBuildSteps, validateBuildStepStatus, BUILD_STEP_STATUSES } from "../src/validate";

// ── validateBuildSteps ────────────────────────────────────────────────────────

test("validateBuildSteps: valid minimal step", () => {
  const result = validateBuildSteps({ steps: [{ title: "Do thing" }] });
  expect(result).not.toBeNull();
  expect(result!.at(0)!.title).toBe("Do thing");
});

test("validateBuildSteps: trims title", () => {
  const result = validateBuildSteps({ steps: [{ title: "  trimmed  " }] });
  expect(result!.at(0)!.title).toBe("trimmed");
});

test("validateBuildSteps: normalizes optional fields", () => {
  const result = validateBuildSteps({
    steps: [{ title: "T", detail: "  some detail  ", id: " my-id ", status: "active" }],
  });
  expect(result!.at(0)).toMatchObject({
    title: "T",
    detail: "some detail",
    id: "my-id",
    status: "active",
  });
});

test("validateBuildSteps: absent optional fields not included", () => {
  const result = validateBuildSteps({ steps: [{ title: "T" }] });
  expect(result!.at(0)).not.toHaveProperty("detail");
  expect(result!.at(0)).not.toHaveProperty("id");
  expect(result!.at(0)).not.toHaveProperty("status");
});

test("validateBuildSteps: empty detail trimmed to empty string is ok", () => {
  const result = validateBuildSteps({ steps: [{ title: "T", detail: "   " }] });
  expect(result!.at(0)!.detail).toBe("");
});

test("validateBuildSteps: rejects non-object body", () => {
  expect(validateBuildSteps("not-an-object")).toBeNull();
  expect(validateBuildSteps(null)).toBeNull();
  expect(validateBuildSteps([])).toBeNull();
  expect(validateBuildSteps(42)).toBeNull();
});

test("validateBuildSteps: rejects missing steps key", () => {
  expect(validateBuildSteps({})).toBeNull();
});

test("validateBuildSteps: rejects non-array steps", () => {
  expect(validateBuildSteps({ steps: "not-array" })).toBeNull();
  expect(validateBuildSteps({ steps: null })).toBeNull();
});

test("validateBuildSteps: rejects empty title", () => {
  expect(validateBuildSteps({ steps: [{ title: "" }] })).toBeNull();
  expect(validateBuildSteps({ steps: [{ title: "   " }] })).toBeNull();
});

test("validateBuildSteps: rejects missing title", () => {
  expect(validateBuildSteps({ steps: [{}] })).toBeNull();
});

test("validateBuildSteps: rejects title > 200 chars", () => {
  expect(validateBuildSteps({ steps: [{ title: "a".repeat(201) }] })).toBeNull();
});

test("validateBuildSteps: accepts title exactly 200 chars", () => {
  const result = validateBuildSteps({ steps: [{ title: "a".repeat(200) }] });
  expect(result).not.toBeNull();
  expect(result!.at(0)!.title.length).toBe(200);
});

test("validateBuildSteps: rejects detail > 4000 chars", () => {
  expect(validateBuildSteps({ steps: [{ title: "T", detail: "x".repeat(4001) }] })).toBeNull();
});

test("validateBuildSteps: accepts detail exactly 4000 chars", () => {
  const result = validateBuildSteps({ steps: [{ title: "T", detail: "x".repeat(4000) }] });
  expect(result).not.toBeNull();
});

test("validateBuildSteps: rejects > 100 steps", () => {
  const steps = Array.from({ length: 101 }, (_, i) => ({ title: `Step ${i}` }));
  expect(validateBuildSteps({ steps })).toBeNull();
});

test("validateBuildSteps: accepts exactly 100 steps", () => {
  const steps = Array.from({ length: 100 }, (_, i) => ({ title: `Step ${i}` }));
  expect(validateBuildSteps({ steps })).not.toBeNull();
});

test("validateBuildSteps: rejects bad status", () => {
  expect(validateBuildSteps({ steps: [{ title: "T", status: "unknown" }] })).toBeNull();
  expect(validateBuildSteps({ steps: [{ title: "T", status: 42 }] })).toBeNull();
});

test("validateBuildSteps: accepts all valid statuses", () => {
  for (const status of BUILD_STEP_STATUSES) {
    const result = validateBuildSteps({ steps: [{ title: "T", status }] });
    expect(result).not.toBeNull();
    expect(result!.at(0)!.status).toBe(status);
  }
});

test("validateBuildSteps: rejects non-string id", () => {
  expect(validateBuildSteps({ steps: [{ title: "T", id: 42 }] })).toBeNull();
});

test("validateBuildSteps: rejects empty id", () => {
  expect(validateBuildSteps({ steps: [{ title: "T", id: "" }] })).toBeNull();
});

test("validateBuildSteps: rejects id > 200 chars", () => {
  expect(validateBuildSteps({ steps: [{ title: "T", id: "x".repeat(201) }] })).toBeNull();
});

test("validateBuildSteps: accepts empty array", () => {
  const result = validateBuildSteps({ steps: [] });
  expect(result).toEqual([]);
});

// ── validateBuildStepStatus ───────────────────────────────────────────────────

test("validateBuildStepStatus: accepts each valid status", () => {
  for (const status of BUILD_STEP_STATUSES) {
    expect(validateBuildStepStatus({ status })).toBe(status);
  }
});

test("validateBuildStepStatus: rejects unknown status", () => {
  expect(validateBuildStepStatus({ status: "unknown" })).toBeNull();
  expect(validateBuildStepStatus({ status: "DONE" })).toBeNull();
  expect(validateBuildStepStatus({ status: "" })).toBeNull();
});

test("validateBuildStepStatus: rejects non-string status", () => {
  expect(validateBuildStepStatus({ status: 42 })).toBeNull();
  expect(validateBuildStepStatus({ status: null })).toBeNull();
  expect(validateBuildStepStatus({ status: true })).toBeNull();
});

test("validateBuildStepStatus: rejects missing status", () => {
  expect(validateBuildStepStatus({})).toBeNull();
});

test("validateBuildStepStatus: rejects non-object body", () => {
  expect(validateBuildStepStatus(null)).toBeNull();
  expect(validateBuildStepStatus("done")).toBeNull();
  expect(validateBuildStepStatus([])).toBeNull();
});
