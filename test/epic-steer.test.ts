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
  const store = new SessionStore(":memory:");
  const svc = new SessionService({
    store,
    worktree: {},
    herdr: {
      send: (_id: string, text: string) => {
        sent.push(text);
      },
      list: () => liveIds.current.map((terminalId) => ({ terminalId })),
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
  return { svc, store, sent, pasted, liveIds, id: s.id };
}

describe("operatorReply", () => {
  test("injects the notice into the PTY on the first epic reply", () => {
    const { svc, pasted, id } = makeSvc();
    expect(svc.operatorReply(id, EPIC_MSG)).toBe(true);
    expect(pasted()).toContain(NOTICE_MARK);
    expect(pasted()).toContain(EPIC_MSG);
  });

  test("records only the raw operator text in the reply signal — never the notice", () => {
    const { svc, store, id } = makeSvc();
    svc.operatorReply(id, EPIC_MSG);
    const sigs = store.listSignals("/r");
    expect(sigs.length).toBe(1);
    expect(sigs[0]!.kind).toBe("reply");
    expect(sigs[0]!.payload).toBe(EPIC_MSG); // raw words, so the distiller never mines the notice
    expect(sigs[0]!.payload).not.toContain(NOTICE_MARK);
  });

  test("injects at most once per session (dedup)", () => {
    const { svc, sent, id } = makeSvc();
    svc.operatorReply(id, EPIC_MSG);
    sent.length = 0; // drop the first delivery's captures
    expect(svc.operatorReply(id, "also split #20 into sub-issues")).toBe(true);
    const second = sent.join("");
    expect(second).not.toContain(NOTICE_MARK); // second epic reply is delivered verbatim
    expect(second).toContain("also split #20 into sub-issues");
  });

  test("marks only on successful delivery — a dead pane keeps the one-shot armed", () => {
    const { svc, pasted, liveIds, id } = makeSvc([]); // no live terminals → delivery fails
    expect(svc.operatorReply(id, EPIC_MSG)).toBe(false);
    expect(pasted()).toBe(""); // nothing delivered, nothing recorded
    liveIds.current = ["t1"]; // pane comes back
    expect(svc.operatorReply(id, EPIC_MSG)).toBe(true);
    expect(pasted()).toContain(NOTICE_MARK); // the notice still rides on the retry
  });

  test("a non-epic reply is delivered verbatim (unchanged reply behavior)", () => {
    const { svc, store, pasted, id } = makeSvc();
    expect(svc.operatorReply(id, PLAIN_MSG)).toBe(true);
    expect(pasted()).toContain(PLAIN_MSG);
    expect(pasted()).not.toContain(NOTICE_MARK);
    expect(store.listSignals("/r")[0]!.payload).toBe(PLAIN_MSG);
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
