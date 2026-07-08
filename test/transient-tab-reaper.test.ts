import { expect, test } from "bun:test";
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
