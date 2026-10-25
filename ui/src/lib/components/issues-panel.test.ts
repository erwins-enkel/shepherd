/**
 * Unit tests for IssuesPanel logic (issues-panel.ts).
 *
 * Follows the backlog-view.test.ts pattern: the Svelte component has no DOM
 * test infrastructure here, so we cover the extracted pure filter the template
 * delegates to.
 */
import { describe, it, expect, vi } from "vitest";
import { m } from "#lib/paraglide/messages.js";
import {
  activeFilterChips,
  shownOfTotal,
  shortcutHints,
  filterIssues,
  applyDefaultFilter,
  defaultFilterEmptiedBy,
  defaultFilterEmptyMessage,
  isMine,
  hideActive,
  hideSubIssues,
  sortEpicsFirst,
  distinctAuthors,
  distinctLabels,
  labelColorMap,
  filterByAuthor,
  filterByLabels,
  isBlocked,
  hideBlockedIssues,
  ACTIVE_LABEL,
  epicFlagForOthers,
  assignedOthers,
  buildIssueRows,
  stepSelection,
  resolveSelection,
  stripEpicPrefix,
  lastChange,
  sortOldestFirst,
  staleSummary,
  labelCounts,
  runningIssues,
} from "./issues-panel";
import type { Issue, EpicSummary, EpicChild, IssueFilterSettings } from "#lib/types.js";

function issue(
  number: number,
  title: string,
  body = "",
  labels: string[] = [],
  assignees: string[] = [],
  author?: string,
): Issue {
  return {
    number,
    title,
    body,
    url: `https://example.test/${number}`,
    labels,
    createdAt: 0,
    assignees,
    author,
  };
}

const issues = [
  issue(122, "Post-Delivery Follow-Up E-Mail", "Kundenzufriedenheit nach Lieferung", [
    "enhancement",
  ]),
  issue(117, "Creator-/Influencer-Tracking", "Link + Gutscheincode als Paket", [
    "enhancement",
    "shepherd:active",
  ]),
  issue(9, "Fix broken images", "", ["bug"]),
];

describe("filterIssues", () => {
  it("returns all issues for an empty or whitespace query", () => {
    expect(filterIssues(issues, "")).toEqual(issues);
    expect(filterIssues(issues, "   ")).toEqual(issues);
  });

  it("matches title case-insensitively", () => {
    expect(filterIssues(issues, "follow-up")).toEqual([issues[0]]);
  });

  it("matches body text", () => {
    expect(filterIssues(issues, "gutscheincode")).toEqual([issues[1]]);
  });

  it("matches labels", () => {
    expect(filterIssues(issues, "bug")).toEqual([issues[2]]);
    expect(filterIssues(issues, "shepherd:active")).toEqual([issues[1]]);
  });

  it("matches the issue number with and without a leading #", () => {
    expect(filterIssues(issues, "122")).toEqual([issues[0]]);
    expect(filterIssues(issues, "#122")).toEqual([issues[0]]);
  });

  it("returns empty when nothing matches", () => {
    expect(filterIssues(issues, "zzz-no-match")).toEqual([]);
  });
});

const RULES: Pick<IssueFilterSettings, "scope" | "forks" | "hiddenLabels"> = {
  scope: "mine_unassigned",
  forks: "all",
  hiddenLabels: [],
};
const kept = (
  list: Issue[],
  over: Partial<typeof RULES> = {},
  ctx = { viewer: "octocat" as string | null, isFork: false },
) => applyDefaultFilter(list, ctx, { ...RULES, ...over }).afterLabels;

