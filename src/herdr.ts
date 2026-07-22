import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { execFileSync } from "./instrument";
import { config } from "./config";
import {
  detectedHerdrVersion,
  HERDR_LAST_SUPPORTED_VERSION,
  herdrSpawnSupported,
  herdrUsesExternalRegistrationSpawn,
} from "./herdr-capabilities";
import { maintenance } from "./maintenance";
import { compileCacheDir, agentTmpDir } from "./tmp-sweep";
import type { HerdrState, LivenessState, SessionStatus } from "./types";
import type { RequestPaneAgentState } from "./generated/herdr-protocol";

const execFileAsync = promisify(execFile);

export interface HerdrAgent {
  agent: string;
  agentStatus: HerdrState;
  cwd: string;
  /** herdr's unique agent name (empty for manually-started agents that have none). */
  name: string;
  paneId: string;
  tabId: string;
  terminalId: string;
  workspaceId: string;
}

export interface HerdrTab {
  tabId: string;
  /** the tab's display label (e.g. "__usage_probe__", "review TASK-09", a session branch). */
  label: string;
  /** "unknown" when no live agent backs the tab — i.e. an orphaned husk. */
  agentStatus: HerdrState;
  workspaceId: string;
}

export interface HerdrPane {
  paneId: string;
  tabId: string;
  label: string;
  cwd: string;
  agentStatus: HerdrState;
}

export type Runner = (args: string[]) => string;
/** Async counterpart to `Runner` — spawns off Bun's single loop (no blocking). */
export type AsyncRunner = (args: string[]) => Promise<string>;

/** A herdr CLI call attempted while an update is in flight. Thrown WITHOUT
 *  spawning, so nothing resurrects the herdr server mid-update. */
export class HerdrUnavailableError extends Error {
  constructor() {
    super("herdr is unavailable (update in progress)");
    this.name = "HerdrUnavailableError";
  }
}

/** Thrown by `start()` when the installed herdr is newer than Shepherd supports. herdr 0.7.5
 *  (protocol 17) reshaped `agent start` so Shepherd's sandboxed/env-wrapped spawn command can no
 *  longer be launched — every agent spawn breaks. Steering/reading is unaffected; only spawning is
 *  gated. Pin herdr to {@link HERDR_LAST_SUPPORTED_VERSION}. Tracked by issue #1889. */
export class HerdrSpawnUnsupportedError extends Error {
  constructor(version: string | null) {
    super(
      `herdr ${version ?? "?"} is not supported for spawning agents — Shepherd requires herdr ` +
        `<= ${HERDR_LAST_SUPPORTED_VERSION}. herdr 0.7.5+ broke \`agent start\` (see issue #1889); ` +
        `pin herdr to ${HERDR_LAST_SUPPORTED_VERSION} to run Shepherd.`,
    );
    this.name = "HerdrSpawnUnsupportedError";
  }
}

/** Hard ceiling on any synchronous herdr CLI call. `execFileSync` blocks Bun's
 *  single JS thread, so an unbounded call against a half-down server would freeze
 *  every HTTP response (the persistent-502 we are fixing). 10s is far above a
 *  healthy call yet bounds the worst case. */
const HERDR_TIMEOUT_MS = 10_000;

/** Build a Runner around a raw exec fn. Refuses (throws) while maintenance is
 *  active; otherwise delegates. Exported so tests can inject a fake exec. */
export function makeHerdrRunner(exec: (args: string[]) => string): Runner {
  return (args) => {
    if (maintenance.active) throw new HerdrUnavailableError();
    return exec(args);
  };
}

const defaultRunner: Runner = makeHerdrRunner((args) =>
  execFileSync(config.herdrBin, args, { encoding: "utf8", timeout: HERDR_TIMEOUT_MS }),
);

/** Async sibling of `makeHerdrRunner`: same maintenance guard, but the delegate
 *  returns a promise so the spawn never blocks Bun's single loop. */
export function makeHerdrAsyncRunner(exec: (args: string[]) => Promise<string>): AsyncRunner {
  return async (args) => {
    if (maintenance.active) throw new HerdrUnavailableError();
    return exec(args);
  };
}

const defaultAsyncRunner: AsyncRunner = makeHerdrAsyncRunner(async (args) => {
  const { stdout } = await execFileAsync(config.herdrBin, args, {
    encoding: "utf8",
    timeout: HERDR_TIMEOUT_MS,
  });
  return stdout;
});

export function mapState(s: HerdrState): SessionStatus {
  switch (s) {
    case "working":
      return "running";
    case "blocked":
      return "blocked";
    case "done":
      return "done";
    default:
      return "idle";
  }
}

/** The reachable subset of {@link RequestPaneAgentState} Shepherd derives for a LIVE session — never
 *  `done` (not a valid report-agent state) nor `unknown` (a live session always resolves to one of
 *  these three). */
export type PushableAgentState = "idle" | "working" | "blocked";

/**
 * Map Shepherd's own per-tick classifier view to the state to push to herdr via `pane report-agent`
 * (issue #1891). herdr freezes `agent_status` for externally-registered, sandboxed 0.7.5 agents (its
 * pane/PID view is `bwrap`, not the agent binary), so Shepherd must report the state IT derives from
 * the terminal + hook signals. Pure so the classifier→push seam is unit-testable in isolation.
 *
 *  - `blocked` — a block reason is currently surfaced for the session (menu/y-n/awaiting-input/stall/
 *    quota); takes precedence, since a block is the actionable state regardless of turn activity.
 *  - `working` — no block AND a fresh active-turn signal (a live turn's spinner/transcript still
 *    advancing, or a fresh hook activity).
 *  - `idle` — no block AND no fresh activity (the agent finished its turn / is resting).
 */
export function deriveHerdrState(input: {
  blocked: boolean;
  working: boolean;
}): PushableAgentState {
  if (input.blocked) return "blocked";
  return input.working ? "working" : "idle";
}

/**
 * Compare a herdr agent's name to a session's name for the cwd-collision disambiguator. On the
 * 0.7.5 external-registration path the agent's `--agent` label was coerced through
 * {@link sanitizeHerdrAgentName} (e.g. `review TASK-09` → `review-task-09`), so it will NOT equal
 * the raw `session.name` — compare in sanitized space there. ≤0.7.4 keeps a strict raw comparison,
 * so its matching is byte-identical. Without this, 2+ same-cwd 0.7.5 sessions could never re-pair by
 * name after a herdr daemon restart (stale terminalIds), misclassifying a live session as stranded.
 */
function agentNameMatchesSession(agentName: string, sessionName: string): boolean {
  return herdrUsesExternalRegistrationSpawn()
    ? agentName === sanitizeHerdrAgentName(sessionName)
    : agentName === sessionName;
}

/**
 * Resolve a session to its live herdr agent by a STABLE key. terminalId is the fast
 * path but is volatile across a herdr daemon restart, so on a miss we fall back to the
 * immutable worktree cwd. A cwd shared by 2+ agents (non-isolated same-repo sessions)
 * is disambiguated by agent name; still ambiguous → no match (never risk mis-pairing).
 */
