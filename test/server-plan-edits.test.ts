import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexLaunchMarker } from "../src/codex-session-id";
import { EventHub } from "../src/events";
import type { HerdrAgent } from "../src/herdr";
import { planHashOf } from "../src/plan-gate";
import { makeApp, type AppDeps } from "../src/server";
import { SessionService } from "../src/service";
import { SessionStore } from "../src/store";
import type { AgentProvider, PlanGate, Session } from "../src/types";

// POST /api/sessions/:id/plan-edits and GET /api/sessions/:id/plan (#3514), end to end: the real
// store and SessionService, with herdr stubbed the way test/codex-task-targeting.test.ts does it —
// a Claude planner idles live at its prompt, a Codex planner has exited and must be resumed.

let root: string;
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.CODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "shepherd-plan-edits-"));
  mkdirSync(join(root, "codex", "sessions"), { recursive: true });
  process.env.CODEX_HOME = join(root, "codex");
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

const PLAN = "# Plan\n\n## Approach\nUse a new table.\n\n## Risks\nRaces are rare.\n";
const EDITED = PLAN.replace("Use a new table.", "Reuse the column.");
const BASE = planHashOf(PLAN.trim());
const EDITS = [
  {
    id: "e1",
    kind: "replace",
    section: "Approach",
    before: "Use a new table.",
    after: "Reuse the column.",
    reason: "Less migration risk",
  },
  { id: "c1", kind: "comment", section: "Risks", before: "Races are rare.", reason: "Name it." },
];

function harness(
  provider: AgentProvider,
  opts: {
    paneLive?: boolean;
    phase?: Session["planPhase"];
    gate?: Partial<PlanGate> | null;
    cancel?: "cancelled" | "skipped" | "none";
  } = {},
) {
  const wt = join(root, "wt");
  mkdirSync(wt);
  writeFileSync(join(wt, ".shepherd-plan.md"), PLAN);
  const store = new SessionStore(":memory:");
  const s = store.create({
    name: "target",
    prompt: "task",
    repoPath: wt,
    baseBranch: "main",
    branch: null,
    worktreePath: wt,
    isolated: false,
    herdrSession: "default",
    herdrAgentId: "target-pane",
    agentProvider: provider,
    claudeSessionId: provider === "claude" ? "claude-target" : "",
    codexLaunchId: provider === "codex" ? "target" : "",
    planPhase: opts.phase === undefined ? "planning" : opts.phase,
  });
  store.update(s.id, { status: "idle" });
  if (opts.gate !== null)
    store.putPlanGate({
      sessionId: s.id,
      planHash: BASE,
      decision: "approved",
      approved: true,
      approvedAt: 1,
      summary: "ok",
      body: "",
      findings: [],
      round: 1,
      cap: 5,
      plan: PLAN.trim(),
      updatedAt: 1,
      ...opts.gate,
    });
  if (provider === "codex")
    writeFileSync(
      join(root, "codex", "sessions", "rollout-native-target.jsonl"),
      [
        { type: "session_meta", payload: { id: "native-target", cwd: wt, source: "cli" } },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: codexLaunchMarker("target") + "Task" }],
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );
  const agent = (terminalId: string, agentStatus = "idle") =>
    ({ terminalId, paneId: terminalId, cwd: wt, name: "target", agentStatus }) as HerdrAgent;
  const agents: HerdrAgent[] = opts.paneLive ? [agent("target-pane")] : [];
  const starts: string[][] = [];
  const sent: { terminal: string; text: string }[] = [];
  const sendControl: { fail: boolean; hold: Promise<void> | null } = { fail: false, hold: null };
  const considered: string[] = [];
  const service = new SessionService({
    transcriptExists: () => true,
    store,
    namer: async () => "target",
    detectBackend: () => null,
    detectEgressBackend: () => null,
    worktree: { remove() {}, gitCommonDir: () => "/git" } as any,
    herdr: {
      listAsync: async () => agents,
      start: async (_name: string, _cwd: string, argv: string[]) => {
        starts.push(argv);
        const live = agent("resumed", "working");
        agents.push(live);
        return live;
      },
      stop: async () => {},
      paneForegroundProcs: async () => [provider],
      send: async (terminal: string, text: string) => {
        if (sendControl.fail) throw new Error("pane gone");
        await sendControl.hold;
        sent.push({ terminal, text });
      },
    } as any,
  });
  const cancels: string[] = [];
  const events = new EventHub();
  const deps: AppDeps = {
    store,
    service,
    events,
    usageLimits: { limits: () => ({}) } as any,
    planGate: {
      consider: (async (session: Session) => {
        considered.push(session.id);
        return "skipped";
      }) as any,
      cancel: async (id: string) => {
        cancels.push(id);
        return opts.cancel ?? "none";
      },
    },
  };
  const app = makeApp(deps);
  const post = (body: unknown, contentType = "application/json") =>
    app.fetch(
      new Request(`http://x/api/sessions/${s.id}/plan-edits`, {
        method: "POST",
        headers: { "content-type": contentType },
        body: JSON.stringify(body),
      }),
    );
  const steers = () => sent.filter((m) => m.text.includes("The operator edited"));
  const planOnDisk = () => readFileSync(join(wt, ".shepherd-plan.md"), "utf8");
  return {
    app,
    store,
    service,
    s,
    wt,
    starts,
    steers,
    cancels,
    post,
    planOnDisk,
    sendControl,
    considered,
  };
}

