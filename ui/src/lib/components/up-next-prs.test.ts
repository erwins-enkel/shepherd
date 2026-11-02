import { describe, expect, test } from "vitest";
import type { UpNextPr } from "#lib/types.js";
import { m } from "#lib/paraglide/messages.js";
import { actionTip } from "./up-next-pr-copy";
import {
  buttonAction,
  ciShown,
  dependabotIgnoreTargets,
  mergeBlock,
  prBandGroups,
  prsInRepos,
  readyPrCount,
} from "./up-next-prs";

const pr = (number: number, over: Partial<UpNextPr> = {}): UpNextPr => ({
  repoPath: "/r/a",
  repoSlug: "o/a",
  repoLabel: "a",
  number,
  title: `pr${number}`,
  url: `https://x/pull/${number}`,
  author: "me",
  kind: "regular",
  createdAt: number,
  checks: "success",
  mergeable: true,
  band: "ready",
  action: "merge",
  ...over,
});

describe("prBandGroups", () => {
  test("orders the bands and keeps the server's order inside each", () => {
    const groups = prBandGroups([
      pr(1, { band: "dependabot", kind: "dependabot" }),
      pr(2, { band: "blocked", action: "fix", blockReason: "ci_failed" }),
      pr(4),
      pr(3),
      pr(5, { band: "review", action: "review" }),
    ]);
    expect(groups.map((g) => [g.band, g.items.map((p) => p.number)])).toEqual([
      ["ready", [4, 3]],
      ["review", [5]],
      ["blocked", [2]],
      ["dependabot", [1]],
    ]);
  });
  test("leaves out empty bands", () => {
    expect(prBandGroups([pr(1)]).map((g) => g.band)).toEqual(["ready"]);
    expect(prBandGroups([])).toEqual([]);
  });
});

test("readyPrCount counts only rows that can merge right now", () => {
  expect(
    readyPrCount([
      pr(1),
      pr(2, { action: null, checks: "pending" }),
      pr(3, { band: "dependabot", kind: "dependabot" }),
      pr(4),
    ]),
  ).toBe(2);
  expect(readyPrCount(undefined)).toBe(0);
});

test("buttonAction shows the band's action, disabled, while CI runs", () => {
  expect(buttonAction(pr(1))).toBe("merge");
  expect(buttonAction(pr(1, { action: null }))).toBe("merge");
  expect(buttonAction(pr(1, { band: "review", action: null }))).toBe("review");
  expect(buttonAction(pr(1, { band: "dependabot", action: null }))).toBe("merge");
  expect(buttonAction(pr(1, { band: "blocked", action: "fix" }))).toBe("fix");
  // A blocked PR whose head the server can't place keeps its fix, locked.
  expect(buttonAction(pr(1, { band: "blocked", action: null, blockReason: "conflict" }))).toBe(
    "fix",
  );
});

test("buttonAction offers a Dependabot rebase once its merge failed", () => {
  const dep = { band: "dependabot" as const, kind: "dependabot" as const };
  expect(buttonAction(pr(1, dep), true)).toBe("dependabot_rebase");
  expect(buttonAction(pr(1, dep), false)).toBe("merge");
  expect(buttonAction(pr(1), true)).toBe("merge");
  // Still waiting on CI: the locked merge stays.
  expect(buttonAction(pr(1, { ...dep, action: null }), true)).toBe("merge");
  expect(actionTip(pr(1, dep), true).summary).toBe(m.upnext_pr_tip_rebase_summary({ number: 1 }));
});

describe("mergeBlock", () => {
  test("is null when the next action is the merge", () => {
    expect(mergeBlock(pr(1))).toBeNull();
  });
  test("names the block reason, a missing review or what is still running", () => {
    expect(mergeBlock(pr(1, { band: "blocked", action: "fix", blockReason: "conflict" }))).toBe(
      "conflict",
    );
    expect(mergeBlock(pr(1, { band: "review", action: "review" }))).toBe("review");
    expect(mergeBlock(pr(1, { action: null, checks: "pending" }))).toBe("ci_running");
    expect(mergeBlock(pr(1, { action: null, checks: "none" }))).toBe("ci_running");
    expect(mergeBlock(pr(1, { action: null, mergeable: null }))).toBe("mergeability");
  });
});