export function matchAgent(
  s: { herdrAgentId: string; worktreePath: string; name: string },
  agents: HerdrAgent[],
): HerdrAgent | null {
  const byId = agents.find((a) => a.terminalId === s.herdrAgentId);
  if (byId) return byId;
  const byCwd = agents.filter((a) => a.cwd === s.worktreePath);
  if (byCwd.length === 1) return byCwd[0]!;
  if (byCwd.length > 1) {
    const byName = byCwd.filter((a) => agentNameMatchesSession(a.name, s.name));
    if (byName.length === 1) return byName[0]!;
  }
  return null;
}

/**
 * True when `agent` is a pane herdr re-created (its terminalId is NOT the one Shepherd last spawned
 * on the owning account) for a session that HAS an owning plugin account. Such a pane is a bare
 * `claude --resume` under the wrong CLAUDE_CONFIG_DIR and must be re-driven through onSpawn, not
 * adopted/steered. Keys on spawnTerminalId (written only by the spawn-finish path, never by
 * reconcile/poller) so their re-pointing of herdrAgentId cannot mask a herdr-restored husk.
 */
export function needsAccountRedrive(
  s: { spawnAccountDir: string | null; spawnTerminalId: string | null },
  agent: { terminalId: string },
): boolean {
  return s.spawnAccountDir !== null && agent.terminalId !== s.spawnTerminalId;
}

/** The Session fields the stranded/liveness helpers read (a structural subset so tests can pass
 *  bare literals). */
export type StrandFields = {
  status: SessionStatus;
  readyToMerge: boolean;
  autopilotComplete: boolean;
  spawnTerminalId: string | null;
  spawnAccountDir: string | null;
};

/**
 * True when a session's pane is a herdr-restored **husk** — the daemon restarted (or the pane was
 * re-created) and the `claude`/`codex` process inside is gone, so the session is stranded and needs
 * reviving. Evaluated against the tick's MATCH RESULT (`agent`), never `session.herdrAgentId`, so a
 * session with no live pane this tick (about to be reaped) is never misread as stranded.
 *
 *  - `agent != null` — a pane matched this tick (restored husk), not gone.
 *  - `claudeAlive === false` — the `/proc` sweep confirms no agent process (herdr's `agent_status`
 *    can't see this; a bare shell still lists `idle`).
 *  - active + not operator/auto-concluded — a parked/finished session's dead agent is expected.
 *  - `spawnTerminalId === null` (legacy row, no verified spawn recorded → fingerprint-free fallback)
 *    OR `terminalId !== spawnTerminalId` (the daemon-restart fingerprint: `spawnTerminalId` advances
 *    only on a verified spawn, so a re-created pane's id differs). A normal Codex exit sits at its OWN
 *    pane (`terminalId === spawnTerminalId`, non-null) → excluded.
 */
export function isStranded(
  s: StrandFields,
  agent: { terminalId: string } | null,
  claudeAlive: boolean,
): boolean {
  return (
    agent !== null &&
    claudeAlive === false &&
    s.status !== "archived" &&
    !s.readyToMerge &&
    !s.autopilotComplete &&
    (s.spawnTerminalId === null || agent.terminalId !== s.spawnTerminalId)
  );
}

/**
 * Fold the `/proc` husk bit + the match result into the 3-state liveness surfaced to the UI.
 * `claudeAlive === undefined` (pre-first-sweep) counts as not-husk → `alive`, so a session is never
 * flagged before `/proc` confirms the husk.
 */
export function classifyLiveness(
  s: StrandFields,
  agent: { terminalId: string } | null,
  claudeAlive: boolean | undefined,
): LivenessState {
  if (claudeAlive !== false) return "alive";
  return isStranded(s, agent, claudeAlive) ? "stranded" : "husk";
}

/**
 * True when a stranded session may be AUTONOMOUSLY force-resumed (auto-revive). A *positively*
 * default-account session: `spawnTerminalId !== null` (a verified spawn happened) AND
 * `spawnAccountDir === null` (that spawn recorded no owning account → genuinely default). This
 * excludes (a) account/plugin panes — already handled every tick by `reDriveAccount` — and (b) legacy
 * rows whose account is unknown, so `resume(force)` can never silently respawn a possible account
 * session under the default `CLAUDE_CONFIG_DIR`. Legacy/account strands stay on operator-initiated
 * revive (manual Resume / "revive all").
 */
export function isAutoRevivable(s: {
  spawnTerminalId: string | null;
  spawnAccountDir: string | null;
}): boolean {
  return s.spawnTerminalId !== null && s.spawnAccountDir === null;
}

/**
 * Pick the cwd-fallback agent for one still-unmatched session from the untaken
 * candidates. When the session contends for its cwd with another active session, only
 * an unambiguous agent-NAME match is safe; a sole session adopts its lone cwd agent via
 * `matchAgent` regardless of name (so a renamed isolated session still re-pairs).
 */
function pickByCwd(
  s: { herdrAgentId: string; worktreePath: string; name: string },
  candidates: HerdrAgent[],
  contended: boolean,
): HerdrAgent | null {
  if (!contended) return matchAgent(s, candidates);
  const byName = candidates.filter(
    (c) => c.cwd === s.worktreePath && agentNameMatchesSession(c.name, s.name),
  );
  return byName.length === 1 ? byName[0]! : null;
}

/**
 * Resolve EVERY active session to its live herdr agent at once, arbitrating
 * cross-session collisions so a dead session can't steal a live sibling's agent.
 *
 * Pass 1 — exact terminalId (the stable-within-a-daemon fast path).
 * Pass 2 — cwd fallback for stale ids (e.g. after a herdr daemon restart). When 2+
 *   still-unmatched sessions share a cwd (non-isolated same-repo), only an exact
 *   agent-NAME match is safe. A session that is the SOLE one at its cwd adopts its lone
 *   agent via `matchAgent` regardless of name, so an isolated session whose name drifted
 *   from its herdr agent still re-pairs. Each agent is adopted by at most one session.
 */
export function matchAgents(
  sessions: { id: string; herdrAgentId: string; worktreePath: string; name: string }[],
  agents: HerdrAgent[],
): Map<string, HerdrAgent | null> {
  const out = new Map<string, HerdrAgent | null>();
  const taken = new Set<string>(); // claimed terminalIds
  const matched = new Set<string>(); // resolved session ids

  for (const s of sessions) {
    const a = agents.find((x) => x.terminalId === s.herdrAgentId);
    if (a && !taken.has(a.terminalId)) {
      out.set(s.id, a);
      taken.add(a.terminalId);
      matched.add(s.id);
    }
  }

  // Frozen before pass 2 so claim order can't shift contention.
  const remaining = sessions.filter((s) => !matched.has(s.id));
  const sessionsPerCwd = new Map<string, number>();
  for (const s of remaining) {
    sessionsPerCwd.set(s.worktreePath, (sessionsPerCwd.get(s.worktreePath) ?? 0) + 1);
  }

  for (const s of remaining) {
    const candidates = agents.filter((a) => !taken.has(a.terminalId));
    const a = pickByCwd(s, candidates, (sessionsPerCwd.get(s.worktreePath) ?? 0) > 1);
    out.set(s.id, a);
    if (a) taken.add(a.terminalId);
  }

  return out;
}

