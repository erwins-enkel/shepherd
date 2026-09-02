import { test, expect } from "bun:test";
import {
  AGENT_SYSTEM_PROMPT,
  EXIT,
  addUsage,
  aggregate,
  buildRequestBody,
  emptySpend,
  captureFrom,
  decide,
  formatReport,
  isCannotRun,
  isPermanent,
  isVerdictWrite,
  majority,
  outcomeFrom,
  parseArgs,
  parseVerdict,
  runEval,
  runTrial,
  selectFixtures,
  smokeDecide,
  spendUsd,
  trialsFor,
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
  // Therefore an edit to UNTRUSTED_CONTENT_DIRECTIVE necessarily moves every eval's fingerprint.
  const names = Object.keys(CASES);
  expect(names.sort()).toEqual(["critic", "plan-gate", "stop-classifier"]);
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

/** Erase the fixture type so every spec can be checked in one loop. The `as F` cast is safe
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
});

// ---------------------------------------------------------------------------
// runEval: preflight, concurrency, retry
// ---------------------------------------------------------------------------

test("runEval aborts on a PERMANENTLY failing first call, without retrying it", async () => {
  let calls = 0;
  const send: Send = async () => {
    calls++;
    throw new Error("401 invalid x-api-key");
  };
  const spec = testSpec({ fixtures: [FIXTURE, { ...FIXTURE, id: "t2" }] });
  expect(await runEval(spec, ["--trials", "3"], send)).toBe(EXIT.CANNOT_RUN);
  // A dead key cannot recover, so it is not retried and no worker ever starts.
  expect(calls).toBe(1);
});

test("a TRANSIENT failure on the first call is retried, not treated as cannot-run", async () => {
  // Without this the preflight had no retry at all: one 529 on the opening call returned
  // CANNOT_RUN and the workflow green-skipped the entire gate — a transient blip silently
  // disabling the check it exists to be.
  let calls = 0;
  const send: Send = async () => {
    calls++;
    if (calls <= 2) throw new Error("Anthropic API 529: overloaded_error");
    return write("verdict.json", '{"label":"ok"}');
  };
  const spec = testSpec({ fixtures: [FIXTURE] });
  expect(await runEval(spec, ["--trials", "2", "--threshold", "1"], send)).toBe(EXIT.PASS);
  expect(calls).toBeGreaterThan(2);
}, 20_000);

test("a transport failure is retried with backoff before it can affect the run", async () => {
  let calls = 0;
  let injected = 0;
  const send: Send = async () => {
    calls++;
    // Let the preflight through, then fail two later attempts: the retries must recover them, so a
    // transient 529 never becomes a data point.
    if (calls > 1 && injected < 2) {
      injected++;
      throw new Error("Anthropic API 529: overloaded_error");
    }
    return write("verdict.json", '{"label":"ok"}');
  };
  const spec = testSpec({ fixtures: [FIXTURE] });
  expect(await runEval(spec, ["--trials", "3", "--threshold", "1"], send)).toBe(EXIT.PASS);
  expect(injected).toBe(2);
}, 20_000);

test("a trial that fails EVERY attempt invalidates the run instead of scoring as a miss", async () => {
  // The failure that reported 42.3% for a prompt measured at 91.8% an hour earlier: a sustained
  // 529 made ~30 of 52 trials fail, each recorded as a mechanical miss. A run that cannot execute
  // its trials is not a bad result — it is not a result.
  let calls = 0;
  const send: Send = async () => {
    calls++;
    if (calls === 1) return write("verdict.json", '{"label":"ok"}');
    throw new Error("Anthropic API 529: overloaded_error");
  };
  const spec = testSpec({ fixtures: [FIXTURE] });
  expect(await runEval(spec, ["--trials", "3", "--threshold", "1"], send)).toBe(EXIT.CANNOT_RUN);
}, 30_000);

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
  // The classifier scored 95.1% WITHOUT it — adding it there would only invalidate a measurement
  // already paid for.
  expect(CLASSIFIER_SPEC.system).toBeUndefined();
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
  // A harness failure, NOT "cannot run": our bug, so it must fail the gate loudly.
  expect(await runEval(spec, ["--trials", "5"], send)).toBe(EXIT.HARNESS_FAIL);
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

test("a 429 is RETRIED, not treated as permanent — backoff is what it is for", async () => {
  // Folding 429 into the permanent set made one rate-limit response abort an entire run, and made
  // isCannotRun's own "rate limiting that survived the retry" unreachable.
  expect(isPermanent("Anthropic API 429: rate_limit_error")).toBe(false);
  expect(isCannotRun("Anthropic API 429: rate_limit_error")).toBe(true);
  // Genuinely permanent conditions still short-circuit the retries.
  for (const msg of [
    "Anthropic API 401: invalid x-api-key",
    "Anthropic API 403: permission_error",
    "Anthropic API 400: You have reached your specified workspace API usage limits.",
  ]) {
    expect(isPermanent(msg)).toBe(true);
  }

  let calls = 0;
  let injected = 0;
  const send: Send = async () => {
    calls++;
    if (calls > 1 && injected < 2) {
      injected++;
      throw new Error("Anthropic API 429: rate_limit_error");
    }
    return write("verdict.json", '{"label":"ok"}');
  };
  const spec = testSpec({ fixtures: [FIXTURE] });
  // A transient 429 must recover through the backoff rather than invalidating the run.
  expect(await runEval(spec, ["--trials", "3", "--threshold", "1"], send)).toBe(EXIT.PASS);
  expect(injected).toBe(2);
}, 20_000);

test("an exhausted usage limit is CANNOT_RUN, not a gate failure", () => {
  // The exact message the API returned when the workspace budget ran out mid-PR. Failing the gate
  // on this would red every unrelated PR until someone tops the account up, while saying nothing
  // whatsoever about the prompt.
  expect(
    isCannotRun(
      'Anthropic API 400: {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified workspace API usage limits. You will regain access on 2026-10-01 at 00:00 UTC."}}',
    ),
  ).toBe(true);
  expect(isCannotRun("Anthropic API 401: invalid x-api-key")).toBe(true);
  expect(isCannotRun("Anthropic API 429: rate_limit_error")).toBe(true);
  expect(isCannotRun("Anthropic API 403: permission_error")).toBe(true);
  // A genuine fault is NOT excused — those must still stop the run.
  expect(isCannotRun("Anthropic API 500: internal server error")).toBe(false);
  expect(isCannotRun("fetch failed: ECONNRESET")).toBe(false);
});

test("runEval reports CANNOT_RUN when the account cannot make calls at all", async () => {
  const send: Send = async () => {
    throw new Error(
      "Anthropic API 400: You have reached your specified workspace API usage limits.",
    );
  };
  expect(await runEval(testSpec(), ["--trials", "3"], send)).toBe(EXIT.CANNOT_RUN);
});

test("a filter that matches nothing is a HARNESS failure, not a silent skip", async () => {
  expect(await runEval(testSpec(), ["--filter", "nope"], async () => ({}))).toBe(EXIT.HARNESS_FAIL);
});

test("the four exit codes stay distinct — the workflow branches on them", () => {
  expect(new Set(Object.values(EXIT)).size).toBe(4);
});

test("a cannot-run failure INSIDE the pool aborts the run, not just at the preflight", async () => {
  // The preflight is not the only place an account can stop accepting calls. Recording a usage
  // limit as a mechanical miss would exit GATE_FAIL and red the PR on a billing state — the exact
  // outcome the exit-code contract exists to prevent.
  let calls = 0;
  const send: Send = async () => {
    calls++;
    if (calls === 1) return write("verdict.json", '{"label":"ok"}');
    throw new Error(
      'Anthropic API 400: {"error":{"message":"You have reached your specified workspace API usage limits."}}',
    );
  };
  const spec = testSpec({ fixtures: [FIXTURE, { ...FIXTURE, id: "t2" }] });
  expect(await runEval(spec, ["--trials", "4", "--concurrency", "2"], send)).toBe(EXIT.CANNOT_RUN);
  // A permanent condition is not retried — it cannot recover, and the backoff would be paid once
  // per trial across the pool.
  expect(calls).toBeLessThanOrEqual(3);
}, 20_000);

test("a 500 that survives every retry also invalidates the run", async () => {
  // Same rule regardless of the code: an unexecuted trial is never a data point.
  let calls = 0;
  const send: Send = async () => {
    calls++;
    if (calls === 1) return write("verdict.json", '{"label":"ok"}');
    throw new Error("Anthropic API 500: internal server error");
  };
  const spec = testSpec({ fixtures: [FIXTURE] });
  expect(await runEval(spec, ["--trials", "2", "--threshold", "1"], send)).toBe(EXIT.CANNOT_RUN);
}, 30_000);

test("an observational eval does not fail the caller on a VERDICT-LESS run either", async () => {
  // The state plan-gate and critic have ended in twice. The guarantee has to cover every failure
  // mode, not just the scoring one — an eval marked "not ready" must not red every PR in the repo
  // for still being not ready.
  const send: Send = async () => ({
    content: [{ type: "text", text: "prose instead of a tool call" }],
    stop_reason: "end_turn",
  });
  const gating = testSpec({ fixtures: [FIXTURE] });
  const observational = testSpec({ fixtures: [FIXTURE], observational: true });
  expect(await runEval(gating, ["--trials", "3"], send)).toBe(EXIT.HARNESS_FAIL);
  expect(await runEval(observational, ["--trials", "3"], send)).toBe(EXIT.PASS);
});

test("an observational eval still fails on CLI misuse — a filter matching nothing", async () => {
  // Not an outcome of running the eval: answering PASS would hide a typo that ran zero trials.
  const observational = testSpec({ fixtures: [FIXTURE], observational: true });
  expect(await runEval(observational, ["--filter", "nope"], async () => ({}))).toBe(
    EXIT.HARNESS_FAIL,
  );
});

test("an observational eval reports a miss but does not fail the caller", async () => {
  const send: Send = async () => write("verdict.json", '{"label":"bad"}');
  const gating = testSpec({ fixtures: [FIXTURE] });
  const observational = testSpec({ fixtures: [FIXTURE], observational: true });
  // Same wrong verdict, two outcomes: the eval with a pinned floor gates, the unmeasured one does
  // not — gating a PR on a floor nobody has observed would be theatre.
  expect(await runEval(gating, ["--trials", "3"], send)).toBe(EXIT.GATE_FAIL);
  expect(await runEval(observational, ["--trials", "3"], send)).toBe(EXIT.PASS);
});

test("an observational eval says so in its report, so green is never read as a passed gate", () => {
  const spec = testSpec({ fixtures: [FIXTURE], observational: true });
  const results = [aggregate(FIXTURE, [outcome("bad", false)], spec.labels)];
  const out = formatReport(spec, results, decide(results, spec.floor), parseArgs(spec, []));
  expect(out).toContain("OBSERVATIONAL");
  expect(out).toContain("does NOT gate");
  expect(out).toContain("(observational — not gating)");
});

test("the two evals with no measured baseline are observational; the classifier gates", () => {
  // Flip these in the SAME commit that pins the floor from a real run.
  expect(PLAN_GATE_SPEC.observational).toBe(true);
  expect(CRITIC_SPEC.observational).toBe(true);
  expect(CLASSIFIER_SPEC.observational).toBeUndefined();
});

test("no comment still claims AGENT_SYSTEM_PROMPT is mode-setting only", () => {
  // The claim was corrected in eval-core.ts and the docs but left stale at both spec sites. A
  // description of what the harness injects has to stay true everywhere it is written down.
  const sources = [
    readFileSync(new URL("../scripts/eval-core.ts", import.meta.url), "utf8"),
    readFileSync(new URL("../scripts/eval-critic.ts", import.meta.url), "utf8"),
    readFileSync(new URL("../scripts/eval-plan-gate.ts", import.meta.url), "utf8"),
    readFileSync(new URL("../docs/eval-harness.md", import.meta.url), "utf8"),
  ];
  for (const src of sources) expect(src).not.toMatch(/mode-setting only/i);
});

test("AGENT_SYSTEM_PROMPT carries no guidance about HOW to review", () => {
  // It may establish tool-driven operation and disclose the harness's turn limit. It may not tell
  // the model what to look for, how much to inspect, or when it has seen enough — those shape the
  // judgement the eval exists to measure, and production carries none of them.
  expect(AGENT_SYSTEM_PROMPT).not.toMatch(/finding|verdict|approve|request-changes|severity/i);
  expect(AGENT_SYSTEM_PROMPT).not.toMatch(
    /inspect only|as soon as you can decide|stop inspecting/i,
  );
  expect(AGENT_SYSTEM_PROMPT).not.toMatch(/only what you (actually )?need/i);
  // What it DOES say: act through tools, and your turns are finite.
  expect(AGENT_SYSTEM_PROMPT).toMatch(/ONLY through the provided tools/);
  expect(AGENT_SYSTEM_PROMPT).toMatch(/turns is limited/);
});

// ---------------------------------------------------------------------------
// Spend meter + ceiling
// ---------------------------------------------------------------------------

test("the spend meter prices a run through the repo's canonical dollars() formula", () => {
  const spend = emptySpend();
  addUsage(spend, { usage: { input_tokens: 1_000_000, output_tokens: 100_000 } });
  addUsage(spend, { usage: { input_tokens: 0, output_tokens: 0 } });
  expect(spend.calls).toBe(2);
  // sonnet list price: $3/Mtok in, $15/Mtok out -> 3 + 1.5.
  expect(spendUsd(spend, "claude-sonnet-5")).toBeCloseTo(4.5, 5);
  // A response the API did not price must not crash or invent tokens.
  addUsage(spend, {});
  expect(spend.calls).toBe(3);
  expect(spendUsd(spend, "claude-sonnet-5")).toBeCloseTo(4.5, 5);
});

test("a run STOPS at the spend ceiling and discards its partial results", async () => {
  // The control the first $10 run did not have. Each call bills ~$0.30 of sonnet output, so a
  // $1 ceiling must stop the run well before its 20 trials complete.
  let calls = 0;
  const send: Send = async () => {
    calls++;
    return {
      content: [
        {
          type: "tool_use",
          id: "w",
          name: "Write",
          input: { file_path: "verdict.json", content: '{"label":"ok"}' },
        },
      ],
      usage: { input_tokens: 10_000, output_tokens: 20_000 },
    };
  };
  const spec = testSpec({ fixtures: [FIXTURE] });
  expect(
    await runEval(spec, ["--trials", "20", "--max-spend", "1", "--concurrency", "1"], send),
  ).toBe(EXIT.CANNOT_RUN);
  expect(calls).toBeLessThan(20);
});

test("the default spend ceiling is low enough to be a real guard", () => {
  // A ceiling above a full run's cost would be decoration.
  expect(parseArgs(testSpec(), []).maxSpend).toBeLessThanOrEqual(5);
  expect(parseArgs(testSpec(), ["--max-spend", "12.5"]).maxSpend).toBe(12.5);
});

test("the fixture tree includes files the DIFF adds, as a real checkout would", () => {
  // A trace showed the reviewer reading the very file under review and being told it does not
  // exist, because the fixture map only carried pre-existing files. In production the PR branch is
  // checked out, so a file the diff creates is there.
  const bug = CRITIC_SPEC.fixtures.find((f) => f.id === "bug-off-by-one")!;
  expect(respondFromEnv(bug.env, "Read", { file_path: "src/paginate.ts" })).toContain(
    "export function paginate",
  );
  expect(respondFromEnv(bug.env, "Grep", { pattern: "pageCount" })).toContain("src/paginate.ts:");
});

test("the fixture shell answers the orientation commands an agent opens with", () => {
  // Silence from `pwd` / `ls` / `echo` is not neutral: it reads as a broken shell. An observed
  // trial spent 15 of its 18 turns hunting for a working environment and ran out before writing.
  const env = { diff: "diff --git a/x.ts b/x.ts\n", files: { "x.ts": "export const a = 1;\n" } };
  expect(respondFromEnv(env, "Bash", { command: "pwd" })).not.toBe("(no output)");
  expect(respondFromEnv(env, "Bash", { command: "echo test123" })).toBe("test123");
  expect(respondFromEnv(env, "Bash", { command: "ls -la" })).toContain("x.ts");
  expect(respondFromEnv(env, "Bash", { command: "git status" })).toContain("branch");
  // A ref must RESOLVE — an unresolvable base reads as a missing repository.
  expect(respondFromEnv(env, "Bash", { command: "git rev-parse --verify origin/main" })).toMatch(
    /^[0-9a-f]{40}$/,
  );
  // Compound commands are evaluated piecewise, with `cd` dropped (there is one tree).
  expect(respondFromEnv(env, "Bash", { command: "cd /repo && pwd; echo done" })).toContain("done");
});

test("every path a critic fixture's diff touches resolves in its worktree", () => {
  // The incoherent-worktree failure, generalized so it cannot come back one fixture at a time:
  // `git diff` shows a patch for a file that `Read`/`ls` says is not there. `addedFiles()` covers
  // CREATED files; a MODIFIED file's post-image cannot be recovered from the diff, so the fixture
  // has to supply it.
  for (const fixture of CRITIC_SPEC.fixtures) {
    const diff = fixture.env.diff ?? "";
    const touched = [...diff.matchAll(/^diff --git a\/\S+ b\/(\S+)$/gm)].map((m) => m[1]!);
    expect(touched.length).toBeGreaterThan(0);
    for (const path of touched) {
      const read = respondFromEnv(fixture.env, "Read", { file_path: path });
      expect(`${fixture.id}: ${path} -> ${read.slice(0, 40)}`).not.toContain("does not exist");
    }
    // And the tree must not look empty while a patch exists.
    expect(respondFromEnv(fixture.env, "Bash", { command: "git ls-files" })).not.toBe(
      "(no output)",
    );
  }
});

test("CASES actually meets the coverage invariant it states", () => {
  // The invariant is only worth stating if it is checked: prose that no canonical case renders can
  // be edited freely, leaving check:eval-fingerprints green and eval-prompts.yml running nothing.
  // Each string below lives in exactly one conditional block of a prompt builder.
  const rendered = Object.fromEntries(
    Object.entries(CASES).map(([name, cases]) => [name, cases.map((c) => c.render()).join("\n")]),
  );
  const covers = (evalName: string, needle: string) =>
    expect(`${evalName} covers: ${needle}`).toBe(
      rendered[evalName]!.includes(needle)
        ? `${evalName} covers: ${needle}`
        : `${evalName} DOES NOT COVER: ${needle}`,
    );

  // #2154 repo-policy blocks — reachable only via opts.reviewPolicy / opts.houseRules.
  covers("critic", "REVIEW.md");
  covers("critic", "shepherd-house-rules");
  // epicBlock's three mutually exclusive headers.
  covers("critic", "carries NO content your fork point does not already have");
  covers("critic", "Sibling children have ALREADY MERGED");
  covers("critic", "the delta could NOT be enumerated here");
});

// ---------------------------------------------------------------------------
// Smoke mode — the PR leg's contract
// ---------------------------------------------------------------------------

test("smoke mode does NOT fail on a wrong-but-well-formed verdict", async () => {
  // The flake this exists to prevent: at T=1 a majority is one sample, and gate-commit-now's own
  // recorded baseline is `gate:4 finished:1` — a correctness gate there reds ~1 run in 5 on noise.
  const send: Send = async () => write("verdict.json", '{"label":"bad"}');
  const spec = testSpec({ fixtures: [FIXTURE] });
  expect(await runEval(spec, ["--trials", "1"], send)).toBe(EXIT.GATE_FAIL);
  expect(await runEval(spec, ["--trials", "1", "--smoke"], send)).toBe(EXIT.PASS);
});

test("smoke mode DOES fail on a malformed or missing verdict", async () => {
  // The mechanical failure is noise-free, and is what broke in every harness failure so far.
  const prose: Send = async () => ({
    content: [{ type: "text", text: "no tool call" }],
    stop_reason: "end_turn",
  });
  const garbage: Send = async () => write("verdict.json", "not json at all");
  const spec = testSpec({ fixtures: [FIXTURE] });
  // A verdict-less preflight is a harness failure before smoke scoring is reached.
  expect(await runEval(spec, ["--trials", "1", "--smoke"], prose)).toBe(EXIT.HARNESS_FAIL);
  expect(await runEval(spec, ["--trials", "1", "--smoke"], garbage)).toBe(EXIT.GATE_FAIL);
});

test("smoke mode CAPS per-fixture trial overrides, which --trials alone does not", () => {
  // `fixture.trials ?? run.trials` means an override wins — so `--trials 1` left the T=9 fixtures
  // running nine times, and the cost bound the PR leg claimed was not real.
  const thick = { ...FIXTURE, trials: 9 };
  const normal = parseArgs(testSpec(), ["--trials", "1"]);
  const smoke = parseArgs(testSpec(), ["--trials", "1", "--smoke"]);
  expect(trialsFor(thick, normal)).toBe(9);
  expect(trialsFor(thick, smoke)).toBe(1);
  // Outside smoke mode the override still wins, so the thick abstain buckets keep their depth.
  expect(trialsFor(thick, parseArgs(testSpec(), []))).toBe(9);
});

test("smokeDecide names every fixture with a mechanical failure", () => {
  const ok = aggregate(FIXTURE, [outcome("ok", true)], ["ok"]);
  const noTool = aggregate({ ...FIXTURE, id: "nt" }, [outcome("ok", true, false, false)], ["ok"]);
  const parseFail = aggregate({ ...FIXTURE, id: "pf" }, [outcome("ok", true, true, false)], ["ok"]);
  expect(smokeDecide([ok]).pass).toBe(true);
  const bad = smokeDecide([ok, noTool, parseFail]);
  expect(bad.pass).toBe(false);
  expect(bad.malformed.join(" ")).toContain("nt");
  expect(bad.malformed.join(" ")).toContain("pf");
});

test("a smoke report says what it gates on, so green is not read as a passed correctness gate", () => {
  const spec = testSpec({ fixtures: [FIXTURE] });
  const results = [aggregate(FIXTURE, [outcome("bad", false)], spec.labels)];
  const run = parseArgs(spec, ["--trials", "1", "--smoke"]);
  const out = formatReport(spec, results, decide(results, spec.floor), run);
  expect(out).toContain("SMOKE");
  expect(out).toContain("WELL-FORMEDNESS only");
  expect(out).toContain("NOT gated");
});

test("no comment or doc claims an eval count that disagrees with CASES", () => {
  // Dropping the rundown left SEVEN stale "all four evals" claims across scripts, workflows and
  // docs, and a reviewer had to find them. The count is derivable, so derive it: a number written
  // next to "evals" in this surface has to match the number of evals that exist.
  const expected = Object.keys(CASES).length;
  // "one eval" is nearly always singular usage ("ONE run per eval"), not a claim about set size.
  const WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5 };
  const files = [
    "scripts/eval-core.ts",
    "scripts/gen-eval-fingerprints.ts",
    "scripts/eval-critic.ts",
    "scripts/eval-plan-gate.ts",
    "scripts/eval-stop-classifier.ts",
    ".github/workflows/eval-prompts.yml",
    ".github/workflows/eval-stop-classifier.yml",
    "docs/eval-harness.md",
  ];
  // Only phrasings that count THE EVALS. "three attempts", "three-month window", "four exit codes"
  // and the like are about other things and must not be swept up. `the other N` is included
  // because it is how the count came back a third time — with no noun for the regex to anchor on.
  const CLAIM =
    /\b(two|three|four|five)[- ](?:evals|prompts|fingerprints|specs|eval push)\b|\ball (two|three|four|five) (?:evals|prompts|fingerprints|specs)\b|\bthe other (two|three|four|five)\b/gi;
  const wrong: string[] = [];
  for (const file of files) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    for (const m of text.matchAll(CLAIM)) {
      const word = (m[1] ?? m[2] ?? m[3] ?? "").toLowerCase();
      const n = WORDS[word];
      // The two sonnet evals are a genuine subset, not a claim about the whole set.
      if (n === undefined || /sonnet/i.test(m[0])) continue;
      // "the other N" counts the set MINUS the one being contrasted with.
      const claimed = /the other/i.test(m[0]) ? n + 1 : n;
      if (claimed !== expected) wrong.push(`${file}: "${m[0]}" (there are ${expected})`);
    }
  }
  expect(wrong).toEqual([]);
});
