import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { execFileSync } from "./instrument";
import { config } from "./config";
import { maintenance } from "./maintenance";
import { compileCacheDir } from "./tmp-sweep";
import type { HerdrState, SessionStatus } from "./types";

const execFileAsync = promisify(execFile);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
    const byName = byCwd.filter((a) => a.name === s.name);
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
  const byName = candidates.filter((c) => c.cwd === s.worktreePath && c.name === s.name);
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
  return agents.map((a: Record<string, string>) => ({
    agent: a.agent ?? "",
    agentStatus: (a.agent_status ?? "unknown") as HerdrState,
    // `noUncheckedIndexedAccess` widens Record<string,string> indexing to `| undefined`;
    // `?? ""` keeps these required-string fields honest without changing the intent of
    // the original (untyped) mapping — herdr always supplies them in practice.
    cwd: a.cwd ?? "",
    name: a.name ?? "",
    paneId: a.pane_id ?? "",
    tabId: a.tab_id ?? "",
    terminalId: a.terminal_id ?? "",
    workspaceId: a.workspace_id ?? "",
  }));
}

/** Maps a `tab list` reply to `HerdrTab[]`. Shared by the sync `tabs()` and async
 *  `tabsAsync()` so both parse the `result.tabs[]` shape identically. */
export function parseTabs(parsed: unknown): HerdrTab[] {
  const tabs = (parsed as { result?: { tabs?: Record<string, string>[] } })?.result?.tabs ?? [];
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
 * `parseAgents`' per-item map. The socket `start` (issue #1553) resolves its started
 * agent straight from this reply — `agent_started.agent` carries `terminal_id`/`tab_id`/…
 * directly (confirmed against live herdr 0.7.3), so it needs no post-start re-list, unlike
 * the CLI path whose `agent start` output exposes no terminal id.
 */
export function parseAgentInfo(agent: unknown): HerdrAgent {
  const a = (agent ?? {}) as Record<string, string>;
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
 */
export function buildWrappedArgv(argv: string[], env?: Record<string, string>): string[] {
  const envTokens = env
    ? Object.entries(env)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
    : [];
  const callerSetRenderer =
    !!env && ("CLAUDE_CODE_NO_FLICKER" in env || "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN" in env);
  return [
    "env",
    `NODE_COMPILE_CACHE=${compileCacheDir()}`,
    ...(callerSetRenderer ? [] : ["CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1"]),
    ...envTokens,
    ...argv,
  ];
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
 * Public method surface of `HerdrDriver`, extracted so the socket-backed
 * driver (`SocketHerdrDriver`, issue #1529) implements the same contract behind the existing seam —
 * callers keep using `Pick<HerdrDriver, …>` today; nothing about them changes.
 */
export interface IHerdrDriver {
  list(): HerdrAgent[];
  /** Non-blocking sibling of `list()` — see `HerdrDriver.listAsync`. */
  listAsync(): Promise<HerdrAgent[]>;
  tabs(): HerdrTab[];
  panes(): HerdrPane[];
  paneForegroundProcs(paneId: string): Promise<string[]>;
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

  constructor(
    private runner: Runner = defaultRunner,
    private asyncRunner: AsyncRunner = defaultAsyncRunner,
    // Read-back retry knobs (issue: reviewer-spawn resolve race). `agent start` returning
    // does not guarantee the agent is in `agent list` yet — a short registration lag. Poll
    // a few times before giving up; injectable so tests run without real delay.
    private resolveAttempts = 5,
    private resolveDelayMs = 100,
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
    return parseTabs(JSON.parse(this.runner(["tab", "list"])));
  }

  /** Async sibling of `tabs()` — same shape via `asyncRunner` so it never blocks the loop.
   *  Used by resolveStartedAgent to tell a genuine spawn failure (tab gone) from a role
   *  `exec` that already exited or a lagging registration (tab husk still present). */
  async tabsAsync(): Promise<HerdrTab[]> {
    return parseTabs(JSON.parse(await this.asyncRunner(["tab", "list"])));
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
  ): Promise<void> {
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
        await this.asyncRunner(agentStartArgs);
        return;
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
    // The workspace/tab orchestration is serialized (concurrent spawns must not race it);
    // it returns the freshly-created tab id. The read-back that resolves the started agent
    // is a pure `agent list` read, so it runs OUTSIDE the serializer — a retry there must
    // not hold the start mutex, or it would stall every other queued spawn. Roll back the
    // orphan tab if the agent never registers.
    const tabId = await this.serializeStart(() => this.startImpl(name, cwd, argv, env));
    try {
      return await this.resolveStartedAgent(tabId, cwd);
    } catch (err) {
      await this.closeTab(tabId);
      throw err;
    }
  }

  /** Resolve the just-started agent from `agent list`, matching the unique tab we created
   *  for it (`tabId`) — deterministic, unlike the old cwd match (two sessions sharing a cwd
   *  could alias). The CLI `agent start` output exposes no terminal id, so a list read is the
   *  only handle for a LIVE agent. Poll a bounded number of times for a registration lag.
   *
   *  A miss is NOT automatically a failure. `agent start` returning without throwing means the
   *  spawn happened; a non-interactive role spawn (`codex exec`) runs to completion and EXITS,
   *  which drops it from `agent list` while its tab husk lingers (`tab list`), and under load a
   *  live agent's registration can lag past the poll window. Either way the review already ran
   *  (or is running) and may have written its verdict — treating that as `error-spawn` would
   *  wrongly delete its worktree. So on exhaustion decide by TAB existence, not agent liveness:
   *    - tab still present ⇒ started; return a handle with an EMPTY terminal id (a completed
   *      exec has no live terminal; `herdr.stop("")` is a safe no-op and callers re-derive a
   *      live terminal by cwd where needed; the husk is reaped by the hourly orphan-tab sweep).
   *      Do NOT close the tab here — a running-but-unregistered agent would be killed.
   *    - tab gone ⇒ genuine failure (herdr never kept the tab) ⇒ throw.
   *  The socket driver reads terminal_id straight from the `agent.start` reply and needs none of this. */
  private async resolveStartedAgent(tabId: string, cwd: string): Promise<HerdrAgent> {
    for (let attempt = 0; attempt < this.resolveAttempts; attempt++) {
      const match = (await this.listAsync()).find((a) => a.tabId === tabId);
      if (match) return match;
      if (attempt < this.resolveAttempts - 1) await sleep(this.resolveDelayMs);
    }
    if ((await this.tabsAsync()).some((t) => t.tabId === tabId)) {
      console.warn(
        `[herdr] agent not in list but tab ${tabId} present — treating exec spawn as started (cwd ${cwd})`,
      );
      return {
        agent: "",
        agentStatus: "done",
        cwd,
        name: "",
        paneId: "",
        tabId,
        terminalId: "",
        workspaceId: "",
      };
    }
    console.warn(
      `[herdr] agent resolve exhausted and tab ${tabId} gone after ${this.resolveAttempts} attempts (cwd ${cwd})`,
    );
    throw new Error(`herdr: started agent not found and tab gone for tab ${tabId} (cwd ${cwd})`);
  }

  private async startImpl(
    name: string,
    cwd: string,
    argv: string[],
    env?: Record<string, string>,
  ): Promise<string> {
    // herdr needs an active workspace before any tab can be created — guarantee one.
    await this.ensureWorkspace(cwd);
    // Give each agent its OWN tab so its pane spans the full herdr window width.
    // `agent start` with no --tab splits the active tab, so agents pile up as
    // side-by-side panes each ~window/N wide — and that split-fixed width (not the
    // browser's attach size) is what the PTY renders at, so the HUD terminal comes
    // out tall-and-narrow and resizing the browser can't widen it. A dedicated tab
    // keeps every agent full-width regardless of how many are running.
    const created = JSON.parse(
      await this.asyncRunner(["tab", "create", "--cwd", cwd, "--label", name, "--no-focus"]),
    );
    const tabId: string | undefined = created?.result?.tab?.tab_id;
    // a fresh tab opens with an empty shell pane; `agent start --tab` splits it, so
    // we close that leftover pane afterward to leave the agent as the sole pane
    const rootPaneId: string | undefined = created?.result?.root_pane?.pane_id;
    if (!tabId) throw new Error(`herdr: tab create returned no tab_id for ${name}`);

    // `agent start` can fail (e.g. name-taken exhaustion). The tab already exists, so on
    // failure we must close it — otherwise it lingers forever as an empty husk with no
    // claude in it. The read-back that resolves the agent runs in start() (outside the
    // serializer); its own rollback lives there.
    try {
      // Byte-identical spawn to the socket path — see `buildWrappedArgv`.
      const wrapped = buildWrappedArgv(argv, env);
      // Collision-breaker: if herdr rejects with `agent_name_taken` (a stale same-named
      // agent is still registered — e.g. shepherd restarted while an interactive `claude`
      // was running), resolve the squatter(s) by name from `list()`, close their tabs
      // (which both kills the orphan via --die-with-parent and synchronously releases the
      // name), then retry. Bounded at 3 total attempts.
      await this.startAgentWithCollisionRetry(name, tabId, cwd, wrapped);

      if (rootPaneId) {
        try {
          await this.asyncRunner(["pane", "close", rootPaneId]);
        } catch {
          /* best-effort: agent still runs if the shell pane lingers, just at split width */
        }
      }

      return tabId;
    } catch (err) {
      await this.closeTab(tabId); // roll back the orphan tab before propagating
      throw err;
    }
  }

  /** Write literal text to an agent's PTY (no implicit Enter). Async since #1567 — spawns via
   *  `asyncRunner` so a steer never blocks Bun's loop, matching the other async writes. */
  async send(target: string, text: string): Promise<void> {
    await this.asyncRunner(["agent", "send", target, text]);
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

  /** Read an agent's terminal buffer as plain text (default: the visible viewport). */
  read(target: string, source: "visible" | "recent" = "visible", lines = 200): string {
    return this.parseRead(this.runner(this.readArgs(target, source, lines)));
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
    return this.parseRead(await this.asyncRunner(this.readArgs(target, source, lines)));
  }

  /**
   * Best-effort teardown of the agent backing a terminal id. Closes the agent's whole
   * TAB, not just its pane: every agent gets its own dedicated tab, so closing only the
   * pane left an empty husk tab behind. Resolves `terminalId → current tabId` FRESH from
   * the live list — the live list is the source of truth; the agent may have ended or been
   * relabeled, so a cached tabId may be stale. Under herdr 0.7 an exited agent persists as
   * a husk that retains its terminalId, so stop() still finds and closes its tab. The no-op
   * path fires only when the pane is truly gone from the list; the orphan sweep handles any
   * residue in that case.
   */
  async stop(terminalId: string): Promise<void> {
    const agent = (await this.listAsync()).find((a) => a.terminalId === terminalId);
    if (!agent?.tabId) return;
    await this.closeTab(agent.tabId);
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
    try {
      await this.asyncRunner(["agent", "rename", terminalId, newName]);
    } catch {
      /* best-effort */
    }
    if (agent.tabId) {
      try {
        await this.asyncRunner(["tab", "rename", agent.tabId, newName]);
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
