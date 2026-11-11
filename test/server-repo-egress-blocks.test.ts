import { test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { config } from "../src/config";
import type { EgressBlock, EgressSuggestion } from "../src/types";

// #3922: the repo's blocked egress hosts, aggregated from egress_drop signals.

let tmpRoot: string;
let repoDir: string;
let store: SessionStore;
const savedExtra = config.sandboxEgressExtraHosts;
const savedForges = config.forges;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-egress-blocks-test-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir, { recursive: true });
  repoDir = realpathSync(repoDir);
  store = new SessionStore(":memory:");
  config.forges = {};
  config.sandboxEgressExtraHosts = [];
});
afterEach(() => {
  config.sandboxEgressExtraHosts = savedExtra;
  config.forges = savedForges;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function app() {
  const deps: AppDeps = {
    store,
    service: {} as any,
    events: new EventHub(),
    usageLimits: { limits: () => ({}) } as any,
    resolveForge: () => null,
  };
  return makeApp(deps);
}

function drop(host: string, sessionId: string | null, repoPath = repoDir) {
  store.addSignal({ repoPath, sessionId, kind: "egress_drop", payload: host });
}

async function get(repo: string): Promise<Response> {
  return app().fetch(
    new Request(`http://x/api/repo-egress-blocks?repo=${encodeURIComponent(repo)}`),
  );
}

test("listEgressBlocks aggregates per host, newest first, repo- and kind-scoped", async () => {
  drop("a.example.com", "s1");
  await Bun.sleep(2);
  drop("b.example.com", "s1");
  await Bun.sleep(2);
  drop("a.example.com", "s2");
  drop("a.example.com", "s2"); // a restart re-reports it
  drop("other.example.com", "s3", "/elsewhere");
  store.addSignal({ repoPath: repoDir, sessionId: "s1", kind: "reply", payload: "x.example.com" });

  const rows = store.listEgressBlocks(repoDir);
  expect(rows.map((r) => r.host)).toEqual(["a.example.com", "b.example.com"]);
  expect(rows[0]).toMatchObject({ count: 3, sessions: 2, sessionIds: ["s2", "s1"] });
  expect(rows[1]).toMatchObject({ count: 1, sessions: 1, sessionIds: ["s1"] });
  expect(rows[0]!.lastSeen).toBeGreaterThan(rows[1]!.lastSeen);
});

test("listEgressBlocks caps sessionIds at 5 and hosts at limit", () => {
  for (let i = 0; i < 7; i++) drop("a.example.com", `s${i}`);
  drop("b.example.com", null);
  const rows = store.listEgressBlocks(repoDir, 1);
  expect(rows).toHaveLength(1);
  const all = store.listEgressBlocks(repoDir);
  const a = all.find((r) => r.host === "a.example.com")!;
  expect(a.sessions).toBe(7);
  expect(a.sessionIds).toHaveLength(5);
  expect(all.find((r) => r.host === "b.example.com")).toMatchObject({
    count: 1,
    sessions: 0,
    sessionIds: [],
  });
});

test("GET refuses an invalid repo", async () => {
  expect((await get("/definitely/not/here")).status).toBe(400);
  expect((await get("")).status).toBe(400);
});

test("GET drops hosts the effective allowlist now covers", async () => {
  for (const h of [
    "registry.npmjs.org",
    "cdn.repo-extra.example", // subdomain of a repo extra
    "global.example.com",
    "api.github.com", // built-in forge host
    "mcp-proxy.anthropic.com", // connector proxy once the repo opts in
    "evil.example.net",
    "_ldap._tcp.example.net", // SRV name: no allowlist entry can hold it
    "localhost", // single label
  ])
    drop(h, "s1");
  store.setRepoConfig(repoDir, {
    ...store.getRepoConfig(repoDir),
    egressExtraHosts: ["registry.npmjs.org", "repo-extra.example"],
    claudeAiConnectorsEnabled: true,
  });
  config.sandboxEgressExtraHosts = ["global.example.com"];

  const res = await get(repoDir);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { hosts: EgressBlock[] };
  expect(body.hosts.map((h) => h.host)).toEqual(["evil.example.net"]);
  expect(body.hosts[0]).toMatchObject({ count: 1, sessions: 1, sessionIds: ["s1"] });
});

// #3927: registry hosts from the repo's tracked lockfiles.

async function getSuggestions(repo: string): Promise<Response> {
  return app().fetch(
    new Request(`http://x/api/repo-egress-suggestions?repo=${encodeURIComponent(repo)}`),
  );
}

function commitLockfiles(files: Record<string, string>) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(repoDir, p, ".."), { recursive: true });
    writeFileSync(join(repoDir, p), text);
  }
  execFileSync("git", ["init", "-q"], { cwd: repoDir, env, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: repoDir, env, stdio: "ignore" });
}

test("GET suggestions refuses an invalid repo", async () => {
  expect((await getSuggestions("/definitely/not/here")).status).toBe(400);
});

test("GET suggestions drops allowed and already-blocked hosts", async () => {
  commitLockfiles({
    "bun.lock": `{"packages":{"a":["a@1.0.0","",{},"x"],"b":["b@1","https://npm.pkg.github.com/",{},"y"]}}`,
    "cli/Cargo.lock": `[[package]]\nsource = "sparse+https://index.crates.io/"\n`,
    "go.sum": "golang.org/x/net v0.1.0 h1:abc=\n",
  });
  store.setRepoConfig(repoDir, {
    ...store.getRepoConfig(repoDir),
    egressExtraHosts: ["registry.npmjs.org"],
  });
  config.sandboxEgressExtraHosts = ["crates.io"]; // suffix-covers static./index.crates.io too
  drop("proxy.golang.org", "s1"); // offered in Blocked hosts instead

  const res = await getSuggestions(repoDir);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { hosts: EgressSuggestion[] };
  expect(body.hosts).toEqual([{ host: "sum.golang.org", sources: ["go.sum"] }]);
});