const edit = (over: Record<string, unknown> = {}) => ({
  baseHash: BASE,
  plan: EDITED,
  edits: EDITS,
  ...over,
});

describe("POST plan-edits lands the edit and hands it to the planner in ONE steer", () => {
  for (const provider of ["claude", "codex"] as const) {
    test(`${provider} planning session`, async () => {
      // Claude idles live at its prompt; Codex exits after its turn and is resumed first.
      const h = harness(provider, { paneLive: provider === "claude" });
      const res = await h.post(edit());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        delivered: true,
        planHash: planHashOf(EDITED.trim()),
        revision: 2,
      });
      expect(h.planOnDisk()).toBe(EDITED);
      const revisions = h.store.listPlanRevisions(h.s.id);
      expect(revisions.map((r) => [r.revision, r.author, r.planHash])).toEqual([
        [1, "agent", BASE],
        [2, "operator", planHashOf(EDITED.trim())],
      ]);
      expect(revisions[1]!.edits.map((e) => e.id)).toEqual(["e1", "c1"]);
      // The approval is withdrawn; approvedAt and the verdict stay as they were.
      expect(h.store.getPlanGate(h.s.id)).toMatchObject({
        approved: false,
        approvedAt: 1,
        decision: "approved",
        planHash: BASE,
      });
      expect(h.steers()).toHaveLength(1);
      const steer = h.steers()[0]!.text;
      expect(steer).toContain("(revision 1 → 2: 1 edit, 1 comment)");
      expect(steer).toContain("[edit 1] Approach\n- Use a new table.\n+ Reuse the column.");
      expect(steer).toContain("why: Less migration risk");
      expect(steer).toContain('[comment 1] on "Races are rare." (Risks)\nName it.');
      expect(steer).not.toContain("STOP implementing");
      expect(h.starts).toHaveLength(provider === "codex" ? 1 : 0);
      expect(h.store.get(h.s.id)?.planPhase).toBe("planning");
    });

    test(`${provider} executing session goes back to planning`, async () => {
      const h = harness(provider, { phase: "executing" });
      const res = await h.post(edit());
      expect(res.status).toBe(200);
      expect(((await res.json()) as { delivered: boolean }).delivered).toBe(true);
      expect(h.store.get(h.s.id)?.planPhase).toBe("planning");
      expect(h.steers()).toHaveLength(1);
      expect(h.steers()[0]!.text).toContain("This session was executing: STOP implementing.");
      expect(h.steers()[0]!.text).toContain("[edit 1] Approach");
    });
  }

  test("a comment-only edit keeps the text and still records the operator's revision", async () => {
    const h = harness("claude", { paneLive: true });
    const res = await h.post(edit({ plan: PLAN, edits: [EDITS[1]] }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { revision: number }).revision).toBe(2);
    expect(h.planOnDisk()).toBe(PLAN);
    expect(h.steers()[0]!.text).toContain("(revision 1 → 2: 1 comment)");
  });

  test("a plan review in flight is cancelled before the edit lands", async () => {
    const h = harness("claude", { paneLive: true, cancel: "cancelled" });
    expect((await h.post(edit())).status).toBe(200);
    expect(h.cancels).toEqual([h.s.id]);
  });
});

