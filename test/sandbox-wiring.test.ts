import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import { config } from "../src/config";
import { DrainService } from "../src/drain";
import { MEMBRANE_MISE_CONFIG, MEMBRANE_TOOL_BIN, type SandboxBackend } from "../src/sandbox";
import type { EgressBackend } from "../src/egress";
import { CLAUDEAI_CONNECTOR_EGRESS_HOST, egressTmpDir } from "../src/egress";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { sandboxScratchpadBind, sessionScratchpadDir } from "../src/tmp-sweep";
import { tmpdir } from "node:os";
import { startPreviewScript } from "../src/preview-launch";
import { join } from "node:path";
import type { StandardCreateInput, Session } from "../src/types";
import type { GitForge, Issue, PrStatus } from "../src/forge/types";
import type { UsageLimits } from "../src/usage-limits";
import type { EgressWatcher } from "../src/egress-watch";

// A herdr stub that records the argv it was started with (the assertion target).
function herdrStub(record: { argv?: string[] }) {
  return {
    start: async (_name: string, cwd: string, argv: string[]) => {
      record.argv = argv;
      return {
        terminalId: "term_x",
        cwd,
        agent: "claude",
        agentStatus: "working",
        paneId: "p",
        tabId: "t",
        workspaceId: "w",
      };
    },
    listAsync: async () => [],
    stop: async () => {},
    send: () => {},
    relabel: async () => {},
  } as any;
}

function worktreeStub() {
  return {
    create: () => ({
      worktreePath: "/wt/s",
      branch: "shepherd/s",
      isolated: true,
    }),
    remove: () => {},
    gitCommonDir: () => "/wt/s/.git",
    ensureBaseRef: async () => {},
    branchExists: () => false,
  } as any;
}

function makeService(opts: {
  store: SessionStore;
  record: { argv?: string[] };
  detectBackend: () => SandboxBackend;
  detectEgressBackend?: () => EgressBackend;
  egressProbed?: { called: boolean };
  prepareMembraneState?: ConstructorParameters<typeof SessionService>[0]["prepareMembraneState"];
  prepareMembraneMiseConfig?: ConstructorParameters<
    typeof SessionService
  >[0]["prepareMembraneMiseConfig"];
  prepareMembraneGhHosts?: ConstructorParameters<
    typeof SessionService
  >[0]["prepareMembraneGhHosts"];
  resolveMembraneGhBin?: () => Promise<string | null>;
  prepareScratchpadBind?: ConstructorParameters<typeof SessionService>[0]["prepareScratchpadBind"];
  previewLogFile?: (sessionId: string) => string;
}) {
  return new SessionService({
    transcriptExists: () => true, // Fixture conversations exist; filesystem refusal is tested separately.
    store: opts.store,
    namer: async () => "s",
    worktree: worktreeStub(),
    herdr: herdrStub(opts.record),
    detectBackend: opts.detectBackend,
    prepareMembraneState: opts.prepareMembraneState,
    prepareMembraneMiseConfig: opts.prepareMembraneMiseConfig,
    prepareMembraneGhHosts: opts.prepareMembraneGhHosts,
    resolveMembraneGhBin: opts.resolveMembraneGhBin,
    prepareScratchpadBind: opts.prepareScratchpadBind,
    previewLogFile: opts.previewLogFile ?? ((id) => `/run/membrane/${id}/preview-start.log`),
    // Default the egress seam to null so an autonomous test never falls through to the real
    // (slow, host-dependent) self-test. Tests that want egress ON inject "slirp4netns".
    detectEgressBackend: () => {
      if (opts.egressProbed) opts.egressProbed.called = true;
      return opts.detectEgressBackend ? opts.detectEgressBackend() : null;
    },
  });
}

const baseInput = (over: Partial<StandardCreateInput> = {}): StandardCreateInput => ({
  repoPath: "/repo",
  baseBranch: "main",
  prompt: "do it",
  model: null,
  images: [],
  ...over,
});

test("create + trusted repo → passthrough argv (no bwrap)", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "trusted" });
  const record: { argv?: string[] } = {};
  const service = makeService({ store, record, detectBackend: () => "bwrap" });
  const s = await service.create(baseInput());
  expect(record.argv?.[0]).toBe("claude");
  expect(record.argv).not.toContain("bwrap");
  expect(s.sandboxApplied).toBe("trusted");
  expect(s.sandboxDegraded).toBe(false);
});

// ── #2100: a new repo inherits the global default — standard where bwrap works ──

async function withDefaultOverride<T>(
  profile: "trusted" | "standard" | "autonomous" | null,
  fn: () => Promise<T>,
) {
  const { config } = await import("../src/config");
  const prev = config.sandboxDefaultProfileOverride;
  config.sandboxDefaultProfileOverride = profile;
  try {
    return await fn();
  } finally {
    config.sandboxDefaultProfileOverride = prev;
  }
}

test("#2100: new repo (no row) + env unset + bwrap → wrapped standard, not degraded", async () => {
  await withDefaultOverride(null, async () => {
    const store = new SessionStore(":memory:");
    const record: { argv?: string[] } = {};
    const service = makeService({ store, record, detectBackend: () => "bwrap" });
    const s = await service.create(baseInput());
    expect(record.argv?.[0]).toBe("bwrap");
    expect(s.sandboxApplied).toBe("standard");
    expect(s.sandboxDegraded).toBe(false);
  });
});

test("#2100: inherit repo + env unset + bwrap → auto spawn refused (standard is interactive-only)", async () => {
  await withDefaultOverride(null, async () => {
    const store = new SessionStore(":memory:");
    store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "inherit" });
    const service = makeService({ store, record: {}, detectBackend: () => "bwrap" });
    await expect(service.create(baseInput({ auto: true }))).rejects.toThrow(
      /autonomous or trusted/,
    );
  });
});

test("#2100: new repo + env unset + NO backend → trusted, no degraded banner", async () => {
  await withDefaultOverride(null, async () => {
    const store = new SessionStore(":memory:");
    const record: { argv?: string[] } = {};
    const service = makeService({ store, record, detectBackend: () => null });
    const s = await service.create(baseInput());
    expect(record.argv?.[0]).toBe("claude");
    expect(s.sandboxApplied).toBe("trusted");
    expect(s.sandboxDegraded).toBe(false);
  });
});

test("#2100: explicit SHEPHERD_SANDBOX_DEFAULT_PROFILE=trusted → new repo runs unwrapped", async () => {
  await withDefaultOverride("trusted", async () => {
    const store = new SessionStore(":memory:");
    const record: { argv?: string[] } = {};
    const service = makeService({ store, record, detectBackend: () => "bwrap" });
    const s = await service.create(baseInput());
    expect(record.argv).not.toContain("bwrap");
    expect(s.sandboxApplied).toBe("trusted");
  });
});

