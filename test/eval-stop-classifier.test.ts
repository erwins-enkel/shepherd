import { test, expect } from "bun:test";
import {
  FIXTURES,
  SPEC,
  WRITE_TOOL,
  extractVerdict,
  jevAuthoredState,
  jevQuestion,
  jevVerdict,
  outcomeFor,
  type Fixture,
} from "../scripts/eval-stop-classifier";
import {
  aggregate,
  decide,
  formatReport,
  majority,
  outcomeFrom,
  parseArgs,
  tolerantParse,
  type AnthropicResponse,
  type TrialOutcome,
} from "../scripts/eval-core";
import type { AutopilotKind } from "../src/types";

// These tests are HERMETIC: they import only the eval script (which imports the leaf module
// `src/autopilot-classify-core.ts`, not `src/autopilot-llm.ts`), so importing them triggers
// no env reads / filesystem I/O, and they never touch the network.

// --- extractVerdict: the verdict is parsed from tool_use.input.content, not input itself ---

function toolUseResponse(content: string): AnthropicResponse {
  return {
    content: [
      { type: "text", text: "ok" },
      {
        type: "tool_use",
        name: "Write",
        input: { file_path: ".shepherd-autopilot.json", content },
      },
    ],
  };
}

test("extractVerdict parses tool_use.input.content (the file-content string), not input", () => {
  const resp = toolUseResponse('{"kind":"gate","summary":"asking whether to start"}');
  const { toolUsed, parseOk, raw } = extractVerdict(resp);
  expect(toolUsed).toBe(true);
  expect(parseOk).toBe(true);
  // The parsed verdict is the CONTENT string's JSON — it must NOT be the {file_path,content}
  // wrapper object.
  expect(raw).toEqual({ kind: "gate", summary: "asking whether to start" });
  expect(raw).not.toHaveProperty("file_path");
  expect(raw).not.toHaveProperty("content");
});

test("extractVerdict tolerates a fenced content string", () => {
  const resp = toolUseResponse('```json\n{"kind":"question","summary":"x"}\n```');
  const { parseOk, raw } = extractVerdict(resp);
  expect(parseOk).toBe(true);
  expect((raw as { kind: string }).kind).toBe("question");
});

test("extractVerdict matches the tool name case-insensitively", () => {
  const resp: AnthropicResponse = {
    content: [{ type: "tool_use", name: "write", input: { content: '{"kind":"finished"}' } }],
  };
  expect(extractVerdict(resp).parseOk).toBe(true);
});

// --- mechanical failures never masquerade as a genuine `unknown` verdict ---

test("no tool call → toolUsed=false, parseOk=false (a no-tool miss, not an abstain)", () => {
  const resp: AnthropicResponse = { content: [{ type: "text", text: "I think this is a gate." }] };
  const { toolUsed, parseOk, raw } = extractVerdict(resp);
  expect(toolUsed).toBe(false);
  expect(parseOk).toBe(false);
  expect(raw).toBeNull();
  // normalize(null) → unknown, but the outcome retains toolUsed=false so it is distinguishable.
  expect(outcomeFor(F, resp)).toEqual({
    toolUsed: false,
    parseOk: false,
    label: "unknown",
    correct: false,
    unrecognised: false,
    // …and it carries what the model said instead, so the miss is diagnosable from the log.
    mechanicalSample: "no-tool stop=? turns=1 said: I think this is a gate.",
  });
});

test("Write tool called with unparseable content → toolUsed=true but parseOk=false", () => {
  const resp = toolUseResponse("not json at all");
  const { toolUsed, parseOk, raw } = extractVerdict(resp);
  expect(toolUsed).toBe(true);
  expect(parseOk).toBe(false);
  expect(raw).toBeNull();
  const outcome = outcomeFor(F, resp);
  expect(outcome).toMatchObject({
    toolUsed: true,
    parseOk: false,
    label: "unknown",
    correct: false,
    unrecognised: false,
  });
  // The parser's message rides along; its wording is engine-specific, so only presence is asserted.
  expect(outcome.mechanicalSample).toEndWith("wrote: not json at all");
});

test("a genuine unknown verdict is distinct from a mechanical failure", () => {
  const genuine = outcomeFor(F, toolUseResponse('{"kind":"unknown","summary":"can\'t tell"}'));
  expect(genuine).toEqual({
    toolUsed: true,
    parseOk: true,
    label: "unknown",
    correct: false,
    unrecognised: false,
  });
  // Same normalized kind as the no-tool / parse-fail cases, but toolUsed/parseOk tell them apart.
  const noTool = outcomeFor(F, { content: [{ type: "text", text: "hmm" }] });
  expect(noTool.label).toBe("unknown");
  expect(genuine.parseOk).not.toBe(noTool.parseOk);
});

