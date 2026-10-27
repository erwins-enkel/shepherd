import { expect, test } from "bun:test";
import {
  CI_FIX_STEER,
  EMPTY_COMPLETION_STEER,
  PROCEED_STEER,
  RESEARCH_PROCEED_STEER,
  openPrSteer,
  rebaseSteer,
} from "../src/autopilot";
import { API_RETRY_STEER } from "../src/api-error-retry-core";
import { RECONCILE_STEER } from "../src/build-queue-reminder";
import { planAnswerSteerText } from "../src/plan-gate";
import { amendmentSteerText } from "../src/task-amendments";
import { classifySteer, steerLog, transcriptSteer, unwrapPasted } from "../src/steer-log";
import { SessionStore } from "../src/store";

test("classifySteer reads the channel off Shepherd's own steer texts", () => {
  expect(classifySteer(CI_FIX_STEER)).toBe("ci_fix");
  expect(classifySteer(rebaseSteer("main"))).toBe("rebase");
  expect(classifySteer(openPrSteer(false, "main"))).toBe("open_pr");
  expect(classifySteer(openPrSteer(true, "epic/1"))).toBe("open_pr");
  expect(classifySteer(PROCEED_STEER)).toBe("nudge");
  expect(classifySteer(RESEARCH_PROCEED_STEER)).toBe("nudge");
  expect(classifySteer(EMPTY_COMPLETION_STEER)).toBe("nudge");
  expect(classifySteer(RECONCILE_STEER)).toBe("queue");
  expect(classifySteer(API_RETRY_STEER)).toBe("api_retry");
  expect(classifySteer(planAnswerSteerText([]))).toBe("plan_review");
});

test("classifySteer covers the steers whose builders are module-private", () => {
  expect(classifySteer("You're in autopilot and your PR has merge conflicts with its base")).toBe(
    "rebase",
  );
  expect(classifySteer("You're in full-auto and your PR can't merge as-is — it's behind")).toBe(
    "rebase",
  );
  expect(classifySteer("Plan approved. Execute `.shepherd-plan.md` now")).toBe("go");
  expect(classifySteer("✅ Build queue approved by the operator. Begin now")).toBe("go");
  expect(classifySteer("The plan reviewer raised these points on `.shepherd-plan.md`.")).toBe(
    "plan_review",
  );
  expect(classifySteer("Shepherd could not run the plan reviewer: the review prompt")).toBe(
    "plan_review",
  );
  expect(classifySteer("The PR critic reviewed your latest push. These are the BLOCKING")).toBe(
    "review",
  );
});

test("anything else — an operator reply, an amendment — counts as the operator's", () => {
  expect(classifySteer("please also update the docs")).toBe("operator");
  expect(classifySteer(amendmentSteerText("also cover Gitea"))).toBe("operator");
  expect(classifySteer("")).toBe("operator");
});

// Copied from a real Claude transcript: the paste wrapper with an id-bearing closer.
const WRAPPED =
  '\n\n<pasted_content id="2c65">\nThe PR critic reviewed your latest push. These are the BLOCKING points:\n\n1. fix it\nThen commit & push so CI and the critic re-run.\n</pasted_content id="2c65">\n';

test("unwrapPasted strips the paste wrapper and the newlines next to it", () => {
  expect(unwrapPasted(WRAPPED)).toBe(
    "The PR critic reviewed your latest push. These are the BLOCKING points:\n\n1. fix it\nThen commit & push so CI and the critic re-run.",
  );
  expect(unwrapPasted('<pasted_content id="a1">\nbody\n</pasted_content>')).toBe("body");
  expect(
    unwrapPasted('<pasted_content id="a1">\nbody\n</pasted_content id="a1">\n\nand more'),
  ).toBe("body\n\nand more");
});

test("unwrapPasted leaves an unpaired or mismatched marker alone", () => {
  const mismatched = '<pasted_content id="a1">\nbody\n</pasted_content id="b2">';
  expect(unwrapPasted(mismatched)).toBe(mismatched);
  expect(unwrapPasted('<pasted_content id="a1">\nbody')).toBe('<pasted_content id="a1">\nbody');
  expect(unwrapPasted("mentions </pasted_content> only")).toBe("mentions </pasted_content> only");
});

test("transcriptSteer names Shepherd's steers, null for the operator's words", () => {
  expect(transcriptSteer(WRAPPED)).toBe("review");
  expect(transcriptSteer("Plan approved. Execute `.shepherd-plan.md` now")).toBe("go");
  expect(transcriptSteer("please also update the docs")).toBeNull();
});

test("steerLog keeps time and kind only, never the text", () => {
  expect(steerLog([{ ts: 5, payload: CI_FIX_STEER }])).toEqual([{ ts: 5, kind: "ci_fix" }]);
});

test("listSessionSteers returns this session's steers since it started, oldest first", () => {
  const store = new SessionStore(":memory:");
  const base = {
    name: "x",
    prompt: "x",
    repoPath: "/r",
    baseBranch: "main",
    branch: "shepherd/x",
    worktreePath: "/wt",
    isolated: true,
    herdrSession: "default",
  };
  const a = store.create({ ...base, herdrAgentId: "term_a" });
  const b = store.create({ ...base, branch: "shepherd/y", herdrAgentId: "term_b" });
  store.addSignal({ repoPath: "/r", sessionId: a.id, kind: "reply", payload: "first" });
  store.addSignal({ repoPath: "/r", sessionId: b.id, kind: "reply", payload: "other session" });
  store.addSignal({ repoPath: "/r", sessionId: a.id, kind: "block", payload: "not a steer" });
  store.addSignal({ repoPath: "/r", sessionId: a.id, kind: "reply", payload: CI_FIX_STEER });

  expect(store.listSessionSteers(a.id).map((r) => r.payload)).toEqual(["first", CI_FIX_STEER]);
  expect(store.listSessionSteers("nope")).toEqual([]);
});
