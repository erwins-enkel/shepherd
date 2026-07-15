import { test, expect, describe } from "bun:test";
import {
  buildSnapshot,
  excludeHiddenSections,
  PRIORITY_CAP,
  REPO_CAP,
  type RepoInput,
  type EpicUnitInput,
  type UpNextSnapshot,
  type UpNextSection,
  type UpNextItem,
} from "../src/up-next-core";
import type { Issue } from "../src/forge/types";

function issue(number: number, over: Partial<Issue> = {}): Issue {
  return {
    number,
    title: `t${number}`,
    body: `body${number}`,
    url: `https://x/${number}`,
    labels: [],
    createdAt: number, // default: createdAt == number so "oldest" == lowest number
    assignees: [],
    ...over,
  };
}

function repo(over: Partial<RepoInput> = {}): RepoInput {
  return {
    repoPath: "/r/a",
    repoSlug: "o/a",
    repoLabel: "a",
    lastUsedAt: 0,
    viewer: null,
    openIssues: [],
    epics: [],
    subIssueNumbers: [],
    linkedIssueNumbers: [],
    ...over,
  };
}

function epic(over: Partial<EpicUnitInput> = {}): EpicUnitInput {
  return {
    parentNumber: 100,
    parentTitle: "epic",
    parentUrl: "https://x/100",
    parentCreatedAt: 100,
    parentLabels: [],
    parentAssignees: [],
    memberNumbers: [],
    candidate: null,
    ...over,
  };
}

const NOW = 1_000_000;
const sections = (r: RepoInput[]) => buildSnapshot(r, NOW).sections;
const repoSection = (r: RepoInput[], path: string) =>
  sections(r).find((s) => s.kind === "repo" && s.repoPath === path);
const prioritySection = (r: RepoInput[]) => sections(r).find((s) => s.kind === "priority");

describe("classification", () => {
  test("bug labels (bug / type/bug / type:bug) → bug kind", () => {
    for (const l of ["bug", "type/bug", "type:bug", "BUG"]) {
      const r = [repo({ openIssues: [issue(1, { labels: [l] })] })];
      expect(repoSection(r, "/r/a")!.items[0]!.kind).toBe("bug");
    }
  });
  test("non-bug issue → feature kind (default)", () => {
    const r = [repo({ openIssues: [issue(1, { labels: ["enhancement"] }), issue(2)] })];
    const items = repoSection(r, "/r/a")!.items;
    expect(items.every((i) => i.kind === "feature")).toBe(true);
  });
});

describe("labels", () => {
  test("standalone item carries the issue's labels and available forge colors", () => {
    const r = [
      repo({
        openIssues: [
          issue(1, {
            labels: ["enhancement", "bug"],
            labelColors: { enhancement: "#111111", bug: "#d73a4a" },
          }),
        ],
      }),
    ];
    const item = repoSection(r, "/r/a")!.items[0]!;
    expect(item.labels).toEqual(["enhancement", "bug"]);
    expect(item.labelColors).toEqual({ enhancement: "#111111", bug: "#d73a4a" });
  });
  test("epic unit carries the PARENT's labels and colors, not the candidate child's", () => {
    const r = [
      repo({
        openIssues: [issue(1), issue(2)],
        epics: [
          epic({
            parentNumber: 100,
            memberNumbers: [2],
            parentLabels: ["enhancement", "epic"],
            parentLabelColors: { enhancement: "#111111", epic: "#7057ff" },
            candidate: issue(2, {
              labels: ["unrelated-child-label"],
              labelColors: { "unrelated-child-label": "#ffffff" },
            }),
          }),
        ],
      }),
    ];
    const epicRow = repoSection(r, "/r/a")!.items.find((i) => i.kind === "epic")!;
    expect(epicRow.labels).toEqual(["enhancement", "epic"]);
    expect(epicRow.labelColors).toEqual({ enhancement: "#111111", epic: "#7057ff" });
  });
});