test("tolerantParse returns null on garbage (never repairs into a spurious verdict)", () => {
  expect(tolerantParse("not json")).toBeNull();
  expect(tolerantParse("")).toBeNull();
  expect(tolerantParse('{"kind":"gate"}')).toEqual({ kind: "gate" });
});

// --- aggregate: kind distribution + no-tool / parse-fail tallies ---

const F: Fixture = {
  id: "x",
  origin: "synthetic",
  taskPrompt: "t",
  tail: ["l"],
  expectedKind: "gate",
  gating: true,
  lang: "en",
  note: "",
};

/** A synthetic trial outcome. `correct` is derived against `expected`, mirroring SPEC.score. */
function outcome(
  kind: AutopilotKind,
  toolUsed = true,
  parseOk = true,
  expected: AutopilotKind = F.expectedKind,
): TrialOutcome {
  return { label: kind, correct: kind === expected, toolUsed, parseOk, unrecognised: false };
}

test("aggregate records full kind counts, majority, correctness, and mechanical tallies", () => {
  const r = aggregate(
    F,
    [
      outcome("gate"),
      outcome("gate"),
      outcome("question"),
      outcome("unknown", false, false), // no-tool miss normalized to unknown
      outcome("unknown", true, false), // parse-fail normalized to unknown
    ],
    SPEC.labels,
  );
  expect(r.counts).toEqual({ gate: 2, question: 1, finished: 0, complete: 0, unknown: 2 });
  expect(r.noTool).toBe(1);
  expect(r.parseFail).toBe(1);
  expect(r.correct).toBe(2); // expected=gate
  expect(r.majorityLabel).toBeNull(); // 2/5 gate is not > half
  expect(r.majorityCorrect).toBe(false);
});

test("majority requires strictly more than half", () => {
  const counts: Record<string, number> = {
    gate: 3,
    question: 2,
    finished: 0,
    complete: 0,
    unknown: 0,
  };
  expect(majority(counts, 5)).toBe("gate");
  expect(majority({ gate: 2, question: 2, finished: 0, complete: 0, unknown: 1 }, 5)).toBeNull();
});

test("aggregate: a clean majority-correct fixture", () => {
  const r = aggregate(F, [outcome("gate"), outcome("gate"), outcome("gate")], SPEC.labels);
  expect(r.majorityLabel).toBe("gate");
  expect(r.majorityCorrect).toBe(true);
  expect(r.correct).toBe(3);
});

// --- decide: gating logic + floor ---

function resultFor(fixture: Partial<Fixture>, kinds: AutopilotKind[]) {
  const fx: Fixture = { ...F, ...fixture } as Fixture;
  return aggregate(
    fx,
    kinds.map((k) => outcome(k, true, true, fx.expectedKind)),
    SPEC.labels,
  );
}

test("decide passes when every gating fixture is majority-correct and accuracy ≥ floor", () => {
  const results = [
    resultFor({ id: "g1", gating: true, expectedKind: "gate" }, ["gate", "gate", "gate"]),
    resultFor({ id: "b1", gating: false, expectedKind: "question" }, ["gate", "gate", "gate"]), // baseline miss ignored
  ];
  const d = decide(results, 0.6);
  expect(d.failures).toEqual([]);
  expect(d.gatingAccuracy).toBe(1);
  expect(d.pass).toBe(true);
});

test("decide fails when a gating fixture misses majority (deadlock signal for contingency)", () => {
  const results = [
    resultFor({ id: "g1", gating: true, expectedKind: "gate" }, ["gate", "question", "unknown"]),
  ];
  const d = decide(results, 0.6);
  expect(d.failures).toEqual(["g1"]);
  expect(d.pass).toBe(false);
});

test("decide fails when gating accuracy is below the floor even if each has a bare majority", () => {
  // Two gating fixtures, each 2/3 correct → accuracy 4/6 ≈ 0.67; floor 0.9 fails.
  const results = [
    resultFor({ id: "g1", gating: true, expectedKind: "gate" }, ["gate", "gate", "question"]),
    resultFor({ id: "g2", gating: true, expectedKind: "gate" }, ["gate", "gate", "unknown"]),
  ];
  const d = decide(results, 0.9);
  expect(d.failures).toEqual([]);
  expect(d.gatingAccuracy).toBeCloseTo(4 / 6, 5);
  expect(d.pass).toBe(false);
});

