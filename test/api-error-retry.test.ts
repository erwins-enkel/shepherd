import { describe, expect, test } from "bun:test";
import { API_RETRY_STEER, transientApiError } from "../src/api-error-retry-core";
import { API_RETRY_DELAYS_MS, ApiErrorRetry } from "../src/api-error-retry";
import type { Session } from "../src/types";

const line = (o: object) => JSON.stringify(o);
const apiError = (uuid: string, error = "server_error", text = "API Error: Connection lost") =>
  line({
    type: "assistant",
    uuid,
    isApiErrorMessage: true,
    error,
    message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text }] },
  });
const assistant = (uuid: string) =>
  line({ type: "assistant", uuid, message: { content: [{ type: "text", text: "ok" }] } });
const user = (uuid: string) => line({ type: "user", uuid, message: { content: "retry" } });
const trailer = [
  line({ type: "system", subtype: "turn_duration" }),
  line({ type: "api-request-blob", content: [] }),
  line({ type: "api-request", timestamp: "2026-10-26T14:15:39.826Z" }),
].join("\n");

describe("transientApiError", () => {
  test("stream cut ending the transcript is transient", () => {
    expect(transientApiError([user("u1"), apiError("e1")].join("\n"))).toEqual({ uuid: "e1" });
  });
  test("529 overloaded (server_error) is transient", () => {
    const t = apiError("e2", "server_error", "API Error: 529 Overloaded.");
    expect(transientApiError(t)).toEqual({ uuid: "e2" });
  });
  test("non-conversational records after the error are skipped", () => {
    expect(transientApiError([apiError("e1"), trailer].join("\n"))).toEqual({ uuid: "e1" });
  });
  test("auth / rate-limit errors are not transient", () => {
    expect(transientApiError(apiError("e1", "authentication_failed"))).toBeNull();
    expect(transientApiError(apiError("e1", "rate_limit"))).toBeNull();
  });
  test("a later conversational record supersedes the error", () => {
    expect(transientApiError([apiError("e1"), user("u2")].join("\n"))).toBeNull();
    expect(transientApiError([apiError("e1"), assistant("a2")].join("\n"))).toBeNull();
  });
  test("sidechain errors are ignored; garbled lines skipped", () => {
    const side = line({
      type: "assistant",
      uuid: "s",
      isSidechain: true,
      isApiErrorMessage: true,
      error: "server_error",
    });
    expect(transientApiError([assistant("a1"), side].join("\n"))).toBeNull();
    expect(transientApiError(["{garbled", apiError("e1"), "nope"].join("\n"))).toEqual({
      uuid: "e1",
    });
    expect(transientApiError("")).toBeNull();
  });
});

function harness(initial: Partial<Session> = {}) {
  let session = {
    id: "s1",
    desig: "TASK-1",
    status: "done",
    claudeSessionId: "c1",
    ...initial,
  } as Session;
  let transcript = apiError("e1");
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const steers: string[] = [];
  const halts: string[] = [];
  const handBacks: string[] = [];
  let steerOk = true;
  const retry = new ApiErrorRetry({
    getSession: () => session,
    readTranscript: async () => transcript,
    steer: async (id, text) => {
      steers.push(`${id}:${text}`);
      return steerOk;
    },
    setHalt: (id) => halts.push(id),
    handBack: async (id) => {
      handBacks.push(id);
    },
    schedule: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => (t.cancelled = true);
    },
    now: () => 1,
    log: () => {},
  });
  const done = () =>
    retry.handle({ kind: "status", status: "done", snapshot: { id: session.id, session } });
  const fireLast = async () => {
    const t = timers.at(-1)!;
    t.fn();
    await new Promise((r) => setTimeout(r, 0));
  };
  return {
    retry,
    timers,
    steers,
    halts,
    handBacks,
    done,
    fireLast,
    set: (p: Partial<Session>) => (session = { ...session, ...p }),
    setTranscript: (t: string) => (transcript = t),
    failSteer: () => (steerOk = false),
  };
}

