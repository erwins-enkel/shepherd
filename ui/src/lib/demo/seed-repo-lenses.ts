// Pure seed data for the repo-scoped lenses the Backlog drawer opens — the PRs tab,
// the Actions tab (plus its per-workflow history and per-run job breakdown), the
// Readiness tab — and the two repo-scoped Settings → Automation reads. Split out of
// `seed.ts` (#2295): that file's narrative is THE HERD (which session is in which
// state); this one is per-repo forge fixtures, a different concern and a different
// thing to keep consistent.
//
// Consistency rule, and the reason these numbers are not invented freely: every PR
// number, URL and head SHA here is the SAME one `buildGitStates()` in `seed.ts` gives
// the session that opened it. A PRs tab that disagrees with the herd rows next to it
// is a worse demo bug than the empty panel this replaces.
//
// Every record is typed against `$lib/types`, so `tsc` proves each shape matches what
// the live UI consumes. Titles, workflow names, logins and readiness artifacts are
// forge/verbatim data — exempt from i18n exactly like the seeded PR titles in `seed.ts`.

import type {
  PullRequest,
  WorkflowRun,
  WorkflowJob,
  ReadinessReport,
  RepoRoles,
  DocAgentRun,
} from "$lib/types";
import { STOREFRONT, API, NOW, MIN, HOUR, DEMO_VIEWER, gh } from "./seed-constants";

/** The workflow whose history the Actions tab can expand. Stable so the history and
 *  run-jobs fixtures below can key off the same id the listed run carries. */
const CI_WORKFLOW_ID = 9001;
const DEPLOY_WORKFLOW_ID = 9002;
const API_CI_WORKFLOW_ID = 9101;

const greenJobs = (): WorkflowJob[] => [
  { name: "lint", state: "success" },
  { name: "check", state: "success" },
  { name: "test", state: "success" },
];

/** GET /api/prs?repo= — the Backlog PRs tab.
 *
 *  storefront carries the two PRs the herd already shows (512 `rounding`, green and
 *  ready-to-merge; 508 `ogimg`, currently in the merge train) plus one Dependabot and
 *  one release-please PR so the PR-kind badges (#555) have real subjects. `api` carries
 *  a single red PR so the tab is not uniformly green.
 *
 *  `kind` mirrors what `classifyPr` would derive from the author/branch — seeded
 *  directly because the demo has no server to classify. */
export function buildPullRequests(): Record<string, PullRequest[]> {
  return {
    [STOREFRONT]: [
      {
        number: 512,
        title: "TASK-38: fix cart-total rounding on 3-for-2 offers",
        url: `${gh(STOREFRONT)}/pull/512`,
        author: DEMO_VIEWER,
        kind: "regular",
        createdAt: NOW - 35 * MIN,
        isDraft: false,
        mergeable: true,
        mergeStateStatus: "clean",
        checks: "success",
        jobs: greenJobs(),
        latestReview: { state: "approved", author: "acme-maintainer", submittedAt: NOW - 12 * MIN },
      },
      {
        number: 508,
        title: "TASK-39: dynamic OG images for product pages",
        url: `${gh(STOREFRONT)}/pull/508`,
        author: DEMO_VIEWER,
        kind: "regular",
        createdAt: NOW - 2 * HOUR,
        isDraft: false,
        mergeable: true,
        mergeStateStatus: "clean",
        checks: "success",
        jobs: greenJobs(),
      },
      {
        number: 511,
        title: "chore(deps): bump @sveltejs/kit from 2.48.1 to 2.49.0",
        url: `${gh(STOREFRONT)}/pull/511`,
        author: "dependabot[bot]",
        kind: "dependabot",
        createdAt: NOW - 6 * HOUR,
        isDraft: false,
        mergeable: true,
        mergeStateStatus: "clean",
        checks: "success",
        jobs: greenJobs(),
      },
      {
        number: 509,
        title: "chore(main): release 3.12.0",
        url: `${gh(STOREFRONT)}/pull/509`,
        author: "release-please[bot]",
        kind: "release",
        createdAt: NOW - 26 * HOUR,
        isDraft: false,
        mergeable: true,
        mergeStateStatus: "blocked",
        checks: "pending",
        jobs: [
          { name: "lint", state: "success" },
          { name: "test", state: "pending" },
        ],
      },
    ],
    [API]: [
      {
        number: 318,
        title: "TASK-41: retry Neon cold starts on connection reset",
        url: `${gh(API)}/pull/318`,
        author: DEMO_VIEWER,
        kind: "regular",
        createdAt: NOW - 50 * MIN,
        isDraft: false,
        mergeable: true,
        mergeStateStatus: "unstable",
        checks: "failure",
        jobs: [
          { name: "lint", state: "success" },
          { name: "check", state: "success" },
          { name: "test", state: "failure" },
        ],
      },
    ],
  };
}

/** GET /api/actions?repo= — latest run per workflow on the default branch, plus the
 *  three capability flags the tab's controls are gated on. Both demo repos are GitHub,
 *  so all three are true; a Gitea repo would report them false. */
