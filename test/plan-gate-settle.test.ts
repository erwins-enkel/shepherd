import { expect, test } from "bun:test";
import { shouldConsiderOnSettle } from "../src/plan-gate";
import type { Session } from "../src/types";

test("shouldConsiderOnSettle truth table", () => {
  const planning: Session["planPhase"] = "planning";
  const executing: Session["planPhase"] = "executing";

  expect(shouldConsiderOnSettle("done", planning, undefined)).toBe(true);
  expect(shouldConsiderOnSettle("done", planning, "changes_requested")).toBe(true);
  expect(shouldConsiderOnSettle("idle", planning, "changes_requested")).toBe(true);
  expect(shouldConsiderOnSettle("idle", planning, "error")).toBe(false);
  expect(shouldConsiderOnSettle("idle", planning, "approved")).toBe(false);
  expect(shouldConsiderOnSettle("idle", planning, undefined)).toBe(false);
  expect(shouldConsiderOnSettle("running", planning, "changes_requested")).toBe(false);
  expect(shouldConsiderOnSettle("blocked", planning, "changes_requested")).toBe(false);
  expect(shouldConsiderOnSettle("done", executing, "changes_requested")).toBe(false);
  expect(shouldConsiderOnSettle("idle", null, "changes_requested")).toBe(false);
});
