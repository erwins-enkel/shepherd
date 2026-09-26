// The structural guard for demo-mode API coverage (#2295).
//
// The demo router ends in a permissive tail: an unmatched GET gets `{}`, an unmatched
// mutation `{ok:true}`. That tail is what keeps the demo from erroring on endpoints no
// screen touches — but it is shape-BLIND, and three separate bugs (#1800, #1821, #2240)
// came out of it. In each, a caller typed with a non-optional array or a required field
// got `undefined`, and the next `$derived` over it threw INSIDE Svelte's flush, which
// aborts the batch and silently freezes every queued effect in the app. A frozen page
// with a boundary log is a miserable thing to diagnose from a bug report.
//
// So this file makes the tail a DECISION rather than an accident, in two independent
// halves:
//
//   1. COMPLETENESS — scrape every `/api/**` path out of `api.ts` and assert each one is
//      accounted for, in either INVENTORY (we handle it) or DELIBERATE_TAIL (we chose not
//      to). A new endpoint added to `api.ts` fails here until someone classifies it.
//   2. HANDLED-NESS — drive each INVENTORY entry through `handleApi` and assert the
//      response carries no `x-demo-fallthrough` marker. A handler that is deleted,
//      renamed or typo'd stops being silently covered by the tail.
//
// Methods are hand-written in INVENTORY rather than scraped. Sniffing `POST`/`PUT` out of
// the source is the genuinely brittle part — multi-line `fetch` calls, `postJson` helpers
// and ordinary formatting drift all defeat it — while a NEW PATH still fails loudly under
// half 1. Paths are cheap and reliable to scrape; methods are not.

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { handleApi } from "./router";
import { demoState } from "./state";
import * as api from "$lib/api";

// ── scraping api.ts ─────────────────────────────────────────────────────────

/** End index (exclusive) of the `${…}` whose `{` sits at `brace`, or -1 if unterminated.
 *  Brace-balanced, so a nested object/template inside the interpolation is spanned too. */
