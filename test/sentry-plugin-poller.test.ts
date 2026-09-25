// Sentry plugin (#2464): poll → rules → triage → filing, end to end over recorded fixtures
// (see sentry-plugin-api.test.ts for the fixture note) with a fake fetch and in-memory state.

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPoller, pollQuery, type PollerDeps } from "../src/plugins/bundled/sentry/poller";
import { DEFAULT_SETTINGS, type Settings } from "../src/plugins/bundled/sentry/state";
import type {
  PluginIssue,
  PluginIssueCreateInput,
  PluginRepo,
  PluginState,
} from "../src/plugins/types";

const FIX = join(import.meta.dir, "fixtures/sentry");
const fixtureText = (n: string) => readFileSync(join(FIX, n), "utf8");

function memState(): PluginState {
  const m = new Map<string, string>();
  return {
    get: <T>(k: string) => (m.has(k) ? (JSON.parse(m.get(k)!) as T) : null),
    set: (k, v) => void m.set(k, JSON.stringify(v ?? null)),
    delete: (k) => void m.delete(k),
    keys: () => [...m.keys()],
  };
}

interface Call {
  url: URL;
}

let repo: string;
let calls: Call[];
let created: Array<{ repo: string; input: PluginIssueCreateInput }>;
let respond: (url: URL) => Response;
let ghState: PluginIssue["state"];
let verdict: { fixable: boolean; confidence: string };
let clock: number;

const ok = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers });

function defaultRespond(url: URL): Response {
  if (url.pathname.endsWith("/events/latest/"))
    return ok(fixtureText("recorded-event-latest.json"));
  if (url.pathname.endsWith("/issues/")) return ok(fixtureText("recorded-issues.json"));
  if (url.pathname.endsWith("/code-mappings/"))
    return ok(fixtureText("recorded-code-mappings.json"));
  return new Response("", { status: 404 });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "shep-sentry-poll-"));
  mkdirSync(join(repo, "src/lib/server"), { recursive: true });
  writeFileSync(join(repo, "src/lib/server/session.ts"), "");
  writeFileSync(join(repo, "src/hooks.server.ts"), "");
  calls = [];
  created = [];
  respond = defaultRespond;
  ghState = "open";
  verdict = { fixable: true, confidence: "high" };
  clock = Date.parse("2026-09-25T10:00:00Z");
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

function setup(
  over: { settings?: Partial<Settings>; autoDrain?: boolean; token?: string | null } = {},
) {
  const state = memState();
  state.set("settings", { ...DEFAULT_SETTINGS, enabled: true, org: "acme", ...over.settings });
  state.set("mappings", {
    [repo]: { project: "flowagent", autoDrain: over.autoDrain ?? false, source: "manual" },
  });
  const repos: PluginRepo[] = [
    { path: repo, name: "flowagent", autoLabel: "shepherd:auto", lightweight: false },
  ];
  let n = 100;
  const deps: PollerDeps = {
    state,
    secrets: { get: () => (over.token === undefined ? "tok-secret" : over.token) },
    envToken: () => undefined,
    issues: {
      create: async (r, input) => {
        created.push({ repo: r, input });
        n++;
        return { number: n, url: `https://github.com/o/r/issues/${n}` };
      },
      get: async (_r, number) => ({
        number,
        title: "t",
        body: "",
        url: "u",
        labels: [],
        state: ghState,
      }),
    },
    agents: {
      runReadonly: async () => ({
        ...verdict,
        hypothesis: "h",
        files: ["src/lib/server/session.ts"],
        reason: "r",
      }),
    },
    repos: () => repos,
    fetch: async (url) => {
      const u = new URL(url);
      calls.push({ url: u });
      return respond(u);
    },
    now: () => new Date(clock),
    log: { log: () => {}, warn: () => {} },
  };
  return { poller: createPoller(deps), state };
}

test("disabled (the default) → no network at all", async () => {
  const { poller } = setup({ settings: { enabled: false } });
  expect(await poller.poll()).toBe("disabled");
  await poller.tick();
  expect(calls).toHaveLength(0);
});

