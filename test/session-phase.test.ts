import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { derivePhase, SessionPhaseService, type PhaseInput } from "../src/session-phase";
import type { PlanGate, Session } from "../src/types";
import type { BlockReason } from "../src/blocked";
import type { GitState } from "../src/forge/types";

type S = PhaseInput["session"];
const base: S = {
  status: "done",
  planPhase: null,
  haltReason: null,
  autopilotPaused: false,
  autopilotComplete: false,
};
const phase = (session: Partial<S>, rest: Partial<Omit<PhaseInput, "session">> = {}) =>
  derivePhase({ session: { ...base, ...session }, awaitingInput: false, ...rest });

const gate = (over: Partial<PlanGate> = {}) => ({ approved: false, ...over }) as PlanGate;
const questionGate = (answered: string[] = []) =>
  gate({
    blocks: [
      {
        type: "question-form",
        id: "qf1",
        questions: [{ id: "q1", prompt: "Which?", kind: "single", options: ["a", "b"] }],
      },
    ],
    answeredQuestionKeys: answered,
  } as Partial<PlanGate>);
const block = { shape: "permission", options: [], tail: [] } as unknown as BlockReason;
const open = { state: "open" } as const;

describe("derivePhase", () => {
  test("finished: archived, merged PR, completed halt — beats everything", () => {
    expect(phase({ status: "archived", haltReason: "error" })).toBe("finished");
    expect(phase({ status: "blocked" }, { git: { state: "merged" } })).toBe("finished");
    expect(phase({ haltReason: "completed" })).toBe("finished");
  });
  test("halted: any other halt reason, unknown ones included", () => {
    for (const r of ["usage_limit", "operator", "error", "future"] as S["haltReason"][])
      expect(phase({ haltReason: r, status: "blocked" })).toBe("halted");
  });
  test("needs_input: blocked status, live block, open plan question, transcript question", () => {
    expect(phase({ status: "blocked" })).toBe("needs_input");
    expect(phase({ status: "running" }, { block })).toBe("needs_input");
    expect(phase({ planPhase: "planning" }, { gate: questionGate() })).toBe("needs_input");
    expect(phase({}, { awaitingInput: true, git: open })).toBe("needs_input");
    // beats plan_ready
    expect(
      phase({ status: "blocked", planPhase: "planning" }, { gate: gate({ approved: true }) }),
    ).toBe("needs_input");
  });
  test("autopilot: complete ⇒ finished, paused (handed back a question) ⇒ needs_input", () => {
    expect(phase({ autopilotComplete: true, status: "idle" })).toBe("finished");
    expect(phase({ autopilotPaused: true }, { git: open })).toBe("needs_input");
  });
  test("plan rework is the operator's turn only while the agent is not revising", () => {
    const rework = gate({ decision: "changes_requested" } as Partial<PlanGate>);
    expect(phase({ planPhase: "planning" }, { gate: rework })).toBe("needs_input");
    expect(phase({ planPhase: "planning", status: "running" }, { gate: rework })).toBe("planning");
    const dismissed = gate({ decision: "changes_requested", dismissed: true } as Partial<PlanGate>);
    expect(phase({ planPhase: "planning" }, { gate: dismissed })).toBe("planning");
  });
  test("plan questions only count while planning, and only unanswered", () => {
    expect(phase({ planPhase: "executing" }, { gate: questionGate() })).toBe("idle");
    expect(phase({ planPhase: "planning" }, { gate: questionGate(["qf1 q1"]) })).toBe("planning");
  });
  test("plan_ready vs planning", () => {
    expect(phase({ planPhase: "planning" }, { gate: gate({ approved: true }) })).toBe("plan_ready");
    expect(phase({ planPhase: "planning" }, { gate: gate() })).toBe("planning");
    expect(phase({ planPhase: "planning", status: "running" })).toBe("planning");
  });
  test("working beats an open PR; pr_open only at rest", () => {
    expect(phase({ status: "running" }, { git: open })).toBe("working");
    expect(phase({ status: "done" }, { git: open })).toBe("pr_open");
    expect(phase({ status: "idle", planPhase: "executing" }, { git: open })).toBe("pr_open");
  });
  test("idle: at rest, no PR, no question — a closed PR included", () => {
    expect(phase({})).toBe("idle");
    expect(phase({ status: "idle" }, { git: { state: "closed" } })).toBe("idle");
    expect(phase({}, { git: { state: "none" } })).toBe("idle");
  });
});

describe("SessionPhaseService", () => {
  const dir = mkdtempSync(join(tmpdir(), "session-phase-"));
  const path = join(dir, "t.jsonl");
  writeFileSync(path, "x\n");
  const session = (over: Partial<Session> = {}) => ({ id: "s1", ...base, ...over }) as Session;

  function service(
    opts: { awaiting?: boolean; git?: GitState; blocks?: Record<string, BlockReason> } = {},
  ) {
    let reads = 0;
    const svc = new SessionPhaseService({
      store: { getPlanGate: () => null },
      prCache: { get: () => opts.git },
      blocks: { snapshot: () => opts.blocks ?? {} },
      transcriptPath: (s) => (s.id === "nofile" ? join(dir, "gone.jsonl") : path),
      readAwaiting: async () => {
        reads++;
        return opts.awaiting ?? false;
      },
    });
    return { svc, reads: () => reads };
  }

  test("transcript question at rest → needs_input; cached until size/mtime change", async () => {
    const { svc, reads } = service({ awaiting: true });
    expect(await svc.phaseOf(session())).toBe("needs_input");
    expect(await svc.phaseOf(session())).toBe("needs_input");
    expect(reads()).toBe(1);
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    await svc.phaseOf(session());
    expect(reads()).toBe(2);
  });
  test("a running or archived session reads no transcript", async () => {
    const { svc, reads } = service({ awaiting: true });
    expect(await svc.phaseOf(session({ status: "running" }))).toBe("working");
    expect(await svc.phaseOf(session({ status: "archived" }))).toBe("finished");
    expect(reads()).toBe(0);
  });
  test("missing transcript → not awaiting", async () => {
    const { svc, reads } = service({ awaiting: true });
    expect(await svc.phaseOf(session({ id: "nofile" }))).toBe("idle");
    expect(reads()).toBe(0);
  });
  test("withPhases attaches phase from PR cache and block snapshot", async () => {
    const { svc } = service({
      git: { state: "open" } as GitState,
      blocks: { b: block },
    });
    const rows = await svc.withPhases([session({ id: "a" }), session({ id: "b" })]);
    expect(rows.map((r) => [r.id, r.phase])).toEqual([
      ["a", "pr_open"],
      ["b", "needs_input"],
    ]);
  });
  test("cleanup", () => rmSync(dir, { recursive: true, force: true }));
});