describe("POST plan-edits refuses without touching the plan", () => {
  async function refused(
    h: ReturnType<typeof harness>,
    body: unknown,
    status: number,
    code: string,
  ): Promise<Record<string, unknown>> {
    const res = await h.post(body);
    expect(res.status).toBe(status);
    const out = (await res.json()) as Record<string, unknown>;
    expect(out.code).toBe(code);
    expect(h.planOnDisk()).toBe(PLAN);
    expect(h.store.listPlanRevisions(h.s.id)).toEqual([]);
    expect(h.store.getPlanGate(h.s.id)?.approved).toBe(true);
    expect(h.steers()).toEqual([]);
    return out;
  }

  test("a stale baseHash → 409 plan_changed with the current plan, hash and revision", async () => {
    const h = harness("codex");
    h.store.recordAgentPlanRevision(h.s.id, BASE, PLAN.trim());
    const res = await h.post(edit({ baseHash: "stale" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: expect.any(String),
      code: "plan_changed",
      plan: PLAN,
      planHash: BASE,
      revision: 1,
    });
    expect(h.planOnDisk()).toBe(PLAN);
    expect(h.store.listPlanRevisions(h.s.id)).toHaveLength(1);
    expect(h.steers()).toEqual([]);
    expect(h.cancels).toEqual([]);
  });

  for (const status of ["running", "blocked"] as const)
    test(`a ${status} planner → 409 planner_busy`, async () => {
      const h = harness("claude", { paneLive: true });
      h.store.update(h.s.id, { status });
      await refused(h, edit(), 409, "planner_busy");
    });

  test("a review verdict already landing → 409 planner_busy", async () => {
    const h = harness("claude", { paneLive: true, cancel: "skipped" });
    await refused(h, edit(), 409, "planner_busy");
  });

  test("no plan gate, an executing session without an approval, or no plan → 409 not_editable", async () => {
    await refused(harness("claude", { phase: null }), edit(), 409, "not_editable");
    rmSync(join(root, "wt"), { recursive: true });
    const unapproved = harness("claude", { phase: "executing", gate: { approved: false } });
    const res = await unapproved.post(edit());
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("not_editable");
    rmSync(join(root, "wt"), { recursive: true });
    const noPlan = harness("claude");
    rmSync(join(noPlan.wt, ".shepherd-plan.md"));
    expect((await noPlan.post(edit())).status).toBe(409);
  });

  test("edits that do not describe the change → 400 edits_mismatch naming the edit", async () => {
    const h = harness("claude", { paneLive: true });
    const out = await refused(
      h,
      edit({ edits: [{ ...EDITS[0], before: "Not in the plan." }] }),
      400,
      "edits_mismatch",
    );
    expect(out.editId).toBe("e1");
  });

  test("a malformed body → 400 invalid_body; not JSON → 415; unknown session → 404", async () => {
    const h = harness("claude", { paneLive: true });
    await refused(h, edit({ edits: [] }), 400, "invalid_body");
    expect((await h.post(edit(), "text/plain")).status).toBe(415);
    const res = await h.app.fetch(
      new Request("http://x/api/sessions/nope/plan-edits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(edit()),
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe('POST plan-edits with mode "go" releases the plan with the edits (#3518)', () => {
  const go = (over: Record<string, unknown> = {}) => edit({ mode: "go", ...over });
  const EDITED_HASH = planHashOf(EDITED.trim());

  for (const provider of ["claude", "codex"] as const) {
    test(`${provider}: exactly one Go carrying every edit, at revision n+1, no review`, async () => {
      const h = harness(provider, { paneLive: provider === "claude" });
      const res = await h.post(go());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        delivered: true,
        planHash: EDITED_HASH,
        revision: 2,
      });
      expect(h.planOnDisk()).toBe(EDITED);
      expect(h.store.get(h.s.id)?.planPhase).toBe("executing");
      expect(h.store.getPlanGate(h.s.id)).toMatchObject({
        approved: true,
        decision: "approved",
        approvedAt: 1,
        updatedAt: 1,
        plan: EDITED.trim(),
        planHash: EDITED_HASH,
        livePlanHash: EDITED_HASH,
        operatorRelease: { revision: 2, fromRevision: 2, at: expect.any(Number) },
      });
      expect(h.store.listPlanRevisions(h.s.id).map((r) => [r.revision, r.author])).toEqual([
        [1, "agent"],
        [2, "operator"],
      ]);
      expect(h.steers()).toHaveLength(1);
      const steer = h.steers()[0]!.text;
      expect(steer).toContain("Plan approved. Execute `.shepherd-plan.md` now");
      expect(steer).toContain("(revision 1 → 2: 1 edit, 1 comment)");
      expect(steer).toContain("- Use a new table.\n+ Reuse the column.");
      expect(steer).toContain("→ follow this while implementing.");
      expect(steer).not.toContain("re-reviewed");
      expect(h.considered).toEqual([]);
    });
  }

  test("a second request while the first is delivering is refused: one Go, one revision", async () => {
    const h = harness("claude", { paneLive: true });
    const comment = { ...EDITS[1] };
    // Comment-only keeps the hash, so only the in-flight guard can stop the second one.
    const body = go({ plan: PLAN, edits: [comment] });
    const [a, b] = await Promise.all([h.post(body), h.post(body)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(((await (a.status === 409 ? a : b).json()) as { code: string }).code).toBe(
      "planner_busy",
    );
    expect(h.steers()).toHaveLength(1);
    expect(h.store.listPlanRevisions(h.s.id).map((r) => r.revision)).toEqual([1, 2]);
    expect(h.store.get(h.s.id)?.planPhase).toBe("executing");
  });

  test("once released, a repeat is refused", async () => {
    const h = harness("claude", { paneLive: true });
    const body = go({ plan: PLAN, edits: [{ ...EDITS[1] }] });
    expect((await h.post(body)).status).toBe(200);
    const again = await h.post(body);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe("not_releasable");
    expect(h.steers()).toHaveLength(1);
  });

  async function notReleasable(h: ReturnType<typeof harness>, why: string): Promise<void> {
    const gate = h.store.getPlanGate(h.s.id);
    const res = await h.post(go());
    expect(res.status).toBe(409);
    const out = (await res.json()) as { code: string; error: string };
    expect(out.code).toBe("not_releasable");
    expect(out.error).toContain(why);
    expect(h.planOnDisk()).toBe(PLAN);
    expect(h.store.listPlanRevisions(h.s.id)).toEqual([]);
    expect(h.store.getPlanGate(h.s.id)).toEqual(gate);
    expect(h.steers()).toEqual([]);
    expect(h.cancels).toEqual([]);
  }

  test("409 not_releasable: not approved", async () => {
    const gate = { approved: false, decision: "changes_requested" as const };
    await notReleasable(harness("claude", { paneLive: true, gate }), "not approved");
  });

  test("409 not_releasable: no verdict yet", async () => {
    await notReleasable(harness("claude", { paneLive: true, gate: null }), "not approved");
  });

  test("409 not_releasable: already executing", async () => {
    await notReleasable(harness("claude", { paneLive: true, phase: "executing" }), "planning");
  });

  test("409 not_releasable: no conversation to continue", async () => {
    const h = harness("claude", { paneLive: true });
    h.store.update(h.s.id, { claudeSessionId: "" });
    h.service.hasConversation = () => false;
    await notReleasable(h, "conversation");
  });

  test("409 not_releasable: the agent edited the plan after approval", async () => {
    const gate = { planHash: planHashOf("reviewed"), plan: "reviewed" };
    await notReleasable(harness("claude", { paneLive: true, gate }), "after it was approved");
  });

  test("a failed delivery keeps the release, and plain Go hands the edits over once", async () => {
    const h = harness("claude", { paneLive: true });
    h.sendControl.fail = true;
    const res = await h.post(go());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, delivered: false, revision: 2 });
    expect(h.store.get(h.s.id)?.planPhase).toBe("planning");
    expect(h.store.getPlanGate(h.s.id)).toMatchObject({ approved: true, planHash: EDITED_HASH });
    h.sendControl.fail = false;
    const retry = await h.app.fetch(
      new Request(`http://x/api/sessions/${h.s.id}/go`, { method: "POST" }),
    );
    expect(retry.status).toBe(200);
    expect(h.store.get(h.s.id)?.planPhase).toBe("executing");
    expect(h.steers()).toHaveLength(1);
    expect(h.steers()[0]!.text).toContain("+ Reuse the column.");
  });

  describe("a Go that never reached the agent leaves its edits pending", () => {
    const SECOND = EDITED.replace("Races are rare.", "Races are handled.");
    const second = {
      id: "e2",
      kind: "replace",
      section: "Risks",
      before: "Races are rare.",
      after: "Races are handled.",
    };
    const secondBody = { baseHash: planHashOf(EDITED.trim()), plan: SECOND, edits: [second] };
    async function failedGo(): Promise<ReturnType<typeof harness>> {
      const h = harness("claude", { paneLive: true });
      h.sendControl.fail = true;
      expect(await (await h.post(go())).json()).toMatchObject({ delivered: false, revision: 2 });
      h.sendControl.fail = false;
      return h;
    }

    test("the next Go carries both revisions, comment included", async () => {
      const h = await failedGo();
      const res = await h.post({ ...secondBody, mode: "go" });
      expect(await res.json()).toMatchObject({ delivered: true, revision: 3 });
      expect(h.store.getPlanGate(h.s.id)?.operatorRelease).toMatchObject({
        revision: 3,
        fromRevision: 2,
      });
      expect(h.steers()).toHaveLength(1);
      const steer = h.steers()[0]!.text;
      expect(steer).toContain("(revision 1 → 3: 2 edits, 1 comment)");
      expect(steer).toContain("+ Reuse the column.");
      expect(steer).toContain("Name it.\n→ follow this while implementing.");
      expect(steer).toContain("+ Races are handled.");
    });

    test("a resubmit carries them too, and withdraws the release", async () => {
      const h = await failedGo();
      expect((await h.post(secondBody)).status).toBe(200);
      expect(h.store.getPlanGate(h.s.id)).toMatchObject({ approved: false, operatorRelease: null });
      expect(h.steers()).toHaveLength(1);
      const steer = h.steers()[0]!.text;
      expect(steer).toContain("(revision 1 → 3: 2 edits, 1 comment)");
      expect(steer).toContain("Name it.\n→ rewrite this passage yourself.");
    });

    test("after a delivered Go, an edit carries only its own revision", async () => {
      const h = harness("claude", { paneLive: true });
      expect(await (await h.post(go())).json()).toMatchObject({ delivered: true });
      expect((await h.post(secondBody)).status).toBe(200);
      const steer = h.steers().at(-1)!.text;
      expect(steer).toContain("(revision 2 → 3: 1 edit)");
      expect(steer).not.toContain("Reuse the column.");
    });
  });

  test("a resubmit withdraws an operator release", async () => {
    const h = harness("claude", {
      paneLive: true,
      phase: "executing",
      gate: { operatorRelease: { revision: 1, fromRevision: 1, at: 5 } },
    });
    expect((await h.post(edit())).status).toBe(200);
    expect(h.store.getPlanGate(h.s.id)).toMatchObject({ approved: false, operatorRelease: null });
  });

  test("an edit while a plain Go is on its way is refused, in either mode", async () => {
    const h = harness("claude", { paneLive: true });
    let release = () => {};
    h.sendControl.hold = new Promise((resolve) => (release = resolve));
    const going = h.service.releasePlanGate(h.s.id);
    for (const body of [edit(), go()]) {
      const res = await h.post(body);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("planner_busy");
    }
    release();
    expect(await going).toBe(true);
    expect(h.planOnDisk()).toBe(PLAN);
    expect(h.store.listPlanRevisions(h.s.id)).toEqual([]);
  });
});

describe("GET plan/revisions (#3518)", () => {
  const read = (h: ReturnType<typeof harness>, id = h.s.id) =>
    h.app.fetch(new Request(`http://x/api/sessions/${id}/plan/revisions`));

  test("empty lists before any revision; 404 for an unknown session", async () => {
    const h = harness("claude");
    expect(await (await read(h)).json()).toEqual({ revisions: [], operatorEdits: [] });
    expect((await read(h, "nope")).status).toBe(404);
  });

  test("names each edit's revision, section, text and reason, against the live plan", async () => {
    const h = harness("claude", { paneLive: true });
    expect((await h.post(edit())).status).toBe(200);
    const body = (await (await read(h)).json()) as any;
    expect(body.revisions.map((r: any) => [r.revision, r.author, r.plan])).toEqual([
      [1, "agent", PLAN.trim()],
      [2, "operator", EDITED.trim()],
    ]);
    expect(body.operatorEdits).toMatchObject([
      {
        id: "e1",
        revision: 2,
        section: EDITS[0]!.section,
        after: "Reuse the column.",
        reason: "Less migration risk",
        inPlan: true,
      },
      { id: "c1", kind: "comment", revision: 2, reason: "Name it.", inPlan: true },
    ]);
    // The agent reverts the edit: it stays listed, marked as gone from the live plan.
    writeFileSync(join(h.wt, ".shepherd-plan.md"), PLAN);
    const reverted = (await (await read(h)).json()) as any;
    expect(reverted.operatorEdits[0]).toMatchObject({ id: "e1", inPlan: false });
  });

  test("falls back to the latest revision when the plan file is gone", async () => {
    const h = harness("claude", { paneLive: true });
    expect((await h.post(edit())).status).toBe(200);
    rmSync(join(h.wt, ".shepherd-plan.md"));
    const body = (await (await read(h)).json()) as any;
    expect(body.operatorEdits[0]).toMatchObject({ id: "e1", inPlan: true });
  });
});

describe("GET plan", () => {
  test("returns the live plan, its hash and the revision that holds it", async () => {
    const h = harness("claude");
    const read = () => h.app.fetch(new Request(`http://x/api/sessions/${h.s.id}/plan`));
    expect(await (await read()).json()).toEqual({ plan: PLAN, planHash: BASE, revision: null });
    h.store.recordAgentPlanRevision(h.s.id, BASE, PLAN.trim());
    expect(await (await read()).json()).toEqual({ plan: PLAN, planHash: BASE, revision: 1 });
  });

  test("404 for an unknown session, and no_plan before a plan is written", async () => {
    const h = harness("claude");
    expect((await h.app.fetch(new Request("http://x/api/sessions/nope/plan"))).status).toBe(404);
    rmSync(join(h.wt, ".shepherd-plan.md"));
    const res = await h.app.fetch(new Request(`http://x/api/sessions/${h.s.id}/plan`));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("no_plan");
  });
});