test("decide ignores baseline fixtures entirely in the accuracy denominator", () => {
  const results = [
    resultFor({ id: "g1", gating: true, expectedKind: "gate" }, ["gate", "gate", "gate"]),
    resultFor({ id: "b1", gating: false, expectedKind: "finished" }, ["gate", "gate", "gate"]),
  ];
  const d = decide(results, 0.6);
  expect(d.gatingTrials).toBe(3); // only g1
  expect(d.pass).toBe(true);
});

// --- formatReport: smoke + surfaces mechanical flags ---

test("formatReport renders gating/baseline segments and flags mechanical misses", () => {
  const results = [
    resultFor({ id: "g1", gating: true, expectedKind: "gate" }, ["gate", "gate", "gate"]),
    aggregate(
      { ...F, id: "g2", gating: true, expectedKind: "unknown" } satisfies Fixture,
      [
        outcome("unknown", false, false, "unknown"),
        outcome("unknown", true, true, "unknown"),
        outcome("gate", true, true, "unknown"),
      ],
      SPEC.labels,
    ),
  ];
  const out = formatReport(
    SPEC,
    results,
    decide(results, 0.6),
    parseArgs(SPEC, ["--model", "claude-haiku-4-5"]),
  );
  expect(out).toContain("GATING");
  expect(out).toContain("g1");
  expect(out).toContain("no-tool:1");
  expect(out).toContain("RESULT:");
});

// --- fixture-set invariants (the coverage contract) ---

test("every fixture has a valid expectedKind and non-empty tail", () => {
  const KINDS: AutopilotKind[] = ["gate", "question", "finished", "complete", "unknown"];
  for (const f of FIXTURES) {
    expect(KINDS).toContain(f.expectedKind);
    expect(f.tail.length).toBeGreaterThan(0);
    expect(f.id).toBeTruthy();
  }
});