test("no token → not-configured, no calls", async () => {
  const { poller } = setup({ token: null });
  expect(await poller.poll()).toBe("not-configured");
  expect(calls).toHaveLength(0);
});

test("one org-wide list call with the rule query, then files the eligible issue", async () => {
  const { poller, state } = setup();
  expect(await poller.poll()).toBe("ok");

  const list = calls.filter((c) => c.url.pathname === "/api/0/organizations/acme/issues/");
  expect(list).toHaveLength(1);
  expect(list[0]!.url.searchParams.get("project")).toBe("-1");
  expect(list[0]!.url.searchParams.get("sort")).toBe("new");
  expect(list[0]!.url.searchParams.get("query")).toBe(pollQuery(10));
  expect(pollQuery(10)).toBe(
    "is:unresolved issue.priority:high (is:new OR is:escalating OR is:regressed) times_seen:>10",
  );
  // Only the mapped, unassigned issue gets its event fetched (1B is human-assigned, OTHER unmapped).
  expect(
    calls.filter((c) => c.url.pathname.endsWith("/events/latest/")).map((c) => c.url.pathname),
  ).toEqual(["/api/0/organizations/acme/issues/4501/events/latest/"]);

  expect(created).toHaveLength(1);
  const { input } = created[0]!;
  expect(created[0]!.repo).toBe(repo);
  expect(input.title).toBe("Sentry FLOWAGENT-1A: production error in flowagent");
  expect(input.title).not.toContain("Cannot read");
  expect(input.labels).toEqual(["sentry"]);
  expect(input.body).toContain("Fixes FLOWAGENT-1A");
  expect(input.body).toContain("draft");
  expect(input.body).toContain("`src/lib/server/session.ts`");
  expect(input.body).toContain("https://sentry.io/organizations/acme/issues/4501/");

  const untrusted = JSON.stringify(input.untrusted);
  for (const leak of [
    "victim@example.com",
    "203.0.113.9",
    "abc123SECRET",
    "SUPERSECRETCOOKIE",
    "deadbeefcafe",
    "u-991",
  ]) {
    expect(untrusted).not.toContain(leak);
    expect(input.body).not.toContain(leak);
  }
  expect(untrusted).toContain("src/lib/server/session.ts:42 in loadUser");
  expect(untrusted).toContain("environment: production");
  expect(untrusted).not.toContain("url:");

  expect(state.get("map:4501")).toMatchObject({ repo, number: 101, attempts: 1 });
  expect(poller.hasToken()).toBe(true);
});

test("auto-drain mapping adds the repo's autoLabel", async () => {
  const { poller } = setup({ autoDrain: true });
  await poller.poll();
  expect(created[0]!.input.labels).toEqual(["sentry", "shepherd:auto"]);
});

test("dedup: a second poll of the same data files nothing and skips the event fetch", async () => {
  const { poller } = setup();
  await poller.poll();
  calls = [];
  await poller.poll();
  expect(created).toHaveLength(1);
  expect(calls.filter((c) => c.url.pathname.endsWith("/events/latest/"))).toHaveLength(0);
});

test("triage rejection is not filed and is not re-triaged next poll", async () => {
  verdict = { fixable: false, confidence: "low" };
  const { poller } = setup();
  await poller.poll();
  expect(created).toHaveLength(0);
  expect(poller.stage.rejected().map((r) => r.shortId)).toEqual(["FLOWAGENT-1A"]);
  calls = [];
  await poller.poll();
  expect(calls.filter((c) => c.url.pathname.endsWith("/events/latest/"))).toHaveLength(0);
});

function issuesResponse(ids: number[], substatus = "new"): string {
  const base = JSON.parse(fixtureText("recorded-issues.json"))[0];
  return JSON.stringify(
    ids.map((id) => ({ ...base, id: String(id), shortId: `FLOWAGENT-${id}`, substatus })),
  );
}

