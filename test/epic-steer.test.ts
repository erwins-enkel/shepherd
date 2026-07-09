import { test, expect, describe } from "bun:test";
import { SessionService, composeEpicSteer } from "../src/service";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { makeApp, type AppDeps } from "../src/server";

const EPIC_MSG = "promote #12 to an epic with sub-issues";
const PLAIN_MSG = "fix the login bug";
const NOTICE_MARK = "<epic-authoring-notice>";

// ── the pure helper ──

describe("composeEpicSteer", () => {
  test("returns null when the message shows no epic intent", () => {
    expect(composeEpicSteer(PLAIN_MSG)).toBeNull();
  });

  test("appends the wrapped notice (with the epic-dag grammar) when intent matches", () => {
    const out = composeEpicSteer(EPIC_MSG);
    expect(out).not.toBeNull();
    expect(out!).toContain(EPIC_MSG); // the operator's own words ride first
    expect(out!).toContain(NOTICE_MARK);
    expect(out!).toContain("</epic-authoring-notice>");
    expect(out!).toContain("```epic-dag"); // the recognition contract is carried
  });
});

// ── operatorReply: stateful behavior ──

/** Service harness modeled on test/signal-capture.test.ts, with a mutable live-terminal set and a
 *  capture of everything pasted into the pane. */
function makeSvc(live: string[] = ["t1"]) {
  const sent: string[] = [];
  const liveIds = { current: live };
  /** Flip to make every `herdr.send` REJECT — a pane that dies after the liveness check (#1567). */
  const sendFails = { current: false };
  const store = new SessionStore(":memory:");
  const svc = new SessionService({
    store,
    worktree: {},
    herdr: {
      send: async (_id: string, text: string) => {
        if (sendFails.current) throw new Error("herdr: no such agent");
        sent.push(text);
      },
      list: () => liveIds.current.map((terminalId) => ({ terminalId, agentStatus: "idle" })),
    },
    namer: (p: string) => p,
  } as any);
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
  const pasted = () => sent.join("");
  return { svc, store, sent, pasted, liveIds, sendFails, id: s.id };
}

/** How many times the epic-authoring notice was injected across everything pasted so far. */
const noticeCount = (pasted: string) => pasted.split(NOTICE_MARK).length - 1;

