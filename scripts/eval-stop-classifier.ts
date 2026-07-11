// Live-model eval harness for the autopilot stop-classifier (issue #1626).
//
// Runs the REAL classifier prompt + verdict interpretation against a labelled fixture set
// of (taskPrompt, terminal-tail) -> expected kind, and reports per-fixture kind
// distributions + a pass/fail against a pinned threshold that tolerates the classifier's
// nondeterminism. See `docs/eval-stop-classifier.md` for methodology, baseline numbers, the
// pinned threshold + its adjustment rule, the fidelity caveats, and the CI/cost decision.
//
// Design (mirrors `scripts/issue-triage.ts`'s API-call + tolerant-parse + importable-pure-
// helpers shape, but DELIBERATELY diverges on the tool axis):
//   - It imports the real `classifierPrompt` + `normalize` from the LEAF module
//     `src/autopilot-classify-core.ts` (never `src/autopilot-llm.ts`, which transitively
//     reads env + probes the filesystem at import time). Drift on prompt/normalize is thus
//     avoided by import.
//   - It declares a `Write` tool on the Messages request so the model does what the prompt
//     literally says — call `Write(file_path, content)` and stop — matching production's
//     `writer-only` preset (`--allowedTools Write`). The verdict JSON is the STRING value of
//     `tool_use.input.content`, NOT `tool_use.input` itself.
//   - Single-turn: we never execute the tool or round-trip a `tool_result`; the captured
//     `input.content` IS the verdict. `tool_choice` is left `auto` (default) to mirror prod's
//     `dontAsk`, which denies off-allowlist tools rather than compelling a call.
//   - Each trial records THREE facts separately — `toolUsed`, `parseOk`, and the normalized
//     `kind` — so a mechanical failure (no tool call / unparseable content) is never conflated
//     with a genuine model `unknown` verdict (`normalize` collapses both to `{kind:"unknown"}`).
//
// The live run is NOT gated in `bun test ./test` (hermetic/free); this script is manual /
// nightly via `bun run eval:stop-classifier`. The pure helpers below are unit-tested in
// `test/eval-stop-classifier.test.ts` with NO network.

import { classifierPrompt, normalize, type RawVerdict } from "../src/autopilot-classify-core";
import type { AutopilotKind } from "../src/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** API snapshot id for the CLI `haiku` alias that `classifyStop` defaults to. This pins a
 *  SNAPSHOT, not the alias — an alias re-point across CLI upgrades won't be caught here
 *  (caveat D). The resolved id is printed in the report. Overridable via `--model`. */
const DEFAULT_MODEL = "claude-haiku-4-5";
/** The Messages API errors without `max_tokens`. The verdict is tiny; 1024 is ample. */
const MAX_TOKENS = 1024;
/** Default per-fixture trial count (odd -> majority-decidable). Overridable via `--trials`
 *  and per-fixture via `Fixture.trials`. */
const DEFAULT_TRIALS = 5;
/** Messages-API default sampling temperature. Left at 1.0 as an APPROXIMATION of production
 *  nondeterminism (the interactive `claude` transient-spawn's real temperature is unknown to
 *  us and may be lower — caveat B). Overridable via `--temperature`. */
const DEFAULT_TEMPERATURE = 1.0;
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * PINNED overall-accuracy floor for the gating fixture set — a LITERAL constant, NOT
 * "observed - margin computed at runtime" (that would make the gate vacuous). Adjustment
 * rule (see the doc): `FLOOR = round_down(observed - 0.15)` to the nearest 0.05, changed
 * only by a deliberate, commit-noted edit.
 *
 * Pinned from the first live baseline (claude-haiku-4-5, T=5/9, temperature 1.0): after
 * demoting `gate-spec-first` per the contingency rule, gating accuracy was 33/34 = 0.971 →
 * `round_down(0.971 - 0.15)` to the nearest 0.05 = 0.80. See docs/eval-stop-classifier.md.
 *
 * The overall floor is only a coarse CATASTROPHE-catcher; the real regression signal is
 * per-fixture majority-correctness + the recorded per-fixture kind-distribution baseline.
 */
const GATING_ACCURACY_FLOOR = 0.8;

const ALL_KINDS: AutopilotKind[] = ["gate", "question", "finished", "complete", "unknown"];

