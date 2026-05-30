import { execFileSync } from "node:child_process";
import { config } from "./config";
import type { HerdrState, SessionStatus } from "./types";

export interface HerdrAgent {
  agent: string;
  agentStatus: HerdrState;
  cwd: string;
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
      paneId: a.pane_id,
      tabId: a.tab_id,
      terminalId: a.terminal_id,
      workspaceId: a.workspace_id,
    }));
  }

  start(name: string, cwd: string, argv: string[]): HerdrAgent {
    this.runner(["agent", "start", name, "--cwd", cwd, "--no-focus", "--", ...argv]);
    const match = this.list()
      .filter((a) => a.cwd === cwd)
      .at(-1);
    if (!match) throw new Error(`herdr: started agent not found for cwd ${cwd}`);
    return match;
  }

  attachArgv(terminalId: string): string[] {
    return ["agent", "attach", terminalId];
  }
}
