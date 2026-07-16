import { test, expect } from "vitest";
import {
  railOrder as railOrderRaw,
  railLocationsOf,
  cycleId,
  nthId,
  nextNeedsYou,
  altComboKey,
  jumpDigitIndex,
} from "./herd-keynav";
import { GROUP_KEY_BY_STAGE, type HerdFilter } from "./herd-partition";
import type { Session, GitState, Epic, EpicChild, SessionStatus } from "$lib/types";

function session(
  id: string,
  readyToMerge = false,
  status: SessionStatus = "running",
  issueNumber: number | null = null,
  repoPath = "/r",
): Session {
  return {
    id,
    desig: "TASK-01",
    name: "n",
    prompt: "p",
    repoPath,
    baseBranch: "main",
    branch: "b",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "a",
    claudeSessionId: "c",
    model: null,
    status,
    readyToMerge,
    mergingSince: null,
    mergingTrainId: null,
    mergeTrainPrs: null,
    autopilotEnabled: null,
    autopilotStepCount: 0,
    autopilotPaused: false,
    autopilotComplete: false,
    autopilotQuestion: null,
    planGateEnabled: null,
    planPhase: null,
    autoMergeEnabled: null,
    autoMergeRebaseCount: 0,
    auto: false,
    sandboxApplied: null,
    sandboxDegraded: false,
    egressApplied: false,
    egressDegraded: false,
    research: false,
    epicAuthoring: false,
    issueNumber,
    lastState: "working",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    haltReason: null,
    haltedAt: null,
    manualSteps: [],
    manualStepsAckedAt: null,
    experimentId: null,
    experimentRole: null,
  };
}

function git(state: GitState["state"], checks: GitState["checks"] = "none"): GitState {
  return { kind: "github", state, checks, deployConfigured: false };
}

function child(number: number): EpicChild {
  return {
    number,
    title: `child #${number}`,
    url: `https://x/${number}`,
    order: number,
    body: "",
    blockedBy: [],
    state: "running",
    sessionId: null,
    prNumber: null,
    issueClosed: false,
    claimed: false,
  };
}

function epic(repoPath: string, parentIssueNumber: number, childNumbers: number[]): Epic {
  return {
    repoPath,
    parentIssueNumber,
    parentTitle: `epic #${parentIssueNumber}`,
    source: "native",
    children: childNumbers.map(child),
    warnings: [],
    run: { repoPath, parentIssueNumber, mode: "auto", status: "running" },
  };
}

const epicKey = (repoPath: string, parent: number) => `${repoPath}#${parent}`;
const noReview = () => false;
const noRework = () => false;

function railOrder(
  sessions: Session[],
  git: Record<string, GitState>,
  isReviewing: (id: string) => boolean = noReview,
  now: number = Date.now(),
  filter: HerdFilter = "all",
  workingBlocked: Record<string, boolean> = {},
  epics: Record<string, Epic> = {},
  activeEpicKeys: Set<string> = new Set(),
  collapsedKeys: Set<string> = new Set(),
  isReworkRunning: (session: Session) => boolean = noRework,
  collapsedStageKeys: ReadonlySet<string> = new Set(),
) {
  return railOrderRaw(
    sessions,
    git,
    isReviewing,
    isReworkRunning,
    now,
    filter,
    workingBlocked,
    epics,
    activeEpicKeys,
    collapsedKeys,
    collapsedStageKeys,
  );
}

/** A comparison-experiment member — two of these with the same experimentId form a group. */
function variant(id: string, experimentId: string, issueNumber: number | null = null): Session {
  return {
    ...session(id, false, "running", issueNumber),
    experimentId,
    experimentRole: "variant",
  };
}

