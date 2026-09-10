import { test, expect } from "bun:test";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { AMENDMENT_MAX_CHARS } from "../src/task-amendments";

const base = {
  name: "amend-me",
  prompt: "do the thing",
  repoPath: "/r",
  baseBranch: "main",
  branch: "shepherd/amend-me",
  worktreePath: "/r-wt",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "term_1",
};

type ReplyCall = { id: string; text: string; signalPayload: string };

function harness(reply: { result?: boolean; throws?: boolean } = {}) {
  const store = new SessionStore(":memory:");
  const session = store.create(base);
  const calls: ReplyCall[] = [];
  const events: { event: string; data: unknown }[] = [];
  const hub = new EventHub();
  hub.subscribe((event, data) => events.push({ event, data }));
  const deps: AppDeps = {
    store,
    service: {
      operatorReply: async (id: string, text: string, signalPayload: string = text) => {
        calls.push({ id, text, signalPayload });
        if (reply.throws) throw new Error("clean-terminal session");
        return reply.result ?? true;
      },
    } as unknown as AppDeps["service"],
    events: hub,
    usageLimits: { limits: () => ({}) } as unknown as AppDeps["usageLimits"],
  } as AppDeps;
  return { app: makeApp(deps), store, session, calls, events };
}

const post = (id: string, body: unknown) =>
  new Request(`http://x/api/sessions/${id}/amendments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// ── POST /api/sessions/:id/amendments ────────────────────────────────────────

test("records an amendment and reports it back", async () => {
  const { app, store, session } = harness();
  const res = await app.fetch(post(session.id, { text: "  also build the gate  " }));
  expect(res.status).toBe(201);
  const body = (await res.json()) as { amendment: { text: string }; steered: boolean };
  expect(body.amendment.text).toBe("also build the gate"); // trimmed
  expect(body.steered).toBe(false); // no steer requested
  expect(store.listActiveTaskAmendments(session.id).map((a) => a.text)).toEqual([
    "also build the gate",
  ]);
});

test("emits session:amendments with the session's FULL list", async () => {
  const { app, session, events } = harness();
  await app.fetch(post(session.id, { text: "first" }));
  await app.fetch(post(session.id, { text: "second" }));
  const emitted = events.filter((e) => e.event === "session:amendments");
  expect(emitted).toHaveLength(2);
  const last = emitted[1]!.data as { id: string; amendments: { text: string }[] };
  expect(last.id).toBe(session.id);
  expect(last.amendments.map((a) => a.text)).toEqual(["first", "second"]);
});

test("rejects an empty or whitespace-only amendment", async () => {
  const { app, store, session } = harness();
  expect((await app.fetch(post(session.id, { text: "" }))).status).toBe(400);
  expect((await app.fetch(post(session.id, { text: "   \n  " }))).status).toBe(400);
  expect(store.listTaskAmendments(session.id)).toEqual([]);
});

test("rejects a non-string text", async () => {
  const { app, session } = harness();
  expect((await app.fetch(post(session.id, { text: 42 }))).status).toBe(400);
  expect((await app.fetch(post(session.id, {}))).status).toBe(400);
});

test("rejects text over the char cap, and accepts text exactly at it", async () => {
  const { app, session } = harness();
  const over = await app.fetch(post(session.id, { text: "x".repeat(AMENDMENT_MAX_CHARS + 1) }));
  expect(over.status).toBe(400);
  const at = await app.fetch(post(session.id, { text: "y".repeat(AMENDMENT_MAX_CHARS) }));
  expect(at.status).toBe(201);
});

test("404s on an unknown session and writes nothing", async () => {
  const { app, store } = harness();
  const res = await app.fetch(post("no-such-session", { text: "hello" }));
  expect(res.status).toBe(404);
  expect(store.snapshotTaskAmendments()).toEqual({});
});

// ── the steer ────────────────────────────────────────────────────────────────

test("steer:true delivers through operatorReply, wrapper on the PTY and raw text in the signal", async () => {
  const { app, session, calls } = harness();
  const res = await app.fetch(post(session.id, { text: "go ahead and build it", steer: true }));
  expect(((await res.json()) as { steered: boolean }).steered).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.id).toBe(session.id);
  // The PTY text is Shepherd's wrapper carrying the operator's words...
  expect(calls[0]!.text).toContain("The operator has AMENDED your task");
  expect(calls[0]!.text).toContain("go ahead and build it");
  // ...while the recorded signal keeps the RAW operator text, so the learnings distiller never
  // mines Shepherd's own boilerplate.
  expect(calls[0]!.signalPayload).toBe("go ahead and build it");
});

test("no steer requested → operatorReply is never called", async () => {
  const { app, session, calls } = harness();
  await app.fetch(post(session.id, { text: "recorded only" }));
  await app.fetch(post(session.id, { text: "also recorded only", steer: false }));
  expect(calls).toEqual([]);
});

test("a steer that does not land reports steered:false and still persists the amendment", async () => {
  const { app, store, session } = harness({ result: false });
  const res = await app.fetch(post(session.id, { text: "dead pane", steer: true }));
  expect(res.status).toBe(201);
  expect(((await res.json()) as { steered: boolean }).steered).toBe(false);
  expect(store.listActiveTaskAmendments(session.id).map((a) => a.text)).toEqual(["dead pane"]);
});

test("a throwing operatorReply (terminal-session guard) is caught, not surfaced as a 500", async () => {
  const { app, store, session } = harness({ throws: true });
  const res = await app.fetch(post(session.id, { text: "clean terminal", steer: true }));
  expect(res.status).toBe(201);
  expect(((await res.json()) as { steered: boolean }).steered).toBe(false);
  expect(store.listActiveTaskAmendments(session.id)).toHaveLength(1);
});

// ── DELETE /api/sessions/:id/amendments/:amendmentId ─────────────────────────

test("retract soft-deletes and re-broadcasts the list", async () => {
  const { app, store, session, events } = harness();
  const rec = store.addTaskAmendment(session.id, "mistyped", 1000);
  const res = await app.fetch(
    new Request(`http://x/api/sessions/${session.id}/amendments/${rec.id}`, { method: "DELETE" }),
  );
  expect(res.status).toBe(200);
  expect(
    ((await res.json()) as { amendment: { retractedAt: number } }).amendment.retractedAt,
  ).toBeGreaterThan(0);
  expect(store.listActiveTaskAmendments(session.id)).toEqual([]);
  const last = events.filter((e) => e.event === "session:amendments").at(-1)!.data as {
    amendments: { retractedAt: number | null }[];
  };
  expect(last.amendments).toHaveLength(1); // still in the record, marked retracted
  expect(last.amendments[0]!.retractedAt).toBeGreaterThan(0);
});

