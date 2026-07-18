/**
 * Unit tests for IssuesPanel logic (issues-panel.ts).
 *
 * Follows the backlog-view.test.ts pattern: the Svelte component has no DOM
 * test infrastructure here, so we cover the extracted pure filter the template
 * delegates to.
 */
import { describe, it, expect } from "vitest";
import {
  filterIssues,
  hideOthers,
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
  hideOthersExceptFlaggedEpics,
  assignedOthers,
} from "./issues-panel";
import type { Issue, EpicSummary } from "$lib/types";

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

describe("hideOthers", () => {
  const me = "octocat";
  const unassigned = issue(1, "Unassigned", "", [], []);
  const mine = issue(2, "Mine", "", [], [me]);
  const theirs = issue(3, "Theirs", "", [], ["someone-else"]);
  const mineAndTheirs = issue(4, "Shared", "", [], ["someone-else", me]);
  const all = [unassigned, mine, theirs, mineAndTheirs];

  it("when enabled, shows unassigned + mine + shared, hides others' issues", () => {
    expect(hideOthers(all, me, true)).toEqual([unassigned, mine, mineAndTheirs]);
  });

  it("keeps an issue assigned to me alone", () => {
    expect(hideOthers([mine], me, true)).toEqual([mine]);
  });

  it("keeps an unassigned issue", () => {
    expect(hideOthers([unassigned], me, true)).toEqual([unassigned]);
  });

  it("hides an issue assigned only to others", () => {
    expect(hideOthers([theirs], me, true)).toEqual([]);
  });

  it("keeps an issue assigned to me and others", () => {
    expect(hideOthers([mineAndTheirs], me, true)).toEqual([mineAndTheirs]);
  });

  it("fails open when disabled — returns all issues", () => {
    expect(hideOthers(all, me, false)).toEqual(all);
  });

  it("fails open when the viewer is null — returns all issues", () => {
    expect(hideOthers(all, null, true)).toEqual(all);
  });

  it("does not throw on a stale payload missing assignees", () => {
    // Simulate an old-shape issue (e.g. mid rolling-deploy) whose payload predates
    // the `assignees` field — the `?? []` guard must keep it from throwing.
    const stale = {
      number: 1,
      title: "Unassigned",
      body: "",
      url: "https://example.test/1",
      labels: [],
      createdAt: 0,
    } as unknown as Issue;
    expect(() => hideOthers([stale], me, true)).not.toThrow();
    expect(hideOthers([stale], me, true)).toEqual([stale]);
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

describe("hideOthersExceptFlaggedEpics", () => {
  const epicByNumber = new Map<number, EpicSummary>([
    [16, summary({ parentIssueNumber: 16, inFlight: 3, inFlightBy: ["scoop"] })],
  ]);

  it("keeps a flagged epic assigned to others (would be hidden by plain hideOthers)", () => {
    const rows = [issue(16, "Epic", "", [], ["scoop"])]; // assigned to scoop, viewer is kai
    const kept = hideOthersExceptFlaggedEpics(rows, "kai", true, epicByNumber);
    expect(kept.map((i) => i.number)).toEqual([16]);
    // plain hideOthers would drop it
    expect(hideOthers(rows, "kai", true).map((i) => i.number)).toEqual([]);
  });

  it("still hides a non-epic issue assigned only to others", () => {
    const rows = [issue(99, "Plain", "", [], ["scoop"])];
    expect(hideOthersExceptFlaggedEpics(rows, "kai", true, epicByNumber)).toEqual([]);
  });

  it("keeps mine + unassigned rows unchanged", () => {
    const rows = [issue(1, "Mine", "", [], ["kai"]), issue(2, "Unassigned", "", [], [])];
    expect(
      hideOthersExceptFlaggedEpics(rows, "kai", true, epicByNumber).map((i) => i.number),
    ).toEqual([1, 2]);
  });

  it("is an identity filter when disabled or viewer unknown", () => {
    const rows = [issue(99, "Plain", "", [], ["scoop"])];
    expect(hideOthersExceptFlaggedEpics(rows, "kai", false, epicByNumber)).toHaveLength(1);
    expect(hideOthersExceptFlaggedEpics(rows, null, true, epicByNumber)).toHaveLength(1);
  });
});
