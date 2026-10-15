import { test, expect } from "bun:test";
import {
  buildGreenfieldReport,
  GREENFIELD_MUST,
  type GreenfieldInputs,
} from "../src/greenfield-core";
import type { ForgeRun } from "../src/forge/types";
import type { GuardrailCheck, GuardrailId } from "../src/readiness";

const c = (id: GuardrailId, present = true): GuardrailCheck => ({
  id,
  present,
  weight: 1,
  evidence: present ? [id] : [],
});

const run = (over: Partial<ForgeRun> = {}): ForgeRun => ({
  id: 1,
  workflowName: "ci",
  workflowFile: ".github/workflows/ci.yml",
  event: "push",
  status: "completed",
  conclusion: "success",
  attempt: 1,
  headSha: "abc",
  createdAt: 1,
  url: "u",
  ...over,
});

const okForge = {
  supported: true as const,
  defaultBranch: "main",
  autoLabel: "shepherd",
  checks: [{ id: "auto_merge" as const, state: "ok" as const, current: true, target: true }],
};

function empty(): GreenfieldInputs {
  return {
    scan: {
      ecosystem: null,
      checks: [c("ci", false), c("issue_templates", false)],
      toolchainPins: [],
    },
    pinnedStackDoc: [],
    docs: { prd: [], design: [], decisions: [] },
    forge: { supported: false },
    runs: [],
    now: 7,
  };
}

function full(): GreenfieldInputs {
  return {
    scan: {
      ecosystem: "js-ts",
      checks: [
        c("ci"),
        c("git_hooks"),
        c("pre_push_ci"),
        c("dead_code_audit"),
        c("issue_templates"),
        c("dependency_automation"),
      ],
      toolchainPins: ["packageManager"],
    },
    pinnedStackDoc: ["CLAUDE.md"],
    docs: { prd: ["docs/prd"], design: ["docs/design"], decisions: ["docs/decisions"] },
    forge: okForge,
    runs: [run()],
    now: 7,
  };
}

test("empty repo: greenfield checklist, score 0, every applicable must-have missing", () => {
  const r = buildGreenfieldReport(empty());
  expect(r.ecosystem).toBeNull();
  expect(r.score).toBe(0);
  // forge unsupported → that item is omitted, not blocking
  expect(r.mustHavesMissing).toEqual(GREENFIELD_MUST.filter((id) => id !== "forge_settings"));
  expect(r.items.find((i) => i.id === "prd")?.tier).toBe("nice");
  expect(r.items.some((i) => i.id === "env_schema")).toBe(false);
  expect(r.checkedAt).toBe(7);
});

test("fully bootstrapped repo: all must-haves green, score 100", () => {
  const r = buildGreenfieldReport(full());
  expect(r.mustHavesMissing).toEqual([]);
  expect(r.score).toBe(100);
});

test("nice-to-haves never block", () => {
  const i = full();
  i.docs = { prd: [], design: [], decisions: [] };
  const r = buildGreenfieldReport(i);
  expect(r.mustHavesMissing).toEqual([]);
  expect(r.score).toBeLessThan(100);
});

test("stack_pinned needs the CLAUDE.md section AND a toolchain pin", () => {
  const a = full();
  a.pinnedStackDoc = [];
  expect(buildGreenfieldReport(a).mustHavesMissing).toEqual(["stack_pinned"]);
  const b = full();
  b.scan.toolchainPins = [];
  expect(buildGreenfieldReport(b).mustHavesMissing).toEqual(["stack_pinned"]);
});

test("scaffold_builds follows the newest finished default-branch run", () => {
  const i = full();
  i.runs = [
    run({ createdAt: 1 }),
    run({ createdAt: 2, conclusion: "failure" }),
    run({ createdAt: 3, status: "in_progress", conclusion: null }),
  ];
  expect(buildGreenfieldReport(i).mustHavesMissing).toEqual(["scaffold_builds"]);
  i.runs = null; // no runs API → manifest alone, flagged unverified
  const r = buildGreenfieldReport(i);
  expect(r.mustHavesMissing).toEqual([]);
  expect(r.items.find((x) => x.id === "scaffold_builds")?.evidence).toContain("unverified");
});

test("ci_on_main needs a default-branch run when the forge lists runs", () => {
  const i = full();
  i.runs = [];
  expect(buildGreenfieldReport(i).mustHavesMissing).toEqual(["scaffold_builds", "ci_on_main"]);
});

test("hooks_pre_push needs both hooks and a pre-push stage", () => {
  const i = full();
  i.scan.checks = i.scan.checks.map((x) => (x.id === "pre_push_ci" ? c("pre_push_ci", false) : x));
  expect(buildGreenfieldReport(i).mustHavesMissing).toEqual(["hooks_pre_push"]);
});

test("forge settings: a mismatch or a read error is red", () => {
  const i = full();
  i.forge = { ...okForge, checks: [{ ...okForge.checks[0]!, state: "fix" }] };
  expect(buildGreenfieldReport(i).mustHavesMissing).toEqual(["forge_settings"]);
  i.forge = "error";
  expect(buildGreenfieldReport(i).mustHavesMissing).toEqual(["forge_settings"]);
});
