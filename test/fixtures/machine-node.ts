/**
 * One Shepherd server as its own OS process, for the two-machine test
 * (test/machines-two-instances.test.ts, issue #2769). Run with `bun test/fixtures/machine-node.ts`.
 *
 * Real: the HTTP/WebSocket server (`serve`), auth gate and access tokens, the SQLite store, and the
 * machines wiring as src/index.ts builds it — RemoteInstanceService (started), RemoteSessionMirror
 * following each probe through `onChange`, and the RemoteDispatcher (injected as `remoteDispatch`,
 * with this Shepherd as the machine choice sees it) reconciling unconfirmed hand-offs and sending
 * waiting tasks after each probe — plus the forwarding, terminal bridge and machine choice
 * src/server.ts builds from them. Stubbed: the agent. `SessionService.create` makes
 * a real git worktree and commits the "agent's work" in it; reply, interrupt and archive only record
 * that they ran. Also stubbed, as what the real ones would have found: the capability probe (a
 * fresh report of the capabilities listed in `<root>/capabilities.json`, re-read on every call so
 * the test can take Xcode away and give it back) and the model that reads a task's requirements
 * from its description (a fixed answer per prompt). Every stub call appends one JSON line to
 * `<root>/agent.jsonl`, so the test can tell on which machine something ran. The terminal runs
 * through the real PtyBridge and node-pty against whatever `HERDR_BIN` names (the test points the
 * machine at fake-herdr-echo.mjs).
 *
 * Layout under MACHINE_NODE_ROOT: `app/` (the checkout of acme/app, created on first boot, with
 * native code in it), `worktrees/`, `token` (the plaintext of the `full` token minted on first boot;
 * the store keeps only its hash, so a restart reads it back from here), `capabilities.json` (written
 * by the caller), `agent.jsonl`. The caller sets SHEPHERD_DB, SHEPHERD_REPO_ROOT (= the root) and
 * SHEPHERD_COOKIE_SECRET; MACHINE_NODE_PLATFORM (`linux` | `macos`) is the platform this Shepherd
 * reports; MACHINE_NODE_PORT 0 picks a free port. Once listening it prints
 * `MACHINE-NODE-READY {"port","token","instanceId"}`; SIGTERM stops it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { SessionStore } from "../../src/store";
import { SessionService } from "../../src/service";
import { EventHub } from "../../src/events";
import { serve, type AppDeps } from "../../src/server";
import { config } from "../../src/config";
import { AccessTokenService } from "../../src/access-tokens";
import { RemoteInstanceService } from "../../src/remote-instances/service";
import { RemoteSessionMirror } from "../../src/remote-instances/sessions";
import { RemoteDispatcher } from "../../src/remote-instances/dispatch";
import { instanceIdentity, setInstanceName } from "../../src/remote-instances/identity";
import { localMachine } from "../../src/remote-instances/placement";
import type { CapabilityService } from "../../src/remote-instances/capability-probe";
import {
  CAPABILITIES,
  type Capability,
  type CapabilitySnapshot,
  capabilityReport,
  missingRequirements,
} from "../../src/remote-instances/capabilities";
import type { AnsweredDerivation } from "../../src/requirements-classify-core";
import type { GitForge } from "../../src/forge/types";
import type { CreateSessionInput } from "../../src/types";

const root = process.env.MACHINE_NODE_ROOT!;
const checkout = join(root, "app");
const agentLog = join(root, "agent.jsonl");
const tokenFile = join(root, "token");
const capabilitiesFile = join(root, "capabilities.json");
const platform = process.env.MACHINE_NODE_PLATFORM ?? "linux";

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.name=agent", "-c", "user.email=agent@example.invalid", ...args],
    {
      cwd,
      stdio: "ignore",
    },
  );
}

function record(entry: Record<string, unknown>): void {
  appendFileSync(agentLog, `${JSON.stringify(entry)}\n`);
}

function created(): number {
  if (!existsSync(agentLog)) return 0;
  return readFileSync(agentLog, "utf8")
    .split("\n")
    .filter((line) => line && (JSON.parse(line) as { op: string }).op === "create").length;
}

if (!existsSync(checkout)) {
  mkdirSync(checkout, { recursive: true });
  git(checkout, "init", "-q", "-b", "main");
  writeFileSync(join(checkout, "README.md"), "acme/app\n");
  // Native code in the repository: on its own it must not send a task to the Mac.
  writeFileSync(join(checkout, "Package.swift"), "// swift-tools-version:6.0\n");
  mkdirSync(join(checkout, "native"));
  writeFileSync(join(checkout, "native", "README.md"), "the native apps\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "init");
}

const store = new SessionStore(config.dbPath);
const events = new EventHub();
const service = new SessionService({
  store,
  events,
  namer: async () => "x",
  worktree: {} as never,
  herdr: { list: () => [] } as never,
});

service.create = (async (input: CreateSessionInput) => {
  if (input.terminal === true) throw new Error("machine-node: clean terminals are not stubbed");
  const n = created() + 1;
  const name = `task-${n}`;
  const branch = `shepherd/${name}`;
  const worktreePath = join(root, "worktrees", name);
  const { prompt, baseBranch, images, requirements, placement } = input;
  git(checkout, "worktree", "add", "-q", "-b", branch, worktreePath, baseBranch);
  writeFileSync(join(worktreePath, `agent-${name}.txt`), `${prompt}\n`);
  git(worktreePath, "add", ".");
  git(worktreePath, "commit", "-q", "-m", `agent: ${name}`);
  const session = store.create({
    name,
    prompt,
    repoPath: input.repoPath,
    baseBranch,
    branch,
    worktreePath,
    isolated: true,
    herdrSession: "default",
    herdrAgentId: `term-${n}`,
  });
  record({ op: "create", id: session.id, prompt, images, requirements, placement });
  return session;
}) as SessionService["create"];
service.operatorReply = async (id: string, text: string) => {
  record({ op: "reply", id, text });
  return true;
};
service.interrupt = async (id: string) => {
  record({ op: "interrupt", id });
  return true;
};
service.archive = async (id: string) => {
  record({ op: "archive", id });
  store.archive(id);
  return 0;
};
service.archiveMany = async (ids: string[]) => {
  for (const id of ids) await service.archive(id);
  return { cleared: ids, leftovers: 0 };
};
service.leftovers = () => [];
service.leftoverProbesUnavailable = () => false;

/** What this machine's probe finds right now: the capabilities `capabilities.json` lists, fresh. */
function probed(): CapabilitySnapshot {
  const ok = existsSync(capabilitiesFile)
    ? (JSON.parse(readFileSync(capabilitiesFile, "utf8")) as Capability[])
    : [];
  return {
    vocabulary: 1,
    probedAt: Date.now(),
    checks: CAPABILITIES.map((id) =>
      ok.includes(id) ? { id, ok: true, reason: null } : { id, ok: false, reason: "not_installed" },
    ),
  };
}

