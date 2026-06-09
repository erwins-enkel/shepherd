import { expect, test } from "bun:test";
import {
  composeSystemPrompt,
  PLAN_GATE_DIRECTIVE_INTERACTIVE,
  PLAN_GATE_DIRECTIVE_AUTO,
} from "../src/service";

test("plan-gate interactive directive replaces autopilot directive", () => {
  const p = composeSystemPrompt(null, true, { planGate: "interactive" });
  expect(p).toContain("plan-gate-directive");
  expect(p).toContain(".shepherd-plan.md");
  expect(p).not.toContain("autopilot-directive"); // suppressed during planning
});
test("plan-gate auto variant skips human Q&A", () => {
  const p = composeSystemPrompt(null, true, { planGate: "auto" });
  expect(p).toContain(PLAN_GATE_DIRECTIVE_AUTO.slice(0, 24));
  expect(p).not.toContain("autopilot-directive");
});
test("no plan gate → unchanged autopilot behavior", () => {
  const p = composeSystemPrompt(null, true);
  expect(p).toContain("autopilot-directive");
  expect(p).not.toContain("plan-gate-directive");
});
test("interactive directive references both reviewer and not-implementing-yet", () => {
  expect(PLAN_GATE_DIRECTIVE_INTERACTIVE).toContain("reviewer");
  expect(PLAN_GATE_DIRECTIVE_INTERACTIVE.toLowerCase()).toContain("aligned");
});
test("interactive directive makes the agent ask actively, not park questions in the plan", () => {
  // names AskUserQuestion as the choice-style mechanism (but not the exclusive channel)
  expect(PLAN_GATE_DIRECTIVE_INTERACTIVE).toContain("AskUserQuestion");
  // forbids parking open/unresolved questions in the plan file
  expect(PLAN_GATE_DIRECTIVE_INTERACTIVE.toLowerCase()).toContain("unresolved");
  // but explicitly still permits stated assumptions / resolved decisions
  expect(PLAN_GATE_DIRECTIVE_INTERACTIVE.toLowerCase()).toContain("assumption");
});