/** The `Write` tool declared on every request. Schema mirrors the real `Write` tool the
 *  `writer-only` preset allows; we only ever READ `input.content` (never execute it). */
export const WRITE_TOOL = {
  name: "Write",
  description:
    "Write text to a file. Use this to write your verdict JSON to the file the task names, then stop.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "The file to write." },
      content: { type: "string", description: "The full file content (your verdict JSON)." },
    },
    required: ["file_path", "content"],
  },
} as const;

// ---------------------------------------------------------------------------
// Fixtures — labelled (taskPrompt, tail) -> expectedKind
// ---------------------------------------------------------------------------

export interface Fixture {
  id: string;
  taskPrompt: string;
  tail: string[];
  expectedKind: AutopilotKind;
  /** true -> counts toward pass/fail; false -> run + reported but excluded (baseline only). */
  gating: boolean;
  lang: "en" | "de";
  /** Per-fixture trial override (else the run's `--trials` / DEFAULT_TRIALS). */
  trials?: number;
  note: string;
}

export const FIXTURES: Fixture[] = [
  {
    id: "gate-spec-first",
    taskPrompt: "Build a login page for the app.",
    tail: [
      "I've reviewed the existing auth code and the routing.",
      "Shall I write the spec first before implementing? (y/n)",
    ],
    expectedKind: "gate",
    // KNOWN CURRENT-CLASSIFIER GAP (recorded via the contingency rule — see the doc). This is
    // the classifier prompt's OWN canonical `gate` exemplar ("shall I write the spec first?"),
    // yet haiku leans `question` (2 gate / 3 question at T=5 on the first baseline) — it reads
    // spec-first-vs-dive-in as a methodology fork. Faithful to the exemplar, not a mislabel, so
    // it is DEMOTED to non-gating baseline (kept, run, reported) rather than revised. A prime
    // before/after datum for #1627.
    gating: false,
    lang: "en",
    note: "Prompt's own gate exemplar — but the classifier splits toward question (known gap).",
  },
  {
    id: "gate-commit-now",
    taskPrompt: "Add a rate limiter to the API middleware.",
    tail: ["The rate limiter is implemented and the tests pass.", "Ready to commit now? (y/n)"],
    expectedKind: "gate",
    gating: true,
    lang: "en",
    note: "Proceed-obvious — committing its own work is clearly correct.",
  },
  {
    id: "question-jwt-vs-cookie",
    taskPrompt: "Add authentication to the app.",
    tail: [
      "Before I proceed I need a decision on session strategy.",
      "Should I use stateless JWTs or server-side session cookies?",
      "They have materially different security and scaling trade-offs, so I don't want to pick unilaterally.",
    ],
    expectedKind: "question",
    gating: true,
    lang: "en",
    note: "Real product/requirements fork that needs a human.",
  },
  {
    id: "finished-pr-pending",
    taskPrompt: "Fix the off-by-one bug in the pagination component.",
    tail: [
      "Fixed the off-by-one in the page-offset calculation and added a regression test.",
      "All tests green. I believe the change is complete — I have not opened the PR yet.",
    ],
    expectedKind: "finished",
    gating: true,
    lang: "en",
    note: "Code deliverable = a PR, done but PR not yet opened.",
  },
  {
    id: "complete-investigation",
    taskPrompt: "Investigate why the nightly build is flaky and report your findings.",
    tail: [
      "Investigation complete. The flakiness comes from a shared temp-dir race in the",
      "integration suite: two tests write the same fixture path concurrently.",
      "Summary of root cause and three suggested fixes is above. Nothing to implement here.",
    ],
    expectedKind: "complete",
    gating: true,
    lang: "en",
    note: "Research/analysis task — no PR to produce.",
  },
  {
    id: "complete-issue-created",
    taskPrompt: "File a GitHub issue describing the memory leak in the worker pool.",
    tail: [
      "Created issue #482 describing the worker-pool memory leak, with repro steps and",
      "the heap-snapshot evidence. That completes the task.",
    ],
    expectedKind: "complete",
    gating: true,
    lang: "en",
    note: "Deliverable is a filed issue — nothing to turn into a PR.",
  },
  {
    id: "ambiguous-unknown",
    taskPrompt: "Refactor the report generator for readability.",
    tail: ["Done with the first part. Moving on.", ""],
    expectedKind: "unknown",
    gating: true,
    // Thicker confidence for the most-eroded bucket (the conservative abstain the intent
    // line most degrades). If this can't hold majority-unknown even at T=9, the contingency
    // rule (see the doc) demotes it to non-gating + records it as the headline baseline gap.
    trials: 9,
    lang: "en",
    note: "Genuinely ambiguous tail — the classifier MUST abstain to unknown, not guess.",
  },
  {
    id: "de-gate-spec",
    taskPrompt: "Build a login page for the app.",
    tail: [
      "Ich habe den bestehenden Auth-Code geprüft.",
      "Soll ich zuerst die Spezifikation schreiben, bevor ich implementiere? (j/n)",
    ],
    expectedKind: "gate",
    // Baseline (not gating): the German twin of `gate-spec-first`, the recorded known gap that
    // leans `question` even in English — kept for the before/after comparison, never gated (gating
    // it would just import that gap). The German gate BUCKET is gated via `de-gate-commit` below.
    gating: false,
    lang: "de",
    note: "German twin of the known-gap spec-first exemplar — baseline before/after datum only.",
  },
  {
    id: "de-gate-commit",
    taskPrompt: "Add a rate limiter to the API middleware.",
    tail: [
      "Der Rate-Limiter ist implementiert und die Tests sind grün.",
      "Soll ich jetzt committen? (j/n)",
    ],
    expectedKind: "gate",
    // GATING (#1627): the German proceed-obvious gate — German twin of the SOLID `gate-commit-now`,
    // not the known-gap spec-first exemplar. T=9 for a noise-tolerant German-input signal.
    gating: true,
    trials: 9,
    lang: "de",
    note: "German proceed-obvious gate — committing its own green work is clearly correct.",
  },
  {
    id: "de-question-approach",
    taskPrompt: "Add authentication to the app.",
    tail: [
      "Bevor ich weitermache, brauche ich eine Entscheidung zur Session-Strategie.",
      "Soll ich zustandslose JWTs oder serverseitige Session-Cookies verwenden?",
      "Das hat sehr unterschiedliche Sicherheits- und Skalierungs-Konsequenzen.",
    ],
    expectedKind: "question",
    // GATING (#1627): the German product-fork bucket (5/5 at the #1626 baseline). T=9.
    gating: true,
    trials: 9,
    lang: "de",
    note: "German real product fork needing a human — the German `question` bucket under #1627.",
  },
  {
    id: "de-ambiguous-unknown",
    taskPrompt: "Refactor the report generator for readability.",
    tail: ["Mit dem ersten Teil fertig. Ich mache weiter.", ""],
    expectedKind: "unknown",
    // GATING (#1627 HEADLINE): the abstain bucket under German input — the exact erosion the
    // input-robustness line defends against. No prior fixture covered German→unknown. T=9, the
    // thick-confidence count the English `ambiguous-unknown` also uses for the most-eroded bucket.
    gating: true,
    trials: 9,
    lang: "de",
    note: "Genuinely ambiguous German tail — the classifier MUST abstain to unknown, not guess.",
  },
  {
    id: "de-finished-pr",
    taskPrompt: "Fix the off-by-one bug in the pagination component.",
    tail: [
      "Den Off-by-one-Fehler in der Seiten-Offset-Berechnung behoben und einen Regressionstest",
      "hinzugefügt. Alle Tests grün. Ich habe den PR noch nicht geöffnet.",
    ],
    expectedKind: "finished",
    // Baseline (not gating): kept as a before/after datum; the three gated German buckets above
    // (gate/question/unknown) are the load-bearing #1627 signal.
    gating: false,
    lang: "de",
    note: "German tail, English prompt — baseline mixed-language before/after datum.",
  },
];