test("railOrder flattens the partition in the rail's render order", () => {
  // input order interleaves stages; the rail renders active → ciRunning →
  // ready → merging → merged (among others), preserving input order within each
  // group — ready precedes merging precedes merged in the flattened output.
  const merging1 = { ...session("merging1"), mergingSince: Date.now(), mergingTrainId: "t" };
  const list = [
    session("merged1"),
    session("ready1", true),
    session("a"),
    merging1,
    session("ci1"),
    session("b"),
  ];
  const order = railOrder(list, { merged1: git("merged"), ci1: git("open", "pending") });
  expect(order).toEqual(["a", "b", "ci1", "ready1", "merging1", "merged1"]);
});

test("railOrder under the ready filter only walks rows the rail shows", () => {
  // "ready" hides running and in-review sessions — keynav must match, so j/k
  // and 1-9 can never select a session the filtered rail isn't rendering
  const list = [
    session("running1"),
    session("idle1", false, "idle"),
    session("blocked1", false, "blocked"),
    session("reviewed1", false, "done"),
  ];
  const inReview = (id: string) => id === "reviewed1";
  expect(railOrder(list, {}, inReview, 0, "ready")).toEqual(["idle1", "blocked1"]);
  // default "all" keeps everything
  expect(railOrder(list, {}, inReview, 0)).toEqual(["running1", "idle1", "blocked1", "reviewed1"]);
});

test("railOrder of an empty herd is empty", () => {
  expect(railOrder([], {})).toEqual([]);
});

test("railOrder puts epic-group children first (group order, lifecycle within), then rest by stage", () => {
  // Two active epics in one repo: parent 100 (children 101,102), parent 200 (child 201).
  // groups sort by parentIssueNumber → epic-100 before epic-200.
  const epics = {
    [epicKey("/r", 100)]: epic("/r", 100, [101, 102]),
    [epicKey("/r", 200)]: epic("/r", 200, [201]),
  };
  const active = new Set([epicKey("/r", 100), epicKey("/r", 200)]);

  // epic-100 members: g-active (active), g-merged (merged) → lifecycle puts active before merged
  const gActive = session("g-active", false, "running", 101);
  const gMerged = session("g-merged", false, "idle", 102);
  // epic-200 member
  const gp2 = session("g200", false, "running", 201);
  // rest (non-epic) spanning two stages: active + ready
  const restActive = session("rest-active", false, "running", null);
  const restReady = session("rest-ready", true, "idle", null);

  // deliberately scrambled input order
  const list = [restReady, gMerged, gp2, restActive, gActive];
  const order = railOrder(
    list,
    { "g-merged": git("merged") },
    () => false,
    1000,
    "all",
    {},
    epics,
    active,
  );

  // groups first (100 before 200; within 100, active before merged), then rest by STAGE_ORDER
  expect(order).toEqual(["g-active", "g-merged", "g200", "rest-active", "rest-ready"]);
});

test("railOrder: a collapsed group contributes no ids; other groups and rest still do", () => {
  const epics = {
    [epicKey("/r", 100)]: epic("/r", 100, [101]),
    [epicKey("/r", 200)]: epic("/r", 200, [201]),
  };
  const active = new Set([epicKey("/r", 100), epicKey("/r", 200)]);

  const g100 = session("g100", false, "running", 101);
  const g200 = session("g200", false, "running", 201);
  const rest1 = session("rest1", false, "running", null);

  const collapsed = new Set([epicKey("/r", 100)]); // collapse the first group only

  const order = railOrder(
    [g100, g200, rest1],
    {},
    () => false,
    1000,
    "all",
    {},
    epics,
    active,
    collapsed,
  );

  // g100's child hidden; g200's child + rest still present
  expect(order).toEqual(["g200", "rest1"]);
});

