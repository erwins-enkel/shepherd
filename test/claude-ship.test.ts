import { describe, expect, test } from "bun:test";
import {
  approvalsHolding,
  claudeShipCheckKind,
  claudeShipInFlight,
  claudeShipSignal,
  sameClaudeShip,
  splitClaudeShipRollup,
} from "../src/forge/claude-ship";
import type { RollupEntry } from "../src/forge/types";

const run = (name: string, conclusion: string | null, extra: Partial<RollupEntry> = {}) =>
  ({
    __typename: "CheckRun",
    name,
    workflowName: "",
    status: conclusion === null ? "IN_PROGRESS" : "COMPLETED",
    conclusion,
    ...extra,
  }) satisfies RollupEntry;

describe("claudeShipCheckKind", () => {
  test("matches the exact App check names", () => {
    expect(claudeShipCheckKind("Claude Code Review", true)).toBe("codeReview");
    expect(claudeShipCheckKind("Claude Approvals", true)).toBe("approvals");
  });

  test("ignores Actions jobs and other names", () => {
    expect(claudeShipCheckKind("Claude Code Review", false)).toBeNull();
    expect(claudeShipCheckKind("claude approvals", true)).toBeNull();
    expect(claudeShipCheckKind("test", true)).toBeNull();
    expect(claudeShipCheckKind(null, true)).toBeNull();
  });
});

describe("splitClaudeShipRollup", () => {
  test("removes Claude App runs from the CI entries", () => {
    const ci = run("test", "SUCCESS", { workflowName: "CI" });
    const { ci: out, checks } = splitClaudeShipRollup([
      ci,
      run("Claude Approvals", "FAILURE"),
      run("Claude Code Review", null),
    ]);
    expect(out).toEqual([ci]);
    expect(checks).toEqual({ approvals: "failure", codeReview: "pending" });
  });

  test("a same-named Actions job stays CI", () => {
    const job = run("Claude Code Review", "FAILURE", { workflowName: "Claude Code Review" });
    expect(splitClaudeShipRollup([job])).toEqual({ ci: [job], checks: {} });
  });

  test("a StatusContext with a Claude name stays CI", () => {
    const ctx = { __typename: "StatusContext", context: "Claude Approvals", state: "FAILURE" };
    expect(splitClaudeShipRollup([ctx])).toEqual({ ci: [ctx], checks: {} });
  });

  test("the latest run per Claude check wins", () => {
    const { checks } = splitClaudeShipRollup([
      run("Claude Approvals", "FAILURE", { completedAt: "2026-11-25T10:00:00Z" }),
      run("Claude Approvals", "SUCCESS", { completedAt: "2026-11-25T11:00:00Z" }),
    ]);
    expect(checks).toEqual({ approvals: "success" });
  });

  test("neutral maps to none", () => {
    expect(splitClaudeShipRollup([run("Claude Approvals", "NEUTRAL")]).checks).toEqual({
      approvals: "none",
    });
  });
});

describe("claudeShipSignal", () => {
  test("absent without label or checks", () => {
    expect(claudeShipSignal(["bug"], {})).toBeUndefined();
    expect(claudeShipSignal(undefined, {})).toBeUndefined();
  });

  test("the Steward label alone marks the PR", () => {
    expect(claudeShipSignal(["claude-pr-steward-watching"], {})).toEqual({
      stewardWatching: true,
    });
  });

  test("checks alone mark the PR", () => {
    expect(claudeShipSignal([], { approvals: "pending" })).toEqual({
      stewardWatching: false,
      approvals: "pending",
    });
  });
});

test("approvalsHolding holds on pending/failure only", () => {
  expect(approvalsHolding("pending")).toBe(true);
  expect(approvalsHolding("failure")).toBe(true);
  expect(approvalsHolding("success")).toBe(false);
  expect(approvalsHolding("none")).toBe(false);
  expect(approvalsHolding(undefined)).toBe(false);
});

test("claudeShipInFlight: Approvals holding or Code Review running", () => {
  expect(claudeShipInFlight({ stewardWatching: false, approvals: "pending" })).toBe(true);
  expect(claudeShipInFlight({ stewardWatching: false, approvals: "failure" })).toBe(true);
  expect(claudeShipInFlight({ stewardWatching: false, codeReview: "pending" })).toBe(true);
  expect(claudeShipInFlight({ stewardWatching: true, codeReview: "failure" })).toBe(false);
  expect(claudeShipInFlight({ stewardWatching: false, approvals: "success" })).toBe(false);
  expect(claudeShipInFlight(undefined)).toBe(false);
});

test("sameClaudeShip compares field-wise", () => {
  expect(sameClaudeShip(undefined, undefined)).toBe(true);
  expect(sameClaudeShip({ stewardWatching: true }, { stewardWatching: true })).toBe(true);
  expect(sameClaudeShip({ stewardWatching: true }, undefined)).toBe(false);
  expect(
    sameClaudeShip(
      { stewardWatching: false, approvals: "pending" },
      { stewardWatching: false, approvals: "success" },
    ),
  ).toBe(false);
});