describe("applyDefaultFilter (mirrors src/issue-filter.ts)", () => {
  const me = "octocat";
  const unassigned = issue(1, "Unassigned", "", [], []);
  const mine = issue(2, "Mine", "", [], [me]);
  const theirs = issue(3, "Theirs", "", [], ["someone-else"]);
  const mineAndTheirs = issue(4, "Shared", "", [], ["someone-else", me]);
  const authored = issue(5, "Authored", "", [], ["someone-else"], me);
  const all = [unassigned, mine, theirs, mineAndTheirs, authored];

  it("mine_unassigned keeps unassigned + mine (assignee or author), hides others'", () => {
    expect(kept(all)).toEqual([unassigned, mine, mineAndTheirs, authored]);
  });

  it("mine keeps only mine; all keeps everything", () => {
    expect(kept(all, { scope: "mine" })).toEqual([mine, mineAndTheirs, authored]);
    expect(kept(all, { scope: "all" })).toEqual(all);
  });

  it("a null viewer fails open for scope and forks: own", () => {
    const ctx = { viewer: null, isFork: true };
    expect(kept(all, { scope: "mine", forks: "own" }, ctx)).toEqual(all);
    expect(isMine(mine, null)).toBe(false);
  });

  it("forks: own keeps only mine in a fork, hide drops the fork; no-op outside forks", () => {
    const fork = { viewer: me, isFork: true };
    expect(kept(all, { scope: "all", forks: "own" }, fork)).toEqual([
      mine,
      mineAndTheirs,
      authored,
    ]);
    expect(kept(all, { scope: "all", forks: "hide" }, fork)).toEqual([]);
    expect(kept(all, { scope: "all", forks: "hide" })).toEqual(all);
  });

  it("hidden labels match case-insensitively", () => {
    const docs = issue(6, "Docs", "", ["Docs"], []);
    expect(kept([docs, unassigned], { hiddenLabels: ["docs"] })).toEqual([unassigned]);
  });

  it("exempts rows from the scope rule only", () => {
    const stages = applyDefaultFilter(
      [theirs],
      { viewer: me, isFork: true },
      { ...RULES, forks: "hide" },
      (i) => i.number === 3,
    );
    expect(stages.afterScope).toEqual([theirs]);
    expect(stages.afterForks).toEqual([]);
  });

  it("does not throw on a stale payload missing assignees", () => {
    const stale = {
      number: 1,
      title: "Unassigned",
      body: "",
      url: "https://example.test/1",
      labels: [],
      createdAt: 0,
    } as unknown as Issue;
    expect(kept([stale])).toEqual([stale]);
  });

  it("attributes an emptied list to the first rule that emptied it", () => {
    const ctx = { viewer: me, isFork: true };
    const by = (over: Partial<typeof RULES>, list = [theirs]) => {
      const f = { ...RULES, ...over };
      return defaultFilterEmptiedBy(list.length, applyDefaultFilter(list, ctx, f), ctx, f);
    };
    expect(by({})).toBe("scope");
    expect(by({ scope: "all", forks: "hide" })).toBe("forks");
    expect(by({ scope: "all", hiddenLabels: ["x"] }, [issue(7, "X", "", ["x"])])).toBe("labels");
    expect(by({ scope: "all" })).toBeNull();
    expect(defaultFilterEmptyMessage("scope", "mine")).toBe(m.issues_filter_all_not_mine());
    expect(defaultFilterEmptyMessage("scope", "mine_unassigned")).toBe(
      m.issues_filter_all_assigned_to_others(),
    );
  });
  describe("repo override (#3020)", () => {
    const fork = (override: "all" | "mine_unassigned" | "mine" | "hide") => ({
      viewer: me as string | null,
      isFork: true,
      override,
    });

    it("all beats the global scope/forks in a fork; hidden labels still apply", () => {
      expect(kept(all, { scope: "mine", forks: "own" }, fork("all"))).toEqual(all);
      const wip = issue(8, "Wip", "", ["WIP"], []);
      expect(kept([wip, theirs], { hiddenLabels: ["wip"] }, fork("all"))).toEqual([theirs]);
    });

    it("hide drops everything, exempt rows included; mine acts as the scope, forks ignored", () => {
      expect(
        applyDefaultFilter(all, fork("hide"), { ...RULES, scope: "all" }, () => true).afterLabels,
      ).toEqual([]);
      expect(kept(all, { scope: "all", forks: "hide" }, fork("mine"))).toEqual([
        mine,
        mineAndTheirs,
        authored,
      ]);
    });

    it("attributes an emptied list to the override", () => {
      const ctx = fork("hide");
      const f = { ...RULES, scope: "all" as const };
      expect(defaultFilterEmptiedBy(1, applyDefaultFilter([mine], ctx, f), ctx, f)).toBe("repo");
      expect(defaultFilterEmptyMessage("repo", "all")).toBe(m.issues_filter_all_repo_override());
    });
  });
});

