import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pruneHelperTabs,
  hasSurvivingPane,
  sessionJsonPath,
  runPrune,
  type ProcReader,
} from "../deploy/herdr-prune-session";

type Tab = { custom_name: string | null; panes: Record<string, object>; [k: string]: unknown };

function tab(name: string | null, paneIds: number[]): Tab {
  const panes: Record<string, object> = {};
  for (const id of paneIds) panes[String(id)] = { cwd: "/tmp" };
  const layout =
    paneIds.length === 1
      ? { Pane: paneIds[0] }
      : { Split: { first: { Pane: paneIds[0] }, second: { Pane: paneIds[1] } } };
  return {
    custom_name: name,
    layout,
    panes,
    zoomed: false,
    focused: paneIds[0],
    root_pane: paneIds[0],
  };
}

function ws(id: string, tabs: Tab[], activeTab: number | null = 0) {
  const public_pane_numbers: Record<string, number> = {};
  let n = 1;
  for (const t of tabs) for (const p of Object.keys(t.panes)) public_pane_numbers[p] = n++;
  return {
    id,
    custom_name: null,
    identity_cwd: "/tmp",
    public_pane_numbers,
    next_public_pane_number: n,
    public_tab_numbers: tabs.map((_, i) => 100 + i),
    next_public_tab_number: 100 + tabs.length,
    tabs,
    active_tab: activeTab,
  };
}

function doc(workspaces: ReturnType<typeof ws>[], active = 0, selected = 0) {
  return {
    version: 3,
    workspaces,
    active,
    selected,
    collapsed_space_keys: [],
    sidebar_width: 30,
    sidebar_section_split: 0.5,
  };
}

type Out = {
  workspaces: {
    id: string;
    tabs: Tab[];
    public_tab_numbers: number[];
    public_pane_numbers: Record<string, number>;
    active_tab: number | null;
  }[];
  active: number | null;
  selected: number | null;
};

