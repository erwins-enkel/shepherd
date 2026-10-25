import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ISSUE_FILTER,
  hiddenByRule,
  isMine,
  parseIssueFilterPatch,
  storedIssueFilter,
  type IssueFilterSettings,
  type IssueFilterSubject,
} from "../src/issue-filter";

const ME = "me";
const subj = (over: Partial<IssueFilterSubject> = {}): IssueFilterSubject => ({
  assignees: [],
  labels: [],
  ...over,
});
const f = (over: Partial<IssueFilterSettings> = {}): IssueFilterSettings => ({
  ...DEFAULT_ISSUE_FILTER,
  ...over,
});

const MINE_ASSIGNED = subj({ assignees: [ME, "x"] });
const MINE_AUTHORED = subj({ author: ME, assignees: ["x"] });
const UNASSIGNED = subj();
const OTHERS = subj({ assignees: ["x"], author: "y" });

describe("isMine", () => {
  test("assignee or author, never with a null viewer", () => {
    expect(isMine(MINE_ASSIGNED, ME)).toBe(true);
    expect(isMine(MINE_AUTHORED, ME)).toBe(true);
    expect(isMine(UNASSIGNED, ME)).toBe(false);
    expect(isMine(OTHERS, ME)).toBe(false);
    expect(isMine(MINE_AUTHORED, null)).toBe(false);
  });
});

describe("scope × forks", () => {
  const cases: [IssueFilterSubject, string][] = [
    [MINE_ASSIGNED, "mineAssigned"],
    [MINE_AUTHORED, "mineAuthored"],
    [UNASSIGNED, "unassigned"],
    [OTHERS, "others"],
  ];
  // Expected hiddenByRule per subject, for [scope, forks, isFork].
  const table: [IssueFilterSettings["scope"], IssueFilterSettings["forks"], boolean, string[]][] = [
    ["all", "all", false, ["-", "-", "-", "-"]],
    ["mine_unassigned", "all", false, ["-", "-", "-", "scope"]],
    ["mine", "all", false, ["-", "-", "scope", "scope"]],
    ["all", "own", false, ["-", "-", "-", "-"]],
    ["all", "own", true, ["-", "-", "forks", "forks"]],
    ["all", "hide", true, ["forks", "forks", "forks", "forks"]],
    ["all", "hide", false, ["-", "-", "-", "-"]],
    ["mine_unassigned", "own", true, ["-", "-", "forks", "scope"]],
    ["mine", "hide", true, ["forks", "forks", "scope", "scope"]],
  ];
  for (const [scope, forks, isFork, expected] of table) {
    test(`${scope}/${forks}/${isFork ? "fork" : "own repo"}`, () => {
      cases.forEach(([s], i) => {
        const got = hiddenByRule(s, { viewer: ME, isFork }, f({ scope, forks }));
        expect(got ?? "-", cases[i]![1]).toBe(expected[i]!);
      });
    });
  }
});

describe("viewer == null fails open", () => {
  test("scope and forks:own hide nothing; forks:hide still drops a fork", () => {
    for (const scope of ["all", "mine_unassigned", "mine"] as const) {
      expect(hiddenByRule(OTHERS, { viewer: null, isFork: true }, f({ scope, forks: "own" }))).toBe(
        null,
      );
    }
    expect(hiddenByRule(OTHERS, { viewer: null, isFork: true }, f({ forks: "hide" }))).toBe(
      "forks",
    );
  });
});

describe("hidden labels", () => {
  test("case-insensitive intersection", () => {
    const s = subj({ labels: ["Needs-Design"] });
    expect(
      hiddenByRule(s, { viewer: ME, isFork: false }, f({ hiddenLabels: ["needs-design"] })),
    ).toBe("labels");
    expect(hiddenByRule(s, { viewer: ME, isFork: false }, f({ hiddenLabels: ["other"] }))).toBe(
      null,
    );
  });
  test("attribution order: scope before forks before labels", () => {
    const s = subj({ assignees: ["x"], labels: ["l"] });
    const all = f({ scope: "mine", forks: "hide", hiddenLabels: ["l"] });
    expect(hiddenByRule(s, { viewer: ME, isFork: true }, all)).toBe("scope");
    expect(hiddenByRule(s, { viewer: ME, isFork: true }, { ...all, scope: "all" })).toBe("forks");
    expect(hiddenByRule(s, { viewer: ME, isFork: false }, { ...all, scope: "all" })).toBe("labels");
  });
});

describe("parseIssueFilterPatch", () => {
  test("partial merge keeps the other fields", () => {
    const r = parseIssueFilterPatch({ forks: "hide" }, f({ scope: "mine" }));
    expect(r).toEqual({ ok: true, value: f({ scope: "mine", forks: "hide" }) });
  });
  test("empty object is a no-op", () => {
    expect(parseIssueFilterPatch({}, DEFAULT_ISSUE_FILTER)).toEqual({
      ok: true,
      value: DEFAULT_ISSUE_FILTER,
    });
  });
  test("refuses bad enums, types, unknown keys and non-objects", () => {
    for (const bad of [
      { scope: "everyone" },
      { forks: 1 },
      { hideActive: "yes" },
      { hideBlocked: null },
      { hiddenLabels: "bug" },
      { hiddenLabels: ["ok", 3] },
      { color: "red" },
      { toString: "x" },
      null,
      [],
      "all",
    ]) {
      expect(parseIssueFilterPatch(bad, DEFAULT_ISSUE_FILTER).ok, JSON.stringify(bad)).toBe(false);
    }
  });
  test("labels: trimmed, blanks dropped, case-insensitive dedupe, capped at 50", () => {
    const r = parseIssueFilterPatch(
      { hiddenLabels: [" Bug ", "bug", "", "  ", "wip", "BUG"] },
      DEFAULT_ISSUE_FILTER,
    );
    expect(r.ok && r.value.hiddenLabels).toEqual(["Bug", "wip"]);
    const many = Array.from({ length: 60 }, (_, i) => `l${i}`);
    const capped = parseIssueFilterPatch({ hiddenLabels: many }, DEFAULT_ISSUE_FILTER);
    expect(capped.ok && capped.value.hiddenLabels).toEqual(many.slice(0, 50));
  });
  test("does not mutate the current value", () => {
    const current = f();
    parseIssueFilterPatch({ scope: "all", hiddenLabels: ["x"] }, current);
    expect(current).toEqual(DEFAULT_ISSUE_FILTER);
  });
});

describe("storedIssueFilter", () => {
  test("defaults when unset, corrupt or invalid; merges a partial row onto defaults", () => {
    expect(storedIssueFilter(null)).toEqual(DEFAULT_ISSUE_FILTER);
    expect(storedIssueFilter("{not json")).toEqual(DEFAULT_ISSUE_FILTER);
    expect(storedIssueFilter(JSON.stringify({ scope: "bogus" }))).toEqual(DEFAULT_ISSUE_FILTER);
    expect(storedIssueFilter(JSON.stringify({ scope: "all" }))).toEqual(f({ scope: "all" }));
  });
  test("returns a fresh copy", () => {
    storedIssueFilter(null).hiddenLabels.push("x");
    expect(DEFAULT_ISSUE_FILTER.hiddenLabels).toEqual([]);
  });
});