describe("operatorReply", () => {
  test("injects the notice into the PTY on the first epic reply", async () => {
    const { svc, pasted, id } = makeSvc();
    expect(await svc.operatorReply(id, EPIC_MSG)).toBe(true);
    expect(pasted()).toContain(NOTICE_MARK);
    expect(pasted()).toContain(EPIC_MSG);
  });

  test("records only the raw operator text in the reply signal — never the notice", async () => {
    const { svc, store, id } = makeSvc();
    await svc.operatorReply(id, EPIC_MSG);
    const sigs = store.listSignals("/r");
    expect(sigs.length).toBe(1);
    expect(sigs[0]!.kind).toBe("reply");
    expect(sigs[0]!.payload).toBe(EPIC_MSG); // raw words, so the distiller never mines the notice
    expect(sigs[0]!.payload).not.toContain(NOTICE_MARK);
  });

  test("injects at most once per session (dedup)", async () => {
    const { svc, sent, id } = makeSvc();
    await svc.operatorReply(id, EPIC_MSG);
    sent.length = 0; // drop the first delivery's captures
    expect(await svc.operatorReply(id, "also split #20 into sub-issues")).toBe(true);
    const second = sent.join("");
    expect(second).not.toContain(NOTICE_MARK); // second epic reply is delivered verbatim
    expect(second).toContain("also split #20 into sub-issues");
  });

  test("marks only on successful delivery — a dead pane keeps the one-shot armed", async () => {
    const { svc, pasted, liveIds, id } = makeSvc([]); // no live terminals → delivery fails
    expect(await svc.operatorReply(id, EPIC_MSG)).toBe(false);
    expect(pasted()).toBe(""); // nothing delivered, nothing recorded
    liveIds.current = ["t1"]; // pane comes back
    expect(await svc.operatorReply(id, EPIC_MSG)).toBe(true);
    expect(pasted()).toContain(NOTICE_MARK); // the notice still rides on the retry
  });

  // The two invariants the async send (#1567) put at risk: the one-shot is now claimed BEFORE the
  // await (so a concurrent steer can't double-inject) and rolled back if that await rejects.

  test("a send that REJECTS mid-flight does not burn the one-shot", async () => {
    const { svc, pasted, sendFails, id } = makeSvc(); // pane is LIVE — it dies during the send
    sendFails.current = true;

    await expect(svc.operatorReply(id, EPIC_MSG)).rejects.toThrow("no such agent");
    expect(pasted()).toBe("");

    sendFails.current = false; // pane recovers
    expect(await svc.operatorReply(id, EPIC_MSG)).toBe(true);
    expect(noticeCount(pasted())).toBe(1); // the notice still rides on the retry
  });

  test("two concurrent epic replies inject the notice exactly once", async () => {
    const { svc, pasted, id } = makeSvc();

    // Both start before either's send resolves — the one-shot must be claimed synchronously.
    const [a, b] = await Promise.all([
      svc.operatorReply(id, EPIC_MSG),
      svc.operatorReply(id, "also split #20 into sub-issues"),
    ]);

    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(noticeCount(pasted())).toBe(1);
  });

  test("a non-epic reply is delivered verbatim (unchanged reply behavior)", async () => {
    const { svc, store, pasted, id } = makeSvc();
    expect(await svc.operatorReply(id, PLAIN_MSG)).toBe(true);
    expect(pasted()).toContain(PLAIN_MSG);
    expect(pasted()).not.toContain(NOTICE_MARK);
    expect(store.listSignals("/r")[0]!.payload).toBe(PLAIN_MSG);
  });
});

// ── broadcast: the other operator free-text channel shares the same notice logic ──

describe("broadcast", () => {
  test("injects the notice on an epic-intent broadcast while preserving accounting + raw signal", async () => {
    const { svc, store, pasted, id } = makeSvc();
    const res = await svc.broadcast([id], EPIC_MSG);
    expect(res).toEqual({ delivered: 1, queued: 0, offline: 0, total: 1 });
    expect(pasted()).toContain(NOTICE_MARK); // the notice rides the PTY
    expect(store.listSignals("/r")[0]!.payload).toBe(EPIC_MSG); // ...but the signal stays raw
  });

  test("shares the once-per-session dedup with operatorReply", async () => {
    const { svc, sent, id } = makeSvc();
    await svc.operatorReply(id, EPIC_MSG); // marks the session
    sent.length = 0;
    const res = await svc.broadcast([id], "promote #30 to an epic");
    expect(res.delivered).toBe(1); // still delivered...
    expect(sent.join("")).not.toContain(NOTICE_MARK); // ...but the notice is not re-injected
  });

  test("a non-epic broadcast is delivered verbatim", async () => {
    const { svc, pasted, id } = makeSvc();
    await svc.broadcast([id], PLAIN_MSG);
    expect(pasted()).toContain(PLAIN_MSG);
    expect(pasted()).not.toContain(NOTICE_MARK);
  });
});

// ── route wiring: the reply endpoint goes through operatorReply, not reply ──

describe("POST /api/sessions/:id/reply", () => {
  test("routes through service.operatorReply", async () => {
    const calls: Array<[string, string]> = [];
    const store = new SessionStore(":memory:");
    const deps: AppDeps = {
      store,
      events: new EventHub(),
      service: {
        // Only operatorReply is provided: if the handler still called reply() it would throw.
        operatorReply: (id: string, text: string) => {
          calls.push([id, text]);
          return true;
        },
      } as any,
      usageLimits: { limits: () => ({}) } as any,
    };
    const app = makeApp(deps);
    const res = await app.fetch(
      new Request("http://x/api/sessions/abc/reply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: EPIC_MSG }),
      }),
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([["abc", EPIC_MSG]]);
  });
});