describe("pruneHelperTabs", () => {
  it("removes helper tabs (incl. split layouts) and their pane numbers, keeping arrays aligned", () => {
    const d = doc([
      ws("w1", [
        tab(null, [1]),
        tab("review TASK-1", [2, 3]),
        tab("fix-login-bug", [4]),
        tab("__distill__abcd1234", [5]),
      ]),
    ]);
    const r = pruneHelperTabs(d);
    expect(r).not.toBeNull();
    expect(r!.removedTabs).toBe(2);
    expect(r!.removedWorkspaces).toBe(0);
    const w = (r!.doc as Out).workspaces[0]!;
    expect(w.tabs.map((t) => t.custom_name)).toEqual([null, "fix-login-bug"]);
    expect(w.public_tab_numbers).toEqual([100, 102]);
    expect(Object.keys(w.public_pane_numbers).sort()).toEqual(["1", "4"]);
  });

  it("does not mutate its input", () => {
    const d = doc([ws("w1", [tab(null, [1]), tab("review TASK-1", [2])])]);
    const before = JSON.stringify(d);
    pruneHelperTabs(d);
    expect(JSON.stringify(d)).toBe(before);
  });

  it("shifts active_tab down past removed tabs before it", () => {
    const d = doc([ws("w1", [tab("review A", [1]), tab("review B", [2]), tab("keep", [3])], 2)]);
    expect((pruneHelperTabs(d)!.doc as Out).workspaces[0]!.active_tab).toBe(0);
  });

  it("clamps active_tab to the nearest survivor when the active tab is removed", () => {
    const d = doc([ws("w1", [tab("a", [1]), tab("b", [2]), tab("review X", [3])], 2)]);
    expect((pruneHelperTabs(d)!.doc as Out).workspaces[0]!.active_tab).toBe(1);
    const d2 = doc([ws("w1", [tab("a", [1]), tab("review X", [2]), tab("c", [3])], 1)]);
    expect((pruneHelperTabs(d2)!.doc as Out).workspaces[0]!.active_tab).toBe(1);
  });

  it("drops a workspace left empty and remaps active/selected", () => {
    const d = doc(
      [
        ws("w1", [tab("keep", [1])]),
        ws("w2", [tab("review A", [2]), tab("plan-review B", [3])]),
        ws("w3", [tab("other", [4])]),
      ],
      2,
      1,
    );
    const r = pruneHelperTabs(d)!;
    expect(r.removedTabs).toBe(2);
    expect(r.removedWorkspaces).toBe(1);
    const out = r.doc as Out;
    expect(out.workspaces.map((w) => w.id)).toEqual(["w1", "w3"]);
    expect(out.active).toBe(1); // w3 shifted down
    expect(out.selected).toBe(1); // w2 removed → nearest survivor
  });

  it("writes zero workspaces when every tab is a helper", () => {
    const r = pruneHelperTabs(doc([ws("w1", [tab("review A", [1])])]))!;
    const out = r.doc as Out;
    expect(out.workspaces).toEqual([]);
    expect(out.active).toBe(0);
  });

  it("keeps null indices null", () => {
    const d = doc([ws("w1", [tab("keep", [1]), tab("review A", [2])], null)]);
    (d as { active: number | null }).active = null;
    const out = pruneHelperTabs(d)!.doc as Out;
    expect(out.workspaces[0]!.active_tab).toBeNull();
    expect(out.active).toBeNull();
  });

  it("returns null when nothing is prunable (session slugs and null names are kept)", () => {
    const d = doc([ws("w1", [tab(null, [1]), tab("session-restore-scope-2031", [2])])]);
    expect(pruneHelperTabs(d)).toBeNull();
  });

  it("returns null for an unknown version", () => {
    const d = { ...doc([ws("w1", [tab("review A", [1])])]), version: 4 };
    expect(pruneHelperTabs(d)).toBeNull();
  });

  it.each([
    ["non-object", 42],
    ["workspaces not array", { version: 3, workspaces: {}, active: 0, selected: 0 }],
    [
      "tabs not array",
      { version: 3, workspaces: [{ ...ws("w1", []), tabs: {} }], active: 0, selected: 0 },
    ],
    [
      "public_tab_numbers misaligned",
      {
        version: 3,
        workspaces: [{ ...ws("w1", [tab("review A", [1])]), public_tab_numbers: [] }],
        active: 0,
        selected: 0,
      },
    ],
    [
      "public_pane_numbers missing",
      {
        version: 3,
        workspaces: [{ ...ws("w1", [tab("review A", [1])]), public_pane_numbers: null }],
        active: 0,
        selected: 0,
      },
    ],
    [
      "active_tab not number",
      {
        version: 3,
        workspaces: [{ ...ws("w1", [tab("review A", [1])]), active_tab: "0" }],
        active: 0,
        selected: 0,
      },
    ],
    ["active not number", { ...doc([ws("w1", [tab("review A", [1])])]), active: "x" }],
    [
      "tab without panes object",
      {
        version: 3,
        workspaces: [{ ...ws("w1", [tab("review A", [1])]), tabs: [{ custom_name: "review A" }] }],
        active: 0,
        selected: 0,
      },
    ],
    [
      "custom_name not string/null",
      {
        version: 3,
        workspaces: [
          { ...ws("w1", [tab("review A", [1])]), tabs: [{ custom_name: 5, panes: {} }] },
        ],
        active: 0,
        selected: 0,
      },
    ],
  ])("returns null on shape violation: %s", (_label, input) => {
    expect(pruneHelperTabs(input)).toBeNull();
  });
});

function fakeProc(
  procs: Record<number, { ppid: number; env?: Record<string, string> }>,
): ProcReader {
  return {
    pids: () => Object.keys(procs).map(Number),
    ppid: (pid) => procs[pid]?.ppid ?? null,
    environ: (pid) => {
      const e = procs[pid]?.env;
      return e
        ? Object.entries(e)
            .map(([k, v]) => `${k}=${v}`)
            .join("\0")
        : null;
    },
  };
}