test("create + standard + backend bwrap → wraps argv, records applied=standard", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "standard" });
  const record: { argv?: string[] } = {};
  const service = makeService({ store, record, detectBackend: () => "bwrap" });
  const s = await service.create(baseInput());
  expect(record.argv?.[0]).toBe("bwrap");
  // the original claude argv appears after a `--` separator
  const sep = record.argv!.indexOf("--");
  expect(sep).toBeGreaterThan(0);
  expect(record.argv![sep + 1]).toBe("claude");
  expect(s.sandboxApplied).toBe("standard");
  expect(s.sandboxDegraded).toBe(false);
});

test("create + standard + bwrap → binds the per-spawn .claude.json copy, never the host file RW (F04)", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "standard" });
  const record: { argv?: string[] } = {};
  const seen: { sessionId?: string; cwd?: string; key?: string } = {};
  const service = makeService({
    store,
    record,
    detectBackend: () => "bwrap",
    prepareMembraneState: async (i) => {
      Object.assign(seen, { sessionId: i.sessionId, cwd: i.cwd, key: i.key });
      return "/run/membrane/copy.claude.json";
    },
  });
  const s = await service.create(baseInput());
  expect(seen).toEqual({ sessionId: s.id, cwd: "/wt/s", key: "session" });
  const a = record.argv!;
  const i = a.indexOf("/run/membrane/copy.claude.json");
  expect(a[i - 1]).toBe("--bind");
  expect(a[i + 1]).toMatch(/\.claude\.json$/);
  for (let k = 0; k + 2 < a.length; k++) {
    if (a[k] === "--bind" || a[k] === "--bind-try")
      expect(a[k + 1]).not.toMatch(/\/\.claude\.json$/);
  }
});

test("create + standard + bwrap → binds the derived mise config + gh hosts file; failures skip", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "standard" });
  const record: { argv?: string[] } = {};
  let pinned: unknown;
  const service = makeService({
    store,
    record,
    detectBackend: () => "bwrap",
    prepareMembraneMiseConfig: async (i) => ((pinned = i.pinnedBins), "/run/membrane/s.mise.toml"),
    prepareMembraneGhHosts: async () => "/run/membrane/s.gh-hosts.yml",
    resolveMembraneGhBin: async () => "/opt/gh/bin/gh",
  });
  await service.create(baseInput());
  const a = record.argv!;
  expect(a[a.indexOf("/opt/gh/bin/gh") + 1]).toBe(`${MEMBRANE_TOOL_BIN}/gh`);
  expect(a[a.indexOf("PATH") + 1]?.startsWith(`${MEMBRANE_TOOL_BIN}:`)).toBe(true);
  expect(a[a.indexOf("/run/membrane/s.mise.toml") + 1]).toBe(MEMBRANE_MISE_CONFIG);
  expect(a[a.indexOf("/run/membrane/s.gh-hosts.yml") + 1]).toMatch(/\/\.config\/gh\/hosts\.yml$/);
  expect(Array.isArray(pinned) && pinned.length).toBe(2);

  const record2: { argv?: string[] } = {};
  const failing = makeService({
    store,
    record: record2,
    detectBackend: () => "bwrap",
    prepareMembraneMiseConfig: async () => {
      throw new Error("EACCES");
    },
    prepareMembraneGhHosts: async () => {
      throw new Error("EACCES");
    },
    resolveMembraneGhBin: async () => {
      throw new Error("EACCES");
    },
  });
  await failing.create(baseInput());
  expect(record2.argv).toContain("bwrap");
  expect(record2.argv).not.toContain(MEMBRANE_MISE_CONFIG);
  expect(record2.argv).not.toContain(`${MEMBRANE_TOOL_BIN}/gh`);
});

test("create + standard + bwrap: a failing state prep degrades to the RO host bind", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "standard" });
  const record: { argv?: string[] } = {};
  const service = makeService({
    store,
    record,
    detectBackend: () => "bwrap",
    prepareMembraneState: async () => {
      throw new Error("EACCES");
    },
  });
  await service.create(baseInput());
  const a = record.argv!;
  const i = a.findIndex((x, k) => x === "--ro-bind-try" && /\.claude\.json$/.test(a[k + 1] ?? ""));
  expect(i).toBeGreaterThan(0);
});

test("create + standard + backend null → passthrough but degraded", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "standard" });
  const record: { argv?: string[] } = {};
  const service = makeService({ store, record, detectBackend: () => null });
  const s = await service.create(baseInput());
  expect(record.argv?.[0]).toBe("claude");
  expect(record.argv).not.toContain("bwrap");
  expect(s.sandboxApplied).toBe("standard");
  expect(s.sandboxDegraded).toBe(true);
});

test("create + auto + standard → rejects (standard refuses auto)", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "standard" });
  const service = makeService({ store, record: {}, detectBackend: () => "bwrap" });
  await expect(service.create(baseInput({ auto: true }))).rejects.toThrow();
});

test("create + auto + autonomous + backend null → rejects", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "autonomous" });
  const service = makeService({ store, record: {}, detectBackend: () => null });
  await expect(service.create(baseInput({ auto: true }))).rejects.toThrow();
});

test("create + auto + autonomous + FS backend + egress backend → egress-runner wraps, files written", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "autonomous" });
  const record: { argv?: string[] } = {};
  const service = makeService({
    store,
    record,
    detectBackend: () => "bwrap",
    detectEgressBackend: () => "slirp4netns",
  });
  const s = await service.create(baseInput({ auto: true }));
  try {
    // argv: egress-runner.sh --tmp <dir> -- bwrap …override-flags… -- <inner>
    expect(record.argv?.[0]).toMatch(/egress-runner\.sh$/);
    expect(record.argv?.[1]).toBe("--tmp");
    const tmp = egressTmpDir(s.id);
    expect(record.argv?.[2]).toBe(tmp);
    expect(record.argv?.[3]).toBe("--");
    expect(record.argv?.[4]).toBe("bwrap");
    // the egress override binds (nsswitch/resolv overrides) sit between the membrane flags
    // and the inner `--`; the inner argv (claude) follows the LAST `--`.
    const lastSep = record.argv!.lastIndexOf("--");
    expect(record.argv!.slice(0, lastSep)).toContain(`${tmp}/nsswitch.conf`);
    expect(record.argv!.slice(0, lastSep)).toContain(`${tmp}/resolv.conf`);
    expect(record.argv![lastSep + 1]).toBe("claude");
    expect(s.sandboxApplied).toBe("autonomous");
    expect(s.sandboxDegraded).toBe(false);
    expect(s.egressApplied).toBe(true);
    expect(s.egressDegraded).toBe(false);
    // config artefacts materialized in the per-session temp dir.
    for (const f of ["egress.nft", "dnsmasq.argv", "resolv.conf", "nsswitch.conf"]) {
      expect(existsSync(join(tmp, f))).toBe(true);
    }
    expect(readFileSync(join(tmp, "resolv.conf"), "utf8")).toContain("nameserver 127.0.0.1");
  } finally {
    rmSync(egressTmpDir(s.id), { recursive: true, force: true });
  }
});