describe("exclusions", () => {
  test("shepherd:active is excluded", () => {
    const r = [repo({ openIssues: [issue(1, { labels: ["shepherd:active"] }), issue(2)] })];
    expect(repoSection(r, "/r/a")!.items.map((i) => i.number)).toEqual([2]);
  });
  test("wontfix / blocked excluded (case-insensitive)", () => {
    const r = [
      repo({
        openIssues: [
          issue(1, { labels: ["WontFix"] }),
          issue(2, { labels: ["blocked"] }),
          issue(3),
        ],
      }),
    ];
    expect(repoSection(r, "/r/a")!.items.map((i) => i.number)).toEqual([3]);
  });
  test("blocked-word label variants excluded (word-boundary, mirrors UI isBlocked)", () => {
    // Up Next only lists startable work, so any blocked-word label is dropped — not just the
    // exact `blocked`. `unblocked` has no word boundary before "blocked", so it is NOT excluded.
    const r = [
      repo({
        openIssues: [
          issue(1, { labels: ["blocked-upstream"] }),
          issue(2, { labels: ["status:blocked"] }),
          issue(3, { labels: ["unblocked"] }),
          issue(4),
        ],
      }),
    ];
    expect(repoSection(r, "/r/a")!.items.map((i) => i.number)).toEqual([3, 4]);
  });
  test("bot-authored issues excluded (dependabot + [bot] suffix)", () => {
    const r = [
      repo({
        openIssues: [
          issue(1, { author: "dependabot[bot]" }),
          issue(2, { author: "app/dependabot" }),
          issue(3, { author: "renovate[bot]" }),
          issue(4, { author: "alice" }),
          issue(5),
        ],
      }),
    ];
    expect(repoSection(r, "/r/a")!.items.map((i) => i.number)).toEqual([4, 5]);
  });
  test("issue with an open linked PR excluded (best-effort secondary)", () => {
    const r = [repo({ openIssues: [issue(1), issue(2)], linkedIssueNumbers: [1] })];
    expect(repoSection(r, "/r/a")!.items.map((i) => i.number)).toEqual([2]);
  });
  test("standalone issue with an open blocker excluded; empty/undefined blockedBy included (#1622)", () => {
    const r = [
      repo({
        openIssues: [
          issue(1, { blockedBy: [1642] }),
          issue(2, { blockedBy: [] }),
          issue(3), // blockedBy undefined
        ],
      }),
    ];
    expect(repoSection(r, "/r/a")!.items.map((i) => i.number)).toEqual([2, 3]);
  });
  test("blocked-by exclusion is independent of the `blocked` LABEL path", () => {
    // #1 has an open blocker but no `blocked` label — must still be excluded via blockedBy alone.
    const r = [repo({ openIssues: [issue(1, { blockedBy: [99], labels: [] }), issue(2)] })];
    expect(repoSection(r, "/r/a")!.items.map((i) => i.number)).toEqual([2]);
  });
  test("fully-excluded repo emits no section", () => {
    const r = [repo({ openIssues: [issue(1, { labels: ["shepherd:active"] })] })];
    expect(repoSection(r, "/r/a")).toBeUndefined();
  });
});

describe("assignee filter — mine & unassigned (#824)", () => {
  test("standalone: keeps unassigned & mine, drops assigned-solely-to-others", () => {
    const r = [
      repo({
        viewer: "me",
        openIssues: [
          issue(1), // unassigned → keep
          issue(2, { assignees: ["me"] }), // mine → keep
          issue(3, { assignees: ["other"] }), // solely others → drop
          issue(4, { assignees: ["other", "me"] }), // mine + others → keep
        ],
      }),
    ];
    expect(repoSection(r, "/r/a")!.items.map((i) => i.number)).toEqual([1, 2, 4]);
  });
  test("standalone: viewer null fails open (no assignee filtering)", () => {
    const r = [
      repo({
        viewer: null,
        openIssues: [issue(1, { assignees: ["other"] }), issue(2, { assignees: ["a", "b"] })],
      }),
    ];
    expect(repoSection(r, "/r/a")!.items.map((i) => i.number)).toEqual([1, 2]);
  });
  test("epic unit: filtered by PARENT assignees, not the candidate child", () => {
    // Parent assigned solely to "other" → unit hidden even though the candidate child carries
    // no assignees (the child is synthesized with assignees:[]).
    const r = [
      repo({
        viewer: "me",
        epics: [epic({ parentAssignees: ["other"], memberNumbers: [2], candidate: issue(2) })],
      }),
    ];
    expect(repoSection(r, "/r/a")).toBeUndefined();
  });
  test("epic unit: parent unassigned / mine surfaces; viewer null keeps it", () => {
    const mkRepo = (viewer: string | null, parentAssignees: string[]) =>
      repo({
        viewer,
        epics: [epic({ parentAssignees, memberNumbers: [2], candidate: issue(2) })],
      });
    for (const r of [
      mkRepo("me", []), // parent unassigned → keep
      mkRepo("me", ["me"]), // parent mine → keep
      mkRepo(null, ["other"]), // unknown "me" → fail open → keep
    ]) {
      const items = repoSection([r], "/r/a")!.items;
      expect(items.filter((i) => i.kind === "epic")).toHaveLength(1);
    }
  });
});