export function buildWorkflowRuns(): Record<string, WorkflowRun[]> {
  return {
    [STOREFRONT]: [
      {
        runId: 77120,
        workflowId: CI_WORKFLOW_ID,
        workflowName: "CI",
        runUrl: `${gh(STOREFRONT)}/actions/runs/77120`,
        headSha: "b8c1d02",
        createdAt: NOW - 40 * MIN,
        state: "success",
        jobs: greenJobs(),
      },
      {
        runId: 77118,
        workflowId: DEPLOY_WORKFLOW_ID,
        workflowName: "Deploy",
        runUrl: `${gh(STOREFRONT)}/actions/runs/77118`,
        headSha: "b8c1d02",
        createdAt: NOW - 38 * MIN,
        state: "pending",
        jobs: [{ name: "deploy", state: "pending" }],
      },
    ],
    [API]: [
      {
        runId: 41009,
        workflowId: API_CI_WORKFLOW_ID,
        workflowName: "CI",
        runUrl: `${gh(API)}/actions/runs/41009`,
        headSha: "d3e4f51",
        createdAt: NOW - 50 * MIN,
        state: "failure",
        jobs: [
          { name: "lint", state: "success" },
          { name: "check", state: "success" },
          { name: "test", state: "failure" },
        ],
      },
    ],
  };
}

/** GET /api/actions/history?repo=&workflowId= — prior runs of ONE workflow on the
 *  default branch, keyed by workflow id. Summary rows: the real server leaves `jobs`
 *  empty here and the UI lazy-loads them per row from `/api/actions/run-jobs`. */
export function buildWorkflowHistory(): Record<string, Record<number, WorkflowRun[]>> {
  const sfRun = (runId: number, headSha: string, ago: number, state: WorkflowRun["state"]) => ({
    runId,
    workflowId: CI_WORKFLOW_ID,
    workflowName: "CI",
    runUrl: `${gh(STOREFRONT)}/actions/runs/${runId}`,
    headSha,
    createdAt: NOW - ago,
    state,
    jobs: [],
  });
  return {
    [STOREFRONT]: {
      [CI_WORKFLOW_ID]: [
        sfRun(77120, "b8c1d02", 40 * MIN, "success"),
        sfRun(77095, "a1b2c3d", 5 * HOUR, "success"),
        sfRun(77061, "c7d8e9f", 9 * HOUR, "failure"),
        sfRun(77044, "9f0a1b2", 26 * HOUR, "success"),
      ],
      [DEPLOY_WORKFLOW_ID]: [
        {
          runId: 77118,
          workflowId: DEPLOY_WORKFLOW_ID,
          workflowName: "Deploy",
          runUrl: `${gh(STOREFRONT)}/actions/runs/77118`,
          headSha: "b8c1d02",
          createdAt: NOW - 38 * MIN,
          state: "pending",
          jobs: [],
        },
      ],
    },
    [API]: {
      [API_CI_WORKFLOW_ID]: [
        {
          runId: 41009,
          workflowId: API_CI_WORKFLOW_ID,
          workflowName: "CI",
          runUrl: `${gh(API)}/actions/runs/41009`,
          headSha: "d3e4f51",
          createdAt: NOW - 50 * MIN,
          state: "failure",
          jobs: [],
        },
      ],
    },
  };
}

/** GET /api/actions/run-jobs?repo=&runId= — the per-job breakdown an expanded history
 *  row lazy-loads, keyed by run id. The failing run (77061) is the one worth expanding:
 *  it names the job that actually broke. */
export function buildRunJobs(): Record<string, Record<number, WorkflowJob[]>> {
  return {
    [STOREFRONT]: {
      77120: greenJobs(),
      77118: [{ name: "deploy", state: "pending" }],
      77095: greenJobs(),
      77061: [
        { name: "lint", state: "success" },
        { name: "check", state: "success" },
        { name: "test", state: "failure" },
      ],
      77044: greenJobs(),
    },
    [API]: {
      41009: [
        { name: "lint", state: "success" },
        { name: "check", state: "success" },
        { name: "test", state: "failure" },
      ],
    },
  };
}

const STOREFRONT_CLAUDE_MD = `# acme/storefront

## Verify

\`bun run check\` then \`bun run test\`. Run both before opening a PR.

## Conventions

- Svelte 5 runes only; no legacy stores in new code.
- Every user-facing string goes through the message catalog (EN + DE).
- One feature per branch, cut from \`origin/main\`, rebased — never merged.
`;

const ISSUE_TEMPLATE = `## Problem

What is broken or missing today, and who feels it.

## Outcome

What is true once this is done. Observable, not "refactor X".

## Constraints

Anything the implementation must respect.

## Non-goals

What this deliberately does NOT do.
`;