test("create + auto + autonomous + FS backend + egress NULL → refused (EGRESS_UNAVAILABLE), no spawn", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "autonomous" });
  const record: { argv?: string[] } = {};
  const service = makeService({
    store,
    record,
    detectBackend: () => "bwrap",
    detectEgressBackend: () => null,
  });
  await expect(service.create(baseInput({ auto: true }))).rejects.toThrow(
    /egress backend unavailable/i,
  );
  expect(record.argv).toBeUndefined(); // never spawned
});

test("create + INTERACTIVE autonomous + FS backend + egress NULL → FS-membrane (plain bwrap), egressDegraded", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "autonomous" });
  const record: { argv?: string[] } = {};
  const service = makeService({
    store,
    record,
    detectBackend: () => "bwrap",
    detectEgressBackend: () => null,
  });
  const s = await service.create(baseInput({ auto: false }));
  expect(record.argv?.[0]).toBe("bwrap"); // plain FS membrane, NOT the egress-runner
  expect(record.argv).not.toContain("--tmp");
  expect(s.sandboxApplied).toBe("autonomous");
  expect(s.egressApplied).toBe(false);
  expect(s.egressDegraded).toBe(true);
});

test("create + trusted → egress NEVER probed, egress fields false", async () => {
  const store = new SessionStore(":memory:");
  const record: { argv?: string[] } = {};
  const egressProbed = { called: false };
  const service = makeService({ store, record, detectBackend: () => "bwrap", egressProbed });
  const s = await service.create(baseInput());
  expect(egressProbed.called).toBe(false); // trusted: backend skipped, so egress never probed
  expect(s.egressApplied).toBe(false);
  expect(s.egressDegraded).toBe(false);
});

test("create + standard → egress NEVER probed, egress fields false", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "standard" });
  const record: { argv?: string[] } = {};
  const egressProbed = { called: false };
  const service = makeService({ store, record, detectBackend: () => "bwrap", egressProbed });
  const s = await service.create(baseInput());
  expect(egressProbed.called).toBe(false); // standard is not egress-confined
  expect(record.argv).not.toContain("--tmp");
  expect(s.egressApplied).toBe(false);
  expect(s.egressDegraded).toBe(false);
});

test("create + auto + trusted → succeeds (legacy), passthrough", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "trusted" });
  const record: { argv?: string[] } = {};
  const service = makeService({ store, record, detectBackend: () => "bwrap" });
  const s = await service.create(baseInput({ auto: true }));
  expect(record.argv?.[0]).toBe("claude");
  expect(s.sandboxApplied).toBe("trusted");
});

test("resume + auto + standard → returns null (does not throw)", async () => {
  const store = new SessionStore(":memory:");
  const record: { argv?: string[] } = {};
  const service = makeService({ store, record, detectBackend: () => "bwrap" });
  // create a row directly: trusted at create time, auto, with a pinned claude session id.
  const s = store.create({
    name: "s",
    prompt: "x",
    repoPath: "/repo",
    baseBranch: "main",
    branch: "shepherd/s",
    worktreePath: "/wt/s",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_old",
    claudeSessionId: "11111111-1111-1111-1111-111111111111",
    auto: true,
  });
  // Now flip the repo to standard so an auto resume is refused.
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "standard" });
  const out = await service.resume(s.id, { force: true });
  expect(out).toBeNull();
  // The auto-gate pre-check fires BEFORE any respawn work (husk preserved): herdr.start
  // is never called, so no new argv was recorded.
  expect(record.argv).toBeUndefined();
});

test("resume + trusted → resumes normally, passthrough argv", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "trusted" });
  const record: { argv?: string[] } = {};
  const service = makeService({ store, record, detectBackend: () => "bwrap" });
  const s = store.create({
    name: "s",
    prompt: "x",
    repoPath: "/repo",
    baseBranch: "main",
    branch: "shepherd/s",
    worktreePath: "/wt/s",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_old",
    claudeSessionId: "22222222-2222-2222-2222-222222222222",
    auto: false,
  });
  const out = await service.resume(s.id, { force: true });
  expect(out).not.toBeNull();
  expect(record.argv?.[0]).toBe("claude");
  expect(record.argv).toContain("--resume");
  expect(out!.sandboxApplied).toBe("trusted");
});

test("resume preserves a per-spawn override stricter than the repo default (no silent unconfine)", async () => {
  const store = new SessionStore(":memory:");
  // Repo default is trusted (unset), but the session was SPAWNED with sandboxApplied=standard
  // (a per-spawn override). On resume it must stay wrapped, not fall back to trusted.
  const record: { argv?: string[] } = {};
  const service = makeService({ store, record, detectBackend: () => "bwrap" });
  const s = store.create({
    name: "s",
    prompt: "x",
    repoPath: "/repo",
    baseBranch: "main",
    branch: "shepherd/s",
    worktreePath: "/wt/s",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_old",
    claudeSessionId: "33333333-3333-3333-3333-333333333333",
    auto: false,
    sandboxApplied: "standard",
    sandboxDegraded: false,
    egressApplied: false,
    egressDegraded: false,
  });
  const out = await service.resume(s.id, { force: true });
  expect(out).not.toBeNull();
  expect(record.argv?.[0]).toBe("bwrap"); // still confined, NOT passthrough
  expect(out!.sandboxApplied).toBe("standard"); // badge preserved, not overwritten to trusted
});

test.each(["standard", "inherit"] as const)(
  "drain pre-check: %s profile (env unset, bwrap) holds → service.create NOT called",
  async (sandboxProfile) => {
    await withDefaultOverride(null, async () => {
      const store = new SessionStore(":memory:");
      store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile });
      let createCalls = 0;
      const service = {
        create: async (input: StandardCreateInput): Promise<Session> => {
          createCalls++;
          return store.create({
            name: "auto",
            prompt: input.prompt,
            repoPath: input.repoPath,
            baseBranch: input.baseBranch,
            branch: "shepherd/auto",
            worktreePath: "/wt",
            isolated: true,
            herdrSession: "default",
            herdrAgentId: "t",
            auto: true,
            issueNumber: input.issueRef?.number ?? null,
          });
        },
        archive: async () => 1,
      };
      const forge = makeForge([issue(1)]);
      const drain = new DrainService({
        store,
        service,
        resolveForge: () => forge,
        prCache: { snapshot: () => ({}) },
        usage: { limits: (): UsageLimits => NO_USAGE },
        repos: () => ["/repo"],
        emitStatus: () => {},
        emitArchived: () => {},
        dropPrCache: () => {},
        rebaseCap: 5,
        detectBackend: () => "bwrap",
      });
      await drain.pump("/repo");
      expect(createCalls).toBe(0);
    });
  },
);