describe("epics as one unit", () => {
  test("epic children are removed from the flat list and collapsed to one unit", () => {
    const r = [
      repo({
        openIssues: [issue(1), issue(2), issue(3)],
        epics: [
          epic({
            parentNumber: 100,
            parentCreatedAt: 5,
            memberNumbers: [2, 3],
            candidate: issue(2),
          }),
        ],
      }),
    ];
    const items = repoSection(r, "/r/a")!.items;
    // #2,#3 collapsed; one epic unit (keyed by child #2) + standalone #1.
    const epicItems = items.filter((i) => i.kind === "epic");
    expect(epicItems).toHaveLength(1);
    expect(epicItems[0]!.number).toBe(2);
    expect(epicItems[0]!.epicParent).toEqual({ number: 100, title: "epic" });
    // #2 must NOT also appear as a standalone non-epic row.
    expect(items.filter((i) => i.number === 2 && i.kind !== "epic")).toHaveLength(0);
    // #3 (other member) is gone entirely.
    expect(items.find((i) => i.number === 3)).toBeUndefined();
  });
  test("native sub-issue numbers are removed from the flat list (orphan off-page child)", () => {
    // #7 is a native sub-issue whose parent is off-page (no epic unit built) → must not list.
    const r = [repo({ openIssues: [issue(7), issue(8)], subIssueNumbers: [7] })];
    expect(repoSection(r, "/r/a")!.items.map((i) => i.number)).toEqual([8]);
  });
  test("epic with no actionable candidate is suppressed", () => {
    const r = [
      repo({ openIssues: [issue(1)], epics: [epic({ memberNumbers: [1], candidate: null })] }),
    ];
    const sec = repoSection(r, "/r/a");
    // #1 removed as a member; no candidate → no epic row → no section at all.
    expect(sec).toBeUndefined();
  });
  test("epic unit is aged by the PARENT createdAt, not the child", () => {
    // child #2 createdAt=2 (young), parent createdAt=1 (old) → epic sorts before bug #5.
    const r = [
      repo({
        openIssues: [issue(5, { labels: ["bug"], createdAt: 1 }), issue(2, { createdAt: 2 })],
        epics: [
          epic({ parentCreatedAt: 1, memberNumbers: [2], candidate: issue(2, { createdAt: 2 }) }),
        ],
      }),
    ];
    const items = repoSection(r, "/r/a")!.items;
    expect(items[0]!.kind).toBe("epic"); // epic tier wins anyway
    expect(items[0]!.createdAt).toBe(1); // aged by parent
  });
  test("priority epic (priority parent) goes to the Priority section", () => {
    const r = [
      repo({
        epics: [
          epic({
            parentLabels: ["shepherd:priority"],
            memberNumbers: [2],
            candidate: issue(2),
          }),
        ],
      }),
    ];
    const p = prioritySection(r);
    expect(p!.items.map((i) => i.number)).toEqual([2]);
    expect(p!.items[0]!.priority).toBe(true);
    expect(repoSection(r, "/r/a")).toBeUndefined(); // pulled out of repo section
  });
  test("epic whose child has a linked PR is suppressed", () => {
    const r = [
      repo({
        epics: [epic({ memberNumbers: [2], candidate: issue(2) })],
        linkedIssueNumbers: [2],
      }),
    ];
    expect(repoSection(r, "/r/a")).toBeUndefined();
  });
  test("epic unit suppressed when its parent has an open blocker; not when empty (#1622)", () => {
    const blocked = [
      repo({
        epics: [epic({ memberNumbers: [2], candidate: issue(2), parentBlockedBy: [99] })],
      }),
    ];
    expect(repoSection(blocked, "/r/a")).toBeUndefined();
    const notBlocked = [
      repo({
        epics: [epic({ memberNumbers: [2], candidate: issue(2), parentBlockedBy: [] })],
      }),
    ];
    expect(repoSection(notBlocked, "/r/a")!.items.filter((i) => i.kind === "epic")).toHaveLength(1);
  });
});

