import { test, expect } from "bun:test";
import {
  AGENT_SYSTEM_PROMPT,
  aggregate,
  buildRequestBody,
  captureFrom,
  decide,
  isVerdictWrite,
  majority,
  outcomeFrom,
  parseArgs,
  parseVerdict,
  runEval,
  runTrial,
  selectFixtures,
  type AnthropicResponse,
  type EvalFixtureBase,
  type EvalSpec,
  type Send,
  type TrialOutcome,
} from "../scripts/eval-core";
import { readFileSync } from "node:fs";
import {
  CASES,
  FINGERPRINTS_PATH,
  changedEvals,
  fingerprint,
  fingerprintAll,
  normalizeRender,
} from "../scripts/gen-eval-fingerprints";
import { UNTRUSTED_CONTENT_DIRECTIVE } from "../src/untrusted";
import { respondFromEnv, tokenize } from "../scripts/eval-fixtures/env";
import { SPEC as CRITIC_SPEC, scoreCritic } from "../scripts/eval-critic";
import { SPEC as PLAN_GATE_SPEC, scorePlanGate } from "../scripts/eval-plan-gate";
import { SPEC as RUNDOWN_SPEC, scoreRundown } from "../scripts/eval-rundown";
import { SPEC as CLASSIFIER_SPEC } from "../scripts/eval-stop-classifier";
import { VERDICT_BODY_FILE, VERDICT_FILE } from "../src/critic-core";
import { PLAN_VERDICT_FILE } from "../src/plan-gate";

// HERMETIC: every eval module imports only leaf-ish production modules with no import-time env
// reads or filesystem probes, and the loop below is driven by an INJECTED transport — no network,
// no ANTHROPIC_API_KEY, no spend.

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface TestFixture extends EvalFixtureBase {
  expected: string;
}

const FIXTURE: TestFixture = {
  id: "t1",
  origin: "synthetic",
  gating: true,
  note: "",
  expected: "ok",
};

/** A spec whose verdict is `{"label": "..."}` — enough to exercise the loop and the scorer. */
function testSpec(over: Partial<EvalSpec<TestFixture>> = {}): EvalSpec<TestFixture> {
  return {
    name: "test",
    defaultModel: "m",
    defaultTrials: 3,
    defaultTemperature: 1,
    floor: 0.5,
    fixtures: [FIXTURE],
    labels: ["ok", "bad", "no-verdict"],
    tools: [],
    verdictFile: "verdict.json",
    maxTurns: 5,
    maxTokens: 128,
    buildPrompt: () => "prompt",
    respond: (_f, name, input) => `answered ${name} ${JSON.stringify(input)}`,
    score: (fixture, raw) =>
      raw === null
        ? { label: "no-verdict", correct: false }
        : { label: String(raw.label), correct: raw.label === fixture.expected },
    ...over,
  };
}

function toolUse(name: string, input: Record<string, unknown>, id = "tu_1"): AnthropicResponse {
  return { content: [{ type: "tool_use", id, name, input }] };
}

function write(filePath: string, content: string, id = "tu_w"): AnthropicResponse {
  return toolUse("Write", { file_path: filePath, content }, id);
}

/** A transport that replays a scripted sequence and records every request body it saw. */
function scriptedSend(
  responses: AnthropicResponse[],
): Send & { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const send = (async (body: Record<string, unknown>) => {
    bodies.push(body);
    return responses[bodies.length - 1] ?? { content: [{ type: "text", text: "done" }] };
  }) as Send & { bodies: Record<string, unknown>[] };
  send.bodies = bodies;
  return send;
}

const run = parseArgs(testSpec(), []);

// ---------------------------------------------------------------------------
// The bounded tool loop
// ---------------------------------------------------------------------------

test("the loop terminates on a Write to the verdict file", async () => {
  const spec = testSpec();
  const send = scriptedSend([write("verdict.json", '{"label":"ok"}')]);
  const capture = await runTrial(send, spec, FIXTURE, "p", "m", 1);
  expect(capture).toEqual({ toolUsed: true, content: '{"label":"ok"}', turns: 1 });
  expect(send.bodies.length).toBe(1);
});