test("railOrder mirrors the template across ≥2 groups + rest over ≥2 stages", () => {
  // groups sort by repo basename then parent: /repo-a#10 before /repo-b#20.
  const epics = {
    [epicKey("/repo-a", 10)]: epic("/repo-a", 10, [1, 2]),
    [epicKey("/repo-b", 20)]: epic("/repo-b", 20, [3]),
  };
  const active = new Set([epicKey("/repo-a", 10), epicKey("/repo-b", 20)]);

  // group A members across two stages (active + ready)
  const aActive = session("a-active", false, "running", 1, "/repo-a");
  const aReady = session("a-ready", true, "idle", 2, "/repo-a");
  // group B member
  const bMember = session("b-member", false, "running", 3, "/repo-b");
  // rest across two stages (ciRunning + merged)
  const restCi = session("rest-ci", false, "running", null, "/repo-c");
  const restMerged = session("rest-merged", false, "idle", null, "/repo-c");

  const list = [restMerged, aReady, bMember, restCi, aActive];
  const order = railOrder(
    list,
    { "rest-ci": git("open", "pending"), "rest-merged": git("merged") },
    () => false,
    1000,
    "all",
    {},
    epics,
    active,
  );

  // groups top in basename/parent order (A then B), each lifecycle-flattened;
  // then rest by STAGE_ORDER (ciRunning before merged)
  expect(order).toEqual(["a-active", "a-ready", "b-member", "rest-ci", "rest-merged"]);
});

test("railOrder places reworkRunning after reviewerRunning and before waiting groups", () => {
  const list = [
    session("wait", false, "idle"),
    session("branch", false, "idle"),
    session("needs", false, "idle"),
    session("rework"),
    session("review"),
    session("active"),
  ];
  const order = railOrder(
    list,
    {
      wait: { ...git("open", "success"), handoff: "reviewer", handoffWho: "scoop" },
      needs: {
        ...git("open", "success"),
        reviewBlock: { reviewer: "scoop", state: "changes_requested", latestAt: 1 },
      },
      branch: { ...git("open", "success"), mergeStateStatus: "blocked" },
    },
    (id) => id === "review",
    1000,
    "all",
    {},
    {},
    new Set(),
    new Set(),
    (s) => s.id === "rework",
  );

  expect(order).toEqual(["active", "review", "rework", "needs", "branch", "wait"]);
});

test("cycleId steps down and up through the order", () => {
  const order = ["a", "b", "c"];
  expect(cycleId(order, "a", 1)).toBe("b");
  expect(cycleId(order, "b", -1)).toBe("a");
});

test("cycleId wraps at both ends", () => {
  const order = ["a", "b", "c"];
  expect(cycleId(order, "c", 1)).toBe("a");
  expect(cycleId(order, "a", -1)).toBe("c");
});

test("cycleId with no/unknown selection lands on first (down) or last (up)", () => {
  const order = ["a", "b", "c"];
  expect(cycleId(order, null, 1)).toBe("a");
  expect(cycleId(order, null, -1)).toBe("c");
  expect(cycleId(order, "gone", 1)).toBe("a");
  expect(cycleId(order, "gone", -1)).toBe("c");
});

test("cycleId on an empty order is null; single entry cycles onto itself", () => {
  expect(cycleId([], "a", 1)).toBeNull();
  expect(cycleId(["only"], "only", 1)).toBe("only");
});

test("nthId picks the 1-based Nth visible session, null out of range", () => {
  const order = ["a", "b", "c"];
  expect(nthId(order, 1)).toBe("a");
  expect(nthId(order, 3)).toBe("c");
  expect(nthId(order, 4)).toBeNull();
  expect(nthId(order, 0)).toBeNull();
  expect(nthId([], 1)).toBeNull();
});

test("nextNeedsYou jumps to the first blocked session when current isn't blocked", () => {
  expect(nextNeedsYou(["x", "y"], "other")).toBe("x");
  expect(nextNeedsYou(["x", "y"], null)).toBe("x");
});

test("nextNeedsYou cycles among blocked sessions, wrapping", () => {
  expect(nextNeedsYou(["x", "y", "z"], "x")).toBe("y");
  expect(nextNeedsYou(["x", "y", "z"], "z")).toBe("x");
});

test("nextNeedsYou is a no-op (null) when none are blocked or only the current one is", () => {
  expect(nextNeedsYou([], "a")).toBeNull();
  expect(nextNeedsYou(["a"], "a")).toBeNull();
});