/**
 * Returns true when the error thrown by `runner` signals that a same-named agent is
 * already registered in herdr. The CLI emits `agent_name_taken` as a JSON code on
 * stderr/stdout, which execFileSync surfaces on the thrown error's `.stderr`/`.stdout`/
 * `.message`. The socket transport surfaces it as `HerdrSocketError.code` (the `.message`
 * is human prose without the marker, so the `.code` check is load-bearing there —
 * confirmed against live herdr 0.7.3). Defensive: coerces unknown fields to string safely;
 * non-Error throws return false.
 */
export function isNameTakenError(err: unknown): boolean {
  if (err == null) return false;
  const marker = "agent_name_taken";
  if (typeof err === "string") return err.includes(marker);
  if (typeof err === "object") {
    const e = err as Record<string, unknown>;
    for (const field of ["stderr", "stdout", "message", "code"]) {
      const v = e[field];
      if (v != null && String(v).includes(marker)) return true;
    }
  }
  return false;
}

type AgentListResult = { agents?: Record<string, string>[] } | null;

/**
 * Maps a herdr `agent.list` reply's `result` object to `HerdrAgent[]`. Pure and
 * module-level so BOTH the sync CLI driver (`HerdrDriver.list`/`listAsync`) and the
 * socket driver (issue #1529) can share the exact same parsing — the reply
 * shape doesn't change with the transport. Read `result?.agents ?? []`.
 */
export function parseAgents(result: unknown): HerdrAgent[] {
  const agents = (result as AgentListResult)?.agents ?? [];
  return agents.map(mapAgentRecord);
}

/** The one snake_case→HerdrAgent field mapping, shared by `parseAgents` and
 *  `parseAgentInfo` so the two reply shapes can't drift apart.
 *  `noUncheckedIndexedAccess` widens Record<string,string> indexing to `| undefined`;
 *  `?? ""` keeps these required-string fields honest — herdr always supplies them in
 *  practice. */
function mapAgentRecord(a: Record<string, string>): HerdrAgent {
  return {
    agent: a.agent ?? "",
    agentStatus: (a.agent_status ?? "unknown") as HerdrState,
    cwd: a.cwd ?? "",
    name: a.name ?? "",
    paneId: a.pane_id ?? "",
    tabId: a.tab_id ?? "",
    terminalId: a.terminal_id ?? "",
    workspaceId: a.workspace_id ?? "",
  };
}

/**
 * Maps a herdr `tab.list` reply's `result` object to `HerdrTab[]`. Takes the `result`
 * (not the whole parsed reply) so BOTH transports share it — the CLI driver passes
 * `JSON.parse(out)?.result`, the socket driver passes the request's resolved result
 * directly (same convention as `parseAgents`).
 */
export function parseTabs(result: unknown): HerdrTab[] {
  const tabs = (result as { tabs?: Record<string, string>[] } | null)?.tabs ?? [];
  return tabs.map((t) => ({
    tabId: t.tab_id ?? "",
    label: t.label ?? "",
    agentStatus: (t.agent_status ?? "unknown") as HerdrState,
    workspaceId: t.workspace_id ?? "",
  }));
}

/**
 * Maps a single herdr `AgentInfo` object (the `result.agent` of an `agent.start`
 * `agent_started` reply) to one `HerdrAgent`, using the SAME field mapping as
 * `parseAgents`' per-item map. Both start transports resolve their started agent straight
 * from this reply — `agent_started.agent` carries `terminal_id`/`tab_id`/… directly
 * (confirmed against live herdr 0.7.3), so no post-start re-list is needed.
 */
export function parseAgentInfo(agent: unknown): HerdrAgent {
  return mapAgentRecord((agent ?? {}) as Record<string, string>);
}

/**
 * Coerce an arbitrary Shepherd label into herdr's agent-name grammar `^[a-z][a-z0-9_-]{0,31}$`
 * (spike-confirmed on 0.7.5: `TASK-01`, `plan-review TASK-707` are rejected as
 * `invalid_agent_name`). Deterministic + stable: lowercase → replace every run of chars outside
 * `[a-z0-9_-]` with a single `-` → strip leading chars that are not `[a-z]` (the first char must be
 * a letter) → fall back to `agent` when nothing survives → truncate to 32. Applied on the 0.7.5
 * path to the `pane report-agent`/`report-agent-session` `--agent` label and to `agent rename`.
 * ≤0.7.4 never calls it (that path passes the raw name to `agent start`), so its behavior is
 * unchanged.
 */
export function sanitizeHerdrAgentName(raw: string): string {
  const lowered = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  const trimmed = lowered.replace(/^[^a-z]+/, "");
  return (trimmed.length > 0 ? trimmed : "agent").slice(0, 32);
}

/**
 * Resolve a herdr `terminal_id` to its `pane_id` from an `agent list` snapshot. On herdr 0.7.5 the
 * driver's read/send/relabel must target `pane_id` — `terminal_id` and label are rejected as
 * `agent_not_found` — but Shepherd keys sessions on `terminal_id`, so this lookup is load-bearing.
 * Returns null when no agent carries that `terminal_id` (gone/exited) or the matched record has no
 * `pane_id` (unusable as a target).
 */
export function resolvePaneId(agents: HerdrAgent[], terminalId: string): string | null {
  return agents.find((a) => a.terminalId === terminalId)?.paneId || null;
}

/** A single 0.7.5 pane write: either literal PTY text (`pane send-text`) or named keys
 *  (`pane send-keys`). */
export type PaneWrite = { kind: "text"; text: string } | { kind: "keys"; keys: string[] };

/**
 * Classify a driver `send(text)` payload for the 0.7.5 write path (spike-confirmed writes go through
 * `pane send-text` + `pane send-keys Enter`, NOT `agent send`/`agent send-keys` — those return
 * `agent_not_ready` on a registered-but-undetected sandboxed agent). A lone CR/LF becomes the
 * `Enter` key; everything else (including a lone ESC byte and the bracketed-paste-wrapped steer
 * blob) is delivered as literal PTY text. Only the `Enter` key name is spike-confirmed, so ESC and
 * the paste markers ride `pane send-text` as literal bytes rather than depending on an unverified
 * key name. This keeps `SessionService.sendSteerTo`'s two-call paste-then-CR sequence correct with
 * no caller change: the CR maps to `Enter`, the paste blob to `send-text` (markers preserved).
 */
export function classifyPaneWrite(text: string): PaneWrite {
  if (text === "\r" || text === "\n" || text === "\r\n") return { kind: "keys", keys: ["Enter"] };
  return { kind: "text", text };
}

