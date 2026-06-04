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

export interface HerdrTab {
  tabId: string;
  /** the tab's display label (e.g. "__usage_probe__", "review TASK-09", a session branch). */
  label: string;
  /** "unknown" when no live agent backs the tab — i.e. an orphaned husk. */
  agentStatus: HerdrState;
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

  /** Every tab in the workspace — including husks with no live agent (`tab list`). */
  tabs(): HerdrTab[] {
    const parsed = JSON.parse(this.runner(["tab", "list"]));
    const tabs = parsed?.result?.tabs ?? [];
    return tabs.map((t: Record<string, string>) => ({
      tabId: t.tab_id,
      label: t.label ?? "",
      agentStatus: (t.agent_status ?? "unknown") as HerdrState,
      workspaceId: t.workspace_id ?? "",
    }));
  }

  /**
   * herdr ≥0.6 refuses `tab create` with `workspace_not_found: no active workspace`
   * unless a workspace exists. A fresh daemon — or one restarted after an update —
   * has none, so the very first New Task after a herdr restart used to 500. Create a
   * "shepherd" workspace on demand. Idempotent: skips when any workspace already exists.
   */
  private ensureWorkspace(cwd: string): void {
    let workspaces: unknown[];
    try {
      workspaces = JSON.parse(this.runner(["workspace", "list"]))?.result?.workspaces ?? [];
    } catch {
      workspaces = []; // unparseable/empty reply → treat as "none", create one
    }
    if (workspaces.length === 0) {
      this.runner(["workspace", "create", "--cwd", cwd, "--label", "shepherd", "--no-focus"]);
    }
  }

  start(name: string, cwd: string, argv: string[]): HerdrAgent {
    // herdr needs an active workspace before any tab can be created — guarantee one.
    this.ensureWorkspace(cwd);
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

    // Anything after `tab create` can throw (agent start fails, or the resolve below
    // finds nothing). The tab already exists, so on ANY failure we must close it —
    // otherwise it lingers forever as an empty husk with no claude in it.
    try {
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
    } catch (err) {
      this.closeTab(tabId); // roll back the orphan tab before propagating
      throw err;
    }
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

  /**
   * Best-effort teardown of the agent backing a terminal id. Closes the agent's whole
   * TAB, not just its pane: every agent gets its own dedicated tab, so closing only the
   * pane left an empty husk tab behind. Resolves the tab id FRESH from the live list
   * (herdr tab ids are positional and renumber on close, so a stored id would drift).
   * No-op if the agent has already left the list — the orphan sweep reaps that husk.
   */
  stop(terminalId: string): void {
    const agent = this.list().find((a) => a.terminalId === terminalId);
    if (!agent?.tabId) return;
    this.closeTab(agent.tabId);
  }

  /**
   * Rename a live agent and its dedicated tab so a background re-name (the LLM namer)
   * is reflected in the herdr UI, not just shepherd's DB. Resolves the agent (and its
   * tabId) FRESH from the live list by terminal id. Best-effort: a dead/already-renamed
   * agent must never crash the caller, so every step is guarded.
   */
  relabel(terminalId: string, newName: string): void {
    let agent;
    try {
      agent = this.list().find((a) => a.terminalId === terminalId);
    } catch {
      return;
    }
    if (!agent) return;
    try {
      this.runner(["agent", "rename", terminalId, newName]);
    } catch {
      /* best-effort */
    }
    if (agent.tabId) {
      try {
        this.runner(["tab", "rename", agent.tabId, newName]);
      } catch {
        /* best-effort */
      }
    }
  }

  /** Best-effort: close a tab by id (takes its panes + any agent down with it). */
  closeTab(tabId: string): void {
    try {
      this.runner(["tab", "close", tabId]);
    } catch {
      /* best-effort; tab may already be gone */
    }
  }
}
