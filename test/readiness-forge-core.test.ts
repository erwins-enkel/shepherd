import { describe, expect, test } from "bun:test";
import { deriveRequiredChecks, forgeChecks, isForgeCheckId } from "../src/readiness-forge-core";
import type { RepoForgeSettings } from "../src/forge/types";

const OK: RepoForgeSettings = {
  defaultBranch: "main",
  mergeMethods: { merge: false, squash: true, rebase: false },
  autoMergeAllowed: true,
  deleteBranchOnMerge: true,
  requiredChecks: ["ci"],
  labelExists: true,
  canAdminister: true,
  canPush: true,
};

const byId = (s: RepoForgeSettings, derived: string[] = []) =>
  Object.fromEntries(
    forgeChecks(s, { mergeMethod: "squash", derivedChecks: derived }).map((c) => [c.id, c]),
  );

describe("deriveRequiredChecks", () => {
  test("PR-triggered jobs by name or id; skips matrix, templated, reusable and push-only", () => {
    const ci = `
on: [push, pull_request]
jobs:
  lint: {runs-on: ubuntu-latest}
  test:
    name: Unit tests
    runs-on: ubuntu-latest
  matrix:
    strategy: {matrix: {os: [a, b]}}
  templ:
    name: "build \${{ matrix.x }}"
  reuse:
    uses: ./.github/workflows/x.yml
`;
    const deploy = "on:\n  push:\n    branches: [main]\njobs:\n  deploy: {runs-on: x}\n";
    const target = "on:\n  pull_request_target: {}\njobs:\n  label: {}\n";
    expect(deriveRequiredChecks([ci, deploy, target, ": : not yaml ["])).toEqual([
      "Unit tests",
      "label",
      "lint",
    ]);
  });

  test("skips PR triggers that don't run on every PR", () => {
    const wf = (trigger: string) => `on:\n  pull_request:\n${trigger}jobs:\n  ci: {}\n`;
    for (const filter of [
      "    paths: [native/**]\n",
      "    paths-ignore: [docs/**]\n",
      "    branches: [main]\n",
      "    branches-ignore: [release]\n",
      "    types: [labeled]\n",
      "    types: [opened]\n",
    ])
      expect(deriveRequiredChecks([wf(filter)])).toEqual([]);
    expect(deriveRequiredChecks([wf("    types: [opened, synchronize, reopened]\n")])).toEqual([
      "ci",
    ]);
    expect(deriveRequiredChecks([wf("")])).toEqual(["ci"]);
    // One unfiltered PR event is enough.
    const mixed =
      "on:\n  pull_request: {paths: [a/**]}\n  pull_request_target: {}\njobs:\n  ci: {}\n";
    expect(deriveRequiredChecks([mixed])).toEqual(["ci"]);
  });

  test("string trigger and dedupe", () => {
    const a = "on: pull_request\njobs:\n  lint: {}\n";
    expect(deriveRequiredChecks([a, a])).toEqual(["lint"]);
  });
});

describe("forgeChecks", () => {
  test("all ok", () => {
    expect(
      forgeChecks(OK, { mergeMethod: "squash", derivedChecks: [] }).map((c) => c.state),
    ).toEqual(["ok", "ok", "ok", "ok", "ok"]);
  });

  test("mismatches with admin → fix with current/target", () => {
    const c = byId(
      {
        ...OK,
        mergeMethods: { merge: true, squash: true, rebase: false },
        autoMergeAllowed: false,
        deleteBranchOnMerge: false,
        requiredChecks: [],
        labelExists: false,
      },
      ["lint"],
    );
    expect(c.merge_methods).toEqual({
      id: "merge_methods",
      state: "fix",
      current: ["merge", "squash"],
      target: ["squash"],
    });
    expect(c.auto_merge!.state).toBe("fix");
    expect(c.delete_branch_on_merge!.state).toBe("fix");
    expect(c.required_checks).toMatchObject({ state: "fix", current: [], target: ["lint"] });
    expect(c.auto_label!.state).toBe("fix");
  });

  test("no admin → hints; push still allows label fix", () => {
    const c = byId(
      {
        ...OK,
        mergeMethods: { merge: true, squash: false, rebase: false },
        autoMergeAllowed: false,
        deleteBranchOnMerge: false,
        requiredChecks: [],
        labelExists: false,
        canAdminister: false,
      },
      ["lint"],
    );
    for (const id of ["merge_methods", "auto_merge", "delete_branch_on_merge", "required_checks"])
      expect(c[id]).toMatchObject({ state: "hint", reason: "no_admin" });
    expect(c.auto_label!.state).toBe("fix");
    expect(byId({ ...OK, labelExists: false, canPush: false }).auto_label).toMatchObject({
      state: "hint",
      reason: "no_push",
    });
  });

  test("no CI → required checks hint no_ci", () => {
    expect(byId({ ...OK, requiredChecks: [] }, []).required_checks).toMatchObject({
      state: "hint",
      reason: "no_ci",
    });
  });

  test("withheld fields → unknown", () => {
    const c = byId({
      ...OK,
      mergeMethods: null,
      autoMergeAllowed: null,
      deleteBranchOnMerge: null,
      requiredChecks: null,
    });
    for (const id of ["merge_methods", "auto_merge", "delete_branch_on_merge", "required_checks"])
      expect(c[id]!.state).toBe("unknown");
  });

  test("isForgeCheckId", () => {
    expect(isForgeCheckId("auto_label")).toBe(true);
    expect(isForgeCheckId("nope")).toBe(false);
  });
});
