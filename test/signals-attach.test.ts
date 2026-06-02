import { test, expect } from "bun:test";
import { EventHub } from "../src/events";
import { SessionStore } from "../src/store";
import { attachSignalCapture } from "../src/signals";

function mk() {
  const store = new SessionStore(":memory:");
  const s = store.create({
    name: "n",
    prompt: "p",
    repoPath: "/r",
    baseBranch: "main",
    branch: "b",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: "t1",
  });
  const events = new EventHub();
  attachSignalCapture(events, store);
  return { store, s, events };
}

test("session:block with a menu shape records a 'block' signal", () => {
  const { store, s, events } = mk();
  events.emit("session:block", {
    id: s.id,
    block: { shape: "menu", options: [], tail: ["1. yes", "2. no"] },
  });
  const sigs = store.listSignals("/r");
  expect(sigs.length).toBe(1);
  expect(sigs[0]!.kind).toBe("block");
  expect(sigs[0]!.payload).toContain("yes");
});

test("session:block with a stall shape records a 'stall' signal", () => {
  const { store, s, events } = mk();
  events.emit("session:block", {
    id: s.id,
    block: { shape: "stall", options: [], tail: ["quiet"] },
  });
  expect(store.listSignals("/r")[0]!.kind).toBe("stall");
});

test("a cleared block (block: null) records nothing", () => {
  const { store, s, events } = mk();
  events.emit("session:block", { id: s.id, block: null });
  expect(store.listSignals("/r").length).toBe(0);
});

test("block for an unknown session records nothing", () => {
  const { store, events } = mk();
  events.emit("session:block", { id: "nope", block: { shape: "menu", options: [], tail: [] } });
  expect(store.listSignals("/r").length).toBe(0);
});