test("fixture ids are unique", () => {
  const ids = FIXTURES.map((f) => f.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test("every gating ambiguous→unknown fixture uses T≥9 (thick abstain-bucket confidence)", () => {
  const abstain = FIXTURES.filter((f) => f.expectedKind === "unknown" && f.gating);
  // Both the English and German abstain fixtures gate: #1627 gated them, #2156 demoted the German
  // one after it degraded to 4/9, and #2177 rewrote the directive and re-measured 27/27 at T=9.
  expect(abstain.length).toBeGreaterThanOrEqual(2);
  for (const f of abstain) expect(f.trials ?? 0).toBeGreaterThanOrEqual(9);
});

test("the German abstain fixture gates again, at full trial depth", () => {
  // It was demoted under #2156 when the old directive let it slip to 4/9, and re-promoted once
  // #2177 rewrote that directive and measured 27/27 across two runs. Re-promotion follows a
  // measurement, never an assumption that a fix worked.
  const de = FIXTURES.find((f) => f.id === "de-ambiguous-unknown");
  expect(de).toBeDefined();
  expect(de?.gating).toBe(true);
  expect(de?.trials).toBeGreaterThanOrEqual(9);
});

test("German fixtures both gate (the #1627 de path) and keep baseline before/after data", () => {
  const de = FIXTURES.filter((f) => f.lang === "de");
  expect(de.length).toBeGreaterThan(0);
  // #1627 makes the de path load-bearing: at least one German gating fixture per abstain-critical
  // bucket, AND at least one German baseline fixture retained for the before/after comparison.
  const deGating = de.filter((f) => f.gating);
  const deBaseline = de.filter((f) => !f.gating);
  expect(deGating.length).toBeGreaterThan(0);
  expect(deBaseline.length).toBeGreaterThan(0);
});

test("the German gating fixtures cover gate, question, and the unknown abstain bucket", () => {
  const deGatingKinds = new Set(
    FIXTURES.filter((f) => f.gating && f.lang === "de").map((f) => f.expectedKind),
  );
  // The abstain bucket is the one #1627 exists to protect and #2177 repaired — it gates.
  for (const k of ["gate", "question", "unknown"] as AutopilotKind[]) {
    expect(deGatingKinds).toContain(k);
  }
});

test("German gating fixtures run at T≥9 (temperature-1.0 noise band — no 1-trial flips)", () => {
  for (const f of FIXTURES.filter((f) => f.gating && f.lang === "de")) {
    expect(f.trials ?? 0).toBeGreaterThanOrEqual(9);
  }
});

test("gating English fixtures cover gate, question, finished, complete, and unknown", () => {
  const gatingKinds = new Set(FIXTURES.filter((f) => f.gating).map((f) => f.expectedKind));
  for (const k of ["gate", "question", "finished", "complete", "unknown"] as AutopilotKind[]) {
    expect(gatingKinds).toContain(k);
  }
});

test("WRITE_TOOL requires file_path and content (verdict is read from content)", () => {
  expect(WRITE_TOOL.name).toBe("Write");
  expect(WRITE_TOOL.input_schema.required).toContain("content");
  expect(WRITE_TOOL.input_schema.required).toContain("file_path");
});

// ---------------------------------------------------------------------------
// The JEV leg (`--backend jev`) — the go/no-go from docs/research/jev-system-one-models.md
// ---------------------------------------------------------------------------

const KINDS: AutopilotKind[] = ["gate", "question", "finished", "complete", "unknown"];

test("the verbatim framing asks about the SAME five kinds, with the prompt carrying the definitions", () => {
  const question = jevQuestion(parseArgs(SPEC, ["--backend", "jev"]));
  expect(question.type).toBe("choice");
  // The option set IS the production enum — JEV's decoder then makes an out-of-enum `kind`
  // impossible, which is the whole structural argument for this leg.
  expect(Object.keys(question.criteria).sort()).toEqual([...KINDS].sort());
  // Bare names: the state (the real prompt) already defines each kind, so descriptions here would
  // say the same thing twice and make the two framings differ in more than one variable.
  expect(Object.values(question.criteria).every((c) => c === null)).toBe(true);
});

test("the authored framing carries per-kind criteria instead, distilled from the prompt", () => {
  const question = jevQuestion(parseArgs(SPEC, ["--backend", "jev", "--jev-authored"]));
  expect(Object.keys(question.criteria).sort()).toEqual([...KINDS].sort());
  expect(question.criteria.unknown).toContain("never guess");
  expect(question.criteria.finished).toContain("pull request");
});

test("the authored state clips exactly as the production prompt clips", () => {
  const fixture: Fixture = {
    ...FIXTURES[0]!,
    taskPrompt: "T".repeat(2_000),
    tail: Array.from({ length: 30 }, (_, i) => `line ${i}`),
  };
  const state = jevAuthoredState(fixture);
  expect(state.task).toHaveLength(1_500);
  // Last 20 lines only, most recent last — the same window `classifierPrompt` takes.
  expect(state.terminal_tail.split("\n")).toHaveLength(20);
  expect(state.terminal_tail.split("\n")[0]).toBe("line 10");
  expect(state.terminal_tail.length).toBeLessThanOrEqual(3_000);
});

test("a JEV choice becomes the verdict the existing scorer already reads", () => {
  const raw = jevVerdict({
    kind: { type: "choice", choice: "gate", confidence: 0.84, probabilities: { gate: 0.88 } },
  });
  expect(raw).toEqual({ kind: "gate", summary: "" });
  // The summary is empty BY CONSTRUCTION — JEV cannot generate prose. This eval scores `kind`
  // only, so nothing is lost here; in production it costs the operator-facing gloss (research
  // doc §3a).
  expect(SPEC.score(FIXTURES[1]!, raw)).toEqual({
    label: "gate",
    correct: true,
    unrecognised: false,
  });
});

test("a missing or out-of-enum answer is rejected rather than collapsed to `unknown`", () => {
  // `normalize` MUST collapse a bad verdict to `unknown` (bias to surface). Doing that here would
  // score a transport failure as a correct abstain on the two fixtures that measure abstaining —
  // so this returns null, which the harness records as a mechanical miss.
  expect(jevVerdict({})).toBeNull();
  expect(
    jevVerdict({
      kind: { type: "choice", choice: "GATE", confidence: 1, probabilities: {} },
    }),
  ).toBeNull();
});

test("the jev backend is offered under its own pinned snapshot, never a floating alias", () => {
  expect(Object.keys(SPEC.backends ?? {})).toEqual(["jev"]);
  const model = parseArgs(SPEC, ["--backend", "jev"]).model;
  expect(model).toBe("jev-1.13.0");
  expect(model).not.toContain("latest");
});

test("the report header names the framing, and says what T does NOT measure here", () => {
  const verbatim = formatReport(SPEC, [], decide([], 0.8), parseArgs(SPEC, ["--backend", "jev"]));
  expect(verbatim).toContain("backend=jev");
  expect(verbatim).toContain("VERBATIM");
  // JEV is near-deterministic; without this line a reader would take T=9 for a variance measure.
  expect(verbatim).toContain("near-deterministic");

  const authored = formatReport(
    SPEC,
    [],
    decide([], 0.8),
    parseArgs(SPEC, ["--backend", "jev", "--jev-authored"]),
  );
  expect(authored).toContain("AUTHORED");
  // The German directives live in the PROMPT, so the authored framing does not exercise them —
  // stated in the header because it is the first thing to misread in the German buckets.
  expect(authored).toContain("does not exercise them");

  // The Anthropic leg's header is untouched by any of this.
  expect(formatReport(SPEC, [], decide([], 0.8), parseArgs(SPEC, []))).not.toContain("jev framing");
});

test("an unrecognised verdict is never counted correct — not even on the abstain fixtures", () => {
  // THE TRAP this guards, which is specific to the two `unknown` fixtures: `normalize` answers
  // `unknown` for anything it cannot read, and `unknown` is what those two fixtures EXPECT. So
  // before this was fixed, failures that produced no judgement at all scored a perfect 9/9 on
  // exactly the buckets whose job is measuring abstention.
  const ambiguous = FIXTURES.find((f) => f.id === "ambiguous-unknown")!;
  const german = FIXTURES.find((f) => f.id === "de-ambiguous-unknown")!;
  const verdictless = { toolUsed: false, content: null, turns: 1 };

  // SHAPE 2, and the more dangerous one: a verdict that parses cleanly but whose `kind` was
  // TRANSLATED. `CLASSIFIER_OUTPUT_LANGUAGE_DE` exists because the model really does this, and such
  // a trial looks mechanically perfect — toolUsed and parseOk both true — so nothing but
  // `unrecognised` names it.
  const translated = {
    toolUsed: true,
    content: '{"kind":"unbekannt","summary":"Kann ich nicht sagen."}',
    turns: 1,
  };
  for (const fixture of [ambiguous, german]) {
    const o = outcomeFrom(SPEC, fixture, translated);
    expect(o).toMatchObject({ toolUsed: true, parseOk: true, label: "unknown", correct: false });
    expect(o.unrecognised).toBe(true);
  }
  const translatedAgg = aggregate(
    german,
    Array.from({ length: 9 }, () => outcomeFrom(SPEC, german, translated)),
    SPEC.labels,
  );
  expect(translatedAgg.unrecognised).toBe(9);
  expect(translatedAgg.correct).toBe(0);
  expect(translatedAgg.majorityCorrect).toBe(false);
  expect(decide([translatedAgg], 0.8).pass).toBe(false);

  // An out-of-enum kind is not correct on a NON-abstain fixture either.
  expect(
    outcomeFrom(
      SPEC,
      FIXTURES.find((f) => f.id === "gate-commit-now")!,
      translated,
    ).correct,
  ).toBe(false);

  for (const fixture of [ambiguous, german]) {
    const o = outcomeFrom(SPEC, fixture, verdictless);
    expect(o.correct).toBe(false);
    expect(o.toolUsed).toBe(false);
    // The label still reads `unknown` — that IS normalize's answer, and the distribution is not
    // the place this is disambiguated. `no-tool` is.
    expect(o.label).toBe("unknown");
  }

  // ...and the whole way up: nine such trials must not pass the gate.
  const agg = aggregate(
    ambiguous,
    Array.from({ length: 9 }, () => outcomeFrom(SPEC, ambiguous, verdictless)),
    SPEC.labels,
  );
  expect(agg.noTool).toBe(9);
  expect(agg.correct).toBe(0);
  expect(agg.majorityCorrect).toBe(false);
  expect(decide([agg], 0.8).pass).toBe(false);

  // A GENUINE abstain — the model really wrote `{"kind":"unknown"}` — still scores correct.
  const real = outcomeFor(ambiguous, {
    content: [
      {
        type: "tool_use",
        id: "t",
        name: "Write",
        input: { file_path: "v.json", content: '{"kind":"unknown","summary":"cannot tell"}' },
      },
    ],
  });
  expect(real).toMatchObject({ toolUsed: true, label: "unknown", correct: true });
});