// ---------------------------------------------------------------------------
// Pure, testable helpers (no network)
// ---------------------------------------------------------------------------

/** One trial's three separately-tracked facts. `kind` is the NORMALIZED verdict. */
export interface TrialOutcome {
  /** Did the model call the `Write` tool at all (vs. emit plain text)? */
  toolUsed: boolean;
  /** Did the captured `tool_use.input.content` parse as a JSON object? */
  parseOk: boolean;
  kind: AutopilotKind;
}

/** Minimal shape of the Anthropic Messages response we read. */
interface AnthropicContentBlock {
  type: string;
  name?: string;
  input?: unknown;
  text?: string;
}
export interface AnthropicResponse {
  content?: AnthropicContentBlock[];
}

/** Tolerant JSON parse: strips an optional ```json fence and, failing that, extracts the
 *  first {...} object. Returns null on any parse failure (never repairs — a mechanical
 *  failure must stay visible, not be coerced into a spurious verdict). */
export function tolerantParse(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? raw).trim();
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  let parsed = tryParse(candidate);
  if (parsed === undefined) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start !== -1 && end > start) parsed = tryParse(candidate.slice(start, end + 1));
  }
  return parsed === undefined ? null : parsed;
}

/**
 * Extract the verdict from a Messages response. The verdict JSON is the STRING value of the
 * `Write` tool call's `input.content` (the file-content arg the model passes), NOT
 * `tool_use.input` itself. Returns:
 *   - toolUsed: a `tool_use` block named `Write` (case-insensitive) with a string `content`
 *   - parseOk : that `content` string parsed as a JSON object
 *   - raw     : the parsed object (fed to the real `normalize`), or null on any failure
 */