test("ciShown reads a terminal none as no CI and a waiting none as running", () => {
  expect(ciShown(pr(1))).toBe("green");
  expect(ciShown(pr(1, { checks: "failure" }))).toBe("red");
  expect(ciShown(pr(1, { checks: "pending" }))).toBe("running");
  expect(ciShown(pr(1, { checks: "none", action: null }))).toBe("running");
  expect(ciShown(pr(1, { checks: "none" }))).toBe("none");
});

test("prsInRepos keeps the chip-rail repos, or everything when none is picked", () => {
  const rows = [pr(1), pr(2, { repoPath: "/r/b" })];
  expect(prsInRepos(rows, new Set()).map((p) => p.number)).toEqual([1, 2]);
  expect(prsInRepos(rows, new Set(["/r/b"])).map((p) => p.number)).toEqual([2]);
});

test("a locked fix's tip says why it is locked", () => {
  const tip = actionTip(pr(1, { band: "blocked", action: null, blockReason: "conflict" }));
  expect(tip.title).toBe(m.upnext_pr_action_fix());
  expect(tip.summary).toBe(m.upnext_pr_fix_locked());
});

test("while the live re-read runs, the tip says what the action waits for", () => {
  const tip = actionTip(pr(1), false, true);
  expect(tip.title).toBe(m.prspanel_merge_button());
  expect(tip.summary).toBe(m.upnext_pr_syncing());
  expect(tip.sections).toEqual([]);
});

describe("dependabotIgnoreTargets", () => {
  test("a single-dependency PR takes the 'this' form", () => {
    const body = "Bumps [rustls](https://x.test) from 0.23.45 to 0.23.46.\n";
    expect(dependabotIgnoreTargets(body)).toEqual([null]);
  });

  test("a release note quoting 'Bumps the … group' doesn't make it grouped", () => {
    const body = "Bumps [a](https://x.test) from 1 to 2.\nBumps the build group\n";
    expect(dependabotIgnoreTargets(body)).toEqual([null]);
  });

  test("a grouped PR with one dependency names it", () => {
    const body =
      "Bumps the production-dependencies group with 1 update in the /ui directory: @pierre/diffs.\n\n" +
      "Updates `@pierre/diffs` from 1.6.1 to 1.6.2\n";
    expect(dependabotIgnoreTargets(body)).toEqual(["@pierre/diffs"]);
  });

  test("a grouped PR in /cli reads the same", () => {
    const body =
      "Bumps the cargo-minor-patch group in /cli with 1 update: [libc](https://x.test).\n\n" +
      "Updates `libc` from 0.2.189 to 0.2.191\n";
    expect(dependabotIgnoreTargets(body)).toEqual(["libc"]);
  });

  test("a group across directories lists each dependency once", () => {
    const body =
      "Bumps the development-dependencies group with 1 update in the /extension directory: x.\n" +
      "Bumps the development-dependencies group with 1 update in the /ui directory: y.\n\n" +
      "Updates `@types/chrome` from 0.3.6 to 0.3.7\n<details></details>\n" +
      "Updates `magic-string` from 1.4.4 to 1.4.5\n" +
      "Updates `magic-string` from 1.4.3 to 1.4.5\n";
    expect(dependabotIgnoreTargets(body)).toEqual(["@types/chrome", "magic-string"]);
  });

  test("keeps extras in a name, as the server accepts them", () => {
    const body =
      "Bumps the python group with 2 updates: x.\n\n" +
      "Updates `uvicorn[standard]` from 0.30 to 0.31\n" +
      "Updates `pkg[a,b]` from 1 to 2\n";
    expect(dependabotIgnoreTargets(body)).toEqual(["uvicorn[standard]", "pkg[a,b]"]);
  });

  test("omits a name the server would refuse", () => {
    const body =
      "Bumps the python group with 2 updates: x.\n\n" +
      "Updates `not a name` from 1 to 2\n" +
      "Updates `libc` from 1 to 2\n";
    expect(dependabotIgnoreTargets(body)).toEqual(["libc"]);
  });

  test("a grouped PR with no readable dependency offers nothing", () => {
    expect(dependabotIgnoreTargets("Bumps the actions group with 2 updates.\n")).toEqual([]);
  });
});