test("a NON-verdict Write is answered and the loop continues (the critic's two-write contract)", async () => {
  const spec = testSpec();
  const send = scriptedSend([
    write(VERDICT_BODY_FILE, "# Review\n\nProse, not JSON.", "tu_md"),
    write("verdict.json", '{"label":"ok"}', "tu_json"),
  ]);
  const capture = await runTrial(send, spec, FIXTURE, "p", "m", 1);
  // The markdown write did NOT end the run — the JSON one did, and its content is the verdict.
  expect(capture.content).toBe('{"label":"ok"}');
  expect(capture.turns).toBe(2);
  // The model was told the markdown write succeeded, referencing the right tool_use id.
  const followUp = send.bodies[1]?.messages as { role: string; content: unknown }[];
  expect(followUp).toHaveLength(3);
  expect(followUp[2]).toEqual({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "tu_md", content: "File written successfully." }],
  });
});

test("stopping at the first Write would capture prose — the regression this guards", async () => {
  // Same conversation, but with `verdictFile` unset (first-write-wins). The captured content is the
  // MARKDOWN, which does not parse as a verdict — every critic fixture would score parse-fail.
  const spec = testSpec({ verdictFile: undefined });
  const send = scriptedSend([
    write(VERDICT_BODY_FILE, "# Review\n\nProse, not JSON.", "tu_md"),
    write("verdict.json", '{"label":"ok"}', "tu_json"),
  ]);
  const capture = await runTrial(send, spec, FIXTURE, "p", "m", 1);
  expect(capture.content).toBe("# Review\n\nProse, not JSON.");
  expect(outcomeFrom(spec, FIXTURE, capture)).toEqual({
    toolUsed: true,
    parseOk: false,
    label: "no-verdict",
    correct: false,
  });
});

test("inspection tool calls are answered from the fixture environment across turns", async () => {
  const spec = testSpec();
  const send = scriptedSend([
    toolUse("Bash", { command: "git diff origin/main...HEAD" }, "tu_a"),
    toolUse("Grep", { pattern: "paginate" }, "tu_b"),
    write("verdict.json", '{"label":"ok"}'),
  ]);
  const capture = await runTrial(send, spec, FIXTURE, "p", "m", 1);
  expect(capture.turns).toBe(3);
  const second = send.bodies[1]?.messages as { role: string; content: { content: string }[] }[];
  expect(second[2]?.content[0]?.content).toContain("answered Bash");
});

test("turn-budget exhaustion is a mechanical miss, not a verdict", async () => {
  const spec = testSpec({ maxTurns: 2 });
  const send = scriptedSend([
    toolUse("Bash", { command: "git log" }, "a"),
    toolUse("Bash", { command: "git log" }, "b"),
    write("verdict.json", '{"label":"ok"}'),
  ]);
  const capture = await runTrial(send, spec, FIXTURE, "p", "m", 1);
  expect(capture).toEqual({
    toolUsed: false,
    content: null,
    turns: 2,
    // The reason is recorded so a verdict-less trial is diagnosable from a log alone.
    stopReason: "turn-budget",
  });
  expect(outcomeFrom(spec, FIXTURE, capture).toolUsed).toBe(false);
});

test("a text-only reply ends the loop as a no-tool miss", async () => {
  const spec = testSpec();
  const send = scriptedSend([{ content: [{ type: "text", text: "I think it's fine." }] }]);
  const capture = await runTrial(send, spec, FIXTURE, "p", "m", 1);
  expect(capture.toolUsed).toBe(false);
  expect(send.bodies.length).toBe(1);
});

test("unparseable verdict content is parse-fail, distinct from a no-tool miss", () => {
  const spec = testSpec();
  const parseFail = outcomeFrom(
    spec,
    FIXTURE,
    captureFrom(write("verdict.json", "not json"), "verdict.json"),
  );
  expect(parseFail).toEqual({
    toolUsed: true,
    parseOk: false,
    label: "no-verdict",
    correct: false,
  });
  const noTool = outcomeFrom(spec, FIXTURE, captureFrom({ content: [] }, "verdict.json"));
  expect(noTool).toEqual({ toolUsed: false, parseOk: false, label: "no-verdict", correct: false });
});

