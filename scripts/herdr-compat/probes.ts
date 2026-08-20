/**
 * Live probes for the herdr compatibility check (SOP: .claude/rules/herdr-version-bump.md).
 *
 * Each probe measures ONE assumption Shepherd's code rides on, against one isolated server;
 * the runner (scripts/herdr-compat.ts) compares candidate vs. baseline observations and turns
 * them into verdicts. Observations are facts ("what did this herdr do"), never judgements —
 * when a step can't be measured the field stays null/"undetermined" rather than guessing.
 *
 * The catalog (ids L1–L8 here; L9 = scripts/verify-herdr-terminal.ts, run by the caller):
 *  L1  tab.list returns a non-null label for every tab            (reaper keying, #2029)
 *  L2  an agentless tab reports agent_status "unknown"            (husk detection, #2029)
 *  L3  pane process-info returns foreground procs for a shell     (fail-closed spare, #2029)
 *  L4  tab_ids are not reused across a close                      (#569)
 *  L5  closing a workspace's last tab: refused / survives / destroys the workspace (#1760)
 *  L6  the external-registration spawn path yields an agent record whose keys Shepherd parses (#1890)
 *  L7  report-agent --state idle: does it land on idle or done?   (herdr #1716 / sandbox floor)
 *  L8  `status server` stays parseable (status: running + version line) — the surface this
 *      SOP's isolated servers, the downgrade script and operator diagnostics read
 */

import type { IsolatedServer } from "./isolated-server";

export type LastTabBehaviour =
  "refused" | "closed-workspace-survives" | "closed-workspace-destroyed" | "undetermined";

export interface LiveObservations {
  /** L1: false as soon as one tab carries a null/absent label. */
  labelsNonNull: boolean | null;
  /** L2: agent_status of a freshly created, agentless tab. */
  agentlessStatus: string | null;
  /** L3: foreground-process count on the agentless pane after settling (≤5s poll). */
  foregroundProcs: number | null;
  /** L4: true = a closed tab's id was handed out again. */
  tabIdReused: boolean | null;
  /** L5 */
  lastTabClose: LastTabBehaviour;
  /** L6: key set of the registered agent's `agent list` record; null = registration failed. */
  agentRecordKeys: string[] | null;
  /** L6: agent_status right after report-agent --state working. */
  statusAfterWorking: string | null;
  /** L7: agent_status after report-agent --state idle. */
  statusAfterIdle: string | null;
  /** L8: `status server` exits 0, says "status: running" and carries a parseable version. */
  statusParseable: boolean | null;
  /** Anything worth carrying into the report verbatim. */
  notes: string[];
}

interface JsonObject {
  [key: string]: unknown;
}
const obj = (v: unknown): JsonObject =>
  typeof v === "object" && v !== null ? (v as JsonObject) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** run() and throw on non-zero exit — for herdr commands that print nothing on success. */
async function runOk(server: IsolatedServer, argv: string[]): Promise<void> {
  const res = await server.run(argv);
  if (res.exitCode !== 0) {
    throw new Error(`herdr ${argv.join(" ")} exited ${res.exitCode}: ${res.stderr || res.stdout}`);
  }
}

async function agentByName(server: IsolatedServer, name: string): Promise<JsonObject | null> {
  const res = obj(obj(await server.runJson(["agent", "list"])).result);
  for (const raw of arr(res.agents)) {
    const a = obj(raw);
    if (a.agent === name) return a;
  }
  return null;
}

/**
 * Run the full probe sequence. `beforeDestructive` runs while the workspace is still intact —
 * the caller hooks L9 (verify-herdr-terminal) in there, because L5 may destroy the workspace.
 */
