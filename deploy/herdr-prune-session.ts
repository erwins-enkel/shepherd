// Pre-start prune of herdr's persisted session (#2031). Runs as herdr.service's ExecStartPre, so
// herdr is DOWN: it drops Shepherd helper tabs (isShepherdHelperLabel) from session.json before
// `herdr server` restores every persisted tab as a fresh shell. Without this a restart after a
// husk leak re-materialises every husk at once (#2029: ~500 pane spawns in the first minute,
// `pthread_create: EAGAIN`) before any Shepherd sweep can run — and a herdr-only crash restart
// never triggers Shepherd's boot sweep at all.
//
// A helper tab is always a husk here: verified on herdr 0.9.1, a pane's processes die with the
// server (graceful stop or SIGKILL, supervised or not). The survivor guard re-checks that at run
// time rather than trusting it.
//
// The file is herdr's, not ours — a compatibility bet. Every doubt resolves to "don't write":
// unknown version, unexpected shape, live socket, surviving pane process, any error. The unit
// prefixes this with `-`, so even a crash here never blocks herdr from starting.
import { createConnection } from "node:net";
import { copyFileSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isShepherdHelperLabel } from "../src/tab-reaper";
import { resolveHerdrSocket } from "../src/herdr-session";

const SUPPORTED_VERSION = 3;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isIndex = (v: unknown): v is number | null => v === null || typeof v === "number";

export interface PruneResult {
  doc: unknown;
  removedTabs: number;
  removedWorkspaces: number;
}

/** Map an index into a list after removing `removed` indices: shift past earlier removals; a
 *  removed index clamps to the nearest survivor (the next one, else the last); 0 when none
 *  survive. `null` stays `null`. */
function remapIndex(
  idx: number | null,
  removed: ReadonlySet<number>,
  oldLen: number,
): number | null {
  if (idx === null) return null;
  const survivors: number[] = [];
  for (let i = 0; i < oldLen; i++) if (!removed.has(i)) survivors.push(i);
  if (survivors.length === 0) return 0;
  const at = survivors.findIndex((i) => i >= idx);
  return at === -1 ? survivors.length - 1 : at;
}

/** True when a workspace has the exact shape the prune edits. */
function workspaceShapeOk(w: unknown): w is Obj & { tabs: Obj[] } {
  if (!isObj(w) || !Array.isArray(w.tabs)) return false;
  if (!Array.isArray(w.public_tab_numbers) || w.public_tab_numbers.length !== w.tabs.length)
    return false;
  if (!isObj(w.public_pane_numbers) || !isIndex(w.active_tab)) return false;
  return w.tabs.every(
    (t) =>
      isObj(t) && isObj(t.panes) && (t.custom_name === null || typeof t.custom_name === "string"),
  );
}

function pruneWorkspace(w: Obj & { tabs: Obj[] }): { ws: Obj; removed: number } {
  const removed = new Set<number>();
  w.tabs.forEach((t, i) => {
    if (typeof t.custom_name === "string" && isShepherdHelperLabel(t.custom_name)) removed.add(i);
  });
  if (removed.size === 0) return { ws: w, removed: 0 };
  const panes = { ...(w.public_pane_numbers as Obj) };
  for (const i of removed) for (const p of Object.keys(w.tabs[i]!.panes as Obj)) delete panes[p];
  const keep = (_: unknown, i: number) => !removed.has(i);
  return {
    ws: {
      ...w,
      tabs: w.tabs.filter(keep),
      public_tab_numbers: (w.public_tab_numbers as unknown[]).filter(keep),
      public_pane_numbers: panes,
      active_tab: remapIndex(w.active_tab as number | null, removed, w.tabs.length),
    },
    removed: removed.size,
  };
}

/** Drop helper-labelled tabs from a parsed session.json. Returns `null` — meaning "do not write" —
 *  for an unsupported version, any shape it does not fully understand, or nothing to prune.
 *  Pure: never mutates `doc`. */
export function pruneHelperTabs(doc: unknown): PruneResult | null {
  if (!isObj(doc) || doc.version !== SUPPORTED_VERSION || !Array.isArray(doc.workspaces))
    return null;
  if (!isIndex(doc.active) || !isIndex(doc.selected)) return null;
  const workspaces: unknown[] = doc.workspaces;
  if (!workspaces.every(workspaceShapeOk)) return null;

  let removedTabs = 0;
  const emptied = new Set<number>();
  const next: Obj[] = [];
  workspaces.forEach((w, i) => {
    const r = pruneWorkspace(w as Obj & { tabs: Obj[] });
    removedTabs += r.removed;
    if (r.removed > 0 && (r.ws.tabs as unknown[]).length === 0) emptied.add(i);
    else next.push(r.ws);
  });
  if (removedTabs === 0) return null;

  return {
    doc: {
      ...doc,
      workspaces: next,
      active: remapIndex(doc.active, emptied, workspaces.length),
      selected: remapIndex(doc.selected, emptied, workspaces.length),
    },
    removedTabs,
    removedWorkspaces: emptied.size,
  };
}