test("resume + autonomous + FS + egress backend → egress-runner re-wraps, egress fields persisted", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "autonomous" });
  const record: { argv?: string[] } = {};
  const service = makeService({
    store,
    record,
    detectBackend: () => "bwrap",
    detectEgressBackend: () => "slirp4netns",
  });
  const s = store.create({
    name: "s",
    prompt: "x",
    repoPath: "/repo",
    baseBranch: "main",
    branch: "shepherd/s",
    worktreePath: "/wt/s",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_old",
    claudeSessionId: "44444444-4444-4444-4444-444444444444",
    auto: false,
    sandboxApplied: "autonomous",
  });
  const out = await service.resume(s.id, { force: true });
  try {
    expect(out).not.toBeNull();
    expect(record.argv?.[0]).toMatch(/egress-runner\.sh$/);
    expect(out!.egressApplied).toBe(true);
    expect(out!.egressDegraded).toBe(false);
  } finally {
    rmSync(egressTmpDir(s.id), { recursive: true, force: true });
  }
});

test("resume + auto autonomous + egress NULL → refused (returns null, husk preserved)", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "autonomous" });
  const record: { argv?: string[] } = {};
  const service = makeService({
    store,
    record,
    detectBackend: () => "bwrap",
    detectEgressBackend: () => null,
  });
  const s = store.create({
    name: "s",
    prompt: "x",
    repoPath: "/repo",
    baseBranch: "main",
    branch: "shepherd/s",
    worktreePath: "/wt/s",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_old",
    claudeSessionId: "55555555-5555-5555-5555-555555555555",
    auto: true,
    sandboxApplied: "autonomous",
  });
  const out = await service.resume(s.id, { force: true });
  expect(out).toBeNull();
  expect(record.argv).toBeUndefined();
});

test("drain + autonomous repo + egress NULL → held, service.create NOT called", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "autonomous" });
  let createCalls = 0;
  const service = {
    create: async (input: StandardCreateInput): Promise<Session> => {
      createCalls++;
      return store.create({
        name: "auto",
        prompt: input.prompt,
        repoPath: input.repoPath,
        baseBranch: input.baseBranch,
        branch: "shepherd/auto",
        worktreePath: "/wt",
        isolated: true,
        herdrSession: "default",
        herdrAgentId: "t",
        auto: true,
        issueNumber: input.issueRef?.number ?? null,
      });
    },
    archive: async () => 1,
  };
  const forge = makeForge([issue(1)]);
  const drain = new DrainService({
    store,
    service,
    resolveForge: () => forge,
    prCache: { snapshot: () => ({}) },
    usage: { limits: (): UsageLimits => NO_USAGE },
    repos: () => ["/repo"],
    emitStatus: () => {},
    emitArchived: () => {},
    dropPrCache: () => {},
    detectBackend: () => "bwrap",
    detectEgressBackend: () => null, // egress unavailable → autonomous drain refused
    rebaseCap: 5,
  });
  await drain.pump("/repo");
  expect(createCalls).toBe(0);
});

// ── egressWatcher wiring tests ────────────────────────────────────────────────

function makeWatcherStub(): Pick<
  EgressWatcher,
  "start" | "stop" | "setAllowlist" | "blockedHosts"
> & {
  starts: Array<{ sessionId: string; opts: Parameters<EgressWatcher["start"]>[1] }>;
  stops: string[];
} {
  const starts: Array<{ sessionId: string; opts: Parameters<EgressWatcher["start"]>[1] }> = [];
  const stops: string[] = [];
  return {
    starts,
    stops,
    start: (sessionId, opts) => starts.push({ sessionId, opts }),
    stop: async (sessionId) => stops.push(sessionId),
    setAllowlist: () => {},
    blockedHosts: () => null,
  };
}

test("egressWatcher.start called on autonomous egress spawn", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "autonomous" });
  const record: { argv?: string[] } = {};
  const watcher = makeWatcherStub();
  const service = new SessionService({
    transcriptExists: () => true, // Fixture conversations exist; filesystem refusal is tested separately.
    store,
    namer: async () => "s",
    worktree: worktreeStub(),
    herdr: herdrStub(record),
    detectBackend: () => "bwrap",
    detectEgressBackend: () => "slirp4netns",
    egressWatcher: watcher,
  });

  const s = await service.create(baseInput({ auto: true }));
  try {
    expect(watcher.starts).toHaveLength(1);
    expect(watcher.starts[0]!.sessionId).toBe(s.id);
    expect(watcher.starts[0]!.opts.repoPath).toBe("/repo");
    expect(watcher.starts[0]!.opts.dnsLogPath).toContain("dns.log");
    expect(watcher.starts[0]!.opts.allowlist.length).toBeGreaterThan(0);
  } finally {
    rmSync(egressTmpDir(s.id), { recursive: true, force: true });
  }
});

test("autonomous allowlist carries the claude.ai connector proxy only when the repo opts in", async () => {
  for (const enabled of [true, false]) {
    const store = new SessionStore(":memory:");
    store.setRepoConfig("/repo", {
      ...defaultRepoConfig(),
      sandboxProfile: "autonomous",
      claudeAiConnectorsEnabled: enabled,
    });
    const watcher = makeWatcherStub();
    const service = new SessionService({
      transcriptExists: () => true,
      store,
      namer: async () => "s",
      worktree: worktreeStub(),
      herdr: herdrStub({}),
      detectBackend: () => "bwrap",
      detectEgressBackend: () => "slirp4netns",
      egressWatcher: watcher,
    });
    const s = await service.create(baseInput({ auto: true }));
    try {
      const allowlist = watcher.starts[0]!.opts.allowlist;
      expect(allowlist.some((host) => host === CLAUDEAI_CONNECTOR_EGRESS_HOST)).toBe(enabled);
    } finally {
      rmSync(egressTmpDir(s.id), { recursive: true, force: true });
    }
  }
});

test("egressWatcher.stop called on archive (before removeEgressTmp)", async () => {
  const dropped: string[] = [];
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "autonomous" });
  const record: { argv?: string[] } = {};
  const watcher = makeWatcherStub();
  const service = new SessionService({
    transcriptExists: () => true, // Fixture conversations exist; filesystem refusal is tested separately.
    store,
    namer: async () => "s",
    worktree: {
      ...worktreeStub(),
      remove: () => {},
    },
    herdr: herdrStub(record),
    detectBackend: () => "bwrap",
    detectEgressBackend: () => "slirp4netns",
    egressWatcher: watcher,
    netnsDevForward: { drop: (id) => dropped.push(id) },
  });

  const s = await service.create(baseInput({ auto: true }));
  try {
    await service.archive(s.id);
    expect(watcher.stops).toContain(s.id);
    expect(dropped).toEqual([s.id]); // in-netns dev forward forgotten too (#2889)
  } finally {
    // egressTmpDir already removed by archive; ignore if already gone.
    try {
      rmSync(egressTmpDir(s.id), { recursive: true, force: true });
    } catch {
      /* already removed */
    }
  }
});