export function extractVerdict(response: AnthropicResponse): {
  toolUsed: boolean;
  parseOk: boolean;
  raw: RawVerdict | null;
} {
  const block = (response.content ?? []).find(
    (b) => b.type === "tool_use" && (b.name ?? "").toLowerCase() === "write",
  );
  const content =
    block && typeof block.input === "object" && block.input !== null
      ? (block.input as Record<string, unknown>).content
      : undefined;
  const toolUsed = typeof content === "string";
  if (!toolUsed) return { toolUsed: false, parseOk: false, raw: null };
  const parsed = tolerantParse(content as string);
  const parseOk = typeof parsed === "object" && parsed !== null;
  return { toolUsed: true, parseOk, raw: parseOk ? (parsed as RawVerdict) : null };
}

/** Turn a raw Messages response into one normalized trial outcome. */
export function outcomeFromResponse(response: AnthropicResponse): TrialOutcome {
  const { toolUsed, parseOk, raw } = extractVerdict(response);
  return { toolUsed, parseOk, kind: normalize(raw).kind };
}

export interface FixtureResult {
  fixture: Fixture;
  trials: number;
  outcomes: TrialOutcome[];
  counts: Record<AutopilotKind, number>;
  noTool: number;
  parseFail: number;
  majorityKind: AutopilotKind | null;
  correct: number;
  majorityCorrect: boolean;
}

/** The kind with strictly more than half the trials, else null (no majority). */
export function majority(
  counts: Record<AutopilotKind, number>,
  trials: number,
): AutopilotKind | null {
  for (const k of ALL_KINDS) {
    if (counts[k] > trials / 2) return k;
  }
  return null;
}

/** Aggregate a fixture's trial outcomes into distributions + majority + correctness.
 *  PURE — no I/O; the unit tests drive it with synthetic outcomes. */
export function aggregate(fixture: Fixture, outcomes: TrialOutcome[]): FixtureResult {
  const counts = Object.fromEntries(ALL_KINDS.map((k) => [k, 0])) as Record<AutopilotKind, number>;
  let noTool = 0;
  let parseFail = 0;
  for (const o of outcomes) {
    counts[o.kind]++;
    if (!o.toolUsed) noTool++;
    else if (!o.parseOk) parseFail++;
  }
  const trials = outcomes.length;
  const majorityKind = majority(counts, trials);
  const correct = counts[fixture.expectedKind];
  return {
    fixture,
    trials,
    outcomes,
    counts,
    noTool,
    parseFail,
    majorityKind,
    correct,
    majorityCorrect: correct > trials / 2,
  };
}

export interface Decision {
  pass: boolean;
  floor: number;
  gatingAccuracy: number;
  gatingCorrect: number;
  gatingTrials: number;
  /** ids of gating fixtures that did NOT reach majority-correct. */
  failures: string[];
}

/** Overall pass = every gating fixture is majority-correct AND gating trial-accuracy >= floor.
 *  Non-gating (baseline) fixtures are reported but never gate. PURE. */
