import { test, expect } from "bun:test";
import { EventHub } from "../src/events";
import { SessionStore } from "../src/store";
import { attachSignalCapture } from "../src/signals";

function mk(opts?: { now?: () => number; debounceMs?: number }) {
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
  attachSignalCapture(events, store, opts);
  return { store, s, events };
}

/** A second session in the SAME repo, so a per-session assertion can't pass by repo scoping. */
function addSession(store: SessionStore, name: string) {
  return store.create({
    name,
    prompt: "p",
    repoPath: "/r",
    baseBranch: "main",
    branch: `b-${name}`,
    worktreePath: `/wt-${name}`,
    isolated: true,
    herdrSession: "default",
    herdrAgentId: `t-${name}`,
  });
}

const menu = (tail: string[]) => ({ shape: "menu" as const, options: [], tail });

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

// ── per-episode dedup (#2242) ────────────────────────────────────────────────
// The poller re-emits `session:block` on every terminal repaint of a waiting dialog, so the
// capture layer collapses an episode into one row. The window SLIDES on every observed event.

test("repaints of the same dialog inside the window record ONE signal", () => {
  let t = 1_000;
  const { store, s, events } = mk({ now: () => t, debounceMs: 60_000 });
  // Same dialog, three different tails — a repaint changes the tail, which is exactly why
  // payload-equality dedup does not work and this window exists.
  events.emit("session:block", { id: s.id, block: menu(["Which ruleset?", "❯ 1. strict"]) });
  t += 3_000; // the poller's reclassify cadence
  events.emit("session:block", { id: s.id, block: menu(["Which ruleset?", "  1. strict", "x"]) });
  t += 25_000;
  events.emit("session:block", { id: s.id, block: menu(["Which ruleset?", "❯ 2. loose"]) });
  const sigs = store.listSignals("/r");
  expect(sigs.length).toBe(1);
  expect(sigs[0]!.payload).toContain("❯ 1. strict"); // the FIRST sighting is the one kept
});

test("a block past the window opens a new episode", () => {
  let t = 1_000;
  const { store, s, events } = mk({ now: () => t, debounceMs: 60_000 });
  events.emit("session:block", { id: s.id, block: menu(["first"]) });
  t += 60_000; // exactly at the boundary — the window has elapsed
  events.emit("session:block", { id: s.id, block: menu(["second"]) });
  expect(store.listSignals("/r").length).toBe(2);
});

test("the window SLIDES: a repaint stream never ages out mid-episode", () => {
  let t = 1_000;
  const { store, s, events } = mk({ now: () => t, debounceMs: 60_000 });
  // 10 minutes of repaints at the 3s cadence stays ONE episode, because each event re-stamps the
  // key. A fixed (non-sliding) window would emit a fresh row every 60s of the same dialog.
  for (let i = 0; i < 200; i++) {
    events.emit("session:block", { id: s.id, block: menu([`repaint ${i}`]) });
    t += 3_000;
  }
  expect(store.listSignals("/r").length).toBe(1);
});

test("the window is per session — a concurrent block elsewhere is its own episode", () => {
  const t = 1_000;
  const { store, s, events } = mk({ now: () => t, debounceMs: 60_000 });
  const other = addSession(store, "other");
  events.emit("session:block", { id: s.id, block: menu(["mine"]) });
  events.emit("session:block", { id: other.id, block: menu(["theirs"]) });
  expect(store.listSignals("/r").length).toBe(2);
});

test("the window is per kind — a stall and a block never share one", () => {
  const t = 1_000;
  const { store, s, events } = mk({ now: () => t, debounceMs: 60_000 });
  events.emit("session:block", { id: s.id, block: menu(["a question"]) });
  events.emit("session:block", {
    id: s.id,
    block: { shape: "stall", options: [], tail: ["quiet"] },
  });
  expect(
    store
      .listSignals("/r")
      .map((x) => x.kind)
      .sort(),
  ).toEqual(["block", "stall"]);
});

test("a clear does NOT reopen the window — the leave-blocked flap is the amplifier", () => {
  let t = 1_000;
  const { store, s, events } = mk({ now: () => t, debounceMs: 60_000 });
  events.emit("session:block", { id: s.id, block: menu(["a question"]) });
  // The poller drops `lastSig` in both trySuppressSpinner and clearBlock, emitting a clear and
  // then re-arming on the next cadence. Treating that as an episode boundary would restore the
  // duplication this dedup exists to remove.
  t += 3_000;
  events.emit("session:block", { id: s.id, block: null });
  t += 3_000;
  events.emit("session:block", { id: s.id, block: menu(["a question", "(repainted)"]) });
  expect(store.listSignals("/r").length).toBe(1);
});

test("an idle session's key is not retained once its episode has aged out", () => {
  let t = 1_000;
  const { store, s, events } = mk({ now: () => t, debounceMs: 60_000 });
  events.emit("session:block", { id: s.id, block: menu(["old"]) });
  t += 120_000;
  // A block for ANOTHER session sweeps the stale key; the original then behaves as unseen.
  const other = addSession(store, "other");
  events.emit("session:block", { id: other.id, block: menu(["theirs"]) });
  events.emit("session:block", { id: s.id, block: menu(["new episode"]) });
  expect(store.listSignals("/r").length).toBe(3);
});