test("isVerdictWrite matches on the trailing path segment, and only for Write", () => {
  const block = { type: "tool_use", name: "Write", input: { file_path: "/tmp/wt/verdict.json" } };
  expect(isVerdictWrite(block, "verdict.json")).toBe(true);
  expect(isVerdictWrite({ ...block, input: { file_path: "./verdict.json" } }, "verdict.json")).toBe(
    true,
  );
  expect(isVerdictWrite({ ...block, input: { file_path: "other.json" } }, "verdict.json")).toBe(
    false,
  );
  expect(isVerdictWrite({ type: "tool_use", name: "Bash", input: {} }, "verdict.json")).toBe(false);
  // Unset verdictFile -> any Write wins (the classifier's single-write contract).
  expect(isVerdictWrite(block, undefined)).toBe(true);
});

test("parseVerdict rejects non-objects so a bare array never scores as a verdict", () => {
  expect(parseVerdict('{"a":1}')).toEqual({ a: 1 });
  expect(parseVerdict("[1,2]")).toBeNull();
  expect(parseVerdict("7")).toBeNull();
  expect(parseVerdict(null)).toBeNull();
});

// ---------------------------------------------------------------------------
// Aggregation + decision, label-agnostic
// ---------------------------------------------------------------------------

function outcome(label: string, correct: boolean, toolUsed = true, parseOk = true): TrialOutcome {
  return { label, correct, toolUsed, parseOk };
}

test("aggregate counts an unlisted label rather than dropping it", () => {
  const r = aggregate(FIXTURE, [outcome("surprise", false), outcome("ok", true)], ["ok", "bad"]);
  expect(r.counts).toEqual({ ok: 1, bad: 0, surprise: 1 });
  expect(r.correct).toBe(1);
});

test("aggregate tracks correctness independently of the label", () => {
  // A fixture can be correct on a label the report shows twice under different predicates.
  const r = aggregate(
    FIXTURE,
    [outcome("ok", true), outcome("ok", false), outcome("ok", true)],
    ["ok"],
  );
  expect(r.majorityLabel).toBe("ok");
  expect(r.correct).toBe(2);
  expect(r.majorityCorrect).toBe(true);
});

test("majority requires strictly more than half", () => {
  expect(majority({ a: 2, b: 1 }, 3)).toBe("a");
  expect(majority({ a: 2, b: 2 }, 4)).toBeNull();
});

test("decide ignores baseline fixtures and enforces both the majority and the floor", () => {
  const gatingMiss = aggregate(
    { ...FIXTURE, id: "g" },
    [outcome("ok", true), outcome("bad", false), outcome("bad", false)],
    ["ok", "bad"],
  );
  const baselineMiss = aggregate(
    { ...FIXTURE, id: "b", gating: false },
    [outcome("bad", false)],
    ["ok", "bad"],
  );
  const d = decide([gatingMiss, baselineMiss], 0.5);
  expect(d.failures).toEqual(["g"]);
  expect(d.gatingTrials).toBe(3);
  expect(d.pass).toBe(false);
});

test("--gating-only selects exactly the gating fixtures", () => {
  const spec = testSpec({
    fixtures: [FIXTURE, { ...FIXTURE, id: "t2", gating: false }],
  });
  expect(selectFixtures(spec, parseArgs(spec, [])).map((f) => f.id)).toEqual(["t1", "t2"]);
  expect(selectFixtures(spec, parseArgs(spec, ["--gating-only"])).map((f) => f.id)).toEqual(["t1"]);
  expect(selectFixtures(spec, parseArgs(spec, ["--filter", "t2"])).map((f) => f.id)).toEqual([
    "t2",
  ]);
});

test("parseArgs falls back to each spec's pinned defaults", () => {
  expect(run.model).toBe("m");
  expect(run.threshold).toBe(0.5);
  expect(parseArgs(testSpec(), ["--threshold", "0.9"]).threshold).toBe(0.9);
});

// ---------------------------------------------------------------------------
// The fixture environment
// ---------------------------------------------------------------------------