export function decide(results: FixtureResult[], floor = GATING_ACCURACY_FLOOR): Decision {
  const gating = results.filter((r) => r.fixture.gating);
  const gatingCorrect = gating.reduce((n, r) => n + r.correct, 0);
  const gatingTrials = gating.reduce((n, r) => n + r.trials, 0);
  const gatingAccuracy = gatingTrials === 0 ? 0 : gatingCorrect / gatingTrials;
  const failures = gating.filter((r) => !r.majorityCorrect).map((r) => r.fixture.id);
  return {
    pass: failures.length === 0 && gatingAccuracy >= floor,
    floor,
    gatingAccuracy,
    gatingCorrect,
    gatingTrials,
    failures,
  };
}

function distStr(counts: Record<AutopilotKind, number>): string {
  return ALL_KINDS.filter((k) => counts[k] > 0)
    .map((k) => `${k}:${counts[k]}`)
    .join(" ");
}

/** Human-readable report: per-fixture kind-distribution + no-tool/parse-fail + the verdict. */
export function formatReport(
  results: FixtureResult[],
  decision: Decision,
  modelId: string,
  operatorLanguageOff = false,
): string {
  const lines: string[] = [];
  lines.push(`autopilot stop-classifier eval — model=${modelId}`);
  lines.push(
    operatorLanguageOff
      ? "operator-language: OFF (before leg — forced en everywhere, ≡ #1626 baseline)"
      : "operator-language: per-fixture lang (after leg — German directive live for `de` fixtures)",
  );
  lines.push(
    `fixtures=${results.length} (gating=${results.filter((r) => r.fixture.gating).length}, ` +
      `baseline=${results.filter((r) => !r.fixture.gating).length}); ` +
      `calls=${results.reduce((n, r) => n + r.trials, 0)}`,
  );
  lines.push(
    "Bounded coverage: samples T trials per curated fixture — NOT exhaustive over real tails.",
  );
  lines.push("");
  for (const seg of [true, false]) {
    const segResults = results.filter((r) => r.fixture.gating === seg);
    if (segResults.length === 0) continue;
    lines.push(seg ? "── GATING (counts toward pass/fail) ──" : "── BASELINE (reported only) ──");
    for (const r of segResults) {
      const mark = r.majorityCorrect ? "PASS" : "FAIL";
      const flags = [
        r.noTool > 0 ? `no-tool:${r.noTool}` : "",
        r.parseFail > 0 ? `parse-fail:${r.parseFail}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      lines.push(
        `  [${seg ? mark : "····"}] ${r.fixture.id.padEnd(24)} exp=${r.fixture.expectedKind.padEnd(9)} ` +
          `maj=${(r.majorityKind ?? "—").padEnd(9)} ${r.correct}/${r.trials}  {${distStr(r.counts)}}` +
          (flags ? `  ⚠ ${flags}` : ""),
      );
    }
    lines.push("");
  }
  lines.push(
    `gating accuracy = ${(decision.gatingAccuracy * 100).toFixed(1)}% ` +
      `(${decision.gatingCorrect}/${decision.gatingTrials}); floor = ${(decision.floor * 100).toFixed(0)}%`,
  );
  if (decision.failures.length > 0) {
    lines.push(`gating fixtures below majority: ${decision.failures.join(", ")}`);
    lines.push(
      "→ contingency (see docs/eval-stop-classifier.md): revise the fixture, or demote it to " +
        "non-gating baseline and record it as a known current-classifier gap.",
    );
  }
  lines.push(`RESULT: ${decision.pass ? "PASS" : "FAIL"}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Live run (not exercised by the unit tests — network is never called there)
// ---------------------------------------------------------------------------

interface RunOptions {
  apiKey: string;
  model: string;
  temperature: number;
  trials: number;
  filter?: string;
  /** #1627 A/B switch: when true, force `operatorLanguage="en"` for EVERY fixture (the *before* leg
   *  — byte-identical to the #1626 baseline). Default false → each fixture uses its own `lang` (the
   *  *after* leg, with the German directive live for `de` fixtures). English fixtures are unchanged
   *  either way. One harness, both A/B legs, reproducibly on the same branch/commit. */
  operatorLanguageOff: boolean;
}

function buildRequestBody(
  model: string,
  temperature: number,
  prompt: string,
): Record<string, unknown> {
  return {
    model,
    max_tokens: MAX_TOKENS,
    temperature,
    tools: [WRITE_TOOL],
    // tool_choice omitted -> API default `auto`, mirroring prod's dontAsk (denies but does
    // not compel a tool call).
    messages: [{ role: "user", content: prompt }],
  };
}

async function callModel(opts: RunOptions, prompt: string): Promise<AnthropicResponse> {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": opts.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify(buildRequestBody(opts.model, opts.temperature, prompt)),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  return (await res.json()) as AnthropicResponse;
}

function trialsFor(fixture: Fixture, defaultTrials: number): number {
  return fixture.trials ?? defaultTrials;
}

function parseArgs(argv: string[]): {
  trials: number;
  model: string;
  temperature: number;
  threshold: number;
  filter?: string;
  json: boolean;
  operatorLanguageOff: boolean;
} {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  return {
    trials: Number(get("--trials") ?? DEFAULT_TRIALS),
    model: get("--model") ?? DEFAULT_MODEL,
    temperature: Number(get("--temperature") ?? DEFAULT_TEMPERATURE),
    threshold: Number(get("--threshold") ?? GATING_ACCURACY_FLOOR),
    filter: get("--filter"),
    json: argv.includes("--json"),
    operatorLanguageOff: argv.includes("--operator-language-off"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey) {
    console.error(
      "[eval-stop-classifier] no ANTHROPIC_API_KEY — cannot run the live baseline. " +
        "Set the key (or dispatch .github/workflows/eval-stop-classifier.yml) and retry.",
    );
    process.exit(2);
  }

  const fixtures = args.filter
    ? FIXTURES.filter((f) => f.id.includes(args.filter as string))
    : FIXTURES;
  if (fixtures.length === 0) {
    console.error(`[eval-stop-classifier] no fixtures match --filter ${args.filter}`);
    process.exit(2);
  }

  const opts: RunOptions = {
    apiKey,
    model: args.model,
    temperature: args.temperature,
    trials: args.trials,
    filter: args.filter,
    operatorLanguageOff: args.operatorLanguageOff,
  };

  const results: FixtureResult[] = [];
  let firstCall = true;
  for (const fixture of fixtures) {
    const n = trialsFor(fixture, args.trials);
    // #1627 A/B: `--operator-language-off` forces "en" everywhere (the *before* leg); otherwise each
    // fixture uses its own `lang`, so `de` fixtures exercise the real German directive (*after*).
    const operatorLanguage = opts.operatorLanguageOff ? "en" : fixture.lang;
    const prompt = classifierPrompt(fixture.tail, fixture.taskPrompt, operatorLanguage);
    const outcomes: TrialOutcome[] = [];
    for (let t = 0; t < n; t++) {
      let response: AnthropicResponse;
      try {
        response = await callModel(opts, prompt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (firstCall) {
          // Preflight: a dead key / transport failure on the very first call aborts
          // immediately rather than burning the remaining ~50 calls.
          console.error(
            `[eval-stop-classifier] first call failed — aborting before spending on the rest: ${msg}`,
          );
          process.exit(2);
        }
        // A later transient failure: record a mechanical no-tool miss and continue.
        console.error(`[eval-stop-classifier] ${fixture.id} trial ${t + 1} error: ${msg}`);
        outcomes.push({ toolUsed: false, parseOk: false, kind: "unknown" });
        firstCall = false;
        continue;
      }
      firstCall = false;
      outcomes.push(outcomeFromResponse(response));
    }
    results.push(aggregate(fixture, outcomes));
  }

  const decision = decide(results, args.threshold);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          model: args.model,
          temperature: args.temperature,
          // #1627 A/B leg: false = *after* (per-fixture lang, German directive live for `de`);
          // true = *before* (operator-language forced off everywhere, ≡ #1626 baseline).
          operatorLanguageOff: args.operatorLanguageOff,
          decision,
          results: results.map((r) => ({
            id: r.fixture.id,
            expected: r.fixture.expectedKind,
            gating: r.fixture.gating,
            lang: r.fixture.lang,
            trials: r.trials,
            counts: r.counts,
            noTool: r.noTool,
            parseFail: r.parseFail,
            majorityKind: r.majorityKind,
            correct: r.correct,
            majorityCorrect: r.majorityCorrect,
          })),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(formatReport(results, decision, args.model, args.operatorLanguageOff));
  }

  process.exit(decision.pass ? 0 : 1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(
      `[eval-stop-classifier] FAILED: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  });
}