describe("hasSurvivingPane", () => {
  const SOCK = "/h/.config/herdr/herdr.sock";

  it("detects a foreign process carrying this herdr's socket", () => {
    const proc = fakeProc({
      1: { ppid: 0 },
      10: { ppid: 1 },
      50: { ppid: 1, env: { HERDR_SOCKET_PATH: SOCK, HERDR_PANE_ID: "w1:p2" } },
    });
    expect(hasSurvivingPane(SOCK, 10, proc)).toBe(true);
  });

  it("ignores a non-pane process that only carries the socket (e.g. Shepherd via ~/.shepherd/env)", () => {
    const proc = fakeProc({
      1: { ppid: 0 },
      10: { ppid: 1 },
      20: { ppid: 1, env: { HERDR_SOCKET_PATH: SOCK } },
    });
    expect(hasSurvivingPane(SOCK, 10, proc)).toBe(false);
  });

  it("ignores its own pid and ancestors", () => {
    const pane = { HERDR_SOCKET_PATH: SOCK, HERDR_PANE_ID: "w1:p1" };
    const proc = fakeProc({
      1: { ppid: 0 },
      5: { ppid: 1, env: pane },
      10: { ppid: 5, env: pane },
    });
    expect(hasSurvivingPane(SOCK, 10, proc)).toBe(false);
  });

  it("ignores other sockets and unreadable environs", () => {
    const proc = fakeProc({
      1: { ppid: 0 },
      10: { ppid: 1 },
      20: { ppid: 1, env: { HERDR_SOCKET_PATH: "/other.sock", HERDR_PANE_ID: "w1:p1" } },
      30: { ppid: 1 },
    });
    expect(hasSurvivingPane(SOCK, 10, proc)).toBe(false);
  });
});

describe("sessionJsonPath", () => {
  it("default session → top-level config dir", () => {
    expect(sessionJsonPath({}, "/h")).toBe("/h/.config/herdr/session.json");
    expect(sessionJsonPath({ HERDR_SESSION: "default" }, "/h")).toBe(
      "/h/.config/herdr/session.json",
    );
  });
  it("named session → sessions/<name>", () => {
    expect(sessionJsonPath({ HERDR_SESSION: "x" }, "/h")).toBe(
      "/h/.config/herdr/sessions/x/session.json",
    );
  });
});

describe("runPrune", () => {
  function setup(content: unknown) {
    const home = mkdtempSync(join(tmpdir(), "prune-"));
    const dir = join(home, ".config", "herdr");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "session.json");
    if (content !== undefined)
      writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
    return { home, file };
  }
  const prunable = doc([ws("w1", [tab("keep", [1]), tab("review A", [2])])]);
  const noProcs = fakeProc({ 1: { ppid: 0 } });

  it("skips when the socket is live", async () => {
    const { home, file } = setup(prunable);
    const before = readFileSync(file, "utf8");
    const msg = await runPrune({
      env: {},
      home,
      socketLive: async () => true,
      proc: noProcs,
      pid: 1,
    });
    expect(msg).toContain("live");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("skips when a pane process survived", async () => {
    const { home, file } = setup(prunable);
    const before = readFileSync(file, "utf8");
    const proc = fakeProc({
      1: { ppid: 0 },
      9: {
        ppid: 1,
        env: { HERDR_SOCKET_PATH: join(home, ".config/herdr/herdr.sock"), HERDR_PANE_ID: "w1:p1" },
      },
    });
    const msg = await runPrune({ env: {}, home, socketLive: async () => false, proc, pid: 1 });
    expect(msg).toContain("surviv");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("prunes, writes a .pre-prune backup, and leaves no tmp file", async () => {
    const { home, file } = setup(prunable);
    const before = readFileSync(file, "utf8");
    const msg = await runPrune({
      env: {},
      home,
      socketLive: async () => false,
      proc: noProcs,
      pid: 1,
    });
    expect(msg).toContain("removed 1 helper tab(s), 0 workspace(s)");
    expect(readFileSync(`${file}.pre-prune`, "utf8")).toBe(before);
    const out = JSON.parse(readFileSync(file, "utf8")) as Out;
    expect(out.workspaces[0]!.tabs.map((t) => t.custom_name)).toEqual(["keep"]);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it("leaves an unparseable file byte-identical", async () => {
    const { home, file } = setup("{not json");
    await runPrune({ env: {}, home, socketLive: async () => false, proc: noProcs, pid: 1 });
    expect(readFileSync(file, "utf8")).toBe("{not json");
    expect(existsSync(`${file}.pre-prune`)).toBe(false);
  });

  it("exits cleanly with no file", async () => {
    const { home } = setup(undefined);
    const msg = await runPrune({
      env: {},
      home,
      socketLive: async () => false,
      proc: noProcs,
      pid: 1,
    });
    expect(msg).toContain("no session.json");
  });
});