test("the environment answers git diff, Read and Grep, and admits absence honestly", () => {
  const env = { diff: "diff --git a/x b/x", files: { "src/x.ts": "export const a = 1;\n" } };
  expect(respondFromEnv(env, "Bash", { command: "git diff origin/main...HEAD" })).toBe(env.diff);
  expect(respondFromEnv(env, "Read", { file_path: "src/x.ts" })).toContain("export const a");
  expect(respondFromEnv(env, "Read", { file_path: "./src/x.ts" })).toContain("export const a");
  expect(respondFromEnv(env, "Read", { file_path: "src/gone.ts" })).toContain("does not exist");
  expect(respondFromEnv(env, "Grep", { pattern: "const a" })).toContain("src/x.ts:1:");
  expect(respondFromEnv(env, "Grep", { pattern: "nope" })).toBe("No matches found.");
  // A worktree-absolute path resolves by path SUFFIX...
  expect(respondFromEnv(env, "Read", { file_path: "/tmp/wt-1/src/x.ts" })).toContain(
    "export const a",
  );
  // ...but a bare basename must NOT — that would answer a question the reviewer did not ask.
  expect(respondFromEnv(env, "Read", { file_path: "x.ts" })).toContain("does not exist");
  // `git grep <pattern>` must not search for the literal "grep", and a QUOTED multi-word pattern
  // must survive as one argument — otherwise its tail reads as a path and the search answers a
  // spurious "No matches found.", which could talk a reviewer into a false finding.
  expect(respondFromEnv(env, "Bash", { command: "git grep 'const a'" })).toContain("src/x.ts:1:");
  expect(respondFromEnv(env, "Bash", { command: 'rg --no-heading "const a" src' })).toContain(
    "src/x.ts:1:",
  );
  expect(tokenize("git grep 'const a' src")).toEqual(["git", "grep", "const a", "src"]);
  // An invalid regex must not throw into the loop.
  expect(respondFromEnv(env, "Grep", { pattern: "([" })).toContain("invalid regular expression");
  // Never an EMPTY tool_result: an empty string reads as a malfunction and invites the model to
  // retry a different way, burning the turn budget the eval bounds it with.
  expect(respondFromEnv({}, "Bash", { command: "git diff" })).toBe("(no changes)");
  expect(respondFromEnv({}, "Bash", { command: "make build" })).toBe("(no output)");
});

// ---------------------------------------------------------------------------
// Per-eval scorers
// ---------------------------------------------------------------------------

function rundownFixture(expect_: Record<string, unknown>) {
  return { ...RUNDOWN_SPEC.fixtures[0]!, expect: expect_ } as (typeof RUNDOWN_SPEC.fixtures)[0];
}

const RUNDOWN_OK = { overnight: "", decisions: [], ciRework: [], train: "", focusNext: [] };

test("rundown scorer: surfaced / leaked / silent / manufactured / epic-echo", () => {
  const mustSurface = rundownFixture({ mustSurface: ["s-1"], mustSurfaceSomething: true });
  expect(
    scoreRundown(mustSurface, {
      ...RUNDOWN_OK,
      decisions: [{ label: "answer", sessionId: "s-1" }],
    }),
  ).toEqual({ label: "ok", correct: true });
  expect(scoreRundown(mustSurface, RUNDOWN_OK).label).toBe("miss:not-surfaced");

  const noLeak = rundownFixture({ mustNotSurface: ["s-2"] });
  // A leak means the ATTENTION buckets. `focusNext` is where the prompt asks for routine follow-on
  // work, so a routine session there is compliance — scoring it as a leak failed four fixtures on
  // the first live run.
  expect(
    scoreRundown(noLeak, { ...RUNDOWN_OK, focusNext: [{ label: "routine", sessionId: "s-2" }] })
      .label,
  ).toBe("ok");
  expect(
    scoreRundown(noLeak, { ...RUNDOWN_OK, decisions: [{ label: "routine", sessionId: "s-2" }] })
      .label,
  ).toBe("miss:leaked");
  expect(
    scoreRundown(noLeak, { ...RUNDOWN_OK, ciRework: [{ label: "routine", sessionId: "s-2" }] })
      .label,
  ).toBe("miss:leaked");

  const silent = rundownFixture({ mustSurfaceSomething: true });
  expect(scoreRundown(silent, RUNDOWN_OK).label).toBe("miss:silent");

  const quiet = rundownFixture({ empty: ["decisions"] });
  expect(scoreRundown(quiet, { ...RUNDOWN_OK, decisions: [{ label: "made up" }] }).label).toBe(
    "miss:manufactured",
  );

  const noEcho = rundownFixture({ noEpicEcho: [1904] });
  expect(
    scoreRundown(noEcho, { ...RUNDOWN_OK, focusNext: [{ label: "land epic #1904" }] }).label,
  ).toBe("miss:epic-echo");

  expect(scoreRundown(mustSurface, null).label).toBe("no-verdict");
});