describe("assignedOthers", () => {
  const me = "octocat";

  it("returns the assignees that are not the viewer", () => {
    expect(assignedOthers(issue(1, "T", "", [], ["someone-else", me]), me)).toEqual([
      "someone-else",
    ]);
  });

  it("returns [] for an issue assigned only to the viewer", () => {
    expect(assignedOthers(issue(2, "Mine", "", [], [me]), me)).toEqual([]);
  });

  it("returns [] for an unassigned issue", () => {
    expect(assignedOthers(issue(3, "Unassigned", "", [], []), me)).toEqual([]);
  });

  it("returns [] when the viewer is null (no 'others' claim without a known me)", () => {
    // The row surfaces its assignees via the neutral fallback, not this helper.
    expect(assignedOthers(issue(4, "T", "", [], ["someone-else"]), null)).toEqual([]);
  });

  it("does not throw on a stale payload missing assignees", () => {
    const stale = {
      number: 5,
      title: "T",
      body: "",
      url: "https://example.test/5",
      labels: [],
      createdAt: 0,
    } as unknown as Issue;
    expect(() => assignedOthers(stale, me)).not.toThrow();
    expect(assignedOthers(stale, me)).toEqual([]);
  });
});

describe("hideActive", () => {
  const plain = issue(1, "Plain", "", ["bug"]);
  const active = issue(2, "Claimed", "", ["enhancement", ACTIVE_LABEL]);
  const all = [plain, active];

  it("when enabled, drops issues labeled shepherd:active", () => {
    expect(hideActive(all, true)).toEqual([plain]);
  });

  it("keeps an issue without the active label", () => {
    expect(hideActive([plain], true)).toEqual([plain]);
  });

  it("fails open when disabled — returns all issues incl. active ones", () => {
    expect(hideActive(all, false)).toEqual(all);
  });

  it("does not throw on a stale payload missing labels", () => {
    const stale = {
      number: 3,
      title: "No labels field",
      body: "",
      url: "https://example.test/3",
      createdAt: 0,
      assignees: [],
    } as unknown as Issue;
    expect(() => hideActive([stale], true)).not.toThrow();
    expect(hideActive([stale], true)).toEqual([stale]);
  });
});

describe("hideSubIssues", () => {
  const subOnly = issue(1, "Sub-issue only");
  const subAndParent = issue(2, "Mid-level epic");
  const normalIssue = issue(3, "Regular issue");
  const all = [subOnly, subAndParent, normalIssue];

  it("when enabled, drops an issue in subIssues but not in epicParents", () => {
    const subs = new Set<number>([1]);
    const parents = new Set<number>([]);
    expect(hideSubIssues(all, true, subs, parents)).toEqual([subAndParent, normalIssue]);
  });

  it("keeps an issue that is both in subIssues and epicParents (mid-level epic)", () => {
    const subs = new Set<number>([1, 2]);
    const parents = new Set<number>([2]);
    expect(hideSubIssues(all, true, subs, parents)).toEqual([subAndParent, normalIssue]);
  });

  it("keeps an issue absent from subIssues", () => {
    const subs = new Set<number>([]);
    const parents = new Set<number>([]);
    expect(hideSubIssues(all, true, subs, parents)).toEqual(all);
  });

  it("fails open when disabled — returns all issues unchanged", () => {
    const subs = new Set<number>([1, 2]);
    const parents = new Set<number>([2]);
    expect(hideSubIssues(all, false, subs, parents)).toEqual(all);
  });

  it("fails open when subIssues is empty — returns all issues unchanged", () => {
    const subs = new Set<number>([]);
    const parents = new Set<number>([2]);
    expect(hideSubIssues(all, true, subs, parents)).toEqual(all);
  });
});

describe("distinctAuthors", () => {
  it("returns unique author logins sorted case-insensitively", () => {
    const list = [
      issue(1, "A", "", [], [], "scoop"),
      issue(2, "B", "", [], [], "Kai"),
      issue(3, "C", "", [], [], "scoop"),
    ];
    expect(distinctAuthors(list)).toEqual(["Kai", "scoop"]);
  });

  it("ignores issues without an author", () => {
    const list = [issue(1, "A", "", [], [], "kai"), issue(2, "B")];
    expect(distinctAuthors(list)).toEqual(["kai"]);
  });

  it("returns an empty array when no issue has an author", () => {
    expect(distinctAuthors([issue(1, "A"), issue(2, "B")])).toEqual([]);
  });
});

