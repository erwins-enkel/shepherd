/**
 * Does the AGENT BINARY actually start inside the bwrap membrane? (issue #2111)
 *
 * `detectBackend` (sandbox.ts) answers a different question — "can bwrap build a sandbox on this
 * host" — by running `node --version && git --version` plus a session-env write through the real
 * derived membrane. It deliberately does NOT launch `claude`/`codex`, and the two questions must
 * stay separate: a `null` backend means RUN UNCONFINED, so folding a launcher fault into it would
 * silently strip the sandbox from around untrusted plan text on exactly the hosts that can sandbox.
 *
 * Which is how #2110 hid: a mise-managed launcher rebuilt `shims/` under the read-only bind, hit
 * EROFS and exited non-zero, so every wrapped role — plan gate, PR critic, doc agent, standalone
 * critic — died at launch while the backend self-test stayed green. Nothing observed it; each role
 * waited out its whole timeout, recorded `no-verdict`, and respawned into the same wall.
 *
 * So this probe is a SECOND, orthogonal signal. Its failure is loud (a `sandbox_membrane` DIAGNOSE
 * row) and blocking (`resolveAuxPatch` refuses the spawn with a stated reason) — never a change to
 * whether the membrane is applied.
 *
 * Self-contained + dependency-injectable, like sandbox.ts: it imports NO store/service/server, and
 * every host touch is an injectable dep so tests never spawn bwrap.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DIAGNOSTICS_PROBE_TIMEOUT_MS } from "./config";
import {
  buildMembraneFlags,
  detectBackend as realDetectBackend,
  membraneForArgv,
  type MembraneInputs,
  type SandboxBackend,
} from "./sandbox";

const execFileAsync = promisify(execFile);

/** Agent runtimes Shepherd can spawn as a wrapped role. Matches `membraneForArgv`'s argv[0] test. */
export type MembraneAgent = "claude" | "codex";

const MEMBRANE_AGENTS: readonly MembraneAgent[] = ["claude", "codex"] as const;

/** Narrow an inner argv's argv[0] to a known agent, or null (nothing this probe can speak to). */
export function membraneAgentOf(argv: readonly string[]): MembraneAgent | null {
  const head = argv[0];
  return (MEMBRANE_AGENTS as readonly string[]).includes(head ?? "")
    ? (head as MembraneAgent)
    : null;
}

/**
 * A launch verdict.
 *   - `ok`            the binary exited 0 inside the real membrane.
 *   - `broken`        it exited NON-ZERO — the observed, deterministic failure. `detail` is the
 *                     captured output tail (the whole diagnosis, e.g. mise's EROFS lines).
 *   - `uninspectable` the probe itself could not run (spawn threw, timed out). NOT evidence of a
 *                     broken launcher — see the fail-open note on {@link probeMembraneLaunch}.
 */
export type MembraneLaunch =
  { state: "ok" } | { state: "broken"; detail: string } | { state: "uninspectable" };

/** Host values the probe needs to build the same membrane a real spawn would get. */
export interface MembraneLaunchEnv {
  claudeDir: string;
  home: string;
  nodeBinReal: string;
}

/** Result of one captured run: exit status plus merged stdout+stderr. */
export interface CapturedRun {
  status: number;
  output: string;
}

export interface MembraneLaunchDeps {
  /** Spawn and capture; default `execFileAsync` with the diagnostics probe timeout. */
  runCapture?: (cmd: string, args: string[]) => Promise<CapturedRun>;
  /** Clock for the TTL cache; default `Date.now`. */
  now?: () => number;
  /** Cache lifetime; default {@link MEMBRANE_LAUNCH_TTL_MS}. */
  ttlMs?: number;
}

/**
 * How long a verdict stays cached. Aligned with `DIAGNOSTICS_TTL_MS` so a host the operator repairs
 * un-blocks within a minute rather than at the next Shepherd restart — unlike `detectBackend`, whose
 * verdict is pinned for the whole process lifetime.
 */
const MEMBRANE_LAUNCH_TTL_MS = 60_000;