describe("ranking", () => {
  test("priority section: warm-first across repos, then oldest age", () => {
    const warm = repo({
      repoPath: "/r/warm",
      repoLabel: "warm",
      lastUsedAt: 999,
      openIssues: [
        issue(10, { labels: ["shepherd:priority"], createdAt: 50 }),
        issue(11, { labels: ["shepherd:priority"], createdAt: 20 }),
      ],
    });
    const cold = repo({
      repoPath: "/r/cold",
      repoLabel: "cold",
      lastUsedAt: 1,
      openIssues: [issue(20, { labels: ["shepherd:priority"], createdAt: 5 })],
    });
    const p = prioritySection([cold, warm])!;
    // warm repo first (both its items), oldest-age-first within repo; cold last.
    expect(p.items.map((i) => i.number)).toEqual([11, 10, 20]);
  });
  test("within a repo: epic-unit → bug → feature, then oldest age", () => {
    const r = [
      repo({
        openIssues: [
          issue(1, { labels: ["bug"], createdAt: 30 }),
          issue(2, { createdAt: 10 }), // feature
          issue(3, { labels: ["bug"], createdAt: 40 }),
          issue(9, { createdAt: 99 }), // epic child
        ],
        epics: [epic({ parentCreatedAt: 1, memberNumbers: [9], candidate: issue(9) })],
      }),
    ];
    const items = repoSection(r, "/r/a")!.items;
    expect(items.map((i) => i.kind)).toEqual(["epic", "bug", "bug", "feature"]);
    expect(items.map((i) => i.number)).toEqual([9, 1, 3, 2]); // bugs oldest-first
  });
  test("repo sections appear in warm order", () => {
    const a = repo({ repoPath: "/r/a", repoLabel: "a", lastUsedAt: 10, openIssues: [issue(1)] });
    const b = repo({ repoPath: "/r/b", repoLabel: "b", lastUsedAt: 99, openIssues: [issue(1)] });
    const repoSecs = sections([a, b]).filter((s) => s.kind === "repo");
    expect(repoSecs.map((s) => s.repoPath)).toEqual(["/r/b", "/r/a"]);
  });
});

describe("caps", () => {
  test("repo section returns the full list + totalCount (UI caps display at REPO_CAP)", () => {
    const many = Array.from({ length: REPO_CAP + 4 }, (_, i) => issue(i + 1));
    const sec = repoSection([repo({ openIssues: many })], "/r/a")!;
    expect(sec.items).toHaveLength(REPO_CAP + 4);
    expect(sec.totalCount).toBe(REPO_CAP + 4);
  });
  test("priority section returns the full list + totalCount (UI caps display at PRIORITY_CAP)", () => {
    const many = Array.from({ length: PRIORITY_CAP + 3 }, (_, i) =>
      issue(i + 1, { labels: ["shepherd:priority"] }),
    );
    const p = prioritySection([repo({ openIssues: many })])!;
    expect(p.items).toHaveLength(PRIORITY_CAP + 3);
    expect(p.totalCount).toBe(PRIORITY_CAP + 3);
  });
});

