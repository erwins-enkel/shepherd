import { test, expect, describe } from "bun:test";
import { assembleEpic, type AssembleInput } from "../src/epic-model";

const BASE: AssembleInput = {
  repoPath: "/repo",
  run: { repoPath: "/repo", parentIssueNumber: 327, mode: "auto", status: "running" },
  parent: { number: 327, title: "EFI cluster", body: "" },
  // native per-child state: 320 closed; 322 open + body, UNCLAIMED — NO listIssues needed.
  // 322 stays unclaimed so its ready/blocked state proves native closed-detection of its blocker.
  subIssues: [
    { number: 320, title: "EFI", url: "u320", body: "b320", closed: true, labels: [] },
    {
      number: 322,
      title: "effort",
      url: "u322",
      body: "effort body",
      closed: false,
      labels: [],
    },
  ],
  blockedBy: new Map([[322, [320]]]),
  openIssues: [], // markdown-only input; ignored on the native path
  openIssuesTruncated: false,
  sessions: [],
};

describe("assembleEpic", () => {
  test("native: order/state/body from sub-issue payload (no listIssues)", () => {
    const e = assembleEpic(BASE);
    expect(e.source).toBe("native");
    expect(e.children.map((c) => c.number)).toEqual([320, 322]);
    expect(e.children.find((c) => c.number === 320)!.state).toBe("merged"); // closed via native state
    // 322 open, unclaimed, blocker 320 closed (native) → ready
    expect(e.children.find((c) => c.number === 322)!.state).toBe("ready");
    expect(e.children.find((c) => c.number === 322)!.claimed).toBe(false);
    expect(e.children.find((c) => c.number === 322)!.body).toBe("effort body");
  });
  test("native gating is correct even when openIssues is empty/over-cap", () => {
    // 320 NOT in openIssues at all — old code would misread it; native state keeps it closed.
    // 322 (unclaimed) is "ready" ONLY because 320 was detected closed from native state, not openIssues.
    expect(assembleEpic(BASE).children.find((c) => c.number === 322)!.state).toBe("ready");
  });
  test("claimed child with no live session surfaces as in-review (retired/in-flight, PR awaiting merge)", () => {
    const e = assembleEpic({
      ...BASE,
      subIssues: [
        { number: 320, title: "EFI", url: "u320", body: "", closed: true, labels: [] },
        {
          number: 324,
          title: "wts",
          url: "u324",
          body: "",
          closed: false,
          labels: ["shepherd:active"],
        },
      ],
      blockedBy: new Map(),
    });
    const c = e.children.find((x) => x.number === 324)!;
    expect(c.claimed).toBe(true);
    expect(c.sessionId).toBeNull();
    expect(c.state).toBe("in-review");
  });
  test("markdown fallback derives state from openIssues + warns on truncation", () => {
    const e = assembleEpic({
      ...BASE,
      subIssues: [],
      blockedBy: new Map(),
      parent: { number: 1, title: "p", body: "```epic-dag\n#2\n#3 <- #2\n```" },
      openIssues: [
        { number: 2, body: "", labels: [] },
        { number: 3, body: "", labels: [] },
      ],
      openIssuesTruncated: true,
    });
    expect(e.source).toBe("markdown");
    expect(e.children.find((c) => c.number === 3)!.state).toBe("blocked"); // #2 open → not closed
    expect(e.warnings.some((w) => w.includes("truncated"))).toBe(true);
  });
  test("non-member + self edges dropped + warned", () => {
    const e = assembleEpic({ ...BASE, blockedBy: new Map([[322, [999, 322]]]) });
    expect(e.children.find((c) => c.number === 322)!.blockedBy).toEqual([]);
    expect(e.warnings.filter((w) => w.includes("blocked_by")).length).toBe(2);
  });
});