test("rundown scorer runs the verdict through production's own parser and clamps", () => {
  // `parseRundownVerdict` drops malformed items; a surfaced id inside one must not count.
  const f = rundownFixture({ mustSurface: ["s-1"] });
  expect(scoreRundown(f, { ...RUNDOWN_OK, decisions: [{ sessionId: "s-1" }] }).label).toBe(
    "miss:not-surfaced",
  );
});

test("plan-gate scorer enforces the prompt's approve/request-changes findings contract", () => {
  const f = PLAN_GATE_SPEC.fixtures.find((x) => x.expectedDecision === "approve")!;
  expect(scorePlanGate(f, { decision: "approve", findings: [] })).toEqual({
    label: "approve",
    correct: true,
  });
  // approve WITH findings contradicts the contract.
  expect(scorePlanGate(f, { decision: "approve", findings: ["x"] }).label).toBe(
    "approve:bad-findings",
  );
  // request-changes with none is equally malformed.
  const rc = PLAN_GATE_SPEC.fixtures.find((x) => x.expectedDecision === "request-changes")!;
  expect(scorePlanGate(rc, { decision: "request-changes", findings: [] }).label).toBe(
    "request-changes:bad-findings",
  );
  expect(scorePlanGate(f, { decision: "approved", findings: [] }).label).toBe("no-verdict");
  expect(scorePlanGate(f, null).label).toBe("no-verdict");
});

test("plan-gate scorer applies the fixture's findings predicates", () => {
  const rc = PLAN_GATE_SPEC.fixtures.find((x) => x.id === "rc-false-assumption")!;
  expect(
    scorePlanGate(rc, {
      decision: "request-changes",
      findings: ["src/automerge-core.ts: isBehindBase does not exist."],
    }).correct,
  ).toBe(true);
  expect(
    scorePlanGate(rc, { decision: "request-changes", findings: ["The plan is a bit terse."] })
      .correct,
  ).toBe(false);
});

test("critic scorer uses production's normalizers and the two-value decision contract", () => {
  const bug = CRITIC_SPEC.fixtures.find((f) => f.id === "bug-off-by-one")!;
  expect(
    scoreCritic(bug, {
      decision: "request-changes",
      findings: ["src/paginate.ts: the final partial page is dropped."],
    }),
  ).toEqual({ label: "changes_requested", correct: true });
  // Right decision, but the planted defect is never named.
  expect(
    scoreCritic(bug, { decision: "request-changes", findings: ["Consider adding a doc comment."] })
      .correct,
  ).toBe(false);
  // "approve" is not a legal critic decision.
  expect(scoreCritic(bug, { decision: "approve", findings: [] }).label).toBe("no-verdict");
  const clean = CRITIC_SPEC.fixtures.find((f) => f.id === "clean-extract-helper")!;
  expect(scoreCritic(clean, { decision: "comment", findings: [] })).toEqual({
    label: "commented",
    correct: true,
  });
  // A "comment" carrying findings contradicts the routing rules.
  expect(scoreCritic(clean, { decision: "comment", findings: ["nit: rename it"] }).label).toBe(
    "commented:bad-findings",
  );
});

test("critic scorer honours findingsMustNotMatch (the SCOPE rule fixture)", () => {
  const scope = CRITIC_SPEC.fixtures.find((f) => f.id === "scope-out-of-diff-not-raised")!;
  expect(scoreCritic(scope, { decision: "comment", findings: [] }).correct).toBe(true);
  expect(
    scoreCritic(scope, {
      decision: "request-changes",
      findings: ["src/deliveries.ts: swallows the parse error."],
    }).correct,
  ).toBe(false);
});

// ---------------------------------------------------------------------------
// Prompt fingerprints — the PR gate's trigger
// ---------------------------------------------------------------------------