export async function runProbes(
  server: IsolatedServer,
  opts?: { beforeDestructive?: () => Promise<void> },
): Promise<LiveObservations> {
  const o: LiveObservations = {
    labelsNonNull: null,
    agentlessStatus: null,
    foregroundProcs: null,
    tabIdReused: null,
    lastTabClose: "undetermined",
    agentRecordKeys: null,
    statusAfterWorking: null,
    statusAfterIdle: null,
    statusParseable: null,
    notes: [],
  };

  // Everything below needs a workspace; a git repo in the workDir keeps the cwd realistic
  // (herdr derives workspace/repo names from it).
  const git = Bun.spawnSync(["git", "init", "-q"], { cwd: server.workDir });
  if (git.exitCode !== 0) o.notes.push("git init failed in the scratch workDir");
  const ws = obj(
    obj(await server.runJson(["workspace", "create", "--cwd", server.workDir])).result,
  );
  const rootTabId = String(obj(ws.root_pane).tab_id ?? "");

  // L6 + L7: external-registration spawn replay (#1890: tab create → pane run → report-agent).
  const agentName = "shepherd-compat-agent";
  try {
    const tab = obj(
      obj(
        await server.runJson([
          "tab",
          "create",
          "--cwd",
          server.workDir,
          "--label",
          agentName,
          "--no-focus",
        ]),
      ).result,
    );
    const paneId = String(obj(tab.root_pane).pane_id);
    // These three print NOTHING on success — judge them by exit code, not JSON.
    await runOk(server, ["pane", "run", paneId, "sleep 300"]);
    await runOk(server, [
      "pane",
      "report-agent-session",
      paneId,
      "--source",
      "shepherd",
      "--agent",
      agentName,
      "--agent-session-id",
      `shepherd-${paneId}`,
    ]);
    await runOk(server, [
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
    await Bun.sleep(500);
    const registered = await agentByName(server, agentName);
    if (registered) {
      o.agentRecordKeys = Object.keys(registered).sort();
      o.statusAfterWorking = String(registered.agent_status ?? "");
    }
    await runOk(server, [
      "pane",
      "report-agent",
      paneId,
      "--source",
      "shepherd",
      "--agent",
      agentName,
      "--state",
      "idle",
    ]);
    await Bun.sleep(500);
    const afterIdle = await agentByName(server, agentName);
    if (afterIdle) o.statusAfterIdle = String(afterIdle.agent_status ?? "");
  } catch (err) {
    o.notes.push(`spawn replay failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // L2 + L3 + L4 on a fresh agentless tab.
  let agentlessTabId: string | null = null;
  try {
    const tab = obj(
      obj(
        await server.runJson([
          "tab",
          "create",
          "--cwd",
          server.workDir,
          "--label",
          "shepherd-compat-idle",
          "--no-focus",
        ]),
      ).result,
    );
    agentlessTabId = String(obj(tab.root_pane).tab_id);
    const paneId = String(obj(tab.root_pane).pane_id);
    const tabs = arr(obj(obj(await server.runJson(["tab", "list"])).result).tabs).map(obj);
    const mine = tabs.find((t) => t.tab_id === agentlessTabId);
    o.agentlessStatus = mine ? String(mine.agent_status ?? "") : null;
    // L1 over the whole list while we hold several tabs.
    o.labelsNonNull = tabs.every((t) => typeof t.label === "string" && t.label !== null);

    // L3: poll until the pane's shell settles (empty list = the "reap nothing" mode of #2029).
    const deadline = Date.now() + 5_000;
    for (;;) {
      const info = obj(
        obj(obj(await server.runJson(["pane", "process-info", "--pane", paneId])).result)
          .process_info,
      );
      const procs = arr(info.foreground_processes);
      if (procs.length > 0) {
        o.foregroundProcs = procs.length;
        break;
      }
      if (Date.now() > deadline) {
        o.foregroundProcs = 0;
        break;
      }
      await Bun.sleep(300);
    }

    // L4: close it, create another, compare ids.
    await server.runJson(["tab", "close", agentlessTabId]);
    const again = obj(
      obj(
        await server.runJson([
          "tab",
          "create",
          "--cwd",
          server.workDir,
          "--label",
          "shepherd-compat-l4",
          "--no-focus",
        ]),
      ).result,
    );
    o.tabIdReused = String(obj(again.root_pane).tab_id) === agentlessTabId;
  } catch (err) {
    o.notes.push(`tab probes failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // L8: the human/tooling status surface (isolated-server startup, the downgrade script's
  // post-swap check and operator diagnostics all read it).
  const st = await server.run(["status", "server"]);
  o.statusParseable =
    st.exitCode === 0 &&
    /status:\s*running/.test(st.stdout) &&
    /version:\s*\d+\.\d+\.\d+/.test(st.stdout);

  await opts?.beforeDestructive?.();

  // L5 — DESTRUCTIVE, last: reduce the workspace to one tab, close it, observe.
  try {
    const tabs = arr(obj(obj(await server.runJson(["tab", "list"])).result).tabs).map(obj);
    for (const t of tabs) {
      if (t.tab_id !== rootTabId) await server.run(["tab", "close", String(t.tab_id)]);
    }
    const close = await server.run(["tab", "close", rootTabId]);
    const parsed = (() => {
      try {
        return obj(JSON.parse(close.stdout));
      } catch {
        return {};
      }
    })();
    if (parsed.error !== undefined) {
      o.lastTabClose = "refused";
    } else if (close.exitCode === 0) {
      const workspaces = arr(
        obj(obj(await server.runJson(["workspace", "list"])).result).workspaces,
      );
      o.lastTabClose =
        workspaces.length > 0 ? "closed-workspace-survives" : "closed-workspace-destroyed";
    }
  } catch (err) {
    o.notes.push(`last-tab probe failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return o;
}