test("retract 404s for an unknown amendment and for another session's amendment", async () => {
  const { app, store, session } = harness();
  const other = store.create({ ...base, herdrAgentId: "term_2" });
  const rec = store.addTaskAmendment(session.id, "belongs to the first session", 1000);
  expect(
    (
      await app.fetch(
        new Request(`http://x/api/sessions/${session.id}/amendments/nope`, { method: "DELETE" }),
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await app.fetch(
        new Request(`http://x/api/sessions/${other.id}/amendments/${rec.id}`, { method: "DELETE" }),
      )
    ).status,
  ).toBe(404);
  expect(store.listActiveTaskAmendments(session.id)).toHaveLength(1);
});

// ── GET /api/amendments ──────────────────────────────────────────────────────

test("GET /api/amendments returns the snapshot keyed by session id", async () => {
  const { app, store, session } = harness();
  store.addTaskAmendment(session.id, "one", 1000);
  const res = await app.fetch(new Request("http://x/api/amendments"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, { text: string }[]>;
  expect(body[session.id]?.map((a) => a.text)).toEqual(["one"]);
});

test("GET /api/amendments is {} when nothing has been amended", async () => {
  const { app } = harness();
  expect(await (await app.fetch(new Request("http://x/api/amendments"))).json()).toEqual({});
});
