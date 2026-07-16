import { test, expect } from "vitest";
import { revealAndSelect, createJumpHandlers, type JumpDeps, type JumpEffects } from "./herd-jump";
import type { RailLocation } from "./herd-keynav";

/** Real sets + a call log; every spy also records the collapsed-set state it observed,
 *  so ordering (expand strictly before select, tick in between) is asserted from the
 *  log instead of trusting implementation details. */
function harness(locations: Map<string, RailLocation> = new Map()) {
  const log: string[] = [];
  const collapsedEpics = new Set<string>();
  const collapsedStages = new Set<string>();
  const seen = (id: string) =>
    `stages=[${[...collapsedStages].join(",")}] epics=[${[...collapsedEpics].join(",")}] id=${id}`;
  const deps: JumpDeps = {
    locate: () => {
      log.push("locate");
      return locations;
    },
    selectedId: () => null,
    blockedIds: () => [],
    isDesktop: () => true,
    collapsedEpics,
    collapsedStages,
    expandEpic: (key) => {
      log.push(`expandEpic:${key}`);
      collapsedEpics.delete(key);
    },
    expandStage: (key) => {
      log.push(`expandStage:${key}`);
      collapsedStages.delete(key);
    },
    tick: async () => {
      log.push("tick");
    },
    select: (id, focusTerm = true, toDetail = true) => {
      log.push(`select:${focusTerm}:${toDetail} ${seen(id)}`);
    },
    keyNavSelect: (id, focusTerm) => {
      log.push(`keyNav:${focusTerm} ${seen(id)}`);
    },
  };
  const effects: JumpEffects = {
    resetLensAndFilters: () => log.push("reset"),
    followRepo: (id) => log.push(`follow:${id}`),
    leaveRundown: () => log.push("leaveRundown"),
    beforeHerdrUpdateJump: () => log.push("closeUpdateModal"),
  };
  return { deps, effects, log, collapsedEpics, collapsedStages, locations };
}

const stage = (key: string): RailLocation => ({ kind: "stage", key });
const epic = (key: string): RailLocation => ({ kind: "epic", key });

// revealAndSelect — core ordering

test("collapsed desktop stage: expand strictly before select, tick in between", async () => {
  const h = harness(new Map([["x", stage("merged")]]));
  h.collapsedStages.add("merged");
  await revealAndSelect("x", h.deps, (id) => h.deps.select(id));
  // the select spy observed the stage already removed from the set
  expect(h.log).toEqual([
    "locate",
    "expandStage:merged",
    "tick",
    "select:true:true stages=[] epics=[] id=x",
  ]);
});

test("collapsed epic group: only the epic set mutates", async () => {
  const h = harness(new Map([["x", epic("/r#100")]]));
  h.collapsedEpics.add("/r#100");
  h.collapsedStages.add("merged"); // unrelated stage stays collapsed
  await revealAndSelect("x", h.deps, (id) => h.deps.select(id));
  expect(h.log).toEqual([
    "locate",
    "expandEpic:/r#100",
    "tick",
    "select:true:true stages=[merged] epics=[] id=x",
  ]);
});

test("experiment member: no set mutates, select fires without a tick", async () => {
  const h = harness(new Map([["x", { kind: "experiment" }]]));
  h.collapsedStages.add("merged");
  await revealAndSelect("x", h.deps, (id) => h.deps.select(id));
  expect(h.log).toEqual(["locate", "select:true:true stages=[merged] epics=[] id=x"]);
});

test("target in an open group (or without a location): no mutation, no tick", async () => {
  const h = harness(new Map([["x", stage("ready")]]));
  await revealAndSelect("x", h.deps, (id) => h.deps.select(id));
  await revealAndSelect("unknown", h.deps, (id) => h.deps.select(id));
  expect(h.log).toEqual([
    "locate",
    "select:true:true stages=[] epics=[] id=x",
    "locate",
    "select:true:true stages=[] epics=[] id=unknown",
  ]);
});

test("mobile gating: a mobile jump never mutates collapsedStages (epic expansion still runs)", async () => {
  const h = harness(
    new Map<string, RailLocation>([
      ["s", stage("merged")],
      ["e", epic("/r#100")],
    ]),
  );
  h.deps.isDesktop = () => false;
  h.collapsedStages.add("merged");
  h.collapsedEpics.add("/r#100");
  await revealAndSelect("s", h.deps, (id) => h.deps.select(id));
  expect(h.collapsedStages.has("merged")).toBe(true); // untouched — desktop-only state
  await revealAndSelect("e", h.deps, (id) => h.deps.select(id));
  expect(h.collapsedEpics.has("/r#100")).toBe(false); // epics collapse on mobile too
  expect(h.log).toEqual([
    "locate",
    "select:true:true stages=[merged] epics=[/r#100] id=s",
    "locate",
    "expandEpic:/r#100",
    "tick",
    "select:true:true stages=[merged] epics=[] id=e",
  ]);
});