describe("distinctLabels", () => {
  it("returns unique labels sorted case-insensitively, excluding shepherd:active", () => {
    const list = [
      issue(1, "A", "", ["enhancement", ACTIVE_LABEL]),
      issue(2, "B", "", ["Bug", "enhancement"]),
    ];
    expect(distinctLabels(list)).toEqual(["Bug", "enhancement"]);
  });

  it("returns an empty array when the only label is shepherd:active", () => {
    expect(distinctLabels([issue(1, "A", "", [ACTIVE_LABEL])])).toEqual([]);
  });

  it("does not throw on a stale payload missing labels", () => {
    const stale = {
      number: 1,
      title: "No labels field",
      body: "",
      url: "https://example.test/1",
      createdAt: 0,
      assignees: [],
    } as unknown as Issue;
    expect(() => distinctLabels([stale])).not.toThrow();
    expect(distinctLabels([stale])).toEqual([]);
  });
});

describe("labelColorMap", () => {
  it("merges labelColors across issues, last-wins on a name clash", () => {
    const a = { ...issue(1, "A", "", ["bug", "enhancement"]), labelColors: { bug: "#ff0000" } };
    const b = {
      ...issue(2, "B", "", ["enhancement"]),
      labelColors: { enhancement: "#00ff00", bug: "#0000ff" },
    };
    expect(labelColorMap([a, b])).toEqual({ bug: "#0000ff", enhancement: "#00ff00" });
  });

  it("skips issues without labelColors", () => {
    const withColors = { ...issue(1, "A", "", ["bug"]), labelColors: { bug: "#ff0000" } };
    const withoutColors = issue(2, "B", "", ["enhancement"]);
    expect(labelColorMap([withColors, withoutColors])).toEqual({ bug: "#ff0000" });
  });

  it("returns an empty object for issues with no labelColors at all", () => {
    expect(labelColorMap([issue(1, "A"), issue(2, "B")])).toEqual({});
  });
});

describe("filterByAuthor", () => {
  const mine = issue(1, "Mine", "", [], [], "kai");
  const theirs = issue(2, "Theirs", "", [], [], "scoop");
  const authorless = issue(3, "Authorless");
  const all = [mine, theirs, authorless];

  it("keeps only issues by the selected author", () => {
    expect(filterByAuthor(all, "kai")).toEqual([mine]);
  });

  it("drops authorless issues when a specific author is selected", () => {
    expect(filterByAuthor(all, "scoop")).toEqual([theirs]);
  });

  it("is an identity filter when author is null", () => {
    const result = filterByAuthor(all, null);
    expect(result).toEqual(all);
    expect(result).not.toBe(all); // new array, input not mutated
  });
});

describe("filterByLabels", () => {
  const bug = issue(1, "Bug", "", ["bug"]);
  const bugAndDocs = issue(2, "Bug+Docs", "", ["bug", "docs"]);
  const docs = issue(3, "Docs", "", ["docs"]);
  const all = [bug, bugAndDocs, docs];

  it("keeps issues carrying the single selected label", () => {
    expect(filterByLabels(all, new Set(["bug"]))).toEqual([bug, bugAndDocs]);
  });

  it("requires ALL selected labels (AND semantics)", () => {
    expect(filterByLabels(all, new Set(["bug", "docs"]))).toEqual([bugAndDocs]);
  });

  it("is an identity filter when the selection is empty", () => {
    const result = filterByLabels(all, new Set());
    expect(result).toEqual(all);
    expect(result).not.toBe(all);
  });

  it("does not throw on a stale payload missing labels", () => {
    const stale = {
      number: 4,
      title: "No labels field",
      body: "",
      url: "https://example.test/4",
      createdAt: 0,
      assignees: [],
    } as unknown as Issue;
    expect(() => filterByLabels([stale], new Set(["bug"]))).not.toThrow();
    expect(filterByLabels([stale], new Set(["bug"]))).toEqual([]);
  });
});

describe("sortEpicsFirst", () => {
  const a = issue(122, "Regular A");
  const epic1 = issue(100, "Epic one");
  const b = issue(117, "Regular B");
  const epic2 = issue(90, "Epic two");
  const all = [a, epic1, b, epic2];

  it("moves epic parents to the front", () => {
    const parents = new Set<number>([100, 90]);
    expect(sortEpicsFirst(all, parents)).toEqual([epic1, epic2, a, b]);
  });

  it("preserves relative order within each group (stable)", () => {
    // epic2 appears after epic1 in the input, and a before b — both orders kept.
    const parents = new Set<number>([100, 90]);
    const result = sortEpicsFirst(all, parents);
    expect(result.map((i) => i.number)).toEqual([100, 90, 122, 117]);
  });

  it("is an identity copy when there are no epic parents", () => {
    const result = sortEpicsFirst(all, new Set<number>());
    expect(result).toEqual(all);
    expect(result).not.toBe(all); // new array, input not mutated
  });

  it("returns all issues when every issue is an epic parent", () => {
    const parents = new Set<number>([122, 100, 117, 90]);
    expect(sortEpicsFirst(all, parents)).toEqual(all);
  });
});