function interpolationEnd(s: string, brace: number): number {
  let depth = 0;
  for (let i = brace; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/** Every `/api/…` string or template literal in `src`, whole.
 *
 *  Not a regex: a template literal's `${…}` can contain its own quotes and backticks
 *  (`${draft ? "draft" : "ready"}`), and a naive `/["'`][^"'`]*["'`]/` truncates there,
 *  silently dropping the rest of the path. */
function apiLiterals(src: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < src.length; i++) {
    const quote = src[i];
    if (quote !== '"' && quote !== "'" && quote !== "`") continue;
    if (src.slice(i + 1, i + 6) !== "/api/") continue;
    let j = i + 1;
    let body = "";
    while (j < src.length && src[j] !== quote) {
      if (src[j] === "$" && src[j + 1] === "{") {
        const end = interpolationEnd(src, j + 1);
        if (end < 0) break;
        body += src.slice(j, end);
        j = end;
        continue;
      }
      body += src[j++];
    }
    out.push(body);
    i = j;
  }
  return out;
}

/** What one `${…}` can expand to, as route-path text.
 *
 *  - Quoted literals inside it are real alternatives, so `${draft ? "draft" : "ready"}`
 *    yields BOTH `draft` and `ready` — two genuine endpoints, not one wildcard.
 *  - A TRAILING interpolation not preceded by `/` is a query-string splice
 *    (`/api/fs/dirs${q}`), so it contributes nothing.
 *  - Anything else is a path parameter → `:p`. */
function expansions(body: string, trailing: boolean, soFar: string): string[] {
  const quoted = [...body.matchAll(/"([^"]*)"|'([^']*)'/g)]
    .map((m) => (m[1] ?? m[2]).split("?")[0])
    .filter((q) => q !== "");
  if (quoted.length > 0) return [...new Set(quoted)];
  if (trailing && !soFar.endsWith("/")) return [""];
  return [":p"];
}

/** One literal → the route path(s) it can request, normalised: path parameters as `:p`,
 *  query string dropped, no trailing slash. Returns more than one only for a literal that
 *  alternates between fixed segments. */
function normalise(literal: string): string[] {
  let variants = [""];
  for (let i = 0; i < literal.length; i++) {
    if (literal[i] === "$" && literal[i + 1] === "{") {
      const end = interpolationEnd(literal, i + 1);
      const body = literal.slice(i + 2, end - 1);
      variants = variants.flatMap((v) =>
        expansions(body, end === literal.length, v).map((e) => v + e),
      );
      i = end - 1;
      continue;
    }
    variants = variants.map((v) => v + literal[i]);
  }
  return [...new Set(variants.map((v) => v.split("?")[0].replace(/\/+$/, "")))];
}

/** Every `/api/**` route path `api.ts` can request. Comments are stripped first — the file
 *  documents paths in prose (`/api/plugins/<id>/<path>`) that nothing actually fetches. */
function scrapeApiPaths(): Set<string> {
  const src = readFileSync(new URL("../api.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ""))
    .join("\n");
  return new Set(apiLiterals(src).flatMap(normalise));
}

// ── what the demo router handles ────────────────────────────────────────────

const REPO = "/demo/acme/storefront";
const r = encodeURIComponent(REPO);

/** A session id no seed uses. Every mutation handler tolerates an unknown id (`find()`
 *  returns undefined), so driving the table costs nothing but still proves the route
 *  matched — which is all half 2 asserts. */
const PROBE = "__probe__";

interface Entry {
  method: string;
  /** The path as `scrapeApiPaths` normalises it — the key completeness matches on. */
  path: string;
  /** A concrete URL to drive through `handleApi`. Defaults to `path`. */
  url?: string;
  body?: unknown;
}

const get = (path: string, url?: string): Entry => ({ method: "GET", path, url });
const post = (path: string, url?: string, body?: unknown): Entry => ({
  method: "POST",
  path,
  url,
  body,
});

/** Every endpoint the demo router answers with a real, correctly-shaped response. */
const INVENTORY: readonly Entry[] = [
  // bootstrap
  get("/api/me"),
  get("/api/sessions"),
  get("/api/sessions/done"),
  get("/api/sessions/clear-merged"),
  get("/api/repos"),
  get("/api/repo-config", `/api/repo-config?repo=${r}`),
  get("/api/commands", `/api/commands?repo=${r}`),
  get("/api/todo", `/api/todo?repo=${r}`),
  get("/api/manual-steps/outstanding"),
  get("/api/held"),
  get("/api/usage/limits"),
  get("/api/update"),
  get("/api/update/log"),
  get("/api/herdr-update"),
  get("/api/codex-update"),
  get("/api/plugin-update"),
  get("/api/star-prompt"),
  get("/api/git"),
  get("/api/activity"),
  get("/api/claude-alive"),
  get("/api/stranded"),
  get("/api/working-blocked"),
  get("/api/holds"),
  get("/api/subagents"),
  get("/api/preview"),
  get("/api/drain"),
  get("/api/automerge"),
  get("/api/epics/completed"),

  // lenses / drawers
  get("/api/settings"),
  get("/api/plugins"),
  get("/api/diagnostics"),
  get("/api/backlog"),
  get("/api/queues"),
  get("/api/reviews"),
  get("/api/reviews/inflight"),
  get("/api/plan-gates"),
  get("/api/plan-gates/inflight"),
  get("/api/recaps"),
  get("/api/up-next"),
  get("/api/steers"),
  get("/api/project-icons"),
  get("/api/learnings/pending"),
  get("/api/learnings/injectable"),
  get("/api/learnings/merge-suggestions"),
  get("/api/learnings/health"),

  // epics
  get("/api/epics", `/api/epics?repo=${r}`),
  get("/api/epic", `/api/epic?repo=${r}&parent=100`),

  // New Task composer (#1800)
  get("/api/branches", `/api/branches?repo=${r}`),
  get("/api/branch-status", `/api/branch-status?repo=${r}&branch=main`),
  get("/api/issues", `/api/issues?repo=${r}`),

  // Settings dialog (#1821)
  get("/api/fs/dirs", "/api/fs/dirs?path=/demo/acme"),
  get("/api/access-tokens"),

  // repo-scoped lenses (#2295)
  get("/api/prs", `/api/prs?repo=${r}`),
  get("/api/actions", `/api/actions?repo=${r}`),
  get("/api/actions/history", `/api/actions/history?repo=${r}&workflowId=9001&limit=10`),
  get("/api/actions/run-jobs", `/api/actions/run-jobs?repo=${r}&runId=77061`),
  get("/api/readiness", `/api/readiness?repo=${r}`),
  get("/api/repo-web", `/api/repo-web?repo=${r}`),
  get("/api/repo-roles", `/api/repo-roles?repo=${r}`),
  get("/api/repo-collaborators", `/api/repo-collaborators?repo=${r}`),
  get("/api/drain/queue", `/api/drain/queue?repo=${r}`),
  get("/api/doc-agent/runs", `/api/doc-agent/runs?repo=${r}`),
  get("/api/issues/:p", `/api/issues/103?repo=${r}`),

  // usage lens (#2295)
  get("/api/usage/breakdown", "/api/usage/breakdown?range=7d"),
  get("/api/usage/timeline", "/api/usage/timeline?range=24h"),
  get("/api/usage/delivery", "/api/usage/delivery?range=7d"),
  get("/api/usage/github"),
  get("/api/prompt-budget"),

  // ambient reads (#2295)
  get("/api/plugins/manage/installed"),
  get("/api/github/owners"),
  get("/api/update/dirty"),
  get("/api/codex-update/notes"),
  get("/api/plugins/voice-whisper/status"),
  get("/api/blocks"),
  get("/api/amendments"),
  get("/api/spawn-notices"),

  // session-detail tabs
  get("/api/sessions/:p/git", `/api/sessions/${PROBE}/git`),
  get("/api/sessions/:p/activity", `/api/sessions/${PROBE}/activity`),
  get("/api/sessions/:p/diff", `/api/sessions/${PROBE}/diff`),
  get("/api/sessions/:p/scratchpad", `/api/sessions/${PROBE}/scratchpad`),
  get("/api/sessions/:p/worktree", `/api/sessions/${PROBE}/worktree`),
  get("/api/sessions/:p/usage", `/api/sessions/${PROBE}/usage`),
  get("/api/sessions/:p/leftovers", `/api/sessions/${PROBE}/leftovers`),
  get("/api/sessions/:p/queue", `/api/sessions/${PROBE}/queue`),

  // mutations the demo flow really performs
  { method: "PUT", path: "/api/settings", body: { defaultModel: "opus" } },
  post("/api/sessions", "/api/sessions", { repoPath: REPO, prompt: "add a thing" }),
  post("/api/sessions/clear-merged", "/api/sessions/clear-merged", { ids: [] }),
  post("/api/projects", "/api/projects", { name: "checkout-svc", createRemote: false }),
  post("/api/adopt-gitignore", `/api/adopt-gitignore?repo=${r}`),
  post("/api/epic/approve-next", `/api/epic/approve-next?repo=${r}&parent=100`),
  post("/api/sessions/:p/reply", `/api/sessions/${PROBE}/reply`, { text: "go on" }),
  { method: "PUT", path: "/api/sessions/:p/autopilot", url: `/api/sessions/${PROBE}/autopilot` },
  post("/api/sessions/:p/review-plan", `/api/sessions/${PROBE}/review-plan`),
  post("/api/sessions/:p/go", `/api/sessions/${PROBE}/go`),
  post("/api/sessions/:p/answer-plan-questions", `/api/sessions/${PROBE}/answer-plan-questions`),
  post("/api/sessions/:p/git/merge", `/api/sessions/${PROBE}/git/merge`),
  post("/api/sessions/:p/git/close", `/api/sessions/${PROBE}/git/close`),
  post("/api/sessions/:p/ready", `/api/sessions/${PROBE}/ready`, { ready: true }),
  post("/api/sessions/:p/ack-manual-steps", `/api/sessions/${PROBE}/ack-manual-steps`),
  { method: "DELETE", path: "/api/sessions/:p", url: `/api/sessions/${PROBE}` },
  post("/api/held/:p/spawn", `/api/held/${PROBE}/spawn`),
  post("/api/manual-steps/:p/steps/:p", `/api/manual-steps/${PROBE}/steps/s1`, { done: true }),
  post("/api/manual-steps/:p/dismiss", `/api/manual-steps/${PROBE}/dismiss`),
];

/** Endpoints that are CORRECT on the permissive tail, grouped by why.
 *
 *  These are triage decisions, not a backlog. The common thread: nothing in the demo can
 *  reach them, or reaching them degrades honestly (a button that does nothing visible)
 *  rather than putting `undefined` somewhere a `$derived` will dereference. Anything that
 *  stops being true — a demo screen starts firing one of these — moves to INVENTORY. */
const DELIBERATE_TAIL: Readonly<Record<string, readonly string[]>> = {
  // The demo has no server to authenticate against and nothing to restart; `/api/me`
  // already answers "authenticated", so none of these are ever fired.
  "auth + process control": [
    "/api/login",
    "/api/logout",
    "/api/halt",
    "/api/restart",
    "/api/retry",
    "/api/broadcast",
    "/api/revive-stranded",
  ],

  // Actions on a session that the scripted demo never drives. Each returns `{ok:true}`,
  // which every one of these callers either ignores or reads only for `ok`.
  "session lifecycle actions": [
    "/api/sessions/:p/interrupt",
    "/api/sessions/:p/rename",
    "/api/sessions/:p/replace",
    "/api/sessions/:p/resume",
    "/api/sessions/:p/restore",
    "/api/sessions/:p/relaunch",
    "/api/sessions/:p/relaunch-uploads",
    "/api/sessions/:p/variant",
    "/api/sessions/:p/recommend-prompt",
    "/api/sessions/:p/quota/dismiss",
    "/api/sessions/:p/quota/resume",
    "/api/sessions/:p/review-pr",
    "/api/sessions/:p/recap/regenerate",
    "/api/sessions/:p/git/pr",
    "/api/sessions/:p/git/draft",
    "/api/sessions/:p/git/ready",
    "/api/sessions/:p/git/redeploy",
    "/api/sessions/:p/git/request-review",
    "/api/sessions/:p/preview/start",
    "/api/sessions/:p/preview/stop",
    "/api/sessions/:p/queue/approve",
    "/api/sessions/:p/epic-draft/approve",
    "/api/spawns/:p/cancel",
    "/api/spawn-notices/:p/:p/retry",
  ],

  // Session reads behind a tab or affordance no seeded session opens: no session carries
  // an amendment, an epic draft, a diff annotation or a downloadable file.
  "session reads with no seeded subject": [
    "/api/sessions/:p/amendments",
    "/api/sessions/:p/amendments/:p",
    "/api/sessions/:p/diff/annotations",
    "/api/sessions/:p/epic-draft",
    "/api/sessions/:p/git/reviewers",
    "/api/sessions/:p/scratchpad/download",
    "/api/sessions/:p/scratchpad/upload",
    "/api/sessions/:p/worktree/download",
  ],

  // Learnings mutations. The lens itself IS seeded and reads fine; approving, dismissing
  // or promoting a learning is a write the demo does not persist.
  "learnings actions": [
    "/api/learnings/:p/approve",
    "/api/learnings/:p/dismiss",
    "/api/learnings/:p/optimize",
    "/api/learnings/:p/promote",
    "/api/learnings/:p/restore",
    "/api/learnings/:p/revert-trial",
    "/api/learnings/:p/scope",
    "/api/learnings/distill",
    "/api/learnings/merge",
    "/api/learnings/merge-dismiss",
    "/api/learnings/merge-suggest",
    "/api/learnings/optimize",
    "/api/learnings/seen-retired",
  ],

  // Backlog / epic / CI actions. Their READS are all in INVENTORY; these are the writes,
  // which would need a real forge behind them to mean anything.
  "backlog, epic + CI actions": [
    "/api/epic/diagnose",
    "/api/epic/import",
    "/api/epics/completed/ack-migrations",
    "/api/epics/completed/dismiss",
    "/api/epics/completed/land",
    "/api/epics/completed/resolve-conflicts",
    "/api/up-next/refresh",
    "/api/up-next/start",
    "/api/prs/merge",
    "/api/prs/dependabot-rebase",
    "/api/actions/rerun",
    "/api/actions/cancel",
    "/api/actions/retry-ci",
    "/api/doc-agent",
    "/api/held/:p",
  ],

  // Repo actions that touch a real checkout or a real forge account.
  "repo actions": [
    "/api/repos/fork",
    "/api/repos/pull",
    "/api/repos/sync-fork",
    "/api/repos/init-empty-commit",
    "/api/github/repos",
  ],

  // Settings/plugin/update WRITES and the probes behind them. Every corresponding read is
  // in INVENTORY; installing a plugin or applying an update has nothing to act on here.
  "settings, plugin + update actions": [
    "/api/access-tokens/:p",
    "/api/settings/verify-key",
    "/api/plugins/manage/install",
    "/api/plugins/manage/activate",
    "/api/plugins/manage/installed/:p",
    "/api/plugins/:p/:p",
    "/api/plugins/voice-whisper/transcribe",
    "/api/plugin-update/apply",
    "/api/plugin-update/check",
    "/api/herdr-update/restart",
    "/api/herdr-update/downgrade",
    "/api/herdr-update/downgrade/sandbox",
    "/api/diagnostics/fix",
    "/api/provider-failover",
    "/api/usage/refresh",
    "/api/usage/codex/reset",
    "/api/usage/codex/automation",
    "/api/experiments/:p/compare",
  ],

  // Operator decision on #2295, recorded here rather than left implicit. Shape is an LLM
  // round-trip with nothing to simulate — a demo handler would have to invent a shaped
  // round that fits exactly one seeded prompt — and Attach writes a real file. Both
  // already degrade honestly: `shapeTask()` to `{error:"timeout"}`, `composeTaskBrief()`
  // to null, `uploadFile()` to an undefined path. None of the three can reach a
  // `$derived`, which is what separates them from `POST /api/projects` (in INVENTORY:
  // its response goes straight into `ondone(entry)` and the caller reads `entry.path`).
  "New Task Shape + Attach": ["/api/shape", "/api/shape/brief", "/api/uploads"],
};

const tailPaths = new Set(Object.values(DELIBERATE_TAIL).flat());
const inventoryPaths = new Set(INVENTORY.map((e) => e.path));

beforeEach(() => demoState.reset());

describe("demo API coverage", () => {
  it("classifies every /api path api.ts can request", () => {
    const unclassified = [...scrapeApiPaths()].filter(
      (p) => !inventoryPaths.has(p) && !tailPaths.has(p),
    );
    // A new endpoint in api.ts lands here. Seed it in the demo router and add it to
    // INVENTORY, or add it to DELIBERATE_TAIL with the reason it is correct on the tail.
    expect(unclassified).toEqual([]);
  });

  it("lists nothing api.ts no longer requests", () => {
    const live = scrapeApiPaths();
    const stale = [...inventoryPaths, ...tailPaths].filter((p) => !live.has(p));
    expect(stale).toEqual([]);
  });

  it("never classifies a path as both handled and deliberately un-handled", () => {
    expect([...inventoryPaths].filter((p) => tailPaths.has(p))).toEqual([]);
  });

  it.each(INVENTORY.map((e) => [`${e.method} ${e.path}`, e] as const))(
    "%s is answered by a real handler",
    async (_label, entry) => {
      const res = await handleApi(
        entry.method,
        new URL(entry.url ?? entry.path, "http://localhost"),
        entry.body,
      );
      // "1" = no route matched (the permissive tail); "error" = a handler matched but
      // threw, which the tail also swallows. Both mean this endpoint is NOT really served.
      expect(res.headers.get("x-demo-fallthrough")).toBeNull();
    },
  );
});

// ── half 3: the shape the CALLER actually unwraps ───────────────────────────
//
// Halves 1 and 2 prove a handler exists and answers. Neither proves it answers the
// shape `api.ts` reads back, and that gap is not hypothetical: two endpoints here
// shipped correct-looking bodies that the caller threw away, because `getIssue()` reads
// `body.issue` and `getPromptBudgets()` reads `body.records` rather than the value
// itself. A hand-written assertion on the RESPONSE cannot catch that — it agrees with
// whatever the handler was written to return.
//
// So this half calls the real `api.ts` function, through the real demo router, and
// asserts the value the UI would actually bind. It covers the endpoints where the demo
// promises CONTENT; for those, empty is a defect, which makes a non-empty assertion a
// genuine contract check rather than a tautology.
describe("api.ts consumers get real content through the demo router", () => {
  const realFetch = globalThis.fetch;

  // Route `api.ts`'s own fetches into the demo router, exactly as install.ts does in the
  // browser — so these run through the real client code path, not a re-implementation.
  // Installed in beforeAll (not at describe-evaluation time) so the override's lifetime is
  // this block's, and the rest of the file keeps the real `fetch`.
  beforeAll(() => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return handleApi(init?.method ?? "GET", url, body);
    }) as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  it("getIssue returns the Issue the peek binds, not null", async () => {
    const issue = await api.getIssue(REPO, 103);
    expect(issue).not.toBeNull();
    expect(issue?.number).toBe(103);
    expect(issue?.title.length).toBeGreaterThan(0);
  });

  it("getPromptBudgets returns the records the Prompt lens renders", async () => {
    const records = await api.getPromptBudgets();
    expect(records.length).toBeGreaterThan(0);
    expect(records[0].blocks.length).toBeGreaterThan(0);
  });

  it("listPullRequests returns the rows the PRs tab renders", async () => {
    const { prs, slug } = await api.listPullRequests(REPO);
    expect(prs.length).toBeGreaterThan(0);
    expect(slug).toBe("acme/storefront");
  });

  it("listWorkflowRuns returns runs plus the capability flags the tab gates on", async () => {
    const res = await api.listWorkflowRuns(REPO);
    expect(res.runs.length).toBeGreaterThan(0);
    expect(res.supportsActions).toBe(true);
  });

  it("listWorkflowRunHistory + listRunJobs fill the expanders under a run", async () => {
    const { runs } = await api.listWorkflowRuns(REPO);
    const history = await api.listWorkflowRunHistory(REPO, runs[0].workflowId, 10);
    expect(history.runs.length).toBeGreaterThan(0);
    const jobs = await api.listRunJobs(REPO, history.runs[0].runId);
    expect(jobs.jobs.length).toBeGreaterThan(0);
  });

  it("getReadiness returns a scored report with both columns populated", async () => {
    const report = await api.getReadiness(REPO);
    expect(report.applicable).toBe(true);
    expect(report.checks.some((c) => c.present)).toBe(true);
    expect(report.checks.some((c) => !c.present)).toBe(true);
  });

  it("getDrainQueue returns the queued issues the popover lists", async () => {
    expect((await api.getDrainQueue(REPO)).length).toBeGreaterThan(0);
  });

  it("getRepoWeb + getRepoRoles + getRepoCollaborators fill Settings → Automation", async () => {
    expect((await api.getRepoWeb(REPO)).slug).toBe("acme/storefront");
    const { roles } = await api.getRepoRoles(REPO);
    expect(roles.reviewer).toBeTruthy();
    const { logins } = await api.getRepoCollaborators(REPO);
    // A configured reviewer the picker cannot offer renders as a blank selection.
    expect(logins).toContain(roles.reviewer);
  });

  it("getInstalledPlugins returns the rows Settings → Plugins renders", async () => {
    expect((await api.getInstalledPlugins()).length).toBeGreaterThan(0);
  });

  it("getUsageBreakdown + getUsageTimeline + getDeliveryMetrics fill the Usage lens", async () => {
    const breakdown = await api.getUsageBreakdown("7d");
    expect(breakdown.repos.length).toBeGreaterThan(0);
    expect(breakdown.satelliteByKind.length).toBeGreaterThan(0);

    const timeline = await api.getUsageTimeline("24h");
    expect(timeline.hours.length).toBeGreaterThan(0);

    const delivery = await api.getDeliveryMetrics("7d");
    expect(delivery.repos.length).toBeGreaterThan(0);
    expect(delivery.tasks.length).toBeGreaterThan(0);
  });

  it("getGithubRateLimit returns all three buckets", async () => {
    const limits = await api.getGithubRateLimit();
    expect(limits.rest).not.toBeNull();
    expect(limits.graphql).not.toBeNull();
    expect(limits.search).not.toBeNull();
  });

  it("getGithubOwners returns owners — and does NOT reach its own error fallback", async () => {
    const { login, orgs } = await api.getGithubOwners();
    // It swallows failures into `{login:null, orgs:[]}`, so a truthy login is the only
    // proof the request actually succeeded rather than silently degrading.
    expect(login).toBeTruthy();
    expect(orgs.length).toBeGreaterThan(0);
  });

  it("createProject returns an entry whose .path the New Project caller can read", async () => {
    const entry = await api.createProject({
      name: "checkout-svc",
      idea: "",
      createRemote: false,
      visibility: "private",
    });
    expect(entry.path.endsWith("/checkout-svc")).toBe(true);
  });
});