// collapsed lifecycle stages (desktop group collapse) + experiment mirroring

test("railOrder: a collapsed lifecycle stage contributes no rest ids", () => {
  const list = [session("act"), session("am", false, "idle"), session("rdy", true, "idle")];
  const g = { am: git("open", "success") };
  // sanity: nothing collapsed → all three in stage order
  expect(railOrder(list, g, noReview, 1000)).toEqual(["act", "am", "rdy"]);
  const collapsedStages = new Set([GROUP_KEY_BY_STAGE.awaitingMerge]);
  expect(
    railOrder(
      list,
      g,
      noReview,
      1000,
      "all",
      {},
      {},
      new Set(),
      new Set(),
      noRework,
      collapsedStages,
    ),
  ).toEqual(["act", "rdy"]);
});

test("railOrder: experiment members of a collapsed stage stay reachable (they render in their experiment group)", () => {
  // Two green-idle variants form an experiment group; a plain green-idle rest row shares
  // their awaitingMerge stage. Collapsing that stage must drop ONLY the rest row.
  const v1 = { ...variant("v1", "e1"), status: "idle" as const };
  const v2 = { ...variant("v2", "e1"), status: "idle" as const };
  const rest = session("plain", false, "idle");
  const g = {
    v1: git("open", "success"),
    v2: git("open", "success"),
    plain: git("open", "success"),
  };
  const collapsedStages = new Set([GROUP_KEY_BY_STAGE.awaitingMerge]);
  const order = railOrder(
    [v1, v2, rest],
    g,
    noReview,
    1000,
    "all",
    {},
    {},
    new Set(),
    new Set(),
    noRework,
    collapsedStages,
  );
  expect(order).toEqual(["v1", "v2"]);
});

test("railOrder renders epic groups, then experiment groups, then the lifecycle rest", () => {
  const epics = { [epicKey("/r", 100)]: epic("/r", 100, [101]) };
  const active = new Set([epicKey("/r", 100)]);
  const epicMember = session("g100", false, "running", 101);
  const rest = session("rest1");
  const order = railOrder(
    [rest, variant("v1", "e1"), epicMember, variant("v2", "e1")],
    {},
    noReview,
    1000,
    "all",
    {},
    epics,
    active,
  );
  expect(order).toEqual(["g100", "v1", "v2", "rest1"]);
});

// railLocationsOf — where each session renders (single authority for jump expansion)

test("railLocationsOf classifies epic members, experiment members, and the lifecycle rest", () => {
  const epics = { [epicKey("/r", 100)]: epic("/r", 100, [101, 102]) };
  const active = new Set([epicKey("/r", 100)]);
  const epicMember = session("g100", false, "running", 101);
  // experiment member CARRYING epic metadata (child 102): experiments are pulled out
  // first, so it must classify as experiment — never as the epic it doesn't render in
  const v1 = variant("v1", "e1", 102);
  const v2 = variant("v2", "e1");
  const restReady = session("rest-ready", true, "idle");
  const locs = railLocationsOf(
    [epicMember, v1, v2, restReady],
    {},
    noReview,
    noRework,
    1000,
    epics,
    active,
  );
  expect(locs.get("g100")).toEqual({ kind: "epic", key: epicKey("/r", 100) });
  expect(locs.get("v1")).toEqual({ kind: "experiment" });
  expect(locs.get("v2")).toEqual({ kind: "experiment" });
  expect(locs.get("rest-ready")).toEqual({ kind: "stage", key: GROUP_KEY_BY_STAGE.ready });
  expect(locs.get("not-shown")).toBeUndefined();
});

test("railLocationsOf: a lone surviving variant falls back into the lifecycle rest", () => {
  // <2 visible variants and no comparison → groupSessionsByExperiment leaves it in rest,
  // where it partitions like any session — the locator must mirror that fallback.
  const lone = variant("lone", "e1");
  const locs = railLocationsOf([lone], {}, noReview, noRework, 1000);
  expect(locs.get("lone")).toEqual({ kind: "stage", key: GROUP_KEY_BY_STAGE.active });
});