/** Cap on the captured tail carried in `detail` — enough for mise's six ERROR lines, bounded so a
 *  chatty launcher can't push an unbounded string into a log line. */
const DETAIL_MAX = 2000;

/**
 * Thrown by the DEFAULT `runCapture` under `NODE_ENV=test`, and deliberately EXEMPT from the
 * fail-open rule below (re-thrown, never folded into `uninspectable`).
 *
 * Without the exemption an un-injected seam would be swallowed: the probe would report
 * `uninspectable`, the spawn would proceed unrefused, and the test would stay GREEN while spawning
 * real `bwrap` + `<agent> --version` on the test host. Loud beats silent — the message names the
 * seam to inject.
 */
export class MembraneProbeUnwiredError extends Error {
  constructor() {
    super(
      "membrane-launch probe reached its real (host-spawning) default under NODE_ENV=test — " +
        "inject `membraneLaunch` (MembraneSeams) or `runCapture` (MembraneLaunchDeps) in this test",
    );
    this.name = "MembraneProbeUnwiredError";
  }
}

/** Default capture: async (never `execFileSync` — the server is one Bun loop). A non-zero exit is a
 *  REJECTION from execFile, so the status is read off the error rather than the resolved value. */
async function defaultRunCapture(cmd: string, args: string[]): Promise<CapturedRun> {
  if (process.env.NODE_ENV === "test") throw new MembraneProbeUnwiredError();
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      encoding: "utf8",
      timeout: DIAGNOSTICS_PROBE_TIMEOUT_MS,
    });
    return { status: 0, output: `${stdout}${stderr}` };
  } catch (e) {
    const err = e as { code?: unknown; killed?: boolean; stdout?: string; stderr?: string };
    // A timeout SIGTERMs the child; execFile reports that as `killed`, with no numeric code. That is
    // the probe failing to run, not the launcher failing — surface it as a throw so the caller's
    // catch maps it to `uninspectable` rather than to a false `broken`.
    if (err.killed || typeof err.code !== "number") throw e;
    return { status: err.code, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

interface CacheEntry {
  at: number;
  result: MembraneLaunch;
}

const _cache = new Map<MembraneAgent, CacheEntry>();

/** Clear the TTL cache (tests, and the DIAGNOSE re-check path). */
export function resetMembraneLaunchCache(): void {
  _cache.clear();
}

/**
 * Probe whether `agent` starts inside the real derived membrane. TTL-cached per agent.
 *
 * `backend` is passed in rather than probed here so the caller's already-resolved verdict is the one
 * that governs: `null` means no membrane is applied at all, so there is nothing to prove — returns
 * `ok` without spawning.
 *
 * FAIL-OPEN. Only a NON-ZERO EXIT yields `broken`. A probe that throws or times out yields
 * `uninspectable`, which callers treat as "proceed" — a flaky probe must never be able to block
 * every reviewer role on a healthy host. {@link MembraneProbeUnwiredError} is the one exception and
 * propagates.
 */
export async function probeMembraneLaunch(
  agent: MembraneAgent,
  backend: SandboxBackend,
  env: MembraneLaunchEnv,
  deps: MembraneLaunchDeps = {},
): Promise<MembraneLaunch> {
  if (backend === null) return { state: "ok" }; // no membrane in play → nothing to prove

  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? MEMBRANE_LAUNCH_TTL_MS;
  const at = now();
  const hit = _cache.get(agent);
  if (hit && at - hit.at < ttlMs) return hit.result;

  const result = await runProbe(agent, env, deps);
  _cache.set(agent, { at, result });
  return result;
}

/** The uncached probe: build the derived membrane and run `<agent> --version` inside it.
 *
 *  Uses the DEFAULT claude config dir even when a caller's spawn will be routed onto another one
 *  (#1213 plugin routing / the api-key mirror). Deliberate: what is under test is the LAUNCHER chain
 *  — manager shims, bin binds, the `$HOME` tmpfs — none of which depends on which credential dir is
 *  bound, and a per-spawn env would fragment the cache for a host-level fact. */
async function runProbe(
  agent: MembraneAgent,
  env: MembraneLaunchEnv,
  deps: MembraneLaunchDeps,
): Promise<MembraneLaunch> {
  const runCapture = deps.runCapture ?? defaultRunCapture;
  const inner = [agent, "--version"];
  // A tmp dir stands in for the worktree/repo, as in detectBackend's self-test: `--version` never
  // reads the cwd, and the point is to exercise the LAUNCHER (manager shims, bin binds, $HOME
  // tmpfs), which is worktree-independent. membraneForArgv attaches the codex binds off argv[0].
  const probeDir = "/tmp";
  const membrane: MembraneInputs = {
    worktreePath: probeDir,
    gitCommonDir: probeDir,
    isolated: false,
    repoPath: probeDir,
    claudeDir: env.claudeDir,
    home: env.home,
    nodeBinReal: env.nodeBinReal,
  };
  const flags = buildMembraneFlags(membraneForArgv(inner, membrane));

  let run: CapturedRun;
  try {
    run = await runCapture("bwrap", [...flags, "--", ...inner]);
  } catch (err) {
    if (err instanceof MembraneProbeUnwiredError) throw err; // exempt from fail-open — see the class
    console.warn(`[sandbox] membrane-launch probe for ${agent} could not run:`, err);
    return { state: "uninspectable" };
  }
  if (run.status === 0) return { state: "ok" };

  const detail = run.output.trim().slice(0, DETAIL_MAX);
  // The tail is the whole diagnosis and the only place a launch failure is visible, but it carries
  // absolute host paths — so it goes to the LOG, never into a diagnostics payload (hintParams bans
  // paths). Logged on every probe rather than on transition: the TTL already bounds it to once a
  // minute, and a transition-only log would go missing across a restart.
  console.warn(
    `[sandbox] ${agent} exits ${run.status} inside the bwrap membrane — every wrapped role ` +
      `(plan gate, PR critic, doc agent, standalone critic) will refuse to spawn:\n${detail}`,
  );
  return { state: "broken", detail };
}

// ── diagnostics facts ────────────────────────────────────────────────────────

/** One agent binary's launch verdict, for the `sandbox_membrane` DIAGNOSE row. */
export interface AgentLaunchFact {
  agent: MembraneAgent;
  state: MembraneLaunch["state"];
}

/** What the `sandbox_membrane` row classifies. `backend === null` ⇒ nothing is wrapped on this host,
 *  so there is nothing to prove and the row is not pushed at all. Agent binaries absent from PATH
 *  are omitted from `agents` — the existing `claude` / `codex` rows already report their absence. */
export interface MembraneLaunchFacts {
  backend: SandboxBackend;
  agents: AgentLaunchFact[];
}

export interface MembraneLaunchFactsDeps extends MembraneLaunchDeps {
  /** Backend probe; default the real cached `detectBackend`. */
  detectBackend?: () => SandboxBackend;
  /** PATH lookup; default Bun.which. */
  which?: (cmd: string) => string | null;
}

/**
 * Read the launch facts for every agent binary on PATH. Wired into DiagnosticsService from index.ts
 * (the dep has NO functional default there, so an unwired/test run can never reach the host).
 *
 * Shares `probeMembraneLaunch`'s TTL cache with the spawn path, so the DIAGNOSE row and the refusal
 * decision cannot disagree, and a diagnostics tick costs no extra spawn while the cache is warm.
 */
export async function readMembraneLaunchFacts(
  env: MembraneLaunchEnv,
  deps: MembraneLaunchFactsDeps = {},
): Promise<MembraneLaunchFacts> {
  const backend = (deps.detectBackend ?? realDetectBackend)();
  if (backend === null) return { backend, agents: [] };

  const which = deps.which ?? ((cmd: string) => Bun.which(cmd));
  const present = MEMBRANE_AGENTS.filter((a) => which(a) !== null);
  const agents = await Promise.all(
    present.map(async (agent) => ({
      agent,
      state: (await probeMembraneLaunch(agent, backend, env, deps)).state,
    })),
  );
  return { backend, agents };
}