test("egressWatcher NOT called for trusted spawn (no egress)", async () => {
  const store = new SessionStore(":memory:");
  const record: { argv?: string[] } = {};
  const watcher = makeWatcherStub();
  const service = new SessionService({
    transcriptExists: () => true, // Fixture conversations exist; filesystem refusal is tested separately.
    store,
    namer: async () => "s",
    worktree: worktreeStub(),
    herdr: herdrStub(record),
    detectBackend: () => "bwrap",
    detectEgressBackend: () => "slirp4netns",
    egressWatcher: watcher,
  });

  await service.create(baseInput()); // trusted profile → no egress
  expect(watcher.starts).toHaveLength(0);
});

// ── egress note channel (#3921) ──────────────────────────────────────────────

async function noteChannelFor(opts: {
  ingressPort?: number;
  hostLoopback?: boolean;
  token?: string | null;
  hooksIngest?: boolean;
}) {
  const saved = { token: config.token, hooksIngest: config.hooksIngest };
  config.token = opts.token ?? null;
  config.hooksIngest = opts.hooksIngest ?? true;
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "autonomous" });
  const watcher = makeWatcherStub();
  const service = new SessionService({
    transcriptExists: () => true,
    store,
    namer: async () => "s",
    worktree: worktreeStub(),
    herdr: herdrStub({}),
    detectBackend: () => "bwrap",
    detectEgressBackend: () => "slirp4netns",
    detectEgressHostLoopback: () => opts.hostLoopback ?? true,
    agentIngressPort: () => ("ingressPort" in opts ? opts.ingressPort : 7331),
    egressWatcher: watcher,
  });
  try {
    const s = await service.create(baseInput());
    rmSync(egressTmpDir(s.id), { recursive: true, force: true });
    return watcher.starts[0]?.opts.noteChannel;
  } finally {
    Object.assign(config, saved);
  }
}

test("egress note channel: Claude + host gateway + hooks on + no token → hook", async () => {
  expect(await noteChannelFor({})).toBe("hook");
});

test("egress note channel: no host gateway (no ingress port / no slirp host loopback) → steer", async () => {
  expect(await noteChannelFor({ ingressPort: undefined })).toBe("steer");
  expect(await noteChannelFor({ hostLoopback: false })).toBe("steer");
});

test("egress note channel: token set or hooks ingest off → steer", async () => {
  expect(await noteChannelFor({ token: "t" })).toBe("steer");
  expect(await noteChannelFor({ hooksIngest: false })).toBe("steer");
});

// ── local helpers ─────────────────────────────────────────────────────────────

const NO_USAGE: UsageLimits = {
  session5h: null,
  week: null,
  perModelWeek: [],
  credits: null,
  stale: false,
  calibratedAt: null,
  subscriptionOnly: false,
};

function defaultRepoConfig() {
  return {
    criticEnabled: false,
    criticAllPrs: false,
    criticSmellLensEnabled: false,
    autoAddressEnabled: false,
    autopilotEnabled: false,
    planGateEnabled: false,
    autoDrainEnabled: true,
    autoMergeEnabled: false,
    buildQueueEnabled: false,
    draftMode: false,
    signoffAuthority: "human" as const,
    maxAuto: 2,
    autoLabel: "shepherd:auto",
    priorityLabels: [],
    usageCeilingPct: 80,
    sandboxProfile: "trusted" as const,
    defaultModel: "inherit",
    defaultEffort: "inherit",
    defaultExecutionEffort: "inherit",
    previewOpenMode: "ask" as const,
    egressExtraHosts: [] as string[],
    egressIncludeStandard: "inherit" as const,
    repoMode: "forge" as const,
    manualStepsIssueEnabled: false,
    preWarmEpicLandingCi: false,
    mergeWithoutCi: false,
    epicStacksEnabled: false,
    sharedBrowserEnabled: false,
    claudeAiConnectorsEnabled: false,
    browserAllowedHosts: [],
    hidden: false,
    pinned: false,
  };
}

function issue(number: number): Issue {
  return {
    number,
    title: `issue ${number}`,
    body: `body ${number}`,
    url: `https://x/${number}`,
    labels: ["shepherd:auto"],
    createdAt: number,
    assignees: [],
  };
}

function makeForge(issues: Issue[]): GitForge {
  return {
    kind: "github",
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => issues,
    listPullRequests: async () => [],
    prStatus: async () => ({ state: "none", checks: "none", deployConfigured: false }) as PrStatus,
    openPr: async () => ({ state: "open", checks: "none", deployConfigured: false }) as PrStatus,
    defaultBranch: async () => "main",
    merge: async () => {},
    redeploy: async () => {},
    postReview: async () => ({}),
    closeIssue: async () => {},
    ensureIssueLink: async () => {},
    addIssueLabel: async () => {},
    removeIssueLabel: async () => {},
    getIssue: async (n: number) => issues.find((i) => i.number === n) ?? null,
  } as unknown as GitForge;
}

// ── F12: unattended Codex never runs silently unconfined ─────────────────────

async function withDefaultProvider<T>(provider: "claude" | "codex", fn: () => Promise<T>) {
  const { config } = await import("../src/config");
  const prev = config.defaultAgentProvider;
  config.defaultAgentProvider = provider;
  try {
    return await fn();
  } finally {
    config.defaultAgentProvider = prev;
  }
}

function autonomousService(record: { argv?: string[] }) {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "autonomous" });
  const service = makeService({
    store,
    record,
    detectBackend: () => "bwrap",
    detectEgressBackend: () => "slirp4netns",
  });
  return { store, service };
}

test("F12: create + auto + explicit codex + autonomous repo → refused, never spawned", async () => {
  const record: { argv?: string[] } = {};
  const { service } = autonomousService(record);
  await expect(service.create(baseInput({ auto: true, agentProvider: "codex" }))).rejects.toThrow(
    /Codex/,
  );
  expect(record.argv).toBeUndefined();
});

test("F12: create + auto + default provider codex + autonomous repo → refused, never spawned", async () => {
  const record: { argv?: string[] } = {};
  const { service } = autonomousService(record);
  await withDefaultProvider("codex", async () => {
    await expect(service.create(baseInput({ auto: true }))).rejects.toThrow(/Codex/);
  });
  expect(record.argv).toBeUndefined();
});

test("F12: create + INTERACTIVE codex + autonomous repo → still spawns (attended)", async () => {
  const record: { argv?: string[] } = {};
  const { service } = autonomousService(record);
  await service.create(baseInput({ auto: false, agentProvider: "codex" }));
  expect(record.argv?.[0]).toBe("codex");
});

