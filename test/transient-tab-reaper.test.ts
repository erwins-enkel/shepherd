import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reapTransientByLabel } from "../src/transient-tab-reaper";

interface FakeAgent {
  name: string;
  terminalId: string;
  tabId: string;
}

function fakeHerdr(listed: FakeAgent[], throwOnList = false) {
  const closed: string[] = [];
  return {
    closed,
    list: () => {
      if (throwOnList) throw new Error("herdr unavailable");
      return listed as never;
    },
    closeTab: async (t: string) => {
      closed.push(t);
    },
  };
}

const LABEL = "__distill__";

test("closes prefix-matched orphan tabs, sparing unrelated names and owned terminals", async () => {
  const h = fakeHerdr([
    { name: LABEL + "deadbeef", terminalId: "orphan1", tabId: "tabO" }, // orphan → close
    { name: "some-session", terminalId: "u1", tabId: "tabU" }, // unrelated → spare
    { name: LABEL + "live0001", terminalId: "m1", tabId: "tabL" }, // owned → spare
  ]);
  await reapTransientByLabel(h, LABEL, new Set(["m1"]), "[distill]");
  expect(h.closed).toEqual(["tabO"]);
});

test("closes ALL unowned prefix matches", async () => {
  const h = fakeHerdr([
    { name: LABEL + "a", terminalId: "t1", tabId: "tab1" },
    { name: LABEL + "b", terminalId: "t2", tabId: "tab2" },
  ]);
  await reapTransientByLabel(h, LABEL, new Set(), "[distill]");
  expect(h.closed).toEqual(["tab1", "tab2"]);
});

test("different label prefix isolates each consumer's reaping", async () => {
  const h = fakeHerdr([
    { name: "__distill__x", terminalId: "t1", tabId: "tabD" },
    { name: "__optimize__y", terminalId: "t2", tabId: "tabO" },
  ]);
  await reapTransientByLabel(h, "__optimize__", new Set(), "[optimize]");
  expect(h.closed).toEqual(["tabO"]); // distiller's tab is left for distiller's own pass
});

test("no matches → closes nothing", async () => {
  const h = fakeHerdr([{ name: "regular-session", terminalId: "t", tabId: "tab" }]);
  await reapTransientByLabel(h, LABEL, new Set(), "[distill]");
  expect(h.closed).toEqual([]);
});

test("herdr unavailable (list throws) → best-effort no-op, never throws", async () => {
  const h = fakeHerdr([], true);
  expect(() => reapTransientByLabel(h, LABEL, new Set(), "[distill]")).not.toThrow();
  expect(h.closed).toEqual([]);
});

// ── Synchronous block-and-clean helpers: boot-reap regression guard (#1147) ──────────
//
// The `name ` / `autopilot ` / `verify api key` helpers start→poll→stop in a `finally`, so a
// CLEAN exit leaves no husk. A server restart mid-poll skips that `finally`, orphaning an
// interactive `claude` that idles at the prompt forever — and the husk-only periodic sweep
// (tab-reaper.ts `reapOrphanTabs`) SPARES it, because its foreground proc is a live non-shell
// `claude`, not a shell. Only the boot label-reap closes it. #1136 wired that reap; #1147 is the
// third recurrence of this leak class (#1135 → #1136 → #1147), so these two tests pin it shut.
//
// NOTE ON `autopilot `: an `autopilot <id>` pane is ONLY ever the transient stop-classifier
// (autopilot.ts builds the label at its two `consider(id, tail, `autopilot ${id}`)` sites →
// classifyStop → herdr.start). It is NEVER a live, re-adoptable session — those carry a
// prompt-derived `[a-z0-9-]` slug via the `relabel` path in service.ts. That is what makes the
// EMPTY owned set at boot correct: no such classifier runs at the synchronous boot point, so
// every match is a prior-lifetime orphan, and a space-prefixed label cannot collide with a slug.

/** The three synchronous block-and-clean helper labels boot-reaped in src/index.ts (#1136). */
const SYNC_HELPER_LABELS = ["name ", "autopilot ", "verify api key"] as const;

describe("synchronous block-and-clean helpers are boot-reapable by label", () => {
  for (const label of SYNC_HELPER_LABELS) {
    test(`\`${label}\` orphan is closed, a user session slug is spared`, async () => {
      const h = fakeHerdr([
        { name: `${label}orphaned`, terminalId: "t1", tabId: "tabH" }, // prior-lifetime orphan → close
        { name: "fix-the-thing", terminalId: "t2", tabId: "tabU" }, // user session slug → spare
      ]);
      // Empty owned set == the boot call: nothing of ours is running yet.
      await reapTransientByLabel(h, label, new Set(), "[boot]");
      expect(h.closed).toEqual(["tabH"]);
    });
  }
});

// The boot calls live as bare `void reapTransientByLabel(...)` statements inside a
// `deferredStarts.push` thunk in src/index.ts — unreachable from a unit test, and therefore
// silently deletable. That deletion IS the recurrence mode this issue class keeps hitting, so
// guard it at the source-text level. Precedent: the `no new ./config import` guard in
// test/operator-language.test.ts, which readFileSync's src/*.ts the same way.
//
// Deliberately narrow: assert only that a `reapTransientByLabel(herdr, "<label>"` call exists per
// label (tolerant of `void`, whitespace and formatting). No "is it inside the deferredStarts
// block" check — proving block membership from raw text needs a brittle multi-line regex and buys
// no real safety. If a future refactor legitimately moves these behind one seam, this fails LOUDLY
// and is meant to be updated deliberately — that review moment is the point.
describe("src/index.ts still wires the boot reap for every synchronous helper (#1147)", () => {
  const INDEX_SRC = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");

  for (const label of SYNC_HELPER_LABELS) {
    test(`boot-reaps \`${label}\``, () => {
      const call = new RegExp(`reapTransientByLabel\\(\\s*herdr\\s*,\\s*"${label}"`);
      expect(INDEX_SRC).toMatch(call);
    });
  }
});