test("daily cap: at most 3 filed per repo per day; next day resumes; all-capped skips the call", async () => {
  respond = (u) =>
    u.pathname.endsWith("/issues/") ? ok(issuesResponse([1, 2, 3, 4, 5])) : defaultRespond(u);
  const { poller } = setup();
  await poller.poll();
  expect(created.map((c) => c.input.title.split(":")[0])).toEqual([
    "Sentry FLOWAGENT-1",
    "Sentry FLOWAGENT-2",
    "Sentry FLOWAGENT-3",
  ]);
  calls = [];
  expect(await poller.poll()).toBe("capped");
  expect(calls).toHaveLength(0);

  clock += 24 * 3600_000;
  await poller.poll();
  expect(created).toHaveLength(5);
});

test("regressed after the GitHub issue closed → re-filed once; attempt cap then holds", async () => {
  const { poller, state } = setup();
  await poller.poll();
  respond = (u) =>
    u.pathname.endsWith("/issues/") ? ok(issuesResponse([4501], "regressed")) : defaultRespond(u);

  await poller.poll(); // GitHub issue still open → no refile
  expect(created).toHaveLength(1);

  ghState = "closed";
  await poller.poll();
  expect(created).toHaveLength(2);
  expect(state.get("map:4501")).toMatchObject({ attempts: 2, number: 102 });

  await poller.poll();
  expect(created).toHaveLength(2);
});

test("429 on the list call backs off; no calls until it expires", async () => {
  respond = () => new Response("", { status: 429, headers: { "retry-after": "600" } });
  const { poller, state } = setup();
  expect(await poller.poll()).toBe("error");
  expect(state.get<{ backoffUntil: number }>("status")!.backoffUntil).toBe(clock + 600_000);
  calls = [];
  clock += 5 * 60_000;
  expect(await poller.poll()).toBe("backoff");
  await poller.tick();
  expect(calls).toHaveLength(0);
  clock += 6 * 60_000;
  respond = defaultRespond;
  expect(await poller.poll()).toBe("ok");
});

test("400 on the grouped query retries once without the group", async () => {
  let first = true;
  respond = (u) => {
    if (u.pathname.endsWith("/issues/") && first) {
      first = false;
      return new Response("", { status: 400 });
    }
    return defaultRespond(u);
  };
  const { poller } = setup();
  expect(await poller.poll()).toBe("ok");
  const queries = calls
    .filter((c) => c.url.pathname.endsWith("/acme/issues/"))
    .map((c) => c.url.searchParams.get("query"));
  expect(queries).toEqual([pollQuery(10), pollQuery(10, false)]);
  expect(created).toHaveLength(1);
});

test("frames outside the repo → not filed", async () => {
  rmSync(join(repo, "src"), { recursive: true, force: true });
  const { poller, state } = setup();
  await poller.poll();
  expect(created).toHaveLength(0);
  expect(
    state.get<{ lastResult: Record<string, number> }>("status")!.lastResult["not-in-repo"],
  ).toBe(1);
});

test("tick honours the poll interval", async () => {
  const { poller } = setup({ settings: { pollMinutes: 5 } });
  await poller.tick();
  const n = calls.length;
  expect(n).toBeGreaterThan(0);
  clock += 4 * 60_000;
  await poller.tick();
  expect(calls.length).toBe(n);
  clock += 60_000;
  await poller.tick();
  expect(calls.length).toBeGreaterThan(n);
});

test("detect: repo config first, code-mappings for the rest; failures tolerated", async () => {
  writeFileSync(join(repo, "vite.config.ts"), fixtureText("vite.config.ts.txt"));
  const { poller, state } = setup();
  state.set("mappings", {});
  expect(await poller.detect()).toEqual([
    { repo, org: "ltdovr", project: "flowagent", source: "sentry-config" },
  ]);

  rmSync(join(repo, "vite.config.ts"));
  mkdirSync(join(repo, ".git"));
  writeFileSync(
    join(repo, ".git/config"),
    '[remote "origin"]\n\turl = https://github.com/ltdovr/flowagent.git\n',
  );
  expect(await poller.detect()).toEqual([
    { repo, org: null, project: "flowagent", source: "code-mappings" },
  ]);

  respond = () => new Response("", { status: 403 });
  expect(await poller.detect()).toEqual([]);
});
