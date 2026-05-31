import { execFileSync } from "node:child_process";
import { config } from "./config";
import type { HerdrState, SessionStatus } from "./types";

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

export type Runner = (args: string[]) => string;

const defaultRunner: Runner = (args) => execFileSync(config.herdrBin, args, { encoding: "utf8" });

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

export class HerdrDriver {
  constructor(private runner: Runner = defaultRunner) {}

  list(): HerdrAgent[] {
    const parsed = JSON.parse(this.runner(["agent", "list"]));
    const agents = parsed?.result?.agents ?? [];
    return agents.map((a: Record<string, string>) => ({
      agent: a.agent ?? "",
      agentStatus: (a.agent_status ?? "unknown") as HerdrState,
      cwd: a.cwd,
      name: a.name ?? "",
      paneId: a.pane_id,
      tabId: a.tab_id,
      terminalId: a.terminal_id,
      workspaceId: a.workspace_id,
    }));
  }

  start(name: string, cwd: string, argv: string[]): HerdrAgent {
    // Give each agent its OWN tab so its pane spans the full herdr window width.
    // `agent start` with no --tab splits the active tab, so agents pile up as
    // side-by-side panes each ~window/N wide — and that split-fixed width (not the
    // browser's attach size) is what the PTY renders at, so the HUD terminal comes
    // out tall-and-narrow and resizing the browser can't widen it. A dedicated tab
    // keeps every agent full-width regardless of how many are running.
    const created = JSON.parse(
      this.runner(["tab", "create", "--cwd", cwd, "--label", name, "--no-focus"]),
    );
    const tabId: string | undefined = created?.result?.tab?.tab_id;
    // a fresh tab opens with an empty shell pane; `agent start --tab` splits it, so
    // we close that leftover pane afterward to leave the agent as the sole pane
    const rootPaneId: string | undefined = created?.result?.root_pane?.pane_id;
    if (!tabId) throw new Error(`herdr: tab create returned no tab_id for ${name}`);

    this.runner([
      "agent",
      "start",
      name,
      "--tab",
      tabId,
      "--cwd",
      cwd,
      "--no-focus",
      "--",
      ...argv,
    ]);

    if (rootPaneId) {
      try {
        this.runner(["pane", "close", rootPaneId]);
      } catch {
        /* best-effort: agent still runs if the shell pane lingers, just at split width */
      }
    }

    // NOTE: resolves the just-started agent by its unique worktree cwd; ambiguous only if two
    // sessions share a cwd (e.g. two non-git cwd-fallbacks on the same repoPath). TODO: prefer a
    // terminal_id returned directly by `herdr agent start` if herdr exposes it.
    const match = this.list()
      .filter((a) => a.cwd === cwd)
      .at(-1);
    if (!match) throw new Error(`herdr: started agent not found for cwd ${cwd}`);
    return match;
  }

  /** Write literal text to an agent's PTY (no implicit Enter). */
  send(target: string, text: string): void {
    this.runner(["agent", "send", target, text]);
  }

  /** Read an agent's terminal buffer as plain text (default: the visible viewport). */
  read(target: string, source: "visible" | "recent" = "visible", lines = 200): string {
    const out = this.runner([
      "agent",
      "read",
      target,
      "--format",
      "text",
      "--source",
      source,
      "--lines",
      String(lines),
    ]);
    try {
      return JSON.parse(out)?.result?.read?.text ?? "";
    } catch {
      return out;
    }
  }

  /** Best-effort: stop the live agent backing a terminal id (closes its herdr pane). */
  stop(terminalId: string): void {
    const agent = this.list().find((a) => a.terminalId === terminalId);
    if (!agent?.paneId) return;
    try {
      this.runner(["pane", "close", agent.paneId]);
    } catch {
      /* best-effort; agent may already be gone */
    }
  }
}
