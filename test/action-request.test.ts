import { expect, test } from "bun:test";
import { ACTION_REQUEST_EVENT, ActionRequestService } from "../src/action-request";
import { EventHub } from "../src/events";

function setup() {
  const events = new EventHub();
  const emitted: { id: string; request: unknown }[] = [];
  events.subscribe((event, data) => {
    if (event === ACTION_REQUEST_EVENT) emitted.push(data as { id: string; request: unknown });
  });
  return { events, emitted, svc: new ActionRequestService({ events, now: () => 42 }) };
}

const open = (state: ReturnType<ActionRequestService["request"]>) => {
  if (state.status !== "open") throw new Error(`not open: ${state.status}`);
  return state.request;
};

test("the same call re-attaches; argument order does not matter", () => {
  const { svc, emitted } = setup();
  const a = open(svc.request("s", "pr_merge", { desig: "TASK-1", force: true }, "TASK-1"));
  const b = open(svc.request("s", "pr_merge", { force: true, desig: "TASK-1" }, "TASK-1"));
  expect(b.id).toBe(a.id);
  expect(a).toMatchObject({ tool: "pr_merge", target: "TASK-1", createdAt: 42 });
  expect(emitted).toHaveLength(1);
});

test("a different call cancels the open request and its waiter", async () => {
  const { svc } = setup();
  const a = open(svc.request("s", "pr_merge", { desig: "TASK-1" }, "TASK-1"));
  const waiting = svc.wait("s", a.id, 5_000);
  const b = open(svc.request("s", "pr_merge", { desig: "TASK-2" }, "TASK-2"));
  expect(b.id).not.toBe(a.id);
  expect(await waiting).toBe("denied");
  expect(svc.resolve("s", a.id, "approved")).toBe(false);
});

test("one approval releases one waiter", async () => {
  const { svc } = setup();
  const a = open(svc.request("s", "herd_halt", {}, "herd"));
  const first = svc.wait("s", a.id, 5_000);
  const second = svc.wait("s", a.id, 5_000);
  expect(svc.resolve("s", a.id, "approved")).toBe(true);
  expect(await first).toBe("approved");
  expect(await second).toBe("denied");
  expect(svc.snapshot()).toEqual({});
});

test("an answer given between long-polls is delivered once, to the identical call only", () => {
  const { svc } = setup();
  const a = open(svc.request("s", "herd_halt", {}, "herd"));
  svc.resolve("s", a.id, "approved");
  expect(svc.request("s", "herd_halt", {}, "herd")).toEqual({ status: "approved" });
  expect(svc.request("s", "herd_halt", {}, "herd").status).toBe("open");

  const b = open(svc.request("t", "herd_halt", {}, "herd"));
  svc.resolve("t", b.id, "approved");
  expect(svc.request("t", "herd_retry", {}, "herd").status).toBe("open");
  expect(svc.request("t", "herd_halt", {}, "herd").status).toBe("open");
});

test("a wait times out as pending; archive drops the request", async () => {
  const { svc, events, emitted } = setup();
  const a = open(svc.request("s", "herd_halt", {}, "herd"));
  expect(await svc.wait("s", a.id, 5)).toBe("pending");
  const waiting = svc.wait("s", a.id, 5_000);
  events.emit("session:archived", { id: "s" });
  expect(await waiting).toBe("denied");
  expect(svc.snapshot()).toEqual({});
  expect(emitted.at(-1)).toEqual({ id: "s", request: null });
});

// ── R2-F05: requests and undelivered approvals expire ──

function clocked() {
  const events = new EventHub();
  const clock = { now: 1_000 };
  return { clock, svc: new ActionRequestService({ events, now: () => clock.now }) };
}

test("an open request expires after 10 minutes and cannot be approved", async () => {
  const { svc, clock } = clocked();
  const a = open(svc.request("s", "pr_merge", { desig: "TASK-1" }, "TASK-1"));
  const waiting = svc.wait("s", a.id, 60_000);
  clock.now += 10 * 60_000 + 1;
  expect(svc.snapshot()).toEqual({});
  expect(svc.resolve("s", a.id, "approved")).toBe(false);
  expect(await waiting).toBe("denied");
  // The identical call opens a fresh request rather than re-attaching to the expired one.
  const b = open(svc.request("s", "pr_merge", { desig: "TASK-1" }, "TASK-1"));
  expect(b.id).not.toBe(a.id);
  expect(await svc.wait("s", a.id, 5)).toBe("denied");
});

test("an expired request re-called identically is replaced, not re-attached", () => {
  const { svc, clock } = clocked();
  const a = open(svc.request("s", "pr_merge", { desig: "TASK-1" }, "TASK-1"));
  clock.now += 10 * 60_000 + 1;
  const b = open(svc.request("s", "pr_merge", { desig: "TASK-1" }, "TASK-1"));
  expect(b.id).not.toBe(a.id);
  expect(svc.resolve("s", b.id, "approved")).toBe(true);
});

test("an undelivered approval is replayed within 2 minutes only", () => {
  const { svc, clock } = clocked();
  const a = open(svc.request("s", "herd_halt", {}, "herd"));
  svc.resolve("s", a.id, "approved");
  clock.now += 2 * 60_000 - 1;
  expect(svc.request("s", "herd_halt", {}, "herd")).toEqual({ status: "approved" });

  const b = open(svc.request("s", "herd_halt", {}, "herd"));
  svc.resolve("s", b.id, "approved");
  clock.now += 2 * 60_000 + 1;
  expect(svc.request("s", "herd_halt", {}, "herd").status).toBe("open");
});
