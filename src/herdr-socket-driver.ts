import { HerdrSocketClient } from "./herdr-socket-client";
import {
  HerdrDriver,
  HerdrSpawnUnsupportedError,
  TabLedger,
  buildWrappedArgv,
  classifyPaneWrite,
  createSerializer,
  isHeadlessCodexExec,
  isNameTakenError,
  parseAgentInfo,
  parseAgents,
  parseProcs,
  parseReadText,
  parseTabs,
  posixShellJoin,
  resolvePaneId,
  sanitizeHerdrAgentName,
  stopViaRecordedTab,
  type HerdrAgent,
  type HerdrTab,
  type IHerdrDriver,
} from "./herdr";
import type { RequestPaneAgentState } from "./generated/herdr-protocol";
import { config, HERDR_SOCKET_SUPPORTED_PROTOCOLS } from "./config";
import {
  detectedHerdrVersion,
  herdrSpawnSupported,
  herdrUsesExternalRegistrationSpawn,
} from "./herdr-capabilities";

/**
 * Socket-backed `IHerdrDriver` (issues #1529, #1553, #1567): routes the async read surface —
 * `listAsync`/`readAsync`/`paneForegroundProcs` (#1529) — and the entire async write surface —
 * `start`/`stop`/`relabel`/`closeTab` (#1553) plus `send` (#1567) — over herdr's Unix-socket
 * JSON-RPC transport (`HerdrSocketClient`, one connection per request), avoiding a CLI spawn
 * per call.
 *
 * Only the sync `list`/`read`/`tabs`/`panes` still delegate to a wrapped `HerdrDriver`, and
 * deliberately: a sync method can't be socket-backed without reintroducing event-loop blocking
 * (a fake-sync wait on a promise); the socket only helps async callers.
 */
export class SocketHerdrDriver implements IHerdrDriver {
  /** Serializes `start` so concurrent spawns can't race the workspace/tab orchestration
   *  across the socket round-trips' async yield points (issue #1553). */
  private serializeStart = createSerializer();

  /** Spawn-handle registry: authoritative tabId per started terminalId (#1852). Owned
   *  here, not shared with the wrapped CLI driver — all starts/stops route through
   *  this driver when the socket transport is active. */
  private ledger = new TabLedger();

