import { test, expect } from "bun:test";
import {
  FIXTURES,
  WRITE_TOOL,
  tolerantParse,
  extractVerdict,
  outcomeFromResponse,
  aggregate,
  majority,
  decide,
  formatReport,
  type Fixture,
  type TrialOutcome,
  type AnthropicResponse,
} from "../scripts/eval-stop-classifier";
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
  expect(outcomeFromResponse(resp)).toEqual({ toolUsed: false, parseOk: false, kind: "unknown" });
});

test("Write tool called with unparseable content → toolUsed=true but parseOk=false", () => {
  const resp = toolUseResponse("not json at all");
  const { toolUsed, parseOk, raw } = extractVerdict(resp);
  expect(toolUsed).toBe(true);
  expect(parseOk).toBe(false);
  expect(raw).toBeNull();
  expect(outcomeFromResponse(resp)).toEqual({ toolUsed: true, parseOk: false, kind: "unknown" });
});

test("a genuine unknown verdict is distinct from a mechanical failure", () => {
  const genuine = outcomeFromResponse(
    toolUseResponse('{"kind":"unknown","summary":"can\'t tell"}'),
  );
  expect(genuine).toEqual({ toolUsed: true, parseOk: true, kind: "unknown" });
  // Same normalized kind as the no-tool / parse-fail cases, but toolUsed/parseOk tell them apart.
  const noTool = outcomeFromResponse({ content: [{ type: "text", text: "hmm" }] });
  expect(noTool.kind).toBe("unknown");
  expect(genuine.parseOk).not.toBe(noTool.parseOk);
});

test("tolerantParse returns null on garbage (never repairs into a spurious verdict)", () => {
  expect(tolerantParse("not json")).toBeNull();
  expect(tolerantParse("")).toBeNull();
  expect(tolerantParse('{"kind":"gate"}')).toEqual({ kind: "gate" });
});

// --- aggregate: kind distribution + no-tool / parse-fail tallies ---

function outcome(kind: AutopilotKind, toolUsed = true, parseOk = true): TrialOutcome {
  return { kind, toolUsed, parseOk };
}

const F: Fixture = {
  id: "x",
  taskPrompt: "t",
  tail: ["l"],
  expectedKind: "gate",
  gating: true,
  lang: "en",
  note: "",
};

test("aggregate records full kind counts, majority, correctness, and mechanical tallies", () => {
  const r = aggregate(F, [
    outcome("gate"),
    outcome("gate"),
    outcome("question"),
    outcome("unknown", false, false), // no-tool miss normalized to unknown
    outcome("unknown", true, false), // parse-fail normalized to unknown
  ]);
  expect(r.counts).toEqual({ gate: 2, question: 1, finished: 0, complete: 0, unknown: 2 });
  expect(r.noTool).toBe(1);
  expect(r.parseFail).toBe(1);
  expect(r.correct).toBe(2); // expected=gate
  expect(r.majorityKind).toBeNull(); // 2/5 gate is not > half
  expect(r.majorityCorrect).toBe(false);
});

test("majority requires strictly more than half", () => {
  const counts = { gate: 3, question: 2, finished: 0, complete: 0, unknown: 0 };
  expect(majority(counts, 5)).toBe("gate");
  expect(majority({ gate: 2, question: 2, finished: 0, complete: 0, unknown: 1 }, 5)).toBeNull();
});

test("aggregate: a clean majority-correct fixture", () => {
  const r = aggregate(F, [outcome("gate"), outcome("gate"), outcome("gate")]);
  expect(r.majorityKind).toBe("gate");
  expect(r.majorityCorrect).toBe(true);
  expect(r.correct).toBe(3);
});

// --- decide: gating logic + floor ---

function resultFor(fixture: Partial<Fixture>, kinds: AutopilotKind[]) {
  const fx: Fixture = { ...F, ...fixture } as Fixture;
  return aggregate(
    fx,
    kinds.map((k) => outcome(k)),
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
    aggregate({ ...F, id: "g2", gating: true, expectedKind: "unknown" }, [
      outcome("unknown", false, false),
      outcome("unknown"),
      outcome("gate"),
    ]),
  ];
  const out = formatReport(results, decide(results, 0.6), "claude-haiku-4-5");
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

test("the ambiguous→unknown fixture exists, is gating, and uses T≥9", () => {
  const amb = FIXTURES.find((f) => f.expectedKind === "unknown");
  expect(amb).toBeDefined();
  expect(amb?.gating).toBe(true);
  expect(amb?.trials ?? 0).toBeGreaterThanOrEqual(9);
});

test("at least one German baseline fixture exists (non-gating), for the #1627 before/after", () => {
  const de = FIXTURES.filter((f) => f.lang === "de");
  expect(de.length).toBeGreaterThan(0);
  for (const f of de) expect(f.gating).toBe(false);
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
