// Labelled fixtures for the PR-critic eval (issue #2156).
//
// Each fixture is a small unified diff plus the tree the reviewer can inspect around it. The critic
// prompt is imported unchanged, so it still orders `git diff <base>...HEAD` and greps the tree —
// both answered by the shared fixture environment (`./env.ts`), never executed.
//
// The set is balanced on purpose. Half carry a PLANTED defect the critic must catch and cite by
// file (a miss here is a bug that ships); half are clean or merely nitty, where the failure mode is
// the opposite one — a manufactured blocking finding that costs the author a rework round. A critic
// that blocks everything scores as badly as one that blocks nothing.
//
// Diffs are kept to a few dozen lines: the eval measures review judgement, not context stamina.

import type { EvalFixtureBase } from "../eval-core";
import type { FixtureEnv } from "./env";

export type CriticDecisionLabel = "changes_requested" | "commented";

export interface CriticFixture extends EvalFixtureBase {
  /** `session` -> `reviewPrompt` (a Shepherd task to satisfy); `pr` -> `prReviewPrompt`. */
  kind: "session" | "pr";
  diffBase: string;
  env: FixtureEnv;
  /** session only. */
  task?: string;
  priorFindings?: string[];
  authorNotes?: string[];
  issueBody?: string | null;
  plan?: string | null;
  smellLens?: boolean;
  round?: number;
  cap?: number;
  /** pr only. */
  prTitle?: string;
  prBody?: string;
  expectedDecision: CriticDecisionLabel;
  /** At least one finding must match each pattern — the planted defect must actually be named. */
  findingsMustMatch?: RegExp[];
  /** No finding may match any of these — the finding class this fixture forbids. */
  findingsMustNotMatch?: RegExp[];
}

const BASE = "origin/main";