test("fingerprints are stable across renders despite the per-fence random nonces", () => {
  // The whole gate rests on this: `fenceUntrusted` embeds a fresh 12-hex nonce on every render, so
  // an un-normalized hash would differ every run and red the freshness gate permanently.
  expect(fingerprintAll()).toEqual(fingerprintAll());
  for (const name of Object.keys(CASES)) {
    expect(fingerprint(name)).toBe(fingerprint(name));
  }
});

test("normalizeRender blanks nonce-shaped markers only", () => {
  const fenced = "⟦UNTRUSTED:issue body:0123456789ab⟧\ntext\n⟦/UNTRUSTED:issue body:0123456789ab⟧";
  expect(normalizeRender(fenced)).toBe(
    "⟦UNTRUSTED:issue body:<nonce>⟧\ntext\n⟦/UNTRUSTED:issue body:<nonce>⟧",
  );
  // The bare markers QUOTED inside the directive carry no nonce and must survive untouched —
  // blanking them would hide edits to the directive from every fingerprint.
  expect(normalizeRender(UNTRUSTED_CONTENT_DIRECTIVE)).toBe(UNTRUSTED_CONTENT_DIRECTIVE);
  expect(normalizeRender(UNTRUSTED_CONTENT_DIRECTIVE)).toContain("⟦UNTRUSTED:…⟧");
});

test("every eval's canonical renders embed the untrusted directive verbatim", () => {
  // Therefore an edit to UNTRUSTED_CONTENT_DIRECTIVE necessarily moves all four fingerprints.
  const names = Object.keys(CASES);
  expect(names.sort()).toEqual(["critic", "plan-gate", "rundown", "stop-classifier"]);
  for (const [name, cases] of Object.entries(CASES)) {
    expect(cases.length).toBeGreaterThan(1);
    for (const c of cases) {
      expect(normalizeRender(c.render())).toContain(UNTRUSTED_CONTENT_DIRECTIVE);
      expect(`${name}/${c.name}`).toBeTruthy();
    }
  }
});

test("the committed fingerprint file matches what the builders render now", () => {
  // The same assertion `bun run check:eval-fingerprints` makes in CI — a prompt edit that skips
  // regeneration fails here too, rather than only in the workflow.
  const committed = JSON.parse(readFileSync(FINGERPRINTS_PATH, "utf8")) as Record<string, string>;
  expect(committed).toEqual(fingerprintAll());
});

test("changedEvals reports only the evals whose hash moved, and fails open on a missing base", () => {
  const head = { a: "1", b: "2" };
  expect(changedEvals({ a: "1", b: "2" }, head)).toEqual([]);
  expect(changedEvals({ a: "1", b: "9" }, head)).toEqual(["b"]);
  // A base without the eval at all (the fingerprint file did not exist there) must run it.
  expect(changedEvals({}, head)).toEqual(["a", "b"]);
});

// ---------------------------------------------------------------------------
// Fixture-set invariants
// ---------------------------------------------------------------------------

/** Erase the fixture type so the four specs can be checked in one loop. The `as F` cast is safe
 *  because each closure only ever receives its own spec's fixtures. */
function describeSpec<F extends EvalFixtureBase>(spec: EvalSpec<F>) {
  return {
    name: spec.name,
    fixtures: spec.fixtures as EvalFixtureBase[],
    verdictFile: spec.verdictFile,
    maxTurns: spec.maxTurns,
    render: (f: EvalFixtureBase) => spec.buildPrompt(f as F, parseArgs(spec, [])),
  };
}

const SPECS = [
  describeSpec(CLASSIFIER_SPEC),
  describeSpec(PLAN_GATE_SPEC),
  describeSpec(CRITIC_SPEC),
  describeSpec(RUNDOWN_SPEC),
];