test("F12: create + auto + codex + trusted repo → spawns (operator chose unconfined)", async () => {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "trusted" });
  const record: { argv?: string[] } = {};
  const service = makeService({ store, record, detectBackend: () => "bwrap" });
  await service.create(baseInput({ auto: true, agentProvider: "codex" }));
  expect(record.argv?.[0]).toBe("codex");
});

test("F12: resume of an auto codex session in an autonomous repo → refused (returns null)", async () => {
  const record: { argv?: string[] } = {};
  const { store, service } = autonomousService(record);
  const s = store.create({
    name: "s",
    prompt: "x",
    repoPath: "/repo",
    baseBranch: "main",
    branch: "shepherd/s",
    worktreePath: "/wt/s",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_old",
    claudeSessionId: "11111111-1111-1111-1111-111111111111",
    auto: true,
    agentProvider: "codex",
    sandboxApplied: "trusted", // what every Codex task session records
  });
  // A resumable Codex conversation (launch provenance + captured rollout id).
  store.update(s.id, {
    codexLaunchId: "launch-1",
    providerSessionId: "rollout-1",
  });
  expect(await service.resume(s.id, { force: true })).toBeNull();
  expect(record.argv).toBeUndefined();
});

function drainWith(provider: "claude" | "codex") {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "autonomous" });
  const counts = { create: 0, claims: 0 };
  const service = {
    create: async (input: StandardCreateInput): Promise<Session> => {
      counts.create++;
      return store.create({
        name: "auto",
        prompt: input.prompt,
        repoPath: input.repoPath,
        baseBranch: input.baseBranch,
        branch: "shepherd/auto",
        worktreePath: "/wt",
        isolated: true,
        herdrSession: "default",
        herdrAgentId: "t",
        auto: true,
        issueNumber: input.issueRef?.number ?? null,
      });
    },
    archive: async () => 1,
  };
  const forge = {
    ...makeForge([issue(1)]),
    addIssueLabel: async () => {
      counts.claims++;
    },
  } as GitForge;
  const drain = new DrainService({
    store,
    service,
    resolveForge: () => forge,
    prCache: { snapshot: () => ({}) },
    usage: { limits: (): UsageLimits => NO_USAGE },
    repos: () => ["/repo"],
    emitStatus: () => {},
    emitArchived: () => {},
    dropPrCache: () => {},
    detectBackend: () => "bwrap",
    detectEgressBackend: () => "slirp4netns",
    rebaseCap: 5,
  });
  return withDefaultProvider(provider, async () => {
    await drain.pump("/repo");
    return counts;
  });
}

test("F12: drain + autonomous repo + codex provider → held before claiming, create NOT called", async () => {
  expect(await drainWith("codex")).toEqual({ create: 0, claims: 0 });
});

test("F12 control: drain + autonomous repo + claude provider → claims and spawns", async () => {
  const counts = await drainWith("claude");
  expect(counts.create).toBe(1);
  expect(counts.claims).toBeGreaterThan(0);
});

