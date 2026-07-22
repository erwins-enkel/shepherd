import { HerdrSocketClient } from "./herdr-socket-client";
import {
  HerdrDriver,
  HerdrSpawnUnsupportedError,
  TabLedger,
  buildWrappedArgv,
  createSerializer,
  isHeadlessCodexExec,
  isNameTakenError,
  parseAgentInfo,
  parseAgents,
  parseProcs,
  parseReadText,
  parseTabs,
  stopViaRecordedTab,
  type HerdrAgent,
  type HerdrTab,
  type IHerdrDriver,
} from "./herdr";
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
    return parseReadText(
      await this.client.request("agent.read", { target, source, lines, format: "text" }),
    );
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
    await this.client.request("agent.send", { target, text });
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
    // supported protocol today, but the version ceiling is the source of truth). See #1889.
    if (!herdrSpawnSupported()) throw new HerdrSpawnUnsupportedError(detectedHerdrVersion());
    // The 0.7.5 external-registration spawn path is CLI-only (#1890); this socket driver does not
    // implement it. It is never *selected* on protocol 17 (17 ∉ HERDR_SOCKET_SUPPORTED_PROTOCOLS),
    // so this is belt-and-suspenders — refuse rather than attempt the broken socket `agent.start`.
    if (herdrUsesExternalRegistrationSpawn()) {
      throw new HerdrSpawnUnsupportedError(detectedHerdrVersion());
    }
    return this.serializeStart(() => this.startImpl(name, cwd, argv, env));
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
        const res = await this.client.request("agent.start", {
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
    try {
      await this.client.request("agent.rename", { target: terminalId, name: newName });
    } catch {
      /* best-effort */
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