describe("ApiErrorRetry", () => {
  test("backs off 20/60/180s, then halts without steering", async () => {
    const h = harness();
    for (let i = 0; i < API_RETRY_DELAYS_MS.length; i++) {
      h.setTranscript(apiError(`e${i}`));
      await h.done();
      expect(h.retry.pending("s1")).toBe(true);
      await h.fireLast();
      expect(h.retry.pending("s1")).toBe(false);
    }
    expect(h.timers.map((t) => t.ms)).toEqual([20_000, 60_000, 180_000]);
    expect(h.steers).toEqual(Array(3).fill(`s1:${API_RETRY_STEER}`));
    h.setTranscript(apiError("e9"));
    await h.done();
    expect(h.timers).toHaveLength(3);
    expect(h.halts).toEqual(["s1"]);
    expect(h.retry.pending("s1")).toBe(false);
    await h.done(); // repeat edge on the same exhausted error → no second halt
    expect(h.halts).toEqual(["s1"]);
  });

  test("a clean turn end resets the streak", async () => {
    const h = harness();
    await h.done();
    await h.fireLast();
    h.setTranscript(assistant("a1"));
    await h.done();
    h.setTranscript(apiError("e2"));
    await h.done();
    expect(h.timers.map((t) => t.ms)).toEqual([20_000, 20_000]);
  });

  test("duplicate done edge for the same error arms one timer", async () => {
    const h = harness();
    await h.done();
    await h.done();
    expect(h.timers).toHaveLength(1);
  });

  test("idle at fire time with the same error still steers", async () => {
    const h = harness();
    await h.done();
    h.set({ status: "idle" });
    await h.fireLast();
    expect(h.steers).toHaveLength(1);
    expect(h.handBacks).toEqual([]);
  });

  test("running or archived at fire time: no steer, no hand-back", async () => {
    for (const status of ["running", "blocked", "archived"] as const) {
      const h = harness();
      await h.done();
      h.set({ status });
      await h.fireLast();
      expect(h.steers).toEqual([]);
      expect(h.handBacks).toEqual([]);
    }
  });

  test("resting but the error is gone → hand back, no steer", async () => {
    const h = harness();
    await h.done();
    h.setTranscript([apiError("e1"), user("u2"), assistant("a2")].join("\n"));
    await h.fireLast();
    expect(h.steers).toEqual([]);
    expect(h.handBacks).toEqual(["s1"]);
  });

  test("undeliverable steer → hand back", async () => {
    const h = harness();
    h.failSteer();
    await h.done();
    await h.fireLast();
    expect(h.steers).toHaveLength(1);
    expect(h.handBacks).toEqual(["s1"]);
  });

  test("non-Claude, terminal and transcript-less sessions are ignored", async () => {
    for (const p of [{ agentProvider: "codex" }, { terminal: true }, { claudeSessionId: "" }]) {
      const h = harness(p as Partial<Session>);
      await h.done();
      expect(h.timers).toEqual([]);
    }
  });

  test("forget cancels the pending timer", async () => {
    const h = harness();
    await h.done();
    h.retry.forget("s1");
    expect(h.timers[0]!.cancelled).toBe(true);
    expect(h.retry.pending("s1")).toBe(false);
    await h.fireLast();
    expect(h.steers).toEqual([]);
  });

  test("a recovered turn end on an idle pane arms the retry; a later edge is a no-op", async () => {
    const h = harness({ status: "idle" });
    await h.retry.onTurnEnd({ id: "s1", status: "idle", claudeSessionId: "c1" } as Session);
    expect(h.retry.pending("s1")).toBe(true);
    await h.done();
    expect(h.timers).toHaveLength(1);
  });

  test("non-done status edges are ignored", async () => {
    const h = harness();
    await h.retry.handle({
      kind: "status",
      status: "running",
      snapshot: { id: "s1", session: { id: "s1" } as Session },
    });
    expect(h.timers).toEqual([]);
  });
});