describe("snapshot shape", () => {
  test("priority section first, then repo sections; carries repoCount + fallback", () => {
    const r = [
      repo({
        repoPath: "/r/a",
        openIssues: [issue(1, { labels: ["shepherd:priority"] }), issue(2)],
      }),
    ];
    const snap = buildSnapshot(r, NOW, "warm-repos-only");
    expect(snap.generatedAt).toBe(NOW);
    expect(snap.repoCount).toBe(1);
    expect(snap.fallback).toBe("warm-repos-only");
    expect(snap.sections[0]!.kind).toBe("priority");
    expect(snap.sections[1]!.kind).toBe("repo");
  });
  test("empty input → no sections", () => {
    expect(buildSnapshot([], NOW).sections).toEqual([]);
  });
});

// ── excludeHiddenSections ────────────────────────────────────────────────────

function makeItem(repoPath: string, num: number): UpNextItem {
  return {
    repoPath,
    repoSlug: "o/r",
    repoLabel: "r",
    number: num,
    title: `t${num}`,
    url: `https://x/${num}`,
    kind: "feature",
    priority: false,
    createdAt: num,
    labels: [],
    issueRef: { number: num, url: `https://x/${num}`, title: `t${num}`, body: "" },
  };
}

function makeRepoSection(repoPath: string, items: UpNextItem[] = []): UpNextSection {
  return {
    kind: "repo",
    repoPath,
    repoSlug: "o/r",
    repoLabel: "r",
    items,
    totalCount: items.length,
  };
}

function makePrioritySection(items: UpNextItem[]): UpNextSection {
  return {
    kind: "priority",
    repoPath: null,
    repoSlug: null,
    repoLabel: null,
    items,
    totalCount: items.length,
  };
}

function makeSnap(sections: UpNextSection[], repoCount: number): UpNextSnapshot {
  return { generatedAt: 1000, sections, repoCount, fallback: null, failedRepoCount: 0 };
}

describe("excludeHiddenSections", () => {
  test("(e) hidden repo section removed; repoCount decremented", () => {
    const snap = makeSnap([makeRepoSection("/r/a"), makeRepoSection("/r/b")], 2);
    const result = excludeHiddenSections(snap, new Set(["/r/a"]));
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.repoPath).toBe("/r/b");
    expect(result.repoCount).toBe(1);
    expect(result.generatedAt).toBe(snap.generatedAt);
    expect(result.fallback).toBe(snap.fallback);
  });

  test("(f) hidden repo item dropped from priority; section dropped when empty", () => {
    const item = makeItem("/r/a", 1);
    const snap = makeSnap([makePrioritySection([item]), makeRepoSection("/r/a", [item])], 1);
    const result = excludeHiddenSections(snap, new Set(["/r/a"]));
    expect(result.sections).toHaveLength(0);
    expect(result.repoCount).toBe(0);
  });

  test("(f2) priority section partially filtered; totalCount recomputed; non-hidden repo kept", () => {
    const itemA = makeItem("/r/a", 1);
    const itemB = makeItem("/r/b", 2);
    const snap = makeSnap(
      [
        makePrioritySection([itemA, itemB]),
        makeRepoSection("/r/a", [itemA]),
        makeRepoSection("/r/b", [itemB]),
      ],
      2,
    );
    const result = excludeHiddenSections(snap, new Set(["/r/a"]));
    const pSec = result.sections.find((s) => s.kind === "priority");
    expect(pSec).toBeDefined();
    expect(pSec!.items.map((i) => i.number)).toEqual([2]);
    expect(pSec!.totalCount).toBe(1);
    const repoSecs = result.sections.filter((s) => s.kind === "repo");
    expect(repoSecs).toHaveLength(1);
    expect(repoSecs[0]!.repoPath).toBe("/r/b");
    expect(result.repoCount).toBe(1);
  });

  test("(g) empty hiddenRaw → same snapshot reference returned (fast-path)", () => {
    const snap = makeSnap([makeRepoSection("/r/a")], 1);
    expect(excludeHiddenSections(snap, new Set())).toBe(snap);
  });

  test("(g2) non-empty hiddenRaw with no match → sections and repoCount unchanged", () => {
    const snap = makeSnap([makeRepoSection("/r/a")], 1);
    const result = excludeHiddenSections(snap, new Set(["/r/z"]));
    expect(result.sections).toHaveLength(1);
    expect(result.repoCount).toBe(1);
  });
});