// A check run on demand is recorded, so the test sees that it ran before the task started:
// `probe` when a coordinator asks for one right before it sends a waiting task, `verify` when this
// machine checks the requirements of a task it accepts.
const capabilities = {
  report: () => capabilityReport(probed(), Date.now()),
  refresh: async () => {
    record({ op: "probe" });
    return probed();
  },
  verify: async (requirements: Capability[]) => {
    record({ op: "verify", requirements });
    return missingRequirements(probed(), requirements);
  },
} as unknown as CapabilityService;

// The model that reads a task's requirements from its description, as it would answer the
// guide's three prompts (docs/machines.md, end-to-end checklist).
const DERIVED: Record<string, AnsweredDerivation> = {
  "Erweitere die native macOS-App": { status: "derived", requirements: ["xcode"] },
  "Implementiere die Web-Einstellungen": { status: "derived", requirements: [] },
  "Passe die App an das neue Logo an": { status: "unclear", options: [["xcode"], []] },
};
const deriveTaskRequirements: AppDeps["deriveTaskRequirements"] = async ({ prompt }) => {
  record({ op: "derive", prompt });
  return DERIVED[prompt] ?? { status: "failed", cause: "error" };
};

// The machines wiring of src/index.ts. The mirror re-probes a dropped machine every 100 ms (instead
// of 2 s … 30 s) so a restored link heals within the test's patience; nothing else differs.
const accessTokens = new AccessTokenService(store);
const remoteInstances = new RemoteInstanceService({ store });
const remoteSessions = new RemoteSessionMirror({
  store,
  instances: remoteInstances,
  recheckDelaysMs: Array<number>(200).fill(100),
});
remoteInstances.onChange((instanceId) => remoteSessions.sync(instanceId));
const remoteDispatch = new RemoteDispatcher({
  store,
  instances: remoteInstances,
  events,
  here: () => localMachine(instanceIdentity(store, platform), capabilities.report()),
});
remoteInstances.onChange((instanceId) => {
  remoteDispatch
    .reconcile(instanceId)
    .catch((err: unknown) =>
      console.warn(
        "[remote-dispatch] reconcile failed:",
        err instanceof Error ? err.message : String(err),
      ),
    );
});

setInstanceName(store, process.env.MACHINE_NODE_NAME ?? null);
const token = existsSync(tokenFile)
  ? readFileSync(tokenFile, "utf8")
  : accessTokens.mint("machines-test", null, "full", null).token;
writeFileSync(tokenFile, token);

const forge = { slug: "acme/app", isFork: false } as unknown as GitForge;
const deps: AppDeps = {
  store,
  events,
  service,
  accessTokens,
  remoteInstances,
  remoteSessions,
  remoteDispatch,
  hostPlatform: platform,
  capabilities,
  deriveTaskRequirements,
  resolveForge: ((path: string) => (path === checkout ? forge : null)) as AppDeps["resolveForge"],
  usageLimits: {
    limits: () => ({
      session5h: null,
      week: null,
      perModelWeek: [],
      credits: null,
      stale: true,
      calibratedAt: null,
      subscriptionOnly: false,
    }),
    projections: () => [],
  },
};

/** A restart reuses its old port, which the killed process may hold for a moment longer. */
async function listen(port: number): Promise<ReturnType<typeof serve>> {
  for (let attempt = 0; ; attempt++) {
    try {
      return serve(deps, port);
    } catch (err) {
      if (attempt >= 30 || (err as { code?: string }).code !== "EADDRINUSE") throw err;
      await Bun.sleep(100);
    }
  }
}

const server = await listen(Number(process.env.MACHINE_NODE_PORT ?? 0));
remoteInstances.start();

process.on("SIGTERM", () => {
  remoteInstances.stop();
  remoteSessions.stop();
  void server.stop(true);
  process.exit(0);
});

console.log(
  `MACHINE-NODE-READY ${JSON.stringify({
    port: server.port,
    token,
    instanceId: instanceIdentity(store).instanceId,
  })}`,
);