describe("isBlocked", () => {
  it.each([
    "blocked",
    "blocked-upstream",
    "blocked-by-net",
    "Blocked-Upstream",
    "status/blocked",
    "S: blocked",
    "kind:blocked",
  ])("matches label %j", (label) => {
    expect(isBlocked([label])).toBe(true);
  });

  it.each(["unblocked", "needs-unblock", "unblock-me"])("does not match label %j", (label) => {
    expect(isBlocked([label])).toBe(false);
  });

  it("returns false when no label matches", () => {
    expect(isBlocked(["enhancement", "bug"])).toBe(false);
  });

  it("returns false for an empty labels array", () => {
    expect(isBlocked([])).toBe(false);
  });
});

describe("hideBlockedIssues", () => {
  const plain = issue(1, "Plain", "", ["bug"]);
  const blocked = issue(2, "Blocked", "", ["blocked-upstream"]);
  const all = [plain, blocked];

  it("when on, drops blocked issues and keeps the rest", () => {
    expect(hideBlockedIssues(all, true)).toEqual([plain]);
  });

  it("when off, is an identity filter — returns all issues", () => {
    const result = hideBlockedIssues(all, false);
    expect(result).toEqual(all);
    expect(result).not.toBe(all);
  });
});

describe("distinctLabels with excludeBlocked", () => {
  const list = [
    issue(1, "A", "", ["enhancement", "blocked-upstream", ACTIVE_LABEL]),
    issue(2, "B", "", ["Bug", "status/blocked"]),
  ];

  it("omits blocked-word labels when excludeBlocked is true", () => {
    expect(distinctLabels(list, { excludeBlocked: true })).toEqual(["Bug", "enhancement"]);
  });

  it("keeps blocked-word labels when excludeBlocked is absent (existing behaviour)", () => {
    expect(distinctLabels(list)).toEqual([
      "blocked-upstream",
      "Bug",
      "enhancement",
      "status/blocked",
    ]);
  });
});

function summary(over: Partial<EpicSummary> = {}): EpicSummary {
  return {
    parentIssueNumber: 16,
    parentTitle: "Epic",
    total: 5,
    merged: 0,
    status: "idle",
    source: "markdown",
    inFlight: 0,
    inFlightBy: [],
    assignedOthers: [],
    authoredByOther: null,
    ...over,
  };
}

describe("epicFlagForOthers", () => {
  it("returns null for a non-epic row (no summary)", () => {
    expect(epicFlagForOthers(undefined)).toBeNull();
  });

  it("returns null when nothing flags the epic", () => {
    expect(epicFlagForOthers(summary())).toBeNull();
  });

  it("inflight tier wins with count + authors", () => {
    const flag = epicFlagForOthers(summary({ inFlight: 5, inFlightBy: ["scoop"] }));
    expect(flag).toEqual({ tier: "inflight", inFlight: 5, who: ["scoop"] });
  });

  it("assigned tier when there are non-viewer assignees but no in-flight", () => {
    const flag = epicFlagForOthers(summary({ assignedOthers: ["scoop", "ada"] }));
    expect(flag).toEqual({ tier: "assigned", inFlight: 0, who: ["scoop", "ada"] });
  });

  it("authored tier as the last resort (fresh unassigned epic)", () => {
    const flag = epicFlagForOthers(summary({ authoredByOther: "scoop" }));
    expect(flag).toEqual({ tier: "authored", inFlight: 0, who: ["scoop"] });
  });

  it("precedence: in-flight beats assigned beats authored", () => {
    const flag = epicFlagForOthers(
      summary({
        inFlight: 2,
        inFlightBy: ["scoop"],
        assignedOthers: ["ada"],
        authoredByOther: "x",
      }),
    );
    expect(flag?.tier).toBe("inflight");
  });
});

function child(number: number, order: number, state: EpicChild["state"] = "ready"): EpicChild {
  return {
    number,
    title: `child ${number}`,
    url: `https://x/${number}`,
    order,
    body: "",
    blockedBy: [],
    state,
    sessionId: null,
    prNumber: null,
    issueClosed: false,
    claimed: false,
  };
}