/**
 * Builds the wrapped spawn argv shared by BOTH drivers (issue #1553), so a socket-backed
 * `start` spawns a byte-identical process to the CLI path. Wraps argv (always
 * `["claude", …]`) in a coreutils `env` shim that pins the V8 compile cache to a disk-backed
 * dir. `env` execvp's straight into claude (no extra process layer), so herdr's PTY/agent
 * detection is unaffected — but NODE_COMPILE_CACHE now lands on disk instead of
 * `$TMPDIR/node-compile-cache` on the tmpfs, where it accreted unbounded and exhausted
 * inodes (#560). Caller-supplied `env` vars (e.g. CLAUDE_CONFIG_DIR for api-key auth mode)
 * are injected as additional KEY=VALUE tokens after NODE_COMPILE_CACHE, in sorted-key order
 * for stability.
 *
 * Pins the CLASSIC renderer for every spawned claude UNLESS the caller already specified a
 * renderer choice in `env` (Shepherd's integration assumes the classic renderer; the
 * poller/blocked classifier scrape `agent read --source visible`, the web terminal forwards
 * xterm keystrokes). The main-session spawn computes its own renderer env and routes it
 * through both the membrane --setenv and this shim, so re-adding the pin here would
 * duplicate it (and `env`'s last-wins would let the pin override an intended NO_FLICKER).
 *
 * Points the agent at the disk-backed `agentTmpDir()` via `TMPDIR=` (#1875) so its temp I/O stays
 * off the `/tmp` tmpfs whose inode table it exhausts, and STRIPS the inherited `CLAUDE_CODE_TMPDIR`
 * via `env -u`: the server sets that on its OWN env so `claudeTmpRoot()` follows, but claude honours
 * it as a BASE and appends its own `claude-$uid`, so letting it reach the agent would double-suffix
 * the agent's root and desync it from the server's read path. Both are skipped when the redirect is
 * disabled (`agentTmpDir()===null`); the `TMPDIR=` token is skipped if the caller already set one.
 * NOTE: for a membrane-wrapped (sandboxed) spawn this OUTER `env` shim is wiped by `bwrap --clearenv`
 * (identically to `NODE_COMPILE_CACHE`), so the redirect is a TRUSTED-spawn guarantee — a sandbox's
 * own ephemeral `--tmpfs /tmp` never threatens the host inode table.
 */
export function buildWrappedArgv(argv: string[], env?: Record<string, string>): string[] {
  const envTokens = env
    ? Object.entries(env)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
    : [];
  const callerSetRenderer =
    !!env && ("CLAUDE_CODE_NO_FLICKER" in env || "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN" in env);
  // `-u CLAUDE_CODE_TMPDIR` must precede the KEY=VALUE assignments (coreutils `env` stops option
  // parsing at the first operand). When enabled we ALWAYS strip CLAUDE_CODE_TMPDIR (even if a caller
  // set TMPDIR — claude prefers CLAUDE_CODE_TMPDIR over TMPDIR, so a leak would still double-suffix),
  // and add our TMPDIR= only when the caller didn't provide one.
  const agentTmp = agentTmpDir();
  const tmpTokens = agentTmp
    ? ["-u", "CLAUDE_CODE_TMPDIR", ...(env && "TMPDIR" in env ? [] : [`TMPDIR=${agentTmp}`])]
    : [];
  return [
    "env",
    ...tmpTokens,
    `NODE_COMPILE_CACHE=${compileCacheDir()}`,
    ...(callerSetRenderer ? [] : ["CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1"]),
    ...envTokens,
    ...argv,
  ];
}

/** A headless Codex role shares its tab's process lifetime with the initial shell pane.
 * Closing that pane immediately after `agent start` can terminate the role before it writes its
 * file-based result, so direct `codex exec` and membrane-wrapped `bwrap … -- codex exec` runs
 * deliberately retain it. */
export function isHeadlessCodexExec(argv: string[]): boolean {
  const commandStart = argv[0] === "bwrap" ? argv.indexOf("--") + 1 : 0;
  return argv[commandStart] === "codex" && argv[commandStart + 1] === "exec";
}

/**
 * A promise-chain serializer (issue #1553): runs each submitted async fn only after the
 * prior one settles, restoring the mutual exclusion the blocking sync `execFileSync` path
 * gave the multi-step `start` orchestration. Without it, async yield points let two
 * concurrent `start`s interleave — both seeing an empty `workspace.list` and
 * double-creating the workspace, or racing collision-retry. NOT `singleFlight` (which
 * coalesces distinct calls onto one run); every `start` must actually run. Per-instance:
 * each driver owns its own chain. The internal tail swallows rejections so one failed call
 * never poisons the queue.
 */