/** Where herdr keeps a session's session.json (herdr's own layout, see herdr-session.ts). */
export function sessionJsonPath(env: Record<string, string | undefined>, home: string): string {
  const session = env.HERDR_SESSION ?? "default";
  return session !== "default"
    ? join(home, ".config", "herdr", "sessions", session, "session.json")
    : join(home, ".config", "herdr", "session.json");
}

/** Minimal /proc view (injectable for tests). `environ` is the raw NUL-separated block, or `null`
 *  when unreadable (another uid, a pid that exited). */
export interface ProcReader {
  pids(): number[];
  ppid(pid: number): number | null;
  environ(pid: number): string | null;
}

const linuxProc: ProcReader = {
  pids: () =>
    readdirSync("/proc")
      .filter((n) => /^\d+$/.test(n))
      .map(Number),
  ppid: (pid) => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // comm may contain spaces/parens: fields resume after the LAST ')' → " <state> <ppid> ..."
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      return Number.isInteger(ppid) ? ppid : null;
    } catch {
      return null;
    }
  },
  environ: (pid) => {
    try {
      return readFileSync(`/proc/${pid}/environ`, "utf8");
    } catch {
      return null;
    }
  },
};

/** True when a process OTHER than `selfPid` and its ancestors is a pane process of THIS herdr:
 *  it carries both `HERDR_SOCKET_PATH=<socket>` and a `HERDR_PANE_ID`, which herdr exports into
 *  every pane — so a match outlived its server, and pruning its tab would leave it tab-less,
 *  beyond every label-keyed reaper. The socket path alone is NOT evidence: `~/.shepherd/env` can
 *  set it, so Shepherd and its non-pane children carry it too. */
export function hasSurvivingPane(socketPath: string, selfPid: number, proc: ProcReader): boolean {
  const lineage = new Set<number>();
  for (let p: number | null = selfPid; p !== null && p > 0 && !lineage.has(p); p = proc.ppid(p))
    lineage.add(p);
  const needle = `HERDR_SOCKET_PATH=${socketPath}`;
  return proc.pids().some((pid) => {
    if (lineage.has(pid)) return false;
    const vars = proc.environ(pid)?.split("\0") ?? [];
    return vars.includes(needle) && vars.some((v) => v.startsWith("HERDR_PANE_ID="));
  });
}

/** Does anything accept connections on the socket? A timeout reads as live (fail toward no write). */
function probeSocket(path: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ path });
    const done = (live: boolean) => {
      clearTimeout(timer);
      sock.destroy();
      resolve(live);
    };
    const timer = setTimeout(() => done(true), timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

export interface RunDeps {
  env: Record<string, string | undefined>;
  home: string;
  socketLive: (path: string) => Promise<boolean>;
  proc: ProcReader;
  pid: number;
}

/** One prune run. Returns a one-line outcome for the journal; never throws for an expected skip. */
export async function runPrune(deps: RunDeps): Promise<string> {
  const file = sessionJsonPath(deps.env, deps.home);
  const { socketPath } = resolveHerdrSocket(deps.env, deps.home);
  if (await deps.socketLive(socketPath)) return `skipped: herdr socket ${socketPath} is live`;
  if (hasSurvivingPane(socketPath, deps.pid, deps.proc))
    return "skipped: a pane process survived the previous server";

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return `no session.json at ${file}`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return `skipped: ${file} is not valid JSON`;
  }
  const r = pruneHelperTabs(parsed);
  if (!r) return `nothing to prune in ${file} (or unrecognised format)`;

  copyFileSync(file, `${file}.pre-prune`);
  const tmp = join(dirname(file), "session.json.tmp");
  writeFileSync(tmp, JSON.stringify(r.doc, null, 2));
  renameSync(tmp, file);
  return `removed ${r.removedTabs} helper tab(s), ${r.removedWorkspaces} workspace(s) from ${file}`;
}

if (import.meta.main) {
  try {
    const msg = await runPrune({
      env: process.env,
      home: homedir(),
      socketLive: (p) => probeSocket(p),
      proc: linuxProc,
      pid: process.pid,
    });
    console.log(`[herdr-prune] ${msg}`);
  } catch (err) {
    console.log(`[herdr-prune] failed, session.json left as-is: ${String(err)}`);
  }
}
