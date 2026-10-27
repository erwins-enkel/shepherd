import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import type { SessionStore } from "../src/store";
import type { SessionService } from "../src/service";
import type { EventHub } from "../src/events";
import type { GitForge, RepoForgeSettings } from "../src/forge/types";
import { config } from "../src/config";

let tmpRoot: string;
let repoDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-readiness-forge-test-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(join(repoDir, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(repoDir, ".github", "workflows", "ci.yml"),
    "on: [pull_request]\njobs:\n  lint: {}\n",
  );
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

const BAD: RepoForgeSettings = {
  defaultBranch: "main",
  mergeMethods: { merge: true, squash: false, rebase: false },
  autoMergeAllowed: false,
  deleteBranchOnMerge: false,
  requiredChecks: [],
  labelExists: false,
  canAdminister: true,
  canPush: true,
  planLimited: false,
};

/** A GitHub-shaped forge whose writes flip the in-memory settings. */
function fakeForge(initial: RepoForgeSettings, opts: { fail?: boolean } = {}) {
  let s = { ...initial };
  const writes: unknown[][] = [];
  const write = async (...args: unknown[]) => {
    writes.push(args);
    if (opts.fail) throw new Error("gh: HTTP 403 secret stderr");
  };
  const forge = {
    kind: "github",
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    repoForgeSettings: async (label: string) => {
      writes.push(["read", label]);
      return s;
    },
    patchRepoSettings: async (p: {
      mergeMethods?: RepoForgeSettings["mergeMethods"];
      deleteBranchOnMerge?: boolean;
    }) => {
      await write("patch", p);
      if (p.mergeMethods) s = { ...s, mergeMethods: p.mergeMethods };
      if (p.deleteBranchOnMerge !== undefined)
        s = { ...s, deleteBranchOnMerge: p.deleteBranchOnMerge };
    },
    enableRepoAutoMerge: async () => {
      await write("auto");
      s = { ...s, autoMergeAllowed: true };
    },
    createRequiredChecksRuleset: async (c: string[]) => {
      await write("ruleset", c);
      s = { ...s, requiredChecks: c };
    },
    createRepoLabel: async (n: string) => {
      await write("label", n);
      s = { ...s, labelExists: true };
    },
  } as unknown as GitForge;
  return { forge, writes: () => writes.filter((w) => w[0] !== "read") };
}

function deps(forge: GitForge | null): AppDeps {
  return {
    store: { getRepoConfig: () => ({ autoLabel: "shepherd:auto" }) } as unknown as SessionStore,
    service: {} as SessionService,
    events: { emit: () => {} } as unknown as EventHub,
    usageLimits: { limits: () => ({}) } as never,
    resolveForge: () => forge,
  };
}

const url = (path: string) =>
  `http://localhost/api/readiness/forge${path}?repo=${encodeURIComponent(repoDir)}`;
const apply = (check: unknown) =>
  new Request(url("/apply"), { method: "POST", body: JSON.stringify({ check }) });

test("GET lists the five checks with current/target", async () => {
  const { forge } = fakeForge(BAD);
  const res = await makeApp(deps(forge)).fetch(new Request(url("")));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.supported).toBe(true);
  expect(body.autoLabel).toBe("shepherd:auto");
  expect(body.checks.map((c: { state: string }) => c.state)).toEqual(Array(5).fill("fix"));
  expect(body.checks[3]).toMatchObject({ id: "required_checks", target: ["lint"] });
});

test("non-GitHub / missing forge → supported:false", async () => {
  const gitea = { kind: "gitea", slug: "o/r", mergeMethod: "squash" } as unknown as GitForge;
  for (const f of [null, gitea]) {
    const res = await makeApp(deps(f)).fetch(new Request(url("")));
    expect(await res.json()).toEqual({ supported: false });
  }
});

test("apply each fix calls the API and returns re-checked state", async () => {
  const { forge, writes } = fakeForge(BAD);
  const app = makeApp(deps(forge));
  for (const id of [
    "merge_methods",
    "auto_merge",
    "delete_branch_on_merge",
    "required_checks",
    "auto_label",
  ]) {
    const res = await app.fetch(apply(id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checks.find((c: { id: string }) => c.id === id).state).toBe("ok");
  }
  expect(writes()).toEqual([
    ["patch", { mergeMethods: { merge: true, squash: true, rebase: false } }],
    ["auto"],
    ["patch", { deleteBranchOnMerge: true }],
    ["ruleset", ["lint"]],
    ["label", "shepherd:auto"],
  ]);
});

test("apply on a non-fix check → 409, no write", async () => {
  const { forge, writes } = fakeForge({ ...BAD, canAdminister: false });
  const res = await makeApp(deps(forge)).fetch(apply("auto_merge"));
  expect(res.status).toBe(409);
  expect(writes()).toEqual([]);
});

test("apply with bad check id → 400", async () => {
  const { forge } = fakeForge(BAD);
  expect((await makeApp(deps(forge)).fetch(apply("nope"))).status).toBe(400);
});

test("apply failure → 502 with a generic body", async () => {
  const { forge } = fakeForge(BAD, { fail: true });
  const res = await makeApp(deps(forge)).fetch(apply("auto_label"));
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: "apply_failed" });
});