describe("buildIssueRows (#2617)", () => {
  const epic = issue(1, "Epic");
  const sub = issue(2, "Sub");
  const single = issue(3, "Single");
  const children = new Map<number, EpicChild[]>([[1, [child(2, 1), child(9, 0, "merged")]]]);
  const childrenOf = (n: number) => children.get(n);

  it("lists sub-issues only inside their expanded epic, in epic order, then singles", () => {
    const rows = buildIssueRows(
      [epic, sub, single],
      new Set([1]),
      new Set([2]),
      new Set([1]),
      childrenOf,
    );
    expect(rows.map((r) => r.key)).toEqual(["e:1", "c:1:9", "c:1:2", "s:3"]);
  });

  it("hides children while collapsed and never re-lists a sub-issue as a single", () => {
    const rows = buildIssueRows(
      [epic, sub, single],
      new Set([1]),
      new Set([2]),
      new Set(),
      childrenOf,
    );
    expect(rows.map((r) => r.key)).toEqual(["e:1", "s:3"]);
    expect(rows[0]).toMatchObject({ kind: "epic", expanded: false });
  });

  it("emits one loading row for an expanded epic whose record isn't loaded", () => {
    const rows = buildIssueRows([epic], new Set([1]), new Set(), new Set([1]), () => undefined);
    expect(rows.map((r) => r.kind)).toEqual(["epic", "loading"]);
  });

  it("keeps a nested epic as its own group", () => {
    const nested = issue(2, "Nested epic");
    const rows = buildIssueRows(
      [epic, nested],
      new Set([1, 2]),
      new Set([2]),
      new Set([1]),
      childrenOf,
    );
    expect(rows.map((r) => r.key)).toEqual(["e:1", "c:1:9", "c:1:2", "e:2"]);
  });
});

describe("stepSelection (#2617)", () => {
  const rows = buildIssueRows(
    [issue(1, "E"), issue(3, "S"), issue(4, "T")],
    new Set([1]),
    new Set(),
    new Set([1]),
    () => undefined,
  );

  it("skips the loading row and clamps at both ends", () => {
    expect(stepSelection(rows, "e:1", 1)).toBe("s:3");
    expect(stepSelection(rows, "s:3", -1)).toBe("e:1");
    expect(stepSelection(rows, "e:1", -1)).toBe("e:1");
    expect(stepSelection(rows, "s:4", 1)).toBe("s:4");
  });

  it("starts at the first row going down and the last going up", () => {
    expect(stepSelection(rows, null, 1)).toBe("e:1");
    expect(stepSelection(rows, null, -1)).toBe("s:4");
    expect(stepSelection([], null, 1)).toBeNull();
  });
});

describe("resolveSelection (#2617)", () => {
  const issues = [issue(1, "Epic"), issue(3, "Single"), issue(5, "Nested")];
  const childrenOf = (n: number) => (n === 1 ? [child(2, 0), child(5, 1)] : undefined);

  it("resolves epic, single and child keys against live data", () => {
    expect(resolveSelection("e:1", issues, new Set([1]), childrenOf)).toMatchObject({
      kind: "epic",
      issue: { number: 1 },
    });
    expect(resolveSelection("s:3", issues, new Set([1]), childrenOf)).toMatchObject({
      kind: "single",
    });
    expect(resolveSelection("c:1:2", issues, new Set([1]), childrenOf)).toMatchObject({
      kind: "child",
      parent: 1,
      child: { number: 2 },
    });
  });

  it("classifies e:/s: keys by the current epic set (summaries may land after a pick)", () => {
    expect(resolveSelection("s:1", issues, new Set([1]), childrenOf)).toMatchObject({
      kind: "epic",
    });
    expect(resolveSelection("e:3", issues, new Set([1]), childrenOf)).toMatchObject({
      kind: "single",
    });
  });

  it("resolves a child that is itself an epic parent to that epic", () => {
    expect(resolveSelection("c:1:5", issues, new Set([1, 5]), childrenOf)).toMatchObject({
      kind: "epic",
      issue: { number: 5 },
    });
  });

  it("returns null for vanished targets", () => {
    expect(resolveSelection(null, issues, new Set(), childrenOf)).toBeNull();
    expect(resolveSelection("s:99", issues, new Set(), childrenOf)).toBeNull();
    expect(resolveSelection("c:7:2", issues, new Set(), childrenOf)).toBeNull();
  });
});