export const CRITIC_FIXTURES: CriticFixture[] = [
  {
    id: "bug-off-by-one",
    origin: "synthetic",
    gating: true,
    kind: "session",
    diffBase: BASE,
    note: "Planted off-by-one: the last page is dropped. Must be caught and cited.",
    task: "Add pagination to the issue list so the backlog loads a page at a time.",
    env: {
      diff: [
        "diff --git a/src/paginate.ts b/src/paginate.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/paginate.ts",
        "@@ -0,0 +1,18 @@",
        "+export interface Page<T> {",
        "+  items: T[];",
        "+  pageCount: number;",
        "+}",
        "+",
        "+/** Split `items` into pages of `size`. */",
        "+export function paginate<T>(items: T[], size: number): Page<T>[] {",
        "+  const pageCount = Math.floor(items.length / size);",
        "+  const pages: Page<T>[] = [];",
        "+  for (let i = 0; i < pageCount; i++) {",
        "+    pages.push({ items: items.slice(i * size, (i + 1) * size), pageCount });",
        "+  }",
        "+  return pages;",
        "+}",
      ].join("\n"),
    },
    expectedDecision: "changes_requested",
    findingsMustMatch: [/paginate\.ts/i],
  },
  {
    id: "bug-missing-await",
    origin: "synthetic",
    gating: true,
    kind: "session",
    diffBase: BASE,
    note: "Planted missing `await`: the flush races the process exit and rows are lost.",
    task: "Flush buffered usage rows to the store before the server shuts down.",
    env: {
      diff: [
        "diff --git a/src/shutdown.ts b/src/shutdown.ts",
        "--- a/src/shutdown.ts",
        "+++ b/src/shutdown.ts",
        '@@ -8,6 +8,7 @@ import { flushUsage } from "./usage";',
        " export async function shutdown(): Promise<void> {",
        "   stopPollers();",
        "+  flushUsage();",
        "   closeSockets();",
        "   process.exit(0);",
        " }",
      ].join("\n"),
      files: {
        // Post-image of the modified file: the diff's `+` line is present, as it would be on the
        // PR branch. `flushUsage()` is async and its result is dropped — the planted defect.
        "src/shutdown.ts": [
          'import { stopPollers } from "./pollers";',
          'import { closeSockets } from "./sockets";',
          'import { flushUsage } from "./usage";',
          "",
          "export async function shutdown(): Promise<void> {",
          "  stopPollers();",
          "  flushUsage();",
          "  closeSockets();",
          "  process.exit(0);",
          "}",
        ].join("\n"),
        "src/usage.ts":
          "/** Persist every buffered usage row. */\nexport async function flushUsage(): Promise<void> {\n  await store.insertMany(buffer.splice(0));\n}\n",
      },
    },
    expectedDecision: "changes_requested",
    findingsMustMatch: [/shutdown\.ts/i],
  },
  {
    id: "security-command-injection",
    origin: "synthetic",
    gating: true,
    kind: "session",
    diffBase: BASE,
    note: "Planted shell injection: a branch name is interpolated into a shell string.",
    task: "Add an endpoint that returns the commit count for a branch.",
    env: {
      diff: [
        "diff --git a/src/branch-stats.ts b/src/branch-stats.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/branch-stats.ts",
        "@@ -0,0 +1,12 @@",
        '+import { execAsync } from "./instrument";',
        "+",
        "+/** Commit count for `branch`, as reported by git. */",
        "+export async function commitCount(repo: string, branch: string): Promise<number> {",
        "+  const { stdout } = await execAsync(",
        "+    `cd ${repo} && git rev-list --count ${branch}`,",
        "+  );",
        "+  return Number(stdout.trim());",
        "+}",
      ].join("\n"),
      files: {
        "src/server.ts":
          'app.get("/api/branch-stats", async (req) => {\n  return { count: await commitCount(repoPath, String(req.query.branch)) };\n});\n',
      },
    },
    expectedDecision: "changes_requested",
    findingsMustMatch: [/branch-stats\.ts/i],
  },
  {
    id: "security-secret-logged",
    origin: "synthetic",
    gating: true,
    kind: "session",
    diffBase: BASE,
    note: "Planted credential disclosure: the API key lands in the log line.",
    task: "Add debug logging to the spawn-auth path so failed logins are diagnosable.",
    env: {
      diff: [
        "diff --git a/src/spawn-auth.ts b/src/spawn-auth.ts",
        "--- a/src/spawn-auth.ts",
        "+++ b/src/spawn-auth.ts",
        "@@ -41,6 +41,9 @@ export function authEnv(mode: AuthMode): Record<string, string> {",
        '   const key = process.env.ANTHROPIC_API_KEY ?? "";',
        "+  log.debug(",
        "+    `[spawn-auth] mode=${mode} key=${key} configDir=${configDir}`,",
        "+  );",
        "   return { ANTHROPIC_API_KEY: key, CLAUDE_CONFIG_DIR: configDir };",
        " }",
      ].join("\n"),
      files: {
        "src/spawn-auth.ts": [
          'export type AuthMode = "subscription" | "api-key";',
          "",
          "export function authEnv(mode: AuthMode): Record<string, string> {",
          "  const configDir = resolveConfigDir(mode);",
          '  const key = process.env.ANTHROPIC_API_KEY ?? "";',
          "  log.debug(",
          "    `[spawn-auth] mode=${mode} key=${key} configDir=${configDir}`,",
          "  );",
          "  return { ANTHROPIC_API_KEY: key, CLAUDE_CONFIG_DIR: configDir };",
          "}",
        ].join("\n"),
      },
    },
    expectedDecision: "changes_requested",
    findingsMustMatch: [/spawn-auth\.ts/i],
  },
  {
    id: "bug-listener-leak",
    origin: "synthetic",
    gating: true,
    kind: "session",
    diffBase: BASE,
    note: "Planted leak: the interval outlives the component, firing against a dead store.",
    task: "Poll the session's PR status every 30s while the git rail is open.",
    env: {
      diff: [
        "diff --git a/ui/src/lib/components/GitRail.svelte b/ui/src/lib/components/GitRail.svelte",
        "--- a/ui/src/lib/components/GitRail.svelte",
        "+++ b/ui/src/lib/components/GitRail.svelte",
        "@@ -12,6 +12,11 @@",
        "   let status = $state<PrStatus | null>(null);",
        "+",
        "+  onMount(() => {",
        "+    refresh();",
        "+    setInterval(refresh, 30_000);",
        "+  });",
        " ",
        "   async function refresh() {",
        "     status = await api.prStatus(sessionId);",
      ].join("\n"),
      files: {
        "ui/src/lib/components/GitRail.svelte": [
          '<script lang="ts">',
          '  import { onMount } from "svelte";',
          '  import { api } from "$lib/api";',
          "",
          "  let { sessionId }: { sessionId: string } = $props();",
          "  let status = $state<PrStatus | null>(null);",
          "",
          "  onMount(() => {",
          "    refresh();",
          "    setInterval(refresh, 30_000);",
          "  });",
          "",
          "  async function refresh() {",
          "    status = await api.prStatus(sessionId);",
          "  }",
          "</script>",
          "",
          '<div class="rail">{status?.state ?? "…"}</div>',
        ].join("\n"),
      },
    },
    expectedDecision: "changes_requested",
    findingsMustMatch: [/GitRail\.svelte/i],
  },
  {
    id: "bug-wrong-comparison",
    origin: "synthetic",
    gating: true,
    kind: "session",
    diffBase: BASE,
    note: "Planted inverted guard: stale entries are kept and fresh ones pruned.",
    task: "Prune cached backlog entries older than the TTL.",
    env: {
      diff: [
        "diff --git a/src/backlog-cache.ts b/src/backlog-cache.ts",
        "--- a/src/backlog-cache.ts",
        "+++ b/src/backlog-cache.ts",
        "@@ -20,6 +20,12 @@ const TTL_MS = 5 * 60_000;",
        "+/** Drop entries whose age exceeds the TTL. */",
        "+export function prune(entries: Entry[], now: number): Entry[] {",
        "+  return entries.filter((e) => now - e.fetchedAt > TTL_MS);",
        "+}",
        "+",
        " export function get(repo: string): Entry | undefined {",
      ].join("\n"),
      files: {
        "src/backlog-cache.ts": [
          "export interface Entry {",
          "  repo: string;",
          "  fetchedAt: number;",
          "}",
          "",
          "const TTL_MS = 5 * 60_000;",
          "",
          "/** Drop entries whose age exceeds the TTL. */",
          "export function prune(entries: Entry[], now: number): Entry[] {",
          "  return entries.filter((e) => now - e.fetchedAt > TTL_MS);",
          "}",
          "",
          "export function get(repo: string): Entry | undefined {",
          "  return cache.get(repo);",
          "}",
        ].join("\n"),
      },
    },
    expectedDecision: "changes_requested",
    findingsMustMatch: [/backlog-cache\.ts/i],
  },
  {
    id: "clean-extract-helper",
    origin: "synthetic",
    gating: true,
    kind: "session",
    diffBase: BASE,
    note: "A correct behaviour-preserving extraction — blocking it costs the author a round.",
    task: "Extract the duplicated ISO-day bucketing in the usage report into one helper.",
    env: {
      diff: [
        "diff --git a/scripts/usage-report.ts b/scripts/usage-report.ts",
        "--- a/scripts/usage-report.ts",
        "+++ b/scripts/usage-report.ts",
        "@@ -30,12 +30,14 @@",
        "+/** The UTC calendar day a timestamp falls in, as `YYYY-MM-DD`. */",
        "+function isoDay(ms: number): string {",
        "+  return new Date(ms).toISOString().slice(0, 10);",
        "+}",
        "+",
        " export function byDay(rows: Row[]): Map<string, Row[]> {",
        "   const out = new Map<string, Row[]>();",
        "-  for (const r of rows) {",
        "-    const day = new Date(r.at).toISOString().slice(0, 10);",
        "-    push(out, day, r);",
        "-  }",
        "+  for (const r of rows) push(out, isoDay(r.at), r);",
        "   return out;",
        " }",
        "@@ -60,8 +62,7 @@",
        " export function byDayAndModel(rows: Row[]): Map<string, Map<string, Row[]>> {",
        "   const out = new Map<string, Map<string, Row[]>>();",
        "-  for (const r of rows) {",
        "-    const day = new Date(r.at).toISOString().slice(0, 10);",
        "-    nest(out, day, r.model, r);",
        "-  }",
        "+  for (const r of rows) nest(out, isoDay(r.at), r.model, r);",
        "   return out;",
        " }",
      ].join("\n"),
      files: {
        "scripts/usage-report.ts": [
          "interface Row {",
          "  at: number;",
          "  model: string;",
          "}",
          "",
          "/** The UTC calendar day a timestamp falls in, as `YYYY-MM-DD`. */",
          "function isoDay(ms: number): string {",
          "  return new Date(ms).toISOString().slice(0, 10);",
          "}",
          "",
          "export function byDay(rows: Row[]): Map<string, Row[]> {",
          "  const out = new Map<string, Row[]>();",
          "  for (const r of rows) push(out, isoDay(r.at), r);",
          "  return out;",
          "}",
          "",
          "export function byDayAndModel(rows: Row[]): Map<string, Map<string, Row[]>> {",
          "  const out = new Map<string, Map<string, Row[]>>();",
          "  for (const r of rows) nest(out, isoDay(r.at), r.model, r);",
          "  return out;",
          "}",
        ].join("\n"),
      },
    },
    expectedDecision: "commented",
  },
  {
    id: "clean-test-added",
    origin: "synthetic",
    gating: true,
    kind: "session",
    diffBase: BASE,
    note: "A correct regression test for an existing helper — nothing to block on.",
    task: "Add a regression test for the empty-input case of `summarize()`.",
    env: {
      diff: [
        "diff --git a/test/summarize.test.ts b/test/summarize.test.ts",
        "--- a/test/summarize.test.ts",
        "+++ b/test/summarize.test.ts",
        "@@ -18,3 +18,9 @@",
        '+test("summarize returns the empty summary for no rows", () => {',
        "+  const s = summarize([]);",
        "+  expect(s.total).toBe(0);",
        "+  expect(s.byModel).toEqual({});",
        "+});",
      ].join("\n"),
      files: {
        "test/summarize.test.ts": [
          'import { test, expect } from "bun:test";',
          'import { summarize } from "../src/summarize";',
          "",
          'test("summarize totals rows by model", () => {',
          '  const s = summarize([{ model: "sonnet", tokens: 10 }]);',
          "  expect(s.total).toBe(10);",
          "});",
          "",
          'test("summarize returns the empty summary for no rows", () => {',
          "  const s = summarize([]);",
          "  expect(s.total).toBe(0);",
          "  expect(s.byModel).toEqual({});",
          "});",
        ].join("\n"),
        "src/summarize.ts":
          "export function summarize(rows: Row[]): Summary {\n  if (rows.length === 0) return { total: 0, byModel: {} };\n  return rows.reduce(accumulate, { total: 0, byModel: {} });\n}\n",
      },
    },
    expectedDecision: "commented",
  },
  {
    id: "nit-only-not-blocking",
    origin: "synthetic",
    gating: true,
    kind: "session",
    diffBase: BASE,
    note: "Only a cosmetic preference is available — FINDINGS ROUTING sends it to a body section.",
    task: "Show the repo name beside the session designator in the herd list.",
    env: {
      diff: [
        "diff --git a/ui/src/lib/components/UnitRow.svelte b/ui/src/lib/components/UnitRow.svelte",
        "--- a/ui/src/lib/components/UnitRow.svelte",
        "+++ b/ui/src/lib/components/UnitRow.svelte",
        "@@ -22,6 +22,7 @@",
        '   <span class="desig">{session.desig}</span>',
        '+  <span class="repo">{repoName(session.repoPath)}</span>',
        " </div>",
        "@@ -60,4 +61,8 @@",
        "+  .repo {",
        "+    color: var(--fg-muted);",
        "+    font-size: 0.85em;",
        "+  }",
      ].join("\n"),
      files: {
        "ui/src/lib/components/UnitRow.svelte": [
          '<script lang="ts">',
          '  import { repoName } from "$lib/repo-name";',
          "",
          "  let { session }: { session: Session } = $props();",
          "</script>",
          "",
          '<div class="row">',
          '  <span class="desig">{session.desig}</span>',
          '  <span class="repo">{repoName(session.repoPath)}</span>',
          "</div>",
          "",
          "<style>",
          "  .desig {",
          "    font-weight: 600;",
          "  }",
          "  .repo {",
          "    color: var(--fg-muted);",
          "    font-size: 0.85em;",
          "  }",
          "</style>",
        ].join("\n"),
        "ui/src/lib/repo-name.ts":
          'export function repoName(path: string): string {\n  return path.split("/").filter(Boolean).pop() ?? path;\n}\n',
      },
    },
    expectedDecision: "commented",
    // A naming/spacing preference is a `Nits (non-blocking):` body item, never a finding.
    findingsMustNotMatch: [/nit/i, /prefer/i, /style/i],
  },
  {
    id: "scope-out-of-diff-not-raised",
    origin: "synthetic",
    gating: true,
    kind: "session",
    diffBase: BASE,
    note: "A real flaw sits in a file the diff does not touch — the SCOPE rule forbids raising it.",
    task: "Add the `--json` flag to the delivery report.",
    env: {
      diff: [
        "diff --git a/scripts/delivery-report.ts b/scripts/delivery-report.ts",
        "--- a/scripts/delivery-report.ts",
        "+++ b/scripts/delivery-report.ts",
        "@@ -14,6 +14,10 @@",
        " const args = process.argv.slice(2);",
        '+const asJson = args.includes("--json");',
        " const report = buildReport(await loadDeliveries());",
        "-console.log(formatReport(report));",
        "+console.log(asJson ? JSON.stringify(report, null, 2) : formatReport(report));",
      ].join("\n"),
      files: {
        "scripts/delivery-report.ts": [
          'import { loadDeliveries } from "../src/deliveries";',
          "",
          "const args = process.argv.slice(2);",
          'const asJson = args.includes("--json");',
          "const report = buildReport(await loadDeliveries());",
          "console.log(asJson ? JSON.stringify(report, null, 2) : formatReport(report));",
        ].join("\n"),
        // Untouched by the diff, and carrying an obvious pre-existing bug (swallowed error). The
        // critic may notice it; the SCOPE rule says it must not become a finding.
        "src/deliveries.ts":
          'export async function loadDeliveries(): Promise<Delivery[]> {\n  try {\n    return JSON.parse(await readFile(PATH, "utf8"));\n  } catch {\n    return [];\n  }\n}\n',
      },
    },
    expectedDecision: "commented",
    findingsMustNotMatch: [/deliveries\.ts/i],
  },
  {
    id: "re-review-note-does-not-excuse",
    origin: "synthetic",
    // BASELINE: a compound judgement (weigh an author note against the diff AND re-raise), which
    // makes it a noisier gate than the single-contract fixtures. Kept as a before/after datum.
    gating: false,
    kind: "session",
    diffBase: BASE,
    note: "An author note claims a fix that the diff does not contain — re-raise anyway.",
    task: "Prune cached backlog entries older than the TTL.",
    env: {
      diff: [
        "diff --git a/src/backlog-cache.ts b/src/backlog-cache.ts",
        "--- a/src/backlog-cache.ts",
        "+++ b/src/backlog-cache.ts",
        "@@ -20,6 +20,12 @@ const TTL_MS = 5 * 60_000;",
        "+/** Drop entries whose age exceeds the TTL. */",
        "+export function prune(entries: Entry[], now: number): Entry[] {",
        "+  return entries.filter((e) => now - e.fetchedAt > TTL_MS);",
        "+}",
      ].join("\n"),
      files: {
        // The note claims the inverted comparison was fixed; the post-image shows it was not.
        "src/backlog-cache.ts": [
          "const TTL_MS = 5 * 60_000;",
          "",
          "/** Drop entries whose age exceeds the TTL. */",
          "export function prune(entries: Entry[], now: number): Entry[] {",
          "  return entries.filter((e) => now - e.fetchedAt > TTL_MS);",
          "}",
        ].join("\n"),
      },
    },
    priorFindings: [
      "src/backlog-cache.ts: `prune` keeps the entries it should drop — the comparison is inverted.",
    ],
    authorNotes: ["Fixed the inverted comparison in prune, good catch."],
    round: 2,
    cap: 12,
    expectedDecision: "changes_requested",
    findingsMustMatch: [/backlog-cache\.ts/i],
  },
  {
    id: "pr-intent-is-context-not-spec",
    origin: "synthetic",
    gating: true,
    kind: "pr",
    diffBase: BASE,
    note: "Standalone PR critic: incompleteness vs stated intent is explicitly NOT a finding.",
    prTitle: "Add dark-mode tokens (part 1 of 2)",
    prBody:
      "First half of the dark-mode work: defines the token palette. The component migration follows in a second PR.",
    env: {
      diff: [
        "diff --git a/ui/src/app.css b/ui/src/app.css",
        "--- a/ui/src/app.css",
        "+++ b/ui/src/app.css",
        "@@ -10,6 +10,18 @@",
        " :root {",
        "   --bg: #ffffff;",
        "   --fg: #14161a;",
        "+  --bg-raised: #f5f6f8;",
        "+  --fg-muted: #5a6472;",
        " }",
        "+",
        "+@media (prefers-color-scheme: dark) {",
        '+  :root:not([data-theme="light"]) {',
        "+    --bg: #101216;",
        "+    --fg: #e8ebef;",
        "+    --bg-raised: #181b21;",
        "+    --fg-muted: #97a1b0;",
        "+  }",
        "+}",
      ].join("\n"),
      files: {
        "ui/src/app.css": [
          ":root {",
          "  --bg: #ffffff;",
          "  --fg: #14161a;",
          "  --bg-raised: #f5f6f8;",
          "  --fg-muted: #5a6472;",
          "}",
          "",
          "@media (prefers-color-scheme: dark) {",
          '  :root:not([data-theme="light"]) {',
          "    --bg: #101216;",
          "    --fg: #e8ebef;",
          "    --bg-raised: #181b21;",
          "    --fg-muted: #97a1b0;",
          "  }",
          "}",
        ].join("\n"),
      },
    },
    expectedDecision: "commented",
    // "The components don't use these tokens yet" is the finding the prompt forbids.
    findingsMustNotMatch: [/incomplete/i, /not.*(used|applied|migrated)/i, /part 2|second PR/i],
  },
];
