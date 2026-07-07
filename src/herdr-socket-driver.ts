import type { HerdrSocketClient } from "./herdr-socket-client";
import {
  HerdrDriver,
  parseAgents,
  parseProcs,
  parseReadText,
  type HerdrAgent,
  type IHerdrDriver,
} from "./herdr";

/**
 * Socket-backed `IHerdrDriver` (issue #1529): routes the async read surface —
 * `listAsync`/`readAsync`/`paneForegroundProcs` — over herdr's persistent Unix-socket
 * JSON-RPC transport (`HerdrSocketClient`), avoiding a CLI spawn per poll tick.
 *
 * Every OTHER method — including the sync `list`/`read`/`tabs`/`panes` and the whole
 * write surface (`start`/`send`/`stop`/`relabel`/`closeTab`) — delegates straight to a
 * wrapped `HerdrDriver`. Two reasons this split is deliberate, not a TODO:
 *  - Sync methods can't be backed by an async socket without reintroducing event-loop
 *    blocking (they'd need a fake-sync wait on a promise) — the socket only helps async
 *    callers.
 *  - The write surface — `start`'s multi-step tab/workspace orchestration especially —
 *    stays on the proven, battle-tested CLI path for this PR; porting it to the socket
 *    is follow-up work, not bundled here.
 */
export class SocketHerdrDriver implements IHerdrDriver {
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

  start(name: string, cwd: string, argv: string[], env?: Record<string, string>): HerdrAgent {
    return this.cli.start(name, cwd, argv, env);
  }

  send(target: string, text: string): void {
    this.cli.send(target, text);
  }

  read(target: string, source: "visible" | "recent" = "visible", lines = 200): string {
    return this.cli.read(target, source, lines);
  }

  stop(terminalId: string): void {
    this.cli.stop(terminalId);
  }

  relabel(terminalId: string, newName: string): void {
    this.cli.relabel(terminalId, newName);
  }

  closeTab(tabId: string): void {
    this.cli.closeTab(tabId);
  }
}