describe("repo overview helpers (#2638)", () => {
  const DAY = 86_400_000;
  const now = 1_000 * DAY;
  const at = (number: number, createdDay: number, updatedDay?: number, labels: string[] = []) => ({
    ...issue(number, `Issue ${number}`, "", labels),
    createdAt: createdDay * DAY,
    ...(updatedDay == null ? {} : { updatedAt: updatedDay * DAY }),
  });

  it("lastChange prefers updatedAt and falls back to createdAt", () => {
    expect(lastChange(at(1, 10, 500))).toBe(500 * DAY);
    expect(lastChange(at(2, 10))).toBe(10 * DAY);
  });

  it("sortOldestFirst orders by last change, least recent first", () => {
    const sorted = sortOldestFirst([at(1, 0, 900), at(2, 800), at(3, 0, 100)]);
    expect(sorted.map((i) => i.number)).toEqual([3, 2, 1]);
  });

  it("staleSummary counts issues unchanged for over 90 days and names the oldest", () => {
    // #1 changed 10 days ago; #2 created 200 days ago, never changed; #3 changed 95 days ago.
    const summary = staleSummary([at(1, 0, 990), at(2, 800), at(3, 0, 905)], now);
    expect(summary.stale).toBe(2);
    expect(summary.total).toBe(3);
    expect(summary.oldest?.issue.number).toBe(2);
    expect(summary.oldest?.days).toBe(200);
    expect(staleSummary([], now)).toEqual({ stale: 0, total: 0, oldest: null });
  });

  it("labelCounts counts only the given labels, most first", () => {
    const issues = [at(1, 0, 0, ["bug", ACTIVE_LABEL]), at(2, 0, 0, ["bug", "docs"]), at(3, 0)];
    expect(labelCounts(issues, ["docs", "bug", "absent"])).toEqual([
      { label: "bug", count: 2 },
      { label: "docs", count: 1 },
    ]);
  });

  it("runningIssues lists a live session or the claim label, even when the list hides it", () => {
    const issues = [at(1, 0, 0, [ACTIVE_LABEL]), at(2, 0), at(3, 0)];
    const sessionFor = (n: number) => (n === 2 ? { id: "s2", desig: "TASK-02" } : null);
    expect(runningIssues(issues, sessionFor, new Set([2, 3]))).toEqual([
      { issue: issues[0], sessionId: null, desig: null, hidden: true },
      { issue: issues[1], sessionId: "s2", desig: "TASK-02", hidden: false },
    ]);
  });
});

describe("stripEpicPrefix", () => {
  it("drops a prefix that only repeats the epic's number", () => {
    expect(stripEpicPrefix("Stack-Angleichung (#158): Foo bar", 158)).toBe("Foo bar");
    expect(stripEpicPrefix("Epic (#158):Foo", 158)).toBe("Foo");
  });

  it("strips only the first prefix of a title with more colons", () => {
    expect(stripEpicPrefix("Stack (#158): fix(ui): wrap", 158)).toBe("fix(ui): wrap");
  });

  it("leaves other epics' numbers, bare numbers and unprefixed titles alone", () => {
    expect(stripEpicPrefix("Stack-Angleichung (#158): Foo", 99)).toBe(
      "Stack-Angleichung (#158): Foo",
    );
    expect(stripEpicPrefix("Stack-Angleichung (#158) Foo", 158)).toBe(
      "Stack-Angleichung (#158) Foo",
    );
    expect(stripEpicPrefix("Plain title", 158)).toBe("Plain title");
  });

  it("keeps the whole title when nothing is left after the prefix", () => {
    expect(stripEpicPrefix("Stack (#158):  ", 158)).toBe("Stack (#158):  ");
  });
});

