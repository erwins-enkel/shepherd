// #4232 follow-up: `<postgres-notice>` rides exactly where `postgres_request` does — spawn, resume,
// and the bootstrap directives' Postgres status follow the same capability.
import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { SessionService, composeSystemPromptBlocks } from "../src/service";
import { DEFAULT_POSTGRES_SETTINGS } from "../src/postgres-core";
import type { HouseStackResolution } from "../src/house-stack";
import type { SandboxProfile } from "../src/sandbox";

const NOTICE = "<postgres-notice>";

function harness(
  opts: {
    enabled?: boolean;
    mode?: "off" | "on-request";
    profile?: SandboxProfile;
    isolated?: boolean;
  } = {},
) {
  const store = new SessionStore(":memory:");
  store.setRepoConfig("/repo", {
    ...store.getRepoConfig("/repo"),
    postgresMode: opts.mode ?? "on-request",
    sandboxProfile: opts.profile ?? "trusted",
  });
  const captured: { argv?: string[] } = {};
  const svc = new SessionService({
    store,
    namer: async () => "pg",
    houseStackResolver: {
      resolve: async (): Promise<HouseStackResolution> => ({
        ok: true,
        resolvedAt: "2026-11-26T08:00:00.000Z",
        npm: [{ name: "bun", version: "7.1.3" }],
        crates: [],
        rustToolchain: null,
        swift: [],
        swiftToolchain: null,
      }),
    },
    worktree: {
      ensureBaseRef: async () => {},
      branchExists: () => false,
      create: () => ({
        worktreePath: "/wt/pg",
        branch: "shepherd/pg",
        isolated: opts.isolated ?? true,
      }),
      remove: () => {},
      gitCommonDir: () => "/wt/pg/.git",
    },
    herdr: {
      start: async (_n: string, _c: string, argv: string[]) => {
        captured.argv = argv;
        return { terminalId: "t1" };
      },
      listAsync: async () => [],
      stop: async () => {},
      send: () => {},
    },
    detectBackend: () => "bwrap" as const,
    detectEgressBackend: () => "slirp4netns" as const,
    readCodexAuthMode: () => "unknown" as const,
    readCodexHelp: () => "",
    transcriptExists: () => true,
    postgres: {
      settings: () => ({ ...DEFAULT_POSTGRES_SETTINGS, enabled: opts.enabled ?? true }),
      hasLease: () => false,
      ensureRunning: async () => {},
      request: async () => ({ status: "starting" as const }),
    },
  } as any);
  return { store, svc, captured };
}

const base = { repoPath: "/repo", baseBranch: "main", prompt: "build it", model: null, images: [] };
const prompt = (argv: string[]) => argv.join("\n");

test("Claude spawn carries the notice on every profile", async () => {
  for (const profile of ["trusted", "standard", "autonomous"] as const) {
    const { svc, captured } = harness({ profile });
    await svc.create(base);
    expect(prompt(captured.argv!)).toContain(NOTICE);
    expect(prompt(captured.argv!)).toContain("`git check-ignore -q .env`");
    expect(prompt(captured.argv!)).toContain(
      'If granting such a role fails with "ADMIN option", wait a minute and re-run the migrations.',
    );
  }
});

test("a session in the shared checkout is never told to write .env", async () => {
  const { svc, captured } = harness({ isolated: false });
  const s = await svc.create(base);
  expect(s.isolated).toBe(false);
  const text = prompt(captured.argv!);
  expect(text).toContain(NOTICE);
  expect(text).toContain("this session shares the repo checkout, so never write it to `.env`");
  expect(text).not.toContain("`git check-ignore -q .env`");
});

test("no notice when Postgres is off for the session: global off, repo off, plain", async () => {
  const cases: [Parameters<typeof harness>[0], Record<string, unknown>][] = [
    [{ enabled: false }, {}],
    [{ mode: "off" }, {}],
    [{}, { plain: true }],
  ];
  for (const [opts, extra] of cases) {
    const { svc, captured } = harness(opts);
    await svc.create({ ...base, ...extra });
    expect(prompt(captured.argv!)).not.toContain(NOTICE);
  }
});

test("Codex on a Postgres repo: no-tool notice, never the how-to", async () => {
  const { svc, captured } = harness();
  const s = await svc.create({ ...base, agentProvider: "codex" });
  expect(s.agentProvider).toBe("codex");
  const text = prompt(captured.argv!);
  expect(text).toContain(NOTICE);
  expect(text).toContain("this session has no `postgres_request` tool");
  expect(text).toContain("Never substitute PGlite");
  expect(text).not.toContain("call `postgres_request`");
  const off = harness({ mode: "off" });
  await off.svc.create({ ...base, agentProvider: "codex" });
  expect(prompt(off.captured.argv!)).not.toContain(NOTICE);
});

test("Claude resume re-carries the notice while the capability holds", async () => {
  const { store, svc, captured } = harness();
  const s = store.create({
    name: "x",
    prompt: "x",
    repoPath: "/repo",
    baseBranch: "main",
    branch: "shepherd/x",
    worktreePath: "/wt/x",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "term_old",
    claudeSessionId: "abc-123",
  });
  store.update(s.id, { status: "done", lastState: "done" });
  await svc.resume(s.id);
  expect(captured.argv).toContain("--resume");
  expect(prompt(captured.argv!)).toContain(NOTICE);

  store.setRepoConfig("/repo", { ...store.getRepoConfig("/repo"), postgresMode: "off" });
  store.update(s.id, { status: "done", lastState: "done" });
  await svc.resume(s.id);
  expect(prompt(captured.argv!)).not.toContain(NOTICE);
});

test("bootstrap spawn: Postgres status follows the repo's switches", async () => {
  const on = harness();
  await on.svc.create({ ...base, bootstrap: true });
  const onText = prompt(on.captured.argv!);
  expect(onText).toContain(NOTICE);
  expect(onText).toContain("Shepherd's Postgres is ON for this repo");

  const off = harness({ mode: "off" });
  await off.svc.create({ ...base, bootstrap: true });
  const offText = prompt(off.captured.argv!);
  expect(offText).not.toContain(NOTICE);
  expect(offText).toContain("Shepherd's Postgres is OFF for this repo");
  expect(offText).toContain("Repo settings → Agent → Postgres on request");
});

test("composer: the notice rides only for a Claude, non-plain session with the tool", () => {
  const names = (opts: Parameters<typeof composeSystemPromptBlocks>[1]) =>
    composeSystemPromptBlocks(false, opts).map((b) => b.name);
  expect(names({ postgres: "worktree" })).toContain("postgres-notice");
  expect(names({})).not.toContain("postgres-notice");
  expect(names({ postgres: "worktree", plain: true })).not.toContain("postgres-notice");
  expect(names({ postgres: "worktree", agentProvider: "codex" })).not.toContain("postgres-notice");
  expect(names({ postgres: "no-tool", agentProvider: "codex" })).toContain("postgres-notice");
  expect(names({ postgres: "no-tool", plain: true })).not.toContain("postgres-notice");
});