export function createSerializer(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/**
 * Extracts the buffer text from a herdr `agent.read` reply's `result` object
 * (`""` when absent). Shared with the socket driver — see `parseAgents`.
 */
type PaneReadResult = { read?: { text?: string } } | null;

export function parseReadText(result: unknown): string {
  return (result as PaneReadResult)?.read?.text ?? "";
}

/**
 * Maps a herdr `pane.process_info` reply's `result` object to the foreground
 * process **names** (`[]` when absent). Shared with the socket driver —
 * see `parseAgents`.
 */
type ProcessInfoResult = {
  process_info?: { foreground_processes?: Array<{ name: string }> };
} | null;

export function parseProcs(result: unknown): string[] {
  const procs = (result as ProcessInfoResult)?.process_info?.foreground_processes ?? [];
  return procs.map((p) => p.name);
}

/**
 * Spawn-handle registry (issue #1852): remembers each `start()`'s authoritative
 * `tabId` + tab label, keyed by the started agent's terminalId, so `stop()` can close
 * the recorded tab WITHOUT rediscovering it through `agent list`. That rediscovery was
 * the leak: a helper that exited (or died milliseconds after `agent.start`) vanishes
 * from `agent list` while its tab persists as a husk — `stop()` then silently no-oped
 * and the tab accumulated until herdr exhausted its FD limit (334 tabs / 1,010 FDs).
 *
 * In-memory by design: entries live exactly as long as the in-process teardown paths
 * that need them; anything orphaned across a Shepherd restart is the orphan-tab
 * sweep's job. Entries are dropped on `stop()` so steady-state size tracks the live
 * agent count.
 */
export class TabLedger {
  private entries = new Map<string, { tabId: string; label: string }>();

  record(terminalId: string, tabId: string, label: string): void {
    if (terminalId && tabId) this.entries.set(terminalId, { tabId, label });
  }

  get(terminalId: string): { tabId: string; label: string } | null {
    return this.entries.get(terminalId) ?? null;
  }

  delete(terminalId: string): void {
    this.entries.delete(terminalId);
  }

  /** Mirror a TAB rename (the label check in `stopViaRecordedTab` compares tab labels). */
  relabel(terminalId: string, label: string): void {
    const e = this.entries.get(terminalId);
    if (e) e.label = label;
  }
}

/**
 * Shared `stop()` body for both drivers (issue #1852): the spawn-recorded tab is the
 * NORMAL teardown path; the fresh `agent list` lookup is only the fallback for handles
 * the ledger doesn't know (re-adopted after a Shepherd restart, legacy callers).
 *
 * - `terminalId === ""` → no-op: cwd-reconcile callers pass `""` deliberately when the
 *   pane is already gone from the live list.
 * - Ledger hit → verify against the live TAB list (which, unlike `agent list`, still
 *   contains an exited helper's husk): recorded tab present with the recorded label →
 *   close it, done — zero `agent list` calls. Tab absent → it died with the daemon or
 *   was already closed; nothing to close. Label mismatch → the id was re-minted by a
 *   restarted daemon (or a rename the ledger missed) — never close on a mismatch; warn
 *   and fall through to the agent-list resolution, which reflects current truth.
 * - A `tabsAsync()` throw (herdr hiccup) also falls through to the agent-list path, so
 *   this is never weaker than the pre-ledger behavior.
 * - Nothing found anywhere → warn: an observable no-op, never a silent one (#1852).
 */
export async function stopViaRecordedTab(
  driver: Pick<IHerdrDriver, "listAsync" | "tabsAsync" | "closeTab">,
  ledger: TabLedger,
  terminalId: string,
): Promise<void> {
  if (!terminalId) return;

  const known = ledger.get(terminalId);
  if (known) {
    let tabs: HerdrTab[] | null = null;
    try {
      tabs = await driver.tabsAsync();
    } catch {
      /* transient tab-list failure — fall back to the agent-list path below */
    }
    if (tabs) {
      const tab = tabs.find((t) => t.tabId === known.tabId);
      if (!tab) {
        // Recorded tab no longer exists (daemon restart without restore, or already
        // closed) — nothing to close, nothing leaked.
        ledger.delete(terminalId);
        return;
      }
      if (tab.label === known.label) {
        ledger.delete(terminalId);
        await driver.closeTab(known.tabId);
        return;
      }
      // Label mismatch: recorded id now denotes some other tab — closing it could kill
      // live work. Drop the unusable entry and resolve from the live agent list instead.
      console.warn(
        `[herdr] stop: recorded tab ${known.tabId} for terminal ${terminalId} is now ` +
          `labeled ${JSON.stringify(tab.label)} (recorded ${JSON.stringify(known.label)}) — ` +
          `not closing it; falling back to agent list`,
      );
      ledger.delete(terminalId);
    }
  }

  const agent = (await driver.listAsync()).find((a) => a.terminalId === terminalId);
  if (agent?.tabId) {
    ledger.delete(terminalId);
    await driver.closeTab(agent.tabId);
    return;
  }
  console.warn(
    `[herdr] stop: no live agent and no usable recorded tab for terminal ${terminalId} — ` +
      `teardown is a no-op (orphan sweep will cover any residue)`,
  );
}

/**
 * Public method surface of `HerdrDriver`, extracted so the socket-backed
 * driver (`SocketHerdrDriver`, issue #1529) implements the same contract behind the existing seam —
 * callers keep using `Pick<HerdrDriver, …>` today; nothing about them changes.
 */
export interface IHerdrDriver {
  list(): HerdrAgent[];
  /** Non-blocking sibling of `list()` — see `HerdrDriver.listAsync`. */
  listAsync(): Promise<HerdrAgent[]>;
  tabs(): HerdrTab[];
  /** Non-blocking sibling of `tabs()` — the recorded-tab verification in `stop()` runs
   *  on the async surface (#1852). */
  tabsAsync(): Promise<HerdrTab[]>;
  panes(): HerdrPane[];
  paneForegroundProcs(paneId: string): Promise<string[]>;
  /** Push a Shepherd-derived lifecycle state to a pane's registered agent (`pane report-agent
   *  --state`, issue #1891). Used for externally-registered sandboxed 0.7.5 agents whose
   *  `agent_status` herdr cannot advance on its own. */
  reportAgentState(paneId: string, agentName: string, state: RequestPaneAgentState): Promise<void>;
  /** Spawn an agent (issue #1553: async — socket-backed when `SHEPHERD_HERDR_SOCKET=1`,
   *  else non-blocking CLI). Returns the started `HerdrAgent`. */
  start(
    name: string,
    cwd: string,
    argv: string[],
    env?: Record<string, string>,
  ): Promise<HerdrAgent>;
  /** Write literal text to an agent's PTY (issue #1567: async — socket-backed when
   *  `SHEPHERD_HERDR_SOCKET=1`, else non-blocking CLI). Callers that deliver a multi-send
   *  sequence (bracket-paste then CR) must serialize the pair — see `SessionService.sendSteerTo`. */
  send(target: string, text: string): Promise<void>;
  read(target: string, source?: "visible" | "recent", lines?: number): string;
  readAsync(target: string, source?: "visible" | "recent", lines?: number): Promise<string>;
  stop(terminalId: string): Promise<void>;
  relabel(terminalId: string, newName: string): Promise<void>;
  closeTab(tabId: string): Promise<void>;
}

export class HerdrDriver implements IHerdrDriver {
  /** Serializes `start` so concurrent spawns can't race the workspace/tab orchestration
   *  now that the writes are async (issue #1553); see `createSerializer`. */
  private serializeStart = createSerializer();

  /** Spawn-handle registry: authoritative tabId per started terminalId (#1852). */
  private ledger = new TabLedger();

  constructor(
    private runner: Runner = defaultRunner,
    private asyncRunner: AsyncRunner = defaultAsyncRunner,
  ) {}

  list(): HerdrAgent[] {
    return parseAgents(JSON.parse(this.runner(["agent", "list"]))?.result);
  }

  /**
   * Async sibling of `list()` — same maintenance guard, but spawns via `asyncRunner`
   * so it never blocks Bun's single loop. Used by the poll loop, which calls `agent
   * list` every 1s; the sync `list()` there would freeze the live web terminal.
   */
  async listAsync(): Promise<HerdrAgent[]> {
    return parseAgents(JSON.parse(await this.asyncRunner(["agent", "list"]))?.result);
  }

  /** Every tab in the workspace — including husks with no live agent (`tab list`). */
  tabs(): HerdrTab[] {
    return parseTabs(JSON.parse(this.runner(["tab", "list"]))?.result);
  }

  /** Async sibling of `tabs()` — spawns via `asyncRunner` so the recorded-tab
   *  verification in `stop()` never blocks Bun's single loop. */
  async tabsAsync(): Promise<HerdrTab[]> {
    return parseTabs(JSON.parse(await this.asyncRunner(["tab", "list"]))?.result);
  }

  /** Every pane across all tabs (`pane list`). Includes idle shell panes left behind by exited agents. */
  panes(): HerdrPane[] {
    const parsed = JSON.parse(this.runner(["pane", "list"]));
    const panes = parsed?.result?.panes ?? [];
    return panes.map((p: Record<string, string>) => ({
      paneId: p.pane_id ?? "",
      tabId: p.tab_id ?? "",
      label: p.label ?? "",
      cwd: p.cwd ?? "",
      agentStatus: (p.agent_status ?? "unknown") as HerdrState,
    }));
  }

  /**
   * Async: returns the foreground process **names** in a pane (`pane process-info`).
   * For a husk pane (idle shell) this is `["zsh"]`; for a live agent pane it includes
   * `"claude"` and companion processes.
   *
   * A JSON parse failure (missing/malformed reply) returns `[]` — the caller can treat
   * an unreadable pane as "no known foreground processes". A thrown CLI error (e.g.
   * herdr lacks the subcommand) **propagates** — callers must distinguish "shell-only"
   * (`["zsh"]`) from "subcommand unavailable" (throw).
   */
  async paneForegroundProcs(paneId: string): Promise<string[]> {
    const out = await this.asyncRunner(["pane", "process-info", "--pane", paneId]);
    try {
      return parseProcs(JSON.parse(out)?.result);
    } catch {
      return [];
    }
  }

  /**
   * Push a Shepherd-derived lifecycle state onto a pane's registered agent (issue #1891). Mirrors the
   * arg shape of the register pair (`pane report-agent <paneId> --source shepherd --agent <name>
   * --state <state>`; the paneId is a leading positional before the flags — CLI quirk). Used only for
   * externally-registered sandboxed 0.7.5 agents, whose `agent_status` herdr freezes at registration
   * (its pane/PID view is `bwrap`), so `agent list` reflects reality only if Shepherd reports it.
   */
  async reportAgentState(
    paneId: string,
    agentName: string,
    state: RequestPaneAgentState,
  ): Promise<void> {
    await this.asyncRunner([
      "pane",
      "report-agent",
      paneId,
      "--source",
      "shepherd",
      "--agent",
      agentName,
      "--state",
      state,
    ]);
  }

  /**
   * herdr ≥0.6 refuses `tab create` with `workspace_not_found: no active workspace`
   * unless a workspace exists. A fresh daemon — or one restarted after an update —
   * has none, so the very first New Task after a herdr restart used to 500. Create a
   * "shepherd" workspace on demand. Idempotent: skips when any workspace already exists.
   */
  private async ensureWorkspace(cwd: string): Promise<void> {
    let workspaces: unknown[];
    try {
      workspaces =
        JSON.parse(await this.asyncRunner(["workspace", "list"]))?.result?.workspaces ?? [];
    } catch {
      workspaces = []; // unparseable/empty reply → treat as "none", create one
    }
    if (workspaces.length === 0) {
      await this.asyncRunner([
        "workspace",
        "create",
        "--cwd",
        cwd,
        "--label",
        "shepherd",
        "--no-focus",
      ]);
    }
  }

  /** Bounded-retry wrapper around `agent start` that evicts same-named squatter agents
   *  when herdr rejects with `agent_name_taken`. Up to 3 attempts; no sleep between them
   *  (the herdr round-trips provide real-world spacing). */
  private async startAgentWithCollisionRetry(
    name: string,
    tabId: string,
    cwd: string,
    wrapped: string[],
  ): Promise<HerdrAgent> {
    const agentStartArgs = [
      "agent",
      "start",
      name,
      "--tab",
      tabId,
      "--cwd",
      cwd,
      "--no-focus",
      "--",
      ...wrapped,
    ];
    const MAX_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const parsed = JSON.parse(await this.asyncRunner(agentStartArgs));
        const agent = parseAgentInfo(parsed?.result?.agent);
        if (!agent.terminalId || agent.tabId !== tabId) {
          throw new Error(`herdr: agent start returned an invalid agent for tab ${tabId}`);
        }
        return agent;
      } catch (err) {
        if (!isNameTakenError(err) || attempt === MAX_ATTEMPTS - 1) {
          // Non-name-taken error → propagate immediately; or attempts exhausted → propagate
          throw err;
        }
        // Evict squatter(s) by name — never by regex-parsing the error string
        const squatters = (await this.listAsync()).filter((a) => a.name === name);
        for (const sq of squatters) await this.closeTab(sq.tabId);
      }
    }
    throw new Error(`herdr: agent start exhausted retries for ${name}`);
  }

  /**
   * Spawn an agent (issue #1553: `async` — non-blocking via `asyncRunner`). Serialized so
   * concurrent spawns can't race the workspace/tab orchestration (the async yield points
   * removed the implicit mutual exclusion the blocking sync path had).
   */
  async start(
    name: string,
    cwd: string,
    argv: string[],
    env?: Record<string, string>,
  ): Promise<HerdrAgent> {
    // Refuse loudly on a herdr too new to spawn on at all (see HerdrSpawnUnsupportedError / #1889).
    // Steering/reading existing agents still works.
    if (!herdrSpawnSupported()) throw new HerdrSpawnUnsupportedError(detectedHerdrVersion());
    return this.serializeStart(() =>
      // 0.7.5 (protocol 17) can't launch the wrapped argv through `agent start`; use the
      // external-registration path instead (#1890). ≤0.7.4 keeps the byte-identical legacy path.
      herdrUsesExternalRegistrationSpawn()
        ? this.startImpl075(name, cwd, argv, env)
        : this.startImpl(name, cwd, argv, env),
    );
  }

  /**
   * Create a dedicated full-width tab for one agent and return its id + root pane id. Shared by both
   * spawn paths (the ≤0.7.4 `agent start` split and the 0.7.5 `pane run`). Each agent gets its OWN
   * tab so its pane spans the full herdr window width: a `--tab`-less `agent start` splits the active
   * tab, so agents pile up as side-by-side panes each ~window/N wide — and that split-fixed width
   * (not the browser's attach size) is what the PTY renders at, so the HUD terminal comes out
   * tall-and-narrow and resizing the browser can't widen it. Throws if herdr returns no `tab_id`
   * (nothing created yet, so nothing to roll back).
   */
  private async createDedicatedTab(
    name: string,
    cwd: string,
  ): Promise<{ tabId: string; rootPaneId: string | undefined }> {
    const created = JSON.parse(
      await this.asyncRunner(["tab", "create", "--cwd", cwd, "--label", name, "--no-focus"]),
    );
    const tabId: string | undefined = created?.result?.tab?.tab_id;
    if (!tabId) throw new Error(`herdr: tab create returned no tab_id for ${name}`);
    const rootPaneId: string | undefined = created?.result?.root_pane?.pane_id;
    return { tabId, rootPaneId };
  }

  /**
   * herdr 0.7.5 (protocol 17) spawn via EXTERNAL REGISTRATION (#1890). `agent start --kind` can't
   * express Shepherd's `env`-shim + `bwrap` argv wrap, so instead: `tab create` → run the wrapped
   * argv in the tab's root pane once its shell is ready → register the agent
   * (`report-agent-session` + `report-agent`) so `agent list` surfaces it (the membrane's
   * `--unshare-pid` hides `claude` from herdr's passive detection) → resolve the started `HerdrAgent`
   * from the live list by `pane_id`. Preserves the dedicated-tab + `TabLedger` teardown semantics of
   * the ≤0.7.4 path; the wrapped argv (`buildWrappedArgv`) flows into `pane run` byte-identically.
   * Unlike the ≤0.7.4 path there is NO leftover shell pane to close — `pane run` reuses the tab's
   * root pane as the agent pane.
   */
  private async startImpl075(
    name: string,
    cwd: string,
    argv: string[],
    env?: Record<string, string>,
  ): Promise<HerdrAgent> {
    await this.ensureWorkspace(cwd);
    // Dedicated full-width tab per agent (same rationale as the ≤0.7.4 path). No --env: the wrapped
    // argv carries every env var itself (the `env …` shim, or bwrap `--setenv`), so the shell pane's
    // own environment is irrelevant to the launched process.
    const { tabId, rootPaneId } = await this.createDedicatedTab(name, cwd);

    // The tab already exists, so on ANY post-create failure we must close it — otherwise it lingers
    // forever as an empty husk. (Mirrors the ≤0.7.4 rollback.) A missing root pane is such a failure,
    // so it is checked INSIDE the try to get the same rollback.
    try {
      // On 0.7.5 the tab's root pane IS the agent pane (`pane run` reuses it) — not a leftover to
      // close, so a missing one is fatal.
      const paneId = rootPaneId;
      if (!paneId) throw new Error(`herdr: tab create returned no root pane for ${name}`);
      const wrapped = buildWrappedArgv(argv, env);
      await this.runInReadyPane(paneId, wrapped);
      const agentName = sanitizeHerdrAgentName(name);
      await this.registerAgentWithCollisionRetry(paneId, agentName);
      // There is no `agent_started` reply on 0.7.5 — resolve the freshly-registered agent from the
      // live list, joining on the pane_id we ran in. Its terminal_id is the id Shepherd keys on.
      const agent = (await this.listAsync()).find((a) => a.paneId === paneId);
      if (!agent || !agent.terminalId) {
        throw new Error(`herdr: agent list has no registered agent for pane ${paneId} (${name})`);
      }
      // Retain the authoritative spawn handle (#1852): the tab is ours even if the process inside
      // dies before it next appears in `agent list`.
      this.ledger.record(agent.terminalId, tabId, name);
      return agent;
    } catch (err) {
      await this.closeTab(tabId); // roll back the orphan tab before propagating
      throw err;
    }
  }

  /**
   * Run `wrapped` in `paneId` once its shell is ready. Readiness is guaranteed by a bounded retry of
   * `pane run` itself, retrying on ANY failure — deliberately name-independent so it does not hinge
   * on herdr's exact busy-error code or prompt string (both unverified). No sleep between attempts:
   * each failed `pane run` is a real herdr round-trip, which provides the spacing (same rationale as
   * the ≤0.7.4 collision retry). A `pane run` that reaches the shell either launches the command or
   * rejects before executing, so a retry never double-launches. CLI quirk: the `pane_id` positional
   * precedes any flags — here it precedes the command argv.
   */
  private async runInReadyPane(paneId: string, wrapped: string[]): Promise<void> {
    const MAX_ATTEMPTS = 3;
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        await this.asyncRunner(["pane", "run", paneId, ...wrapped]);
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error(`herdr: pane run failed for pane ${paneId}`);
  }

  /**
   * Register an externally-launched agent so `agent list` surfaces it: `pane report-agent-session`
   * (establishes the agent session) then `pane report-agent --state working` (sets its live state).
   * Both take the `pane_id` positional BEFORE the flags (CLI quirk). Bounded retry mirrors the
   * ≤0.7.4 name-collision breaker but at the REGISTER step — on 0.7.5 the `--agent` name is bound
   * here, not at spawn, and our tab/pane/`claude` are already live — so a collision re-runs ONLY the
   * register pair (never tab-create/pane-run) after evicting same-named squatters. Whether
   * `report-agent(-session)` even emits `agent_name_taken` is unverified; because `agentName` is
   * sanitized AND de-duped upstream (`uniqueName`) and each spawn registers a freshly-created pane, a
   * real collision is expected to be rare/absent, and the retry collapses to a single pass otherwise.
   */
  private async registerAgentWithCollisionRetry(paneId: string, agentName: string): Promise<void> {
    // Opaque per-pane associator: claude's own session id is unknown at spawn, and herdr only echoes
    // this back on the agent record — keeping agent_status fresh via a real session id is a separate
    // child (#1889). Stable + unique per spawn (one pane per spawn).
    const agentSessionId = `shepherd-${paneId}`;
    const MAX_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        await this.asyncRunner([
          "pane",
          "report-agent-session",
          paneId,
          "--source",
          "shepherd",
          "--agent",
          agentName,
          "--agent-session-id",
          agentSessionId,
        ]);
        await this.asyncRunner([
          "pane",
          "report-agent",
          paneId,
          "--source",
          "shepherd",
          "--agent",
          agentName,
          "--state",
          "working",
        ]);
        return;
      } catch (err) {
        if (!isNameTakenError(err) || attempt === MAX_ATTEMPTS - 1) throw err;
        // Evict squatter(s) by name — never by regex-parsing the error string — then re-run the
        // register pair against our existing pane.
        const squatters = (await this.listAsync()).filter((a) => a.name === agentName);
        for (const sq of squatters) await this.closeTab(sq.tabId);
      }
    }
  }

  private async startImpl(
    name: string,
    cwd: string,
    argv: string[],
    env?: Record<string, string>,
  ): Promise<HerdrAgent> {
    // herdr needs an active workspace before any tab can be created — guarantee one.
    await this.ensureWorkspace(cwd);
    // a fresh tab opens with an empty shell pane; `agent start --tab` splits it, so
    // we close that leftover pane afterward to leave the agent as the sole pane
    const { tabId, rootPaneId } = await this.createDedicatedTab(name, cwd);

    // `agent start` can fail (e.g. name-taken exhaustion). The tab already exists, so on
    // failure we must close it — otherwise it lingers forever as an empty husk with no
    // claude in it.
    try {
      // Byte-identical spawn to the socket path — see `buildWrappedArgv`.
      const wrapped = buildWrappedArgv(argv, env);
      // Collision-breaker: if herdr rejects with `agent_name_taken` (a stale same-named
      // agent is still registered — e.g. shepherd restarted while an interactive `claude`
      // was running), resolve the squatter(s) by name from `list()`, close their tabs
      // (which both kills the orphan via --die-with-parent and synchronously releases the
      // name), then retry. Bounded at 3 total attempts.
      // Capture the authoritative handle before root-pane cleanup: a fast role can already be
      // absent from agent.list, and closing the remaining shell pane can remove the whole tab.
      const agent = await this.startAgentWithCollisionRetry(name, tabId, cwd, wrapped);
      // Retain the authoritative spawn handle (#1852): the tab exists and is ours even
      // if the process inside dies before it ever appears in `agent list`.
      this.ledger.record(agent.terminalId, tabId, name);

      if (rootPaneId && !isHeadlessCodexExec(argv)) {
        try {
          await this.asyncRunner(["pane", "close", rootPaneId]);
        } catch {
          /* best-effort: agent still runs if the shell pane lingers, just at split width */
        }
      }

      return agent;
    } catch (err) {
      await this.closeTab(tabId); // roll back the orphan tab before propagating
      throw err;
    }
  }

  /**
   * Map a session `terminal_id` to the target the current herdr wants for read/send/relabel. ≤0.7.4:
   * identity (`terminal_id` is the target). 0.7.5: the `pane_id` — `terminal_id`/label are rejected
   * as `agent_not_found` (#1890) — resolved from a fresh `agent list`. Returns null on 0.7.5 when the
   * agent is gone (no live pane), so callers can no-op/throw rather than issue a doomed CLI call.
   */
  private async resolveTargetAsync(terminalId: string): Promise<string | null> {
    if (!herdrUsesExternalRegistrationSpawn()) return terminalId;
    return resolvePaneId(await this.listAsync(), terminalId);
  }

  /** Sync sibling of {@link resolveTargetAsync} for the sync `read` (uses the sync `list()`). */
  private resolveTargetSync(terminalId: string): string | null {
    if (!herdrUsesExternalRegistrationSpawn()) return terminalId;
    return resolvePaneId(this.list(), terminalId);
  }

  /**
   * Write literal text to an agent's PTY (no implicit Enter). Async since #1567 — spawns via
   * `asyncRunner` so a steer never blocks Bun's loop, matching the other async writes. On 0.7.5 the
   * write goes through `pane send-text` / `pane send-keys` against the resolved `pane_id`
   * (`agent send` returns `agent_not_ready` on a registered-but-undetected sandboxed agent — #1890);
   * `send` is never best-effort, so a gone pane throws rather than silently dropping the steer.
   */
  async send(target: string, text: string): Promise<void> {
    if (!herdrUsesExternalRegistrationSpawn()) {
      await this.asyncRunner(["agent", "send", target, text]);
      return;
    }
    const paneId = resolvePaneId(await this.listAsync(), target);
    if (!paneId) throw new Error(`herdr: no live pane for terminal ${target} (send)`);
    const write = classifyPaneWrite(text);
    await this.asyncRunner(
      write.kind === "keys"
        ? ["pane", "send-keys", paneId, ...write.keys]
        : ["pane", "send-text", paneId, write.text],
    );
  }

  /** The `agent read` argv shared by the sync and async readers. */
  private readArgs(target: string, source: "visible" | "recent", lines: number): string[] {
    return [
      "agent",
      "read",
      target,
      "--format",
      "text",
      "--source",
      source,
      "--lines",
      String(lines),
    ];
  }

  /** Extract the buffer text from a herdr `agent read` reply (raw output on a parse miss). */
  private parseRead(out: string): string {
    try {
      return parseReadText(JSON.parse(out)?.result);
    } catch {
      return out;
    }
  }

  /** Read an agent's terminal buffer as plain text (default: the visible viewport). On 0.7.5 the
   *  same `agent read` command targets the resolved `pane_id` (#1890); a gone pane reads as `""`. */
  read(target: string, source: "visible" | "recent" = "visible", lines = 200): string {
    const resolved = this.resolveTargetSync(target);
    if (resolved === null) return "";
    return this.parseRead(this.runner(this.readArgs(resolved, source, lines)));
  }

  /**
   * Async sibling of `read` — same args/timeout/maintenance guard, but spawns via
   * `promisify(execFile)` so it never blocks Bun's single loop. Use this from the
   * poll loop (the poller reads the visible buffer for EVERY running agent every
   * probe cadence in the interim heartbeat path); the sync `read` would freeze the
   * live web terminal under that fan-out.
   */
  async readAsync(
    target: string,
    source: "visible" | "recent" = "visible",
    lines = 200,
  ): Promise<string> {
    const resolved = await this.resolveTargetAsync(target);
    if (resolved === null) return "";
    return this.parseRead(await this.asyncRunner(this.readArgs(resolved, source, lines)));
  }

  /**
   * Best-effort teardown of the agent backing a terminal id. Closes the agent's whole
   * TAB, not just its pane: every agent gets its own dedicated tab, so closing only the
   * pane left an empty husk tab behind. For a spawn this driver started, the tab recorded
   * at `start()` is the NORMAL path — verified against the live tab list and closed
   * directly, with no dependency on the agent still being present in `agent list` (an
   * exited helper vanishes from that list while its husk tab persists — the #1852 leak).
   * Unknown handles fall back to the fresh agent-list resolution; a full miss warns
   * instead of silently no-oping. See {@link stopViaRecordedTab}.
   */
  async stop(terminalId: string): Promise<void> {
    await stopViaRecordedTab(this, this.ledger, terminalId);
  }

  /**
   * Rename a live agent and its dedicated tab so a background re-name (the LLM namer)
   * is reflected in the herdr UI, not just shepherd's DB. Resolves the agent (and its
   * tabId) FRESH from the live list by terminal id — the live list is the source of truth;
   * a cached tabId may be stale. Best-effort: a dead/already-renamed agent must never
   * crash the caller, so every step is guarded.
   */
  async relabel(terminalId: string, newName: string): Promise<void> {
    let agent;
    try {
      agent = (await this.listAsync()).find((a) => a.terminalId === terminalId);
    } catch {
      return;
    }
    if (!agent) return;
    // 0.7.5: `agent rename` must target the pane_id and the agent label must satisfy herdr's name
    // grammar (#1890). ≤0.7.4: byte-identical — target the terminal_id with the raw name. The TAB
    // rename below always uses the raw, human-facing label (tab labels are unconstrained).
    const external = herdrUsesExternalRegistrationSpawn();
    const renameTarget = external ? agent.paneId : terminalId;
    const agentLabel = external ? sanitizeHerdrAgentName(newName) : newName;
    if (renameTarget) {
      try {
        await this.asyncRunner(["agent", "rename", renameTarget, agentLabel]);
      } catch {
        /* best-effort */
      }
    }
    if (agent.tabId) {
      try {
        await this.asyncRunner(["tab", "rename", agent.tabId, newName]);
        // Mirror the successful TAB rename so the ledger label keeps matching the live
        // tab (the stop() fallback refuses to close on a label mismatch, #1852).
        this.ledger.relabel(terminalId, newName);
      } catch {
        /* best-effort */
      }
    }
  }

  /** Best-effort: close a tab by id (takes its panes + any agent down with it). */
  async closeTab(tabId: string): Promise<void> {
    try {
      await this.asyncRunner(["tab", "close", tabId]);
    } catch {
      /* best-effort; tab may already be gone */
    }
  }
}