describe("activeFilterChips (#2639)", () => {
  const OFF: IssueFilterSettings = {
    scope: "all",
    forks: "all",
    hiddenLabels: [],
    hideActive: false,
    hideSubIssues: true,
    hideBlocked: false,
  };
  const toggles = (over: Partial<IssueFilterSettings>) => ({
    filter: { ...OFF, ...over },
    update: vi.fn(),
  });
  const base = {
    mineOffered: true,
    isFork: true,
    author: null,
    labels: [],
    clearAuthor: vi.fn(),
    clearLabel: vi.fn(),
  };

  it("is empty when nothing filters", () => {
    expect(activeFilterChips({ ...base, toggles: toggles({}) })).toEqual([]);
  });

  it("lists every rule, the author and each label, in that order", () => {
    const chips = activeFilterChips({
      ...base,
      toggles: toggles({
        scope: "mine_unassigned",
        forks: "hide",
        hiddenLabels: ["wontfix"],
        hideActive: true,
        hideBlocked: true,
      }),
      author: "octocat",
      labels: ["bug", "docs"],
    });
    expect(chips.map((c) => c.id)).toEqual([
      "active",
      "blocked",
      "others",
      "forks",
      "hidden:wontfix",
      "author",
      "label:bug",
      "label:docs",
    ]);
    expect(chips.map((c) => c.label)).toEqual([
      m.issues_filter_chip_active(),
      m.issues_filter_chip_blocked(),
      m.issues_filter_chip_others(),
      m.upnext_filter_chip_forks_hide(),
      m.upnext_filter_chip_label({ label: "wontfix" }),
      m.issues_filter_chip_author({ name: "octocat" }),
      "bug",
      "docs",
    ]);
  });

  it("each chip's clear turns off exactly its filter", () => {
    const t = toggles({
      scope: "mine",
      forks: "own",
      hiddenLabels: ["a", "B"],
      hideActive: true,
      hideBlocked: true,
    });
    const clearAuthor = vi.fn();
    const clearLabel = vi.fn();
    const chips = activeFilterChips({
      ...base,
      toggles: t,
      author: "a",
      labels: ["bug"],
      clearAuthor,
      clearLabel,
    });
    const byId = (id: string) => chips.find((c) => c.id === id)!.clear();
    byId("active");
    expect(t.update).toHaveBeenLastCalledWith({ hideActive: false });
    byId("blocked");
    expect(t.update).toHaveBeenLastCalledWith({ hideBlocked: false });
    byId("others");
    expect(t.update).toHaveBeenLastCalledWith({ scope: "all" });
    byId("forks");
    expect(t.update).toHaveBeenLastCalledWith({ forks: "all" });
    byId("hidden:B");
    expect(t.update).toHaveBeenLastCalledWith({ hiddenLabels: ["a"] });
    byId("author");
    expect(clearAuthor).toHaveBeenCalled();
    byId("label:bug");
    expect(clearLabel).toHaveBeenCalledWith("bug");
  });

  it("skips the scope rule without a viewer and the fork rule outside a fork", () => {
    const chips = activeFilterChips({
      ...base,
      mineOffered: false,
      isFork: false,
      toggles: toggles({ scope: "mine", forks: "hide" }),
    });
    expect(chips).toEqual([]);
  });
});

describe("shownOfTotal (#2639)", () => {
  const issue = (number: number): Issue => ({
    number,
    title: `#${number}`,
    body: "",
    url: "",
    labels: [],
    createdAt: 0,
    assignees: [],
  });
  const issues = [issue(1), issue(2), issue(3), issue(4)];
  const epics = new Set([1]);
  const subs = new Set([4]);
  const rowsFor = (visible: Issue[]) =>
    buildIssueRows(visible, epics, subs, new Set(), () => undefined);

  it("counts top-level issues (epics + singles, not sub-issues) against the rendered rows", () => {
    expect(shownOfTotal(rowsFor([issue(1), issue(3)]), issues, epics, subs)).toEqual({
      shown: 2,
      total: 3,
    });
  });

  it("is null when nothing is hidden", () => {
    expect(shownOfTotal(rowsFor(issues), issues, epics, subs)).toBeNull();
  });

  it("ignores an expanded epic's child rows", () => {
    const rows = buildIssueRows([issue(1)], epics, subs, new Set([1]), () => [
      {
        number: 4,
        title: "child",
        url: "",
        order: 0,
        body: "",
        blockedBy: [],
        state: "ready",
        sessionId: null,
        prNumber: null,
        issueClosed: false,
        claimed: false,
      },
    ]);
    expect(shownOfTotal(rows, issues, epics, subs)).toEqual({ shown: 1, total: 3 });
  });
});

describe("shortcutHints (#2639)", () => {
  it("names → only with epics and Esc only with a selection", () => {
    expect(shortcutHints({ hasEpics: false, selected: false })).toBe(
      `${m.issuespanel_hint_select()} · ${m.issuespanel_hint_start()}`,
    );
    expect(shortcutHints({ hasEpics: true, selected: true })).toBe(
      [
        m.issuespanel_hint_select(),
        m.issuespanel_hint_expand(),
        m.issuespanel_hint_start(),
        m.issuespanel_hint_esc(),
      ].join(" · "),
    );
  });
});
