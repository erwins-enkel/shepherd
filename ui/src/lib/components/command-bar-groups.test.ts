import { describe, it, expect } from "vitest";
import {
  arrangeGroups,
  pinKeep,
  rowLabel,
  stableKey,
  type ArrangeInput,
  type PinSources,
  type Row,
} from "./command-bar-groups";

const sess = (id: string, rank = 0): Row => ({
  kind: "session",
  id,
  title: `t-${id}`,
  designation: id,
  repoPath: "/r",
  repoName: null,
  status: "",
  hl: [],
  designationHl: [],
  repoHl: [],
  promptMatch: false,
  rank,
});
const repo = (path: string, rank = 0): Row => ({
  kind: "repo",
  path,
  realPath: path,
  name: path.slice(1),
  display: path,
  hl: [],
  displayHl: [],
  hasLiveSession: false,
  rank,
});
const lens = (id: "all" | "next", rank = 0): Row => ({
  kind: "lens",
  lens: id,
  label: id,
  icon: "",
  hl: [],
  rank,
});
const cmd = (id: string, rank = 0): Row => ({
  kind: "command",
  id,
  label: id,
  run: () => {},
  confirmLabel: null,
  confirmAria: null,
  shortcut: null,
  hl: [],
  rank,
});
const doc = (url: string, rank = 0): Row => ({ kind: "doc", title: url, url, hl: [], rank });

const labels: ArrangeInput["labels"] = {
  pinned: "Pinned",
  needsYou: (n) => `Needs you · ${n}`,
  sessions: "Sessions",
  repos: "Repositories",
  lenses: "Lenses",
  commands: "Commands",
  docs: "Docs",
};

function arrange(over: Partial<ArrangeInput> = {}) {
  return arrangeGroups({
    q: "",
    pins: [],
    rows: {
      sessions: [sess("a"), sess("b"), sess("c")],
      repos: [repo("/x"), repo("/y")],
      lenses: [lens("all"), lens("next")],
      commands: [cmd("usage"), cmd("new-task")],
      docs: [doc("https://d/1")],
    },
    needsInputIds: new Set(),
    labels,
    ...over,
  });
}
const shape = (gs: ReturnType<typeof arrange>) =>
  gs.map((g) => [g.label, g.rows.map(stableKey)] as const);

describe("arrangeGroups — empty query", () => {
  it("without pins keeps Sessions → Repositories → Lenses and hides commands/docs", () => {
    expect(shape(arrange())).toEqual([
      ["Sessions", ["s:a", "s:b", "s:c"]],
      ["Repositories", ["r:/x", "r:/y"]],
      ["Lenses", ["l:all", "l:next"]],
    ]);
  });

  it("leads with Pinned in pin order, then Needs you, then the rest — no duplicates", () => {
    const gs = arrange({
      pins: ["c:usage", "s:c", "d:https://d/1", "l:next", "r:/y"],
      needsInputIds: new Set(["b", "c"]),
    });
    expect(shape(gs)).toEqual([
      ["Pinned", ["c:usage", "s:c", "d:https://d/1", "l:next", "r:/y"]],
      ["Needs you · 1", ["s:b"]],
      ["Sessions", ["s:a"]],
      ["Repositories", ["r:/x"]],
      ["Lenses", ["l:all"]],
    ]);
  });

  it("hides a pin whose target is absent (unavailable command) without failing", () => {
    expect(shape(arrange({ pins: ["c:broadcast", "c:usage"] }))[0]).toEqual([
      "Pinned",
      ["c:usage"],
    ]);
  });
});

describe("arrangeGroups — typed query", () => {
  it("puts matching pins above every group whatever their rank, in pin order", () => {
    const gs = arrange({
      q: "u",
      pins: ["r:/y", "c:usage", "s:zzz"],
      rows: {
        sessions: [sess("a", 900)],
        repos: [repo("/y", 10)],
        lenses: [],
        commands: [cmd("usage", 50), cmd("new-task", 40)],
        docs: [doc("https://d/1", 500)],
      },
    });
    expect(shape(gs)).toEqual([
      ["Pinned", ["r:/y", "c:usage"]],
      ["Sessions", ["s:a"]],
      ["Docs", ["d:https://d/1"]],
      ["Commands", ["c:new-task"]],
    ]);
  });

  it("has no Needs-you group and ranks sessions as given", () => {
    const gs = arrange({ q: "t", needsInputIds: new Set(["a"]) });
    expect(gs.map((g) => g.key)).not.toContain("needs-you");
  });
});

describe("rowLabel", () => {
  it("names each kind by its primary text", () => {
    expect([sess("a"), repo("/x"), lens("next"), cmd("usage"), doc("u")].map(rowLabel)).toEqual([
      "t-a",
      "x",
      "next",
      "usage",
      "u",
    ]);
  });
});

describe("pinKeep", () => {
  const src = (over: Partial<PinSources> = {}): PinSources => ({
    sessionIds: new Set(["a"]),
    repoPaths: new Set(["/x"]),
    commandIds: new Set(["usage", "broadcast"]),
    docUrls: new Set(["https://d/1"]),
    lensIds: new Set(["all", "next"]),
    ...over,
  });

  it("keeps known targets and drops missing ones", () => {
    const keys = ["s:a", "s:gone", "r:/x", "r:/gone", "c:broadcast", "c:removed"];
    expect(keys.filter((k) => pinKeep(k, src()))).toEqual(["s:a", "r:/x", "c:broadcast"]);
    expect(
      ["d:https://d/1", "d:old", "l:next", "l:nope", "x:what"].filter((k) => pinKeep(k, src())),
    ).toEqual(["d:https://d/1", "l:next"]);
  });

  it("keeps every s:/r: pin while its source is untrusted (null)", () => {
    const s = src({ sessionIds: null, repoPaths: null });
    expect(pinKeep("s:gone", s)).toBe(true);
    expect(pinKeep("r:/gone", s)).toBe(true);
  });
});