test("every fixture set has unique ids, provenance, a note and at least one gating fixture", () => {
  for (const spec of SPECS) {
    const ids = spec.fixtures.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(spec.fixtures.filter((f) => f.gating).length).toBeGreaterThan(0);
    for (const f of spec.fixtures) {
      expect(f.id).toBeTruthy();
      expect(f.note).toBeTruthy();
      // Provenance: `synthetic` or a real incident this case was distilled from (#2156 step 3).
      expect(f.origin === "synthetic" || /^incident:#\d+$/.test(f.origin)).toBe(true);
    }
  }
});

test("every fixture renders a non-empty prompt naming its own verdict file", () => {
  for (const spec of SPECS) {
    for (const f of spec.fixtures) {
      const prompt = spec.render(f);
      expect(prompt.length).toBeGreaterThan(200);
      if (spec.verdictFile) expect(prompt).toContain(spec.verdictFile);
    }
  }
});

test("every eval's turn budget admits every write its prompt's contract orders", () => {
  // The critic writes twice; a budget that admits only one would score every fixture no-tool.
  expect(CRITIC_SPEC.maxTurns).toBeGreaterThanOrEqual(2);
  expect(CRITIC_SPEC.verdictFile).toBe(VERDICT_FILE);
  expect(PLAN_GATE_SPEC.verdictFile).toBe(PLAN_VERDICT_FILE);
  for (const spec of SPECS) expect(spec.maxTurns).toBeGreaterThanOrEqual(1);
});

test("the plan-gate prompt still names exactly the two decision literals the scorer maps", () => {
  // `normalizePlanDecision` mirrors PlanGateService's private normalizeDecision; this pins the
  // mapping to the prompt's own output contract so the two cannot drift apart silently.
  const prompt = PLAN_GATE_SPEC.buildPrompt(
    PLAN_GATE_SPEC.fixtures[0]!,
    parseArgs(PLAN_GATE_SPEC, []),
  );
  expect(prompt).toContain('"decision": "approve" | "request-changes"');
});

test("the critic prompt still orders the markdown file FIRST and the JSON LAST", () => {
  // The premise `verdictFile: VERDICT_FILE` rests on. If this ordering ever changes, the loop's
  // terminator has to be revisited.
  const prompt = CRITIC_SPEC.buildPrompt(CRITIC_SPEC.fixtures[0]!, parseArgs(CRITIC_SPEC, []));
  expect(prompt).toContain(`Write \`${VERDICT_BODY_FILE}\` FIRST and \`${VERDICT_FILE}\` LAST`);
});

test("both prompt-driven evals cover their contract in both directions", () => {
  // A set that only ever expects one decision cannot detect a critic/reviewer that always says it.
  for (const spec of [PLAN_GATE_SPEC, CRITIC_SPEC]) {
    const expected = new Set(
      spec.fixtures
        .filter((f) => f.gating)
        .map((f) => (f as { expectedDecision: string }).expectedDecision),
    );
    expect(expected.size).toBe(2);
  }
  // The rundown's decidable contracts run in both directions too: something must be surfaced, and
  // routine work must not be.
  const rundownGating = RUNDOWN_SPEC.fixtures.filter((f) => f.gating);
  expect(rundownGating.some((f) => (f.expect.mustSurface ?? []).length > 0)).toBe(true);
  expect(rundownGating.some((f) => (f.expect.empty ?? []).length > 0)).toBe(true);
});

// ---------------------------------------------------------------------------
// runEval: preflight, concurrency, retry
// ---------------------------------------------------------------------------

test("runEval aborts on a failing FIRST call rather than burning the rest of the spend", async () => {
  let calls = 0;
  const send: Send = async () => {
    calls++;
    throw new Error("401 invalid x-api-key");
  };
  const spec = testSpec({ fixtures: [FIXTURE, { ...FIXTURE, id: "t2" }] });
  expect(await runEval(spec, ["--trials", "3"], send)).toBe(2);
  // Exactly one attempt: no retry on the preflight, and no worker ever started.
  expect(calls).toBe(1);
});

test("runEval retries a transport failure once before recording a mechanical miss", async () => {
  let calls = 0;
  let injected = false;
  const send: Send = async () => {
    calls++;
    // Let the preflight through, then fail exactly one later attempt: its retry must recover it,
    // so a 429 never becomes a data point in the measurement.
    if (calls > 1 && !injected) {
      injected = true;
      throw new Error("429 rate_limit_error");
    }
    return write("verdict.json", '{"label":"ok"}');
  };
  const spec = testSpec({ fixtures: [FIXTURE] });
  expect(await runEval(spec, ["--trials", "3", "--threshold", "1"], send)).toBe(0);
  expect(injected).toBe(true);
});

test("runEval records a mechanical miss when both attempts fail, without aborting", async () => {
  let calls = 0;
  const send: Send = async () => {
    calls++;
    if (calls === 1) return write("verdict.json", '{"label":"ok"}');
    throw new Error("503 overloaded");
  };
  const spec = testSpec({ fixtures: [FIXTURE] });
  // The second trial misses, so 1/2 correct is below a floor of 1 → exit 1, not the abort code 2.
  expect(await runEval(spec, ["--trials", "2", "--threshold", "1", "--json"], send)).toBe(1);
});

test("runEval runs trials concurrently and still groups outcomes by fixture", async () => {
  let inFlight = 0;
  let peak = 0;
  const send: Send = async (body) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    // Echo the fixture back via the prompt so we can assert outcomes are not cross-assigned.
    const prompt = (body.messages as { content: string }[])[0]!.content;
    return write("verdict.json", JSON.stringify({ label: prompt }));
  };
  const specs = testSpec({
    fixtures: [
      { ...FIXTURE, id: "a", expected: "prompt-a" },
      { ...FIXTURE, id: "b", expected: "prompt-b" },
    ],
    buildPrompt: (fixture) => `prompt-${fixture.id}`,
  });
  // Every trial scores correct only if its outcome landed on the fixture whose prompt produced it.
  expect(
    await runEval(specs, ["--trials", "4", "--threshold", "1", "--concurrency", "4"], send),
  ).toBe(0);
  expect(peak).toBeGreaterThan(1);
});