// createJumpHandlers — effect ordering with an initially filter-hidden target

test("jumpToSession: effects run BEFORE locate, so a filter-hidden target becomes locatable", async () => {
  // Stateful locate fake: the target has NO location until resetLensAndFilters ran —
  // exactly how the real locator behaves while a repo/status filter hides the session.
  const h = harness();
  h.collapsedStages.add("awaiting-merge");
  let filtersReset = false;
  h.deps.locate = () => {
    h.log.push("locate");
    return filtersReset ? new Map([["x", stage("awaiting-merge")]]) : new Map();
  };
  h.effects.resetLensAndFilters = () => {
    filtersReset = true;
    h.log.push("reset");
  };
  const handlers = createJumpHandlers(h.deps, h.effects);
  await handlers.jumpToSession("x");
  expect(h.log).toEqual([
    "reset",
    "follow:x",
    "locate",
    "expandStage:awaiting-merge",
    "tick",
    "select:true:true stages=[] epics=[] id=x",
  ]);
});

// createJumpHandlers — per-path wiring: every handler opens a collapsed desktop stage
// before select/scroll, with its exact effects and select variant

test.each([
  ["jumpToSession", ["reset", "follow:x"], "select:true:true"],
  ["selectRundownItem", ["leaveRundown"], "select:true:true"],
  ["selectFromDeepLink", [], "select:true:true"],
  ["jumpFromHerdrUpdate", ["closeUpdateModal"], "select:true:true"],
  ["navigateFromViewport", [], "select:true:true"],
  ["retargetForRepoFilter", [], "select:false:false"],
] as const)("%s expands the collapsed stage before selecting", async (name, fx, sel) => {
  const h = harness(new Map([["x", stage("merged")]]));
  h.collapsedStages.add("merged");
  const handlers = createJumpHandlers(h.deps, h.effects);
  await handlers[name]("x");
  expect(h.log).toEqual([
    ...fx,
    "locate",
    "expandStage:merged",
    "tick",
    `${sel} stages=[] epics=[] id=x`,
  ]);
});

test("selectNextNeedsYou: target from nextNeedsYou, expansion via the same core, keyNavSelect", async () => {
  const h = harness(new Map([["blocked1", stage("ci-failed")]]));
  h.collapsedStages.add("ci-failed");
  h.deps.blockedIds = () => ["blocked1"];
  h.deps.selectedId = () => "other";
  const handlers = createJumpHandlers(h.deps, h.effects);
  await handlers.selectNextNeedsYou();
  expect(h.log).toEqual([
    "locate",
    "expandStage:ci-failed",
    "tick",
    "keyNav:true stages=[] epics=[] id=blocked1",
  ]);
});

test("selectNextNeedsYou: no blocked sessions → no locate, no select", async () => {
  const h = harness();
  const handlers = createJumpHandlers(h.deps, h.effects);
  await handlers.selectNextNeedsYou();
  expect(h.log).toEqual([]);
});

// live getters — values mutated AFTER factory creation must be picked up

test("handlers read locate/selectedId/blockedIds/isDesktop live, never as creation-time snapshots", async () => {
  const h = harness(); // empty locations, nothing blocked, desktop off
  let desktop = false;
  const blocked: string[] = [];
  let selected: string | null = null;
  h.deps.isDesktop = () => desktop;
  h.deps.blockedIds = () => blocked;
  h.deps.selectedId = () => selected;
  const handlers = createJumpHandlers(h.deps, h.effects);

  // mutate the UNDERLYING values after creation — the getters must see all of them
  h.locations.set("late", stage("merged"));
  h.collapsedStages.add("merged");
  blocked.push("late", "other");
  selected = "other";
  desktop = true;

  await handlers.selectNextNeedsYou(false);
  // fresh blockedIds/selectedId chose "late"; fresh locations + isDesktop expanded its stage
  expect(h.log).toEqual([
    "locate",
    "expandStage:merged",
    "tick",
    "keyNav:false stages=[] epics=[] id=late",
  ]);
});