  constructor(
    private client: HerdrSocketClient,
    private cli: HerdrDriver,
    /** Injectable delay for the trusted-spawn auto-detect poll; overridden in tests to run instantly. */
    private sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms).unref?.()),
  ) {}

  // ── Socket-backed async reads ────────────────────────────────────────────

  async listAsync(): Promise<HerdrAgent[]> {
    return parseAgents(await this.client.request("agent.list", {}));
  }

  async readAsync(
    target: string,
    source: "visible" | "recent" = "visible",
    lines = 200,
  ): Promise<string> {
    // 0.7.5 addresses reads by pane_id (terminal_id/label are rejected as agent_not_found — #1890);
    // ≤0.7.4 is identity. A gone pane resolves to null → "" (matches the CLI readAsync).
    const resolved = await this.resolveTarget(target);
    if (resolved === null) return "";
    return parseReadText(
      await this.client.request("agent.read", { target: resolved, source, lines, format: "text" }),
    );
  }

  /**
   * Map a session `terminal_id` to the target the current herdr wants for read/rename. ≤0.7.4:
   * identity. 0.7.5: the agent's `pane_id`, resolved from a fresh `agent list` (null when the pane
   * is gone, so callers can no-op). Mirrors `HerdrDriver.resolveTargetAsync`.
   */
  private async resolveTarget(terminalId: string): Promise<string | null> {
    if (!herdrUsesExternalRegistrationSpawn()) return terminalId;
    return resolvePaneId(await this.listAsync(), terminalId);
  }

  /**
   * A rejected `request()` (socket/herdr error) propagates — matches the CLI
   * `paneForegroundProcs` contract, where callers must distinguish a shell-only pane
   * (`["zsh"]`) from a genuinely failed lookup. `parseProcs` already returns `[]` for a
   * well-formed-but-empty reply, so no separate empty-case handling is needed here.
   */
  async paneForegroundProcs(paneId: string): Promise<string[]> {
    return parseProcs(await this.client.request("pane.process_info", { pane_id: paneId }));
  }

  /** Socket-backed async tab list — feeds the recorded-tab verification in `stop()` (#1852). */
  async tabsAsync(): Promise<HerdrTab[]> {
    return parseTabs(await this.client.request("tab.list", {}));
  }

  // ── Delegated to the CLI driver (unchanged) ──────────────────────────────

  list(): HerdrAgent[] {
    return this.cli.list();
  }

  tabs() {
    return this.cli.tabs();
  }

  panes() {
    return this.cli.panes();
  }

  read(target: string, source: "visible" | "recent" = "visible", lines = 200): string {
    return this.cli.read(target, source, lines);
  }

  // ── Socket-backed async writes (issues #1553, #1567) ─────────────────────

  /**
   * Write literal text to an agent's PTY (issue #1567). A rejected `request()` propagates —
   * `send` has never been best-effort: `haltAll` catches per-agent so one dead pane can't abort
   * the e-stop sweep, and a failed steer must report "not delivered" rather than silently drop.
   * Deliberately NOT serialized here: ordering a multi-send sequence is the caller's contract
   * (`SessionService.sendSteerTo` serializes its bracket-paste + CR pair), and serializing at the
   * driver would also stall unrelated panes behind a slow one.
   */
  async send(target: string, text: string): Promise<void> {
    if (!herdrUsesExternalRegistrationSpawn()) {
      // ≤0.7.4: `agent.send` was removed from the vendored protocol-17 types (replaced by
      // `agent.send_keys`) but is still valid on a live ≤0.7.4 server, so reach it via the legacy
      // escape — keeps the ≤p16 wire behavior byte-identical. See `HerdrSocketClient.requestLegacy`.
      await this.client.requestLegacy("agent.send", { target, text });
      return;
    }
    // 0.7.5: `agent.send` returns `agent_not_ready` on a registered-but-undetected sandboxed agent,
    // so write to the resolved `pane_id` via `pane.send_text` / `pane.send_keys` (mirrors the CLI
    // `send`). Never best-effort: a gone pane throws rather than silently dropping the steer.
    const paneId = resolvePaneId(await this.listAsync(), target);
    if (!paneId) throw new Error(`herdr: no live pane for terminal ${target} (send)`);
    const write = classifyPaneWrite(text);
    if (write.kind === "keys") {
      await this.client.request("pane.send_keys", { pane_id: paneId, keys: write.keys });
    } else {
      await this.client.request("pane.send_text", { pane_id: paneId, text: write.text });
    }
  }

  /**
   * Spawn an agent over the socket, mirroring `HerdrDriver.start`'s orchestration:
   * ensure a workspace → create a dedicated tab → `agent.start` (with collision-retry) →
   * close the leftover shell pane → resolve the `HerdrAgent`. As on the CLI path, the
   * `agent.start` reply carries the started agent's full `AgentInfo` (terminal_id/tab_id/…),
   * so no post-start re-list is needed. Serialized to preserve start atomicity.
   */
  start(
    name: string,
    cwd: string,
    argv: string[],
    env?: Record<string, string>,
  ): Promise<HerdrAgent> {
    // Same unsupported-herdr guard as the CLI driver (defensive: the socket only activates on a
    // supported protocol, but the version ceiling is the source of truth). See #1889.
    if (!herdrSpawnSupported()) throw new HerdrSpawnUnsupportedError(detectedHerdrVersion());
    return this.serializeStart(() =>
      // 0.7.5 (protocol 17) can't launch the wrapped argv through `agent.start`; use the
      // external-registration path instead (#1892), mirroring `HerdrDriver.startImpl075`.
      // ≤0.7.4 keeps the legacy `agent.start` path.
      herdrUsesExternalRegistrationSpawn()
        ? this.startImpl075(name, cwd, argv, env)
        : this.startImpl(name, cwd, argv, env),
    );
  }

  /**
   * herdr 0.7.5 (protocol 17) spawn via EXTERNAL REGISTRATION — the socket sibling of
   * `HerdrDriver.startImpl075` (#1892). `agent.start` can't express Shepherd's `env`-shim + `bwrap`
   * argv wrap, so instead: `tab.create` → run the wrapped argv in the tab's root pane → register the
   * agent (`pane.report_agent_session` + `pane.report_agent`) so `agent.list` surfaces it → resolve
   * the started `HerdrAgent` from the live list by `pane_id`. Preserves the dedicated-tab +
   * `TabLedger` teardown semantics of the ≤0.7.4 path; the wrapped argv flows in byte-identically.
   * Unlike the ≤0.7.4 path there is NO leftover shell pane to close — the run reuses the root pane.
   */
  private async startImpl075(
    name: string,
    cwd: string,
    argv: string[],
    env?: Record<string, string>,
  ): Promise<HerdrAgent> {
    await this.ensureWorkspace(cwd);
    const created = await this.client.request("tab.create", { cwd, label: name, focus: false });
    const tabId = created?.tab?.tab_id;
    const rootPaneId = created?.root_pane?.pane_id;
    if (!tabId) throw new Error(`herdr: tab.create returned no tab_id for ${name}`);

    // The tab already exists, so on ANY post-create failure we must close it (mirrors the ≤0.7.4
    // rollback). A missing root pane is such a failure — on 0.7.5 that pane IS the agent pane.
    try {
      if (!rootPaneId) throw new Error(`herdr: tab.create returned no root pane for ${name}`);
      await this.runInReadyPane(rootPaneId, buildWrappedArgv(argv, env));
      // Sandboxed spawns (bwrap in argv) hide `claude` from herdr's detection → must be externally
      // registered + Shepherd-owned. Trusted spawns are auto-detected by herdr → register nothing and
      // let herdr own the status (≤0.7.4 parity); a register/pin would freeze it. Mirrors
      // `HerdrDriver.startImpl075`.
      const sandboxed = argv.includes("bwrap");
      const agent = sandboxed
        ? await this.resolveByRegistration(rootPaneId, sanitizeHerdrAgentName(name))
        : await this.resolveByAutoDetect(rootPaneId, name);
      // Retain the authoritative spawn handle (#1852) — the tab is ours even if the process inside
      // dies before it next appears in `agent.list`.
      this.ledger.record(agent.terminalId, tabId, name);
      return agent;
    } catch (err) {
      await this.closeTab(tabId); // roll back the orphan tab before propagating
      throw err;
    }
  }

  /** Sandboxed resolve: externally register (surfaces the bwrap'd agent + establishes Shepherd's
   *  lifecycle authority) then resolve from the live list. Socket sibling of the CLI driver's. */
  private async resolveByRegistration(paneId: string, agentName: string): Promise<HerdrAgent> {
    await this.registerAgentWithCollisionRetry(paneId, agentName);
    const agent = (await this.listAsync()).find((a) => a.paneId === paneId);
    if (!agent || !agent.terminalId) {
      throw new Error(
        `herdr: agent list has no registered agent for pane ${paneId} (${agentName})`,
      );
    }
    return agent;
  }

  /** Trusted resolve: register nothing; wait (bounded) for herdr's own detection to surface the
   *  agent, handing it full status ownership (≤0.7.4 parity). Socket sibling of the CLI driver's. */
  private async resolveByAutoDetect(paneId: string, name: string): Promise<HerdrAgent> {
    const DEADLINE_MS = 30_000;
    const POLL_MS = 500;
    for (let waited = 0; waited <= DEADLINE_MS; waited += POLL_MS) {
      const agent = (await this.listAsync()).find((a) => a.paneId === paneId);
      if (agent?.terminalId) return agent;
      await this.sleep(POLL_MS);
    }
    throw new Error(`herdr: agent for pane ${paneId} (${name}) not auto-detected within 30s`);
  }

  /**
   * Launch `wrapped` in `paneId`'s shell. herdr's protocol-17 socket API exposes NO direct pane-run
   * RPC (unlike the CLI `pane run`, #1892), so the wrapped argv is TYPED into the pane's ready shell
   * as a POSIX-quoted command line (`pane.send_text`) then submitted with Enter (`pane.send_keys`).
   * `send_text` is bounded-retried on ANY failure to ride out shell-not-ready without hinging on an
   * unverified busy-error code: a rejected `send_text` means herdr didn't write it, so a retry never
   * double-types (mirrors the CLI `runInReadyPane` reject-before-exec contract). The Enter is sent
   * once, OUTSIDE that loop, so a delivered command is never re-typed. NOTE: this routes through the
   * interactive shell rather than a direct exec — the per-token quoting keeps it robust; only the
   * 0.7.5 socket spawn path (default-off) reaches it.
   */
  private async runInReadyPane(paneId: string, wrapped: string[]): Promise<void> {
    const cmdline = posixShellJoin(wrapped);
    const MAX_ATTEMPTS = 3;
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        await this.client.request("pane.send_text", { pane_id: paneId, text: cmdline });
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) throw lastErr;
    await this.client.request("pane.send_keys", { pane_id: paneId, keys: ["Enter"] });
  }

  /**
   * Register an externally-launched agent so `agent.list` surfaces it — the socket sibling of
   * `HerdrDriver.registerAgentWithCollisionRetry`: `pane.report_agent_session` (establishes the
   * agent session) then `pane.report_agent` (`state: "working"`). Bounded collision-retry at the
   * REGISTER step: the `agent` name is bound here, and our tab/pane are already live, so a
   * collision re-runs ONLY the register pair after evicting same-named squatters (never
   * tab-create/pane-run). The opaque per-pane `agent_session_id` (`shepherd-<paneId>`) is stable +
   * unique per spawn (one pane per spawn).
   */
  private async registerAgentWithCollisionRetry(paneId: string, agentName: string): Promise<void> {
    const agentSessionId = `shepherd-${paneId}`;
    const MAX_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        await this.client.request("pane.report_agent_session", {
          pane_id: paneId,
          source: "shepherd",
          agent: agentName,
          agent_session_id: agentSessionId,
        });
        await this.client.request("pane.report_agent", {
          pane_id: paneId,
          source: "shepherd",
          agent: agentName,
          state: "working",
        });
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
    await this.ensureWorkspace(cwd);
    const created = await this.client.request("tab.create", { cwd, label: name, focus: false });
    const tabId = created?.tab?.tab_id;
    const rootPaneId = created?.root_pane?.pane_id;
    if (!tabId) throw new Error(`herdr: tab.create returned no tab_id for ${name}`);

    // The tab already exists, so on ANY post-create failure we must close it — otherwise it
    // lingers forever as an empty husk with no agent in it.
    try {
      const agent = await this.startAgentWithCollisionRetry(
        name,
        tabId,
        cwd,
        buildWrappedArgv(argv, env),
      );
      const started = parseAgentInfo(agent);
      // Retain the authoritative spawn handle (#1852) — see the CLI driver's startImpl.
      this.ledger.record(started.terminalId, tabId, name);
      if (rootPaneId && !isHeadlessCodexExec(argv)) {
        try {
          await this.client.request("pane.close", { pane_id: rootPaneId });
        } catch {
          /* best-effort: agent still runs if the shell pane lingers, just at split width */
        }
      }
      return started;
    } catch (err) {
      await this.closeTab(tabId); // roll back the orphan tab before propagating
      throw err;
    }
  }

  /** herdr refuses `tab.create` without an active workspace; create a "shepherd" one on
   *  demand. Idempotent: skips when any workspace already exists. Mirrors the CLI path. */
  private async ensureWorkspace(cwd: string): Promise<void> {
    let workspaces: unknown[];
    try {
      const res = await this.client.request("workspace.list", {});
      workspaces = res?.workspaces ?? [];
    } catch {
      workspaces = []; // unreachable/error reply → treat as "none", create one
    }
    if (workspaces.length === 0) {
      await this.client.request("workspace.create", { cwd, label: "shepherd", focus: false });
    }
  }

  /** Bounded-retry `agent.start` that evicts same-named squatters on `agent_name_taken`
   *  (confirmed the literal socket error `code` against live herdr 0.7.3). Returns the
   *  started agent's raw `AgentInfo` for `parseAgentInfo`. Up to 3 attempts. */
  private async startAgentWithCollisionRetry(
    name: string,
    tabId: string,
    cwd: string,
    wrapped: string[],
  ): Promise<unknown> {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        // ≤0.7.4 only: `agent.start` was reshaped incompatibly in protocol 17 (`{ kind, pane_id, …}`),
        // so the p16 request shape lives outside the vendored types — call it via the legacy escape.
        const res = await this.client.requestLegacy<{ agent?: unknown }>("agent.start", {
          name,
          argv: wrapped,
          cwd,
          tab_id: tabId,
          focus: false,
        });
        return res?.agent;
      } catch (err) {
        if (!isNameTakenError(err) || attempt === MAX_ATTEMPTS - 1) throw err;
        // Evict squatter(s) by name — never by regex-parsing the error string
        const squatters = (await this.listAsync()).filter((a) => a.name === name);
        for (const sq of squatters) await this.closeTab(sq.tabId);
      }
    }
    // Unreachable: the final attempt either returns or throws above.
    throw new Error(`herdr: agent.start exhausted retries for ${name}`);
  }

  /** Best-effort teardown of the agent backing a terminal id. Recorded-handle-first,
   *  agent-list fallback, observable full miss — mirrors the CLI driver; the shared
   *  body is {@link stopViaRecordedTab} (#1852). */
  async stop(terminalId: string): Promise<void> {
    await stopViaRecordedTab(this, this.ledger, terminalId);
  }

  /** Rename a live agent and its dedicated tab. Resolves FRESH from the live list;
   *  best-effort — a dead/already-renamed agent must never crash the caller. */
  async relabel(terminalId: string, newName: string): Promise<void> {
    let agent;
    try {
      agent = (await this.listAsync()).find((a) => a.terminalId === terminalId);
    } catch {
      return;
    }
    if (!agent) return;
    // 0.7.5: `agent.rename` must target the pane_id and the agent label must satisfy herdr's name
    // grammar (#1890). ≤0.7.4: target the terminal_id with the raw name. The TAB rename below always
    // uses the raw, human-facing label (tab labels are unconstrained). Mirrors the CLI relabel.
    const external = herdrUsesExternalRegistrationSpawn();
    const renameTarget = external ? agent.paneId : terminalId;
    const agentLabel = external ? sanitizeHerdrAgentName(newName) : newName;
    if (renameTarget) {
      try {
        await this.client.request("agent.rename", { target: renameTarget, name: agentLabel });
      } catch {
        /* best-effort */
      }
    }
    if (agent.tabId) {
      try {
        await this.client.request("tab.rename", { tab_id: agent.tabId, label: newName });
        // Mirror the successful TAB rename into the ledger — see the CLI driver (#1852).
        this.ledger.relabel(terminalId, newName);
      } catch {
        /* best-effort */
      }
    }
  }

  /** Best-effort: close a tab by id (takes its panes + any agent down with it). */
  async closeTab(tabId: string): Promise<void> {
    try {
      await this.client.request("tab.close", { tab_id: tabId });
    } catch {
      /* best-effort; tab may already be gone */
    }
  }

  /**
   * Lifecycle-state push (issue #1891) for externally-registered SANDBOXED 0.7.5 agents — the socket
   * driver DOES host the 0.7.5 external-registration spawn (`startImpl075`), so the poller pushes
   * here when this driver is active. A `pane.report_agent` request mirroring the CLI driver.
   */
  async reportAgentState(
    paneId: string,
    agentName: string,
    state: RequestPaneAgentState,
  ): Promise<void> {
    await this.client.request("pane.report_agent", {
      pane_id: paneId,
      source: "shepherd",
      agent: agentName,
      state,
    });
  }
}

