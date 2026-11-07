import { test, expect } from "bun:test";
import {
  afterGateOpen,
  predecessorLanded,
  resolvePredecessor,
  type TaskDepsStore,
} from "../src/task-deps";
import type { Session } from "../src/types";

const session = (over: Partial<Session> = {}) =>
  ({
    id: "a",
    repoPath: "/r",
    status: "idle",
    archiveReason: null,
    issueNumber: null,
    ...over,
  }) as Session;

function store(rows: Session[], integrated: number[] = []): TaskDepsStore {
  return {
    get: (id) => rows.find((r) => r.id === id) ?? null,
    isEpicIntegratedChild: (_repo, n) => integrated.includes(n),
  };
}

const none = () => undefined;

test("live merged PR counts as landed", () => {
  const s = session();
  expect(predecessorLanded(store([s]), () => ({ state: "merged" }), s)).toBe(true);
});

test("open PR / running session is not landed", () => {
  const s = session({ status: "running" });
  expect(predecessorLanded(store([s]), () => ({ state: "open" }), s)).toBe(false);
});

test("archived as merged counts as landed", () => {
  const s = session({ status: "archived", archiveReason: "merged" });
  expect(predecessorLanded(store([s]), none, s)).toBe(true);
});

test("epic child integrated by the drain counts as landed", () => {
  const s = session({ status: "archived", archiveReason: "drain", issueNumber: 7 });
  expect(predecessorLanded(store([s], [7]), none, s)).toBe(true);
  expect(predecessorLanded(store([s]), none, s)).toBe(false);
});

test("operator archive without a merge is not landed", () => {
  const s = session({ status: "archived", archiveReason: "operator" });
  expect(predecessorLanded(store([s]), () => ({ state: "closed" }), s)).toBe(false);
});

test("afterGateOpen: no predecessor, pruned predecessor → open", () => {
  expect(afterGateOpen(store([]), none, undefined)).toBe(true);
  expect(afterGateOpen(store([]), none, "gone")).toBe(true);
});

test("afterGateOpen follows predecessorLanded", () => {
  const s = session({ status: "running" });
  expect(afterGateOpen(store([s]), none, "a")).toBe(false);
  expect(afterGateOpen(store([s]), () => ({ state: "merged" }), "a")).toBe(true);
});

// ── resolvePredecessor (#3633): the predecessor may run on a connected machine ──
const mirrored = (id: string, desig: string, host = "macbook") => ({
  id,
  desig,
  host: { instanceId: `id-${host}`, name: host },
});
const noLocal = { byId: null, byDesig: null };

test("resolvePredecessor: a local id wins over the mirror", () => {
  const s = session({ id: "u1" });
  const r = resolvePredecessor("u1", { byId: s, byDesig: null }, [mirrored("u1", "TASK-1")]);
  expect(r).toEqual({ kind: "local", session: s });
});

test("resolvePredecessor: a mirrored id resolves to its machine", () => {
  const m = mirrored("u2", "TASK-108");
  expect(resolvePredecessor("u2", noLocal, [m])).toEqual({ kind: "remote", session: m });
});

test("resolvePredecessor: a mirrored id two machines report is ambiguous", () => {
  const r = resolvePredecessor("u2", noLocal, [
    mirrored("u2", "TASK-1", "macbook"),
    mirrored("u2", "TASK-1", "studio"),
  ]);
  expect(r).toEqual({ kind: "ambiguous", local: false, hosts: ["macbook", "studio"] });
});

test("resolvePredecessor: a local desig with no mirrored match is local", () => {
  const s = session({ id: "u3" });
  const r = resolvePredecessor("TASK-7", { byId: null, byDesig: s }, [mirrored("x", "TASK-8")]);
  expect(r).toEqual({ kind: "local", session: s });
});

test("resolvePredecessor: a mirrored desig matches any case and bare digits", () => {
  const m = mirrored("u4", "TASK-108");
  for (const ref of ["TASK-108", "task-108", "108"]) {
    expect(resolvePredecessor(ref, noLocal, [mirrored("y", "TASK-109"), m])).toEqual({
      kind: "remote",
      session: m,
    });
  }
});

test("resolvePredecessor: the same desig here and on a machine is ambiguous", () => {
  const s = session({ id: "u5" });
  const r = resolvePredecessor("TASK-108", { byId: null, byDesig: s }, [
    mirrored("u6", "TASK-108"),
  ]);
  expect(r).toEqual({ kind: "ambiguous", local: true, hosts: ["macbook"] });
});

test("resolvePredecessor: the same desig on two machines is ambiguous", () => {
  const r = resolvePredecessor("108", noLocal, [
    mirrored("a", "TASK-108", "macbook"),
    mirrored("b", "TASK-108", "studio"),
  ]);
  expect(r).toEqual({ kind: "ambiguous", local: false, hosts: ["macbook", "studio"] });
});

test("resolvePredecessor: nothing matches → none", () => {
  expect(resolvePredecessor("TASK-9", noLocal, [mirrored("a", "TASK-8")])).toEqual({
    kind: "none",
  });
  expect(resolvePredecessor("not-a-desig", noLocal, [mirrored("a", "TASK-8")])).toEqual({
    kind: "none",
  });
});