// ── audit F03: preview-start.sh never runs unconfined with the server env ─────
describe("SessionService.previewLaunch (F03)", () => {
  const script = "/repo/.git/shepherd/preview-start.sh";
  const setup = (repoProfile: "trusted" | "standard" | "autonomous", backend: SandboxBackend) => {
    const store = new SessionStore(":memory:");
    store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: repoProfile });
    const s = store.create({
      name: "p",
      prompt: "x",
      repoPath: "/repo",
      baseBranch: "main",
      branch: "shepherd/p",
      worktreePath: "/wt/p",
      isolated: true,
      herdrSession: "default",
      herdrAgentId: "term_p",
    });
    const service = makeService({ store, record: {}, detectBackend: () => backend });
    return { store, service, s };
  };

  test("trusted repo + trusted session → null (unchanged direct launch)", () => {
    const { service, s } = setup("trusted", "bwrap");
    expect(service.previewLaunch(s, script)).toBeNull();
  });

  for (const profile of ["standard", "autonomous"] as const) {
    test(`${profile} repo → bwrap membrane, --clearenv, creds masked, no --die-with-parent`, () => {
      process.env.DUMMY_SERVER_SECRET = "dummy-not-real";
      try {
        const { service, s } = setup(profile, "bwrap");
        const l = service.previewLaunch(s, script)!;
        expect(l.argv[0]).toBe("bwrap");
        expect(l.argv.slice(-2)).toEqual(["--", script]);
        expect(l.argv).toContain("--clearenv");
        expect(l.argv).not.toContain("--die-with-parent");
        expect(l.argv).not.toContain("--unshare-net");
        // git common dir = the script's grandparent, bound like the agent's.
        expect(l.argv.join(" ")).toContain("--bind /repo/.git /repo/.git");
        expect(l.argv.some((a) => a.endsWith("/.credentials.json"))).toBe(false);
        const wi = l.argv.indexOf("SHEPHERD_WORKTREE_PATH");
        expect(l.argv[wi - 1]).toBe("--setenv");
        expect(l.argv[wi + 1]).toBe("/wt/p");
        expect(JSON.stringify(l)).not.toContain("dummy-not-real");
        // The script's log must be writable: <common>/shepherd is re-bound RO by the membrane.
        const log = `/run/membrane/${s.id}/preview-start.log`;
        const li = l.argv.indexOf("SHEPHERD_PREVIEW_LOG");
        expect(l.argv[li - 1]).toBe("--setenv");
        expect(l.argv[li + 1]).toBe(log);
        const bi = l.argv.findIndex((x, k) => x === "--bind" && l.argv[k + 1] === log);
        expect(l.argv[bi + 2]).toBe(log);
        const roShepherd = l.argv.findIndex(
          // Fail-closed RO carve-out: absent on this host → empty RO tmpfs.
          (x, k) => x === "--remount-ro" && l.argv[k + 1] === "/repo/.git/shepherd",
        );
        expect(roShepherd).toBeGreaterThan(0);
        expect(bi).toBeGreaterThan(roShepherd);
        expect(log.startsWith("/repo/.git/shepherd")).toBe(false);
        expect(Object.keys(l.env)).toEqual(["PATH"]);
      } finally {
        delete process.env.DUMMY_SERVER_SECRET;
      }
    });
  }

  test("trusted repo but sandboxed SESSION → wrapped", () => {
    const { service, s } = setup("trusted", "bwrap");
    const sandboxed = { ...s, sandboxApplied: "standard" as const };
    expect(service.previewLaunch(sandboxed, script)?.argv[0]).toBe("bwrap");
  });

  test("sandboxed repo, no backend → script directly with a minimal env", () => {
    process.env.DUMMY_SERVER_SECRET = "dummy-not-real";
    try {
      const { service, s } = setup("standard", null);
      const l = service.previewLaunch(s, script)!;
      expect(l.argv).toEqual([script]);
      expect(l.env.SHEPHERD_WORKTREE_PATH).toBe("/wt/p");
      expect(l.env.DUMMY_SERVER_SECRET).toBeUndefined();
      expect(typeof l.env.PATH).toBe("string");
    } finally {
      delete process.env.DUMMY_SERVER_SECRET;
    }
  });

  test("startPreviewScript honors the launch env (server env not inherited)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "preview-launch-"));
    try {
      const sh = join(dir, "preview-start.sh");
      const marker = join(dir, "MARKER");
      writeFileSync(
        sh,
        `#!/bin/sh\necho "secret=$DUMMY_SERVER_SECRET wt=$SHEPHERD_WORKTREE_PATH" > ${marker}\n`,
      );
      chmodSync(sh, 0o700);
      process.env.DUMMY_SERVER_SECRET = "dummy-not-real";
      await startPreviewScript(sh, dir, {
        argv: [sh],
        env: { PATH: "/usr/bin:/bin", SHEPHERD_WORKTREE_PATH: dir },
      });
      for (let i = 0; i < 100 && !existsSync(marker); i++) await Bun.sleep(20);
      expect(readFileSync(marker, "utf8").trim()).toBe(`secret= wt=${dir}`);
    } finally {
      delete process.env.DUMMY_SERVER_SECRET;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reapplyEgressAllowlist (live allowlist edits)", () => {
  /** A stand-in for the runner's reload loop: answers every reload request with `result`. */
  function fakeReloadLoop(dir: string, result: "ok" | "fail", beforeAnswer = ":") {
    const fifo = join(dir, "reload.fifo");
    spawnSync("mkfifo", [fifo]);
    return Bun.spawn([
      "bash",
      "-c",
      `while :; do read -r r < "${fifo}" || continue; ${beforeAnswer}; echo "$r ${result}" > "${dir}/reload.status"; done`,
    ]);
  }

  async function waitForReader(fifo: string) {
    // The fake loop needs a moment to open the FIFO for reading.
    for (let i = 0; i < 50; i++) {
      try {
        const fd = openSync(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
        closeSync(fd);
        return;
      } catch {
        await Bun.sleep(20);
      }
    }
  }

  async function setup(blocked: string[] = []) {
    const store = new SessionStore(":memory:");
    store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "autonomous" });
    const watcher = makeWatcherStub();
    const allowlists: string[][] = [];
    watcher.setAllowlist = (_id, list) => void allowlists.push(list);
    watcher.blockedHosts = () => blocked;
    const service = new SessionService({
      transcriptExists: () => true,
      store,
      namer: async () => "s",
      worktree: worktreeStub(),
      herdr: herdrStub({}),
      detectBackend: () => "bwrap",
      detectEgressBackend: () => "slirp4netns",
      egressWatcher: watcher,
    });
    const steers: Array<[string, string]> = [];
    service.reply = async (id, text) => {
      steers.push([id, text]);
      return true;
    };
    const s = await service.create(baseInput({ auto: true }));
    return { store, service, s, dir: egressTmpDir(s.id), allowlists, steers };
  }

  const spawnInputs = (dir: string) =>
    JSON.parse(readFileSync(join(dir, "egress-spawn.json"), "utf8")) as { allowlist: string[] };

  test("spawn records its egress inputs", async () => {
    const { s, dir } = await setup();
    try {
      const inputs = spawnInputs(dir) as { repoPath: string; allowlist: string[] };
      expect(inputs.repoPath).toBe("/repo");
      expect(inputs.allowlist.length).toBeGreaterThan(0);
    } finally {
      rmSync(egressTmpDir(s.id), { recursive: true, force: true });
    }
  });

  test("an added host is applied live, the watcher updated and the blocked session steered", async () => {
    const { store, service, s, dir, allowlists, steers } = await setup([
      "registry.npmjs.org",
      "other.evil.com",
    ]);
    const loop = fakeReloadLoop(dir, "ok");
    try {
      await waitForReader(join(dir, "reload.fifo"));
      store.setRepoConfig("/repo", {
        ...store.getRepoConfig("/repo"),
        egressExtraHosts: ["registry.npmjs.org"],
      });
      await service.reapplyEgressAllowlist("/repo");
      expect(readFileSync(join(dir, "egress.reload.nft"), "utf8")).toContain(
        "flush chain inet egress out",
      );
      expect(readFileSync(join(dir, "dnsmasq.argv"), "utf8")).toContain("registry.npmjs.org");
      expect(spawnInputs(dir).allowlist).toContain("registry.npmjs.org");
      expect((spawnInputs(dir) as { uncertain?: boolean }).uncertain).toBe(false);
      expect(allowlists).toHaveLength(1);
      expect(allowlists[0]).toContain("registry.npmjs.org");
      expect(steers).toHaveLength(1);
      expect(steers[0]![0]).toBe(s.id);
      expect(steers[0]![1]).toContain("registry.npmjs.org now allowed");
      expect(steers[0]![1]).not.toContain("other.evil.com");

      // Unchanged list → no reload, no steer.
      rmSync(join(dir, "egress.reload.nft"));
      await service.reapplyEgressAllowlist("/repo");
      expect(existsSync(join(dir, "egress.reload.nft"))).toBe(false);
      expect(steers).toHaveLength(1);

      // Removal → the reload drops the tables (revokes pinned IPs).
      store.setRepoConfig("/repo", { ...store.getRepoConfig("/repo"), egressExtraHosts: [] });
      await service.reapplyEgressAllowlist("/repo");
      expect(readFileSync(join(dir, "egress.reload.nft"), "utf8")).toStartWith(
        "delete table inet egress",
      );
    } finally {
      loop.kill();
      rmSync(egressTmpDir(s.id), { recursive: true, force: true });
    }
  });

  test("standard hosts join the allowlist per the repo toggle and the global default", async () => {
    const { store, service, s, dir } = await setup();
    const loop = fakeReloadLoop(dir, "ok");
    try {
      await waitForReader(join(dir, "reload.fifo"));
      expect(spawnInputs(dir).allowlist).not.toContain("cdn.playwright.dev");
      store.setSetting("egressStandardHosts", JSON.stringify(["cdn.playwright.dev"]));
      await service.reapplyEgressAllowlist("/repo"); // inherit + default off → unchanged
      expect(spawnInputs(dir).allowlist).not.toContain("cdn.playwright.dev");
      store.setSetting("egressStandardDefault", "1");
      await service.reapplyEgressAllowlist("/repo");
      expect(spawnInputs(dir).allowlist).toContain("cdn.playwright.dev");
      store.setRepoConfig("/repo", {
        ...store.getRepoConfig("/repo"),
        egressIncludeStandard: "off",
      });
      await service.reapplyEgressAllowlist("/repo");
      expect(spawnInputs(dir).allowlist).not.toContain("cdn.playwright.dev");
    } finally {
      loop.kill();
      rmSync(egressTmpDir(s.id), { recursive: true, force: true });
    }
  });

  test("a respawn during the reload wins: its spawn inputs and watcher stay untouched", async () => {
    const { store, service, s, dir, allowlists, steers } = await setup(["registry.npmjs.org"]);
    // Simulate a respawn of the same session landing while the reload is in flight.
    const fresh = JSON.stringify({
      spawnId: "respawned",
      repoPath: "/repo",
      connectorHosts: [],
      allowlist: ["x.example.com"],
    });
    writeFileSync(join(dir, "fresh.json"), fresh);
    const loop = fakeReloadLoop(dir, "ok", `cp "${dir}/fresh.json" "${dir}/egress-spawn.json"`);
    try {
      await waitForReader(join(dir, "reload.fifo"));
      store.setRepoConfig("/repo", {
        ...store.getRepoConfig("/repo"),
        egressExtraHosts: ["registry.npmjs.org"],
      });
      await service.reapplyEgressAllowlist("/repo");
      expect(readFileSync(join(dir, "egress-spawn.json"), "utf8")).toBe(fresh);
      expect(allowlists).toHaveLength(0);
      expect(steers).toHaveLength(0);
    } finally {
      loop.kill();
      rmSync(egressTmpDir(s.id), { recursive: true, force: true });
    }
  });

  test("a failed reload marks the session uncertain, so a revert still reloads", async () => {
    const { store, service, s, dir, allowlists, steers } = await setup(["registry.npmjs.org"]);
    const loop = fakeReloadLoop(dir, "fail");
    try {
      await waitForReader(join(dir, "reload.fifo"));
      const before = spawnInputs(dir).allowlist;
      store.setRepoConfig("/repo", {
        ...store.getRepoConfig("/repo"),
        egressExtraHosts: ["registry.npmjs.org"],
      });
      await service.reapplyEgressAllowlist("/repo");
      expect(spawnInputs(dir).allowlist).toEqual(before);
      expect((spawnInputs(dir) as { uncertain?: boolean }).uncertain).toBe(true);
      expect(allowlists).toHaveLength(0);
      expect(steers).toHaveLength(0);

      // The operator reverts: the wanted list equals the recorded one, but the session may run
      // the new list (the reload may have landed) → reload anyway, dropping pinned IPs.
      rmSync(join(dir, "egress.reload.nft"));
      store.setRepoConfig("/repo", { ...store.getRepoConfig("/repo"), egressExtraHosts: [] });
      await service.reapplyEgressAllowlist("/repo");
      expect(readFileSync(join(dir, "egress.reload.nft"), "utf8")).toStartWith(
        "delete table inet egress",
      );
    } finally {
      loop.kill();
      rmSync(egressTmpDir(s.id), { recursive: true, force: true });
    }
  });

  test("another repo → untouched; no reload listener → marked uncertain", async () => {
    const { store, service, s, dir, allowlists } = await setup();
    try {
      store.setRepoConfig("/repo", {
        ...store.getRepoConfig("/repo"),
        egressExtraHosts: ["registry.npmjs.org"],
      });
      await service.reapplyEgressAllowlist("/other");
      expect(existsSync(join(dir, "egress.reload.nft"))).toBe(false);
      await service.reapplyEgressAllowlist("/repo"); // no FIFO → unsupported
      expect(allowlists).toHaveLength(0);
      expect(spawnInputs(dir).allowlist).not.toContain("registry.npmjs.org");
      // A runner still starting up may load the rewritten files → the next reapply must reload.
      expect((spawnInputs(dir) as { uncertain?: boolean }).uncertain).toBe(true);
    } finally {
      rmSync(egressTmpDir(s.id), { recursive: true, force: true });
    }
  });
});