// altComboKey — physical KeyboardEvent.code → keynav key vocabulary

test("altComboKey maps j/k letter codes", () => {
  expect(altComboKey("KeyJ")).toBe("j");
  expect(altComboKey("KeyK")).toBe("k");
});

test("altComboKey does not map KeyG (needs-you jump retired from Alt combos)", () => {
  expect(altComboKey("KeyG")).toBeNull();
});

test("altComboKey maps arrow codes", () => {
  expect(altComboKey("ArrowDown")).toBe("arrowdown");
  expect(altComboKey("ArrowUp")).toBe("arrowup");
});

test("altComboKey maps Digit1–Digit9 to '1'–'9'", () => {
  for (let n = 1; n <= 9; n++) {
    expect(altComboKey(`Digit${n}`)).toBe(String(n));
  }
});

test("altComboKey maps Tab + bracket session-switch codes", () => {
  // Tab is direction-agnostic here (Shift resolved by the window handler);
  // brackets match on physical e.code because macOS Option+]/[ type other glyphs.
  expect(altComboKey("Tab")).toBe("tab");
  expect(altComboKey("BracketRight")).toBe("]");
  expect(altComboKey("BracketLeft")).toBe("[");
});

test("altComboKey returns null for non-combo codes", () => {
  expect(altComboKey("KeyN")).toBeNull();
  expect(altComboKey("Digit0")).toBeNull();
  expect(altComboKey("Numpad1")).toBeNull();
  expect(altComboKey("Escape")).toBeNull();
  expect(altComboKey("")).toBeNull();
});

// jumpDigitIndex — command-bar Alt+digit → 0-based result index

function altDigit(
  code: string,
  mods: Partial<Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">> = {},
): KeyboardEvent {
  // Only the fields jumpDigitIndex reads; `key` intentionally differs from `code` to prove
  // the helper keys off physical `e.code` (macOS Option+1 emits "¡", not "1").
  return {
    code,
    key: code === "Digit1" ? "¡" : code,
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...mods,
  } as KeyboardEvent;
}

test("jumpDigitIndex maps Alt+Digit1–9 to indices 0–8", () => {
  for (let n = 1; n <= 9; n++) {
    expect(jumpDigitIndex(altDigit(`Digit${n}`))).toBe(n - 1);
  }
});

test("jumpDigitIndex maps Alt+Digit0 to index 9 (the tenth row)", () => {
  expect(jumpDigitIndex(altDigit("Digit0"))).toBe(9);
});

test("jumpDigitIndex keys off physical e.code, not e.key (macOS Option glyph)", () => {
  // Alt+1 on a US Mac layout reports key "¡" but code "Digit1".
  const e = altDigit("Digit1");
  expect(e.key).toBe("¡");
  expect(jumpDigitIndex(e)).toBe(0);
});

test("jumpDigitIndex rejects Numpad digits (Windows alt-code input method)", () => {
  for (let n = 0; n <= 9; n++) {
    expect(jumpDigitIndex(altDigit(`Numpad${n}`))).toBeNull();
  }
});

test("jumpDigitIndex requires Alt with no other modifier", () => {
  expect(jumpDigitIndex(altDigit("Digit1", { altKey: false }))).toBeNull();
  expect(jumpDigitIndex(altDigit("Digit1", { ctrlKey: true }))).toBeNull();
  expect(jumpDigitIndex(altDigit("Digit1", { metaKey: true }))).toBeNull();
  expect(jumpDigitIndex(altDigit("Digit1", { shiftKey: true }))).toBeNull();
});

test("jumpDigitIndex returns null for non-digit codes", () => {
  expect(jumpDigitIndex(altDigit("KeyA"))).toBeNull();
  expect(jumpDigitIndex(altDigit("Enter"))).toBeNull();
  expect(jumpDigitIndex(altDigit("Minus"))).toBeNull();
});
