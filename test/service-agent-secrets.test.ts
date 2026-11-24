// Per-repo agent secrets (#4122) at the task spawn seam: prepareSpawn writes the session's secret
// dir, launches the agent behind the secret launcher (directly when trusted, inside the membrane
// when sandboxed), records the names-only audit, and archive removes the dir. Values never ride
// the argv or the spawn env.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionService } from "../src/service";
import { SessionStore } from "../src/store";
import { secretEnvLauncher, secretLauncherSkip } from "../src/agent-secrets";

const VALUE = "s3cr3t value with 'quotes' and $dollar";
let spawnDir: string;

beforeEach(async () => {
  spawnDir = await mkdtemp(join(tmpdir(), "shepherd-agent-secrets-"));
});
afterEach(async () => {
  await rm(spawnDir, { recursive: true, force: true });
});

type Captured = { argv?: string[]; env?: Record<string, string> };

function harness(opts: {
  store: SessionStore;
  record: Captured;
  backend: "bwrap" | null;
  secrets: Record<string, Record<string, string>>;
}) {
  const entriesCalls: string[] = [];
  const svc = new SessionService({
    providerHandoffGit: async () => null,
    providerHandoffDeliver: async () => true,
    transcriptExists: () => true,
    store: opts.store,
    namer: async () => "s",
    worktree: {
      create: () => ({ worktreePath: "/wt/s", branch: "shepherd/s", isolated: true }),
      remove: () => {},
      gitCommonDir: () => "/wt/s/.git",
      ensureBaseRef: async () => {},
      branchExists: () => false,
    } as any,
    herdr: {
      start: async (_name: string, cwd: string, argv: string[], env: Record<string, string>) => {
        opts.record.argv = argv;
        opts.record.env = env;
        return { terminalId: "term_x", cwd } as any;
      },
      listAsync: async () => [],
      stop: async () => {},
      send: () => {},
    } as any,
    detectBackend: () => opts.backend,
    agentSpawnDir: spawnDir,
    agentSecrets: {
      entries: (repo: string) => {
        entriesCalls.push(repo);
        return { ...opts.secrets[repo] };
      },
    },
  });
  return { svc, entriesCalls };
}

function storeWith(profile: "trusted" | "standard"): SessionStore {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...store.getRepoConfig("/repo"), sandboxProfile: profile });
  return store;
}

async function create(svc: SessionService) {
  return svc.create({
    repoPath: "/repo",
    baseBranch: "main",
    prompt: "go",
    model: null,
    images: [],
  });
}

async function expectSecretDir(id: string): Promise<string> {
  const dir = join(spawnDir, `${id}.secrets`);
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
  const file = join(dir, "PKG_TOKEN");
  // One handle for mode + content (no path stat-then-read: CodeQL js/file-system-race).
  const fh = await open(file, "r");
  try {
    expect((await fh.stat()).mode & 0o777).toBe(0o600);
    expect(await fh.readFile("utf8")).toBe(VALUE);
  } finally {
    await fh.close();
  }
  return dir;
}

function expectNoValue(record: Captured) {
  expect(record.argv!.join("\n")).not.toContain(VALUE);
  expect(JSON.stringify(record.env)).not.toContain(VALUE);
}

test("trusted task spawn: launcher prefixes the agent argv, dir 0700/0600, audit recorded", async () => {
  const store = storeWith("trusted");
  const record: Captured = {};
  const { svc } = harness({
    store,
    record,
    backend: "bwrap",
    secrets: { "/repo": { PKG_TOKEN: VALUE } },
  });
  const s = await create(svc);
  const dir = await expectSecretDir(s.id);
  const argv = record.argv!;
  expect(secretLauncherSkip(argv, 0)).toBe(5);
  expect(argv[4]).toBe(dir);
  expect(argv[5]).toBe("claude");
  expectNoValue(record);
  expect(Object.keys(store.agentSecretLastInjected("/repo"))).toEqual(["PKG_TOKEN"]);

  await svc.archive(s.id);
  await expect(stat(dir)).rejects.toThrow();
});

test("standard task spawn: dir bound RO, launcher right after bwrap's `--`", async () => {
  const store = storeWith("standard");
  const record: Captured = {};
  const { svc } = harness({
    store,
    record,
    backend: "bwrap",
    secrets: { "/repo": { PKG_TOKEN: VALUE } },
  });
  const s = await create(svc);
  const dir = await expectSecretDir(s.id);
  const argv = record.argv!;
  expect(argv[0]).toBe("bwrap");
  const sep = argv.indexOf("--");
  const bind = argv.findIndex((t, i) => t === "--ro-bind" && argv[i + 1] === dir);
  expect(bind).toBeGreaterThan(0);
  expect(bind).toBeLessThan(sep);
  expect(argv.slice(sep + 1, sep + 6)).toEqual(secretEnvLauncher(dir, []));
  expect(argv[sep + 6]).toBe("claude");
  expectNoValue(record);
  expect(store.agentSecretLastInjected("/repo").PKG_TOKEN).toBeGreaterThan(0);
});

test("a repo without secrets gets no launcher, no dir and no audit row", async () => {
  const store = storeWith("trusted");
  const record: Captured = {};
  const { svc } = harness({
    store,
    record,
    backend: null,
    secrets: { "/other": { PKG_TOKEN: VALUE } },
  });
  const s = await create(svc);
  expect(record.argv![0]).toBe("claude");
  await expect(stat(join(spawnDir, `${s.id}.secrets`))).rejects.toThrow();
  expect(store.agentSecretLastInjected("/repo")).toEqual({});
});

test("the Operator Assistant never gets secrets (store not even consulted)", async () => {
  const store = storeWith("trusted");
  const { svc, entriesCalls } = harness({
    store,
    record: {},
    backend: null,
    secrets: { "/repo": { PKG_TOKEN: VALUE } },
  });
  const out = await (svc as any).prepareAgentSecrets({
    sessionId: "oa1",
    repoPath: "/repo",
    operatorAssistant: true,
  });
  expect(out).toEqual({ dir: undefined, names: [], repoKey: "/repo" });
  expect(entriesCalls).toEqual([]);
  await expect(stat(join(spawnDir, "oa1.secrets"))).rejects.toThrow();
});

test("a secret dir that can't be written holds the spawn with a value-free reason", async () => {
  const store = storeWith("trusted");
  const { svc } = harness({
    store,
    record: {},
    backend: null,
    secrets: { "/repo": { PKG_TOKEN: VALUE } },
  });
  const out = await (svc as any).prepareAgentSecrets({ sessionId: "../escape", repoPath: "/repo" });
  expect(out.holdReason).toContain("agent secrets could not be prepared");
  expect(out.holdReason).not.toContain(VALUE);
});