describe("scratchpad bind (sandboxed claude)", () => {
  const prevSweep = process.env.SHEPHERD_TMP_SWEEP_DIR;
  const prevAgent = process.env.SHEPHERD_AGENT_TMPDIR;
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "shepherd-wiring-scratch-"));
    process.env.SHEPHERD_TMP_SWEEP_DIR = root;
    delete process.env.SHEPHERD_AGENT_TMPDIR;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (prevSweep === undefined) delete process.env.SHEPHERD_TMP_SWEEP_DIR;
    else process.env.SHEPHERD_TMP_SWEEP_DIR = prevSweep;
    if (prevAgent === undefined) delete process.env.SHEPHERD_AGENT_TMPDIR;
    else process.env.SHEPHERD_AGENT_TMPDIR = prevAgent;
  });
  const uid = process.getuid?.() ?? 1000;
  const bindOf = (argv: string[], sid: string) => {
    const host = sessionScratchpadDir("/wt/s", sid);
    const i = argv.indexOf(host);
    return i > 0 && argv[i - 1] === "--bind" ? argv[i + 1] : null;
  };

  test("create + standard + bwrap → binds this session's scratchpad at claude's membrane path", async () => {
    const store = new SessionStore(":memory:");
    store.setRepoConfig("/repo", { ...defaultRepoConfig(), sandboxProfile: "standard" });
    const record: { argv?: string[] } = {};
    const service = makeService({
      store,
      record,
      detectBackend: () => "bwrap",
      prepareScratchpadBind: sandboxScratchpadBind,
    });
    const s = await service.create(baseInput());
    expect(s.claudeSessionId).toBeTruthy();
    expect(bindOf(record.argv!, s.claudeSessionId)).toBe(
      `/tmp/claude-${uid}/-wt-s/${s.claudeSessionId}/scratchpad`,
    );
  });

  test("resume + standard → binds the stored claude session's scratchpad", async () => {
    const store = new SessionStore(":memory:");
    const record: { argv?: string[] } = {};
    const service = makeService({
      store,
      record,
      detectBackend: () => "bwrap",
      prepareScratchpadBind: sandboxScratchpadBind,
    });
    const sid = "66666666-6666-6666-6666-666666666666";
    const s = store.create({
      name: "s",
      prompt: "x",
      repoPath: "/repo",
      baseBranch: "main",
      branch: "shepherd/s",
      worktreePath: "/wt/s",
      isolated: true,
      herdrSession: "default",
      herdrAgentId: "term_old",
      claudeSessionId: sid,
      auto: false,
      sandboxApplied: "standard",
      sandboxDegraded: false,
      egressApplied: false,
      egressDegraded: false,
    });
    expect(await service.resume(s.id, { force: true })).not.toBeNull();
    expect(bindOf(record.argv!, sid)).toBe(`/tmp/claude-${uid}/-wt-s/${sid}/scratchpad`);
  });

  test("create + trusted → no scratchpad bind (passthrough)", async () => {
    const store = new SessionStore(":memory:");
    const record: { argv?: string[] } = {};
    const service = makeService({
      store,
      record,
      detectBackend: () => "bwrap",
      prepareScratchpadBind: sandboxScratchpadBind,
    });
    const s = await service.create(baseInput());
    expect(record.argv?.[0]).not.toBe("bwrap");
    expect(bindOf(record.argv!, s.claudeSessionId)).toBeNull();
  });
});
