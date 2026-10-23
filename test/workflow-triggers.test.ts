import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countPrCiWorkflows, workflowChecksPrs } from "../src/workflow-triggers";

const cases: [string, string, boolean][] = [
  [
    "schedule + workflow_dispatch only",
    "on:\n  schedule:\n    - cron: '0 3 * * *'\n  workflow_dispatch:\n",
    false,
  ],
  ["on: push", "on: push\n", true],
  ["on: [push, pull_request]", "on: [push, pull_request]\n", true],
  ["map form pull_request with base filter", "on:\n  pull_request:\n    branches: [main]\n", true],
  ["pull_request_target", "on: pull_request_target\n", true],
  ["merge_group", "on:\n  merge_group:\n", true],
  ["push branches: [main] only", "on:\n  push:\n    branches: [main]\n", false],
  ["push branches: [main, master] only", "on:\n  push:\n    branches: [main, master]\n", false],
  ["push branches glob", "on:\n  push:\n    branches: ['**']\n", true],
  ["push branches negation", "on:\n  push:\n    branches: ['!main']\n", true],
  ["push branches-ignore only", "on:\n  push:\n    branches-ignore: [main]\n", true],
  ["push tags only", "on:\n  push:\n    tags: ['v*']\n", false],
  ["push paths filter (no branch filter)", "on:\n  push:\n    paths: ['src/**']\n", true],
  [
    "push branches [main] + pull_request",
    "on:\n  push:\n    branches: [main]\n  pull_request:\n",
    true,
  ],
  ["workflow_call only", "on: workflow_call\n", false],
  ["release + issues", "on: [release, issues]\n", false],
  ["workflow_run", "on:\n  workflow_run:\n    workflows: [CI]\n", false],
  ["invalid YAML ⇒ counts", "on: [push\n  : :\n", true],
  ["no on: key ⇒ counts", "name: x\njobs: {}\n", true],
];

for (const [name, yaml, want] of cases) {
  test(`workflowChecksPrs: ${name} → ${want}`, () => {
    expect(workflowChecksPrs(yaml)).toBe(want);
  });
}

function repoWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "wf-triggers-"));
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  for (const [n, body] of Object.entries(files))
    writeFileSync(join(dir, ".github", "workflows", n), body);
  return dir;
}

test("countPrCiWorkflows: missing dir → 0", () => {
  expect(countPrCiWorkflows("/no/such/repo")).toBe(0);
});

test("countPrCiWorkflows: counts only PR-checking files", () => {
  const dir = repoWith({
    "db-backup.yml": "on:\n  schedule:\n    - cron: '0 3 * * *'\n  workflow_dispatch:\n",
    "ci.yaml": "on: [pull_request]\n",
    "notes.txt": "on: push\n",
  });
  try {
    expect(countPrCiWorkflows(dir)).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