/** GET /api/readiness?repo= — the Backlog Readiness tab's guardrail scorecard.
 *
 *  Two deliberately different repos so the tab shows both of its columns with real
 *  content: `storefront` scores "good" with three gaps left (commit lint, dead-code
 *  audit, issue templates), `api` scores "low" with nine — never a wall of green, and
 *  never an empty "adopt" prescription.
 *
 *  SCORE is Σ(present weights) / Σ(all weights), rounded — the same weighted ratio the
 *  server computes. The two are seeded consistently with their own `checks` so the
 *  headline number can't contradict the list under it. */
export function buildReadiness(): Record<string, ReadinessReport> {
  return {
    [STOREFRONT]: {
      applicable: true,
      ecosystem: "js-ts",
      score: 83, // Σ present weights (79) / Σ all weights (95) — see the SCORE note above.
      checks: [
        { id: "linter", present: true, weight: 9, evidence: ["eslint.config.js", "scripts.lint"] },
        {
          id: "type_checker",
          present: true,
          weight: 9,
          evidence: ["scripts.check", "tsconfig.json"],
        },
        {
          id: "test_runner",
          present: true,
          weight: 10,
          evidence: ["scripts.test", "vitest.config.ts"],
        },
        { id: "formatter", present: true, weight: 6, evidence: [".prettierrc", "scripts.format"] },
        { id: "ci", present: true, weight: 10, evidence: [".github/workflows/ci.yml"] },
        { id: "git_hooks", present: true, weight: 8, evidence: [".husky/pre-commit"] },
        { id: "lint_staged", present: true, weight: 6, evidence: ["package.json#lint-staged"] },
        { id: "pre_push_ci", present: true, weight: 8, evidence: [".husky/pre-push"] },
        { id: "agent_instructions", present: true, weight: 8, evidence: ["CLAUDE.md"] },
        {
          id: "dependency_automation",
          present: true,
          weight: 5,
          evidence: [".github/dependabot.yml"],
        },
        { id: "commit_lint", present: false, weight: 5, evidence: [] },
        { id: "dead_code_audit", present: false, weight: 5, evidence: [] },
        { id: "issue_templates", present: false, weight: 6, evidence: [] },
      ],
      hasAgentInstructions: true,
      hasIssueTemplates: false,
      claudeMd: STOREFRONT_CLAUDE_MD,
      issueTemplate: ISSUE_TEMPLATE,
    },
    [API]: {
      applicable: true,
      ecosystem: "js-ts",
      score: 36, // Σ present weights (34) / Σ all weights (95).
      checks: [
        { id: "linter", present: true, weight: 9, evidence: ["eslint.config.js"] },
        { id: "type_checker", present: true, weight: 9, evidence: ["tsconfig.json"] },
        { id: "test_runner", present: true, weight: 10, evidence: ["scripts.test"] },
        { id: "formatter", present: true, weight: 6, evidence: [".prettierrc"] },
        { id: "ci", present: false, weight: 10, evidence: [] },
        { id: "git_hooks", present: false, weight: 8, evidence: [] },
        { id: "lint_staged", present: false, weight: 6, evidence: [] },
        { id: "pre_push_ci", present: false, weight: 8, evidence: [] },
        { id: "agent_instructions", present: false, weight: 8, evidence: [] },
        { id: "dependency_automation", present: false, weight: 5, evidence: [] },
        { id: "commit_lint", present: false, weight: 5, evidence: [] },
        { id: "dead_code_audit", present: false, weight: 5, evidence: [] },
        { id: "issue_templates", present: false, weight: 6, evidence: [] },
      ],
      hasAgentInstructions: false,
      hasIssueTemplates: false,
      claudeMd: `# acme/api\n\n## Verify\n\n\`bun run test\`. There is no CI yet — run it locally before pushing.\n`,
      issueTemplate: ISSUE_TEMPLATE,
    },
  };
}

/** GET /api/repo-roles?repo= — Settings → Automation's reviewer/merger handoff.
 *  storefront has a named reviewer (so the handoff row has a subject); `api` is
 *  unconfigured, which is the far more common real state. */
export function buildRepoRoles(): Record<string, RepoRoles> {
  return {
    [STOREFRONT]: { reviewer: "acme-maintainer", merger: null },
    [API]: { reviewer: null, merger: null },
  };
}

/** GET /api/repo-collaborators?repo= — the logins the roles pickers offer. */
export function buildRepoCollaborators(): Record<string, string[]> {
  return {
    [STOREFRONT]: [DEMO_VIEWER, "acme-maintainer", "acme-design"],
    [API]: [DEMO_VIEWER, "acme-maintainer"],
  };
}

/** GET /api/doc-agent/runs?repo= — history of the PR-gated doc agent.
 *
 *  Genuinely empty, and it stays that way: `BacklogView` only fires this when the
 *  `docAgentEnabled` setting is on, and the demo seeds it OFF. Seeded as an explicit
 *  empty rather than left to the router's permissive tail so the shape is stated
 *  (`getDocAgentRuns()` returns `{running, runs}`, and `runs` is assigned into a
 *  `$state` array) if the setting is ever flipped on in the demo. */
export function buildDocAgentRuns(): Record<string, DocAgentRun[]> {
  return { [STOREFRONT]: [], [API]: [] };
}