test("--concurrency is clamped to at least 1", () => {
  expect(parseArgs(testSpec(), ["--concurrency", "0"]).concurrency).toBe(1);
  expect(parseArgs(testSpec(), ["--concurrency", "8"]).concurrency).toBe(8);
});

test("the inspection-tool evals carry the agent framing; the single-tool evals do not", () => {
  // Production runs these prompts inside the claude CLI, whose system prompt establishes tool-driven
  // operation. Without it the model answers in prose: the first live run recorded `no-tool` on 55/55
  // critic and 50/55 plan-gate trials, zero transport errors.
  expect(CRITIC_SPEC.system).toBe(AGENT_SYSTEM_PROMPT);
  expect(PLAN_GATE_SPEC.system).toBe(AGENT_SYSTEM_PROMPT);
  // The classifier scored 95.1% and the rundown produced a verdict on every trial WITHOUT it —
  // adding it there would only invalidate measurements already paid for.
  expect(CLASSIFIER_SPEC.system).toBeUndefined();
  expect(RUNDOWN_SPEC.system).toBeUndefined();
  // Mode-setting only: it must not smuggle in review guidance the eval is supposed to measure.
  expect(AGENT_SYSTEM_PROMPT).not.toMatch(/finding|verdict|approve|request-changes|severity/i);
});

test("the system prompt reaches the request body only when the spec sets one", () => {
  const withSystem = buildRequestBody([], 10, "m", 1, [], AGENT_SYSTEM_PROMPT);
  expect(withSystem.system).toBe(AGENT_SYSTEM_PROMPT);
  expect(buildRequestBody([], 10, "m", 1, [])).not.toHaveProperty("system");
});

test("runEval aborts when the preflight obtains NO verdict, before spending on the rest", async () => {
  // The failure that cost a full paid run to discover: the model answers in prose and never writes.
  let calls = 0;
  const send: Send = async () => {
    calls++;
    return {
      content: [{ type: "text", text: "Here is my review in prose instead of a tool call." }],
      stop_reason: "end_turn",
    };
  };
  const spec = testSpec({ fixtures: [FIXTURE, { ...FIXTURE, id: "t2" }] });
  expect(await runEval(spec, ["--trials", "5"], send)).toBe(2);
  // Two attempts (one retry), then abort — not the 10 trials the run would otherwise have paid for.
  expect(calls).toBe(2);
});

test("a verdict-less trial records why, so a log alone can diagnose it", async () => {
  const spec = testSpec();
  const send = scriptedSend([
    { content: [{ type: "text", text: "I will describe it instead." }], stop_reason: "end_turn" },
  ]);
  const capture = await runTrial(send, spec, FIXTURE, "p", "m", 1);
  expect(capture.stopReason).toBe("end_turn");
  expect(capture.text).toContain("describe it instead");
});