/**
 * Boot-time driver selection (issue #1529), flag-gated behind `config.herdrSocket`
 * (default off). When enabled, pings herdr's socket once to confirm it speaks a
 * protocol version we support before committing to `SocketHerdrDriver` — any
 * mismatch or connection failure falls back to the plain CLI driver so a stale/absent
 * herdr socket never blocks boot. Pure function of its (all-optional, injectable)
 * args so it's unit-testable without a real socket.
 */
export async function selectHerdrDriver(opts?: {
  enabled?: boolean;
  supportedProtocols?: Set<number>;
  makeCli?: () => HerdrDriver;
  makeClient?: () => HerdrSocketClient;
  log?: (msg: string) => void;
}): Promise<IHerdrDriver> {
  const enabled = opts?.enabled ?? config.herdrSocket;
  const supportedProtocols = opts?.supportedProtocols ?? HERDR_SOCKET_SUPPORTED_PROTOCOLS;
  const makeCli = opts?.makeCli ?? (() => new HerdrDriver());
  const makeClient = opts?.makeClient ?? (() => new HerdrSocketClient());
  const log = opts?.log ?? console.warn;

  if (!enabled) return makeCli();

  const client = makeClient();
  try {
    const { protocol } = await client.ping();
    if (supportedProtocols.has(protocol)) {
      log(`[herdr] socket driver active (protocol ${protocol})`);
      return new SocketHerdrDriver(client, makeCli());
    }
    log(`[herdr] socket protocol ${protocol} not supported; using CLI driver`);
    client.close();
    return makeCli();
  } catch (err) {
    log(`[herdr] socket unavailable; using CLI driver: ${err}`);
    client.close();
    return makeCli();
  }
}
