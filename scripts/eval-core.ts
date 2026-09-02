// Generic live-model eval harness (issue #2156).
//
// The reusable half of the stop-classifier eval (#1626), lifted out so four prompts share one
// runner: the autopilot stop-classifier, the plan-gate reviewer, the PR critic and the rundown.
// See `docs/eval-harness.md` for methodology, baselines, the pinned floors and the CI/cost
// decision; `docs/eval-stop-classifier.md` still owns the classifier's own history.
//
// Three axes are generalized out of the original script:
//   - VERDICT: the enum `AutopilotKind` becomes an opaque `label: string` for reporting plus a
//     per-fixture PREDICATE SET for correctness (`correct` = every predicate holds). The
//     classifier's single `kind === expectedKind` predicate is the degenerate case.
//   - TURNS: a single request becomes a bounded tool loop. `Bash`/`Read`/`Grep` calls are answered
//     from a per-fixture in-memory environment, so a prompt that orders the reviewer to `git diff`
//     and grep the tree (the PR critic) can be evaluated WITHOUT rewriting the prompt and WITHOUT
//     executing any model-authored shell.
//   - TERMINATION: `EvalSpec.verdictFile` names the file whose `Write` ends the run. Any OTHER
//     write is answered with a success `tool_result` and the loop continues — the critic's contract
//     is two writes (`.shepherd-review.md` FIRST, `.shepherd-review.json` LAST as the completion
//     signal), so stopping at the first `Write` would capture prose, not the verdict. Leaving
//     `verdictFile` undefined keeps "first `Write` wins", which is what the classifier does.
//
// Every eval imports its prompt builder and its verdict parser from the REAL production module, so
// drift is prevented by import rather than by vigilance.
//
// The live run is never part of gated CI (paid, keyed, nondeterministic). Everything in this file
// is pure or transport-injected, and is unit-tested with no network and no key in
// `test/eval-core.test.ts`.

// ---------------------------------------------------------------------------
// Anthropic Messages API — the minimal shapes we read
// ---------------------------------------------------------------------------

export interface AnthropicContentBlock {
  type: string;
  /** `tool_use` only: the tool's name. */
  name?: string;
  /** `tool_use` only: the arguments object. */
  input?: unknown;
  /** `tool_use` only: the id a `tool_result` must reference. */
  id?: string;
  text?: string;
}

export interface AnthropicResponse {
  content?: AnthropicContentBlock[];
}

/** The transport. Injected so the whole loop is testable without network access. */
export type Send = (body: Record<string, unknown>) => Promise<AnthropicResponse>;

export interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** The `Write` tool every eval declares. Schema mirrors the real `Write` the `writer-only` preset
 *  allows; we only ever READ `input.content` (the tool is never executed). */
export const WRITE_TOOL: ToolDef = {
  name: "Write",
  description:
    "Write text to a file. Use this to write your verdict to the file the task names, then stop.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "The file to write." },
      content: { type: "string", description: "The full file content." },
    },
    required: ["file_path", "content"],
  },
};

/** The read-only inspection tools a reviewer prompt expects to have (the `reviewer` preset allows
 *  these). Declared only by evals whose prompt orders tree inspection; every call is answered from
 *  the fixture's in-memory environment, never executed. */
export const BASH_TOOL: ToolDef = {
  name: "Bash",
  description: "Run a read-only shell command (e.g. `git diff`, `git log`) and read its output.",
  input_schema: {
    type: "object",
    properties: { command: { type: "string", description: "The command to run." } },
    required: ["command"],
  },
};

export const READ_TOOL: ToolDef = {
  name: "Read",
  description: "Read a file from the repository.",
  input_schema: {
    type: "object",
    properties: { file_path: { type: "string", description: "Repo-relative path to read." } },
    required: ["file_path"],
  },
};

export const GREP_TOOL: ToolDef = {
  name: "Grep",
  description: "Search the repository for a regular expression and list matching lines.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The regular expression to search for." },
      path: { type: "string", description: "Optional path to restrict the search to." },
    },
    required: ["pattern"],
  },
};

export const READONLY_TOOLS: ToolDef[] = [BASH_TOOL, READ_TOOL, GREP_TOOL];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Where a fixture came from (#2156 step 3, "incidents become fixtures"). `synthetic` is an authored
 * case; `incident:#NNNN` records the GitHub issue of a real misfire the fixture was distilled from,
 * so the set's provenance is auditable and a recurring failure class is traceable to the incident
 * that motivated it. See the incident→fixture procedure in `docs/eval-harness.md`.
 */
export type FixtureOrigin = "synthetic" | `incident:#${number}`;

export interface EvalFixtureBase {
  id: string;
  /** true -> counts toward pass/fail; false -> run + reported but excluded (baseline only). */
  gating: boolean;
  /** Per-fixture trial override (else the run's `--trials`). */
  trials?: number;
  origin: FixtureOrigin;
  note: string;
}

/** One trial's separately-tracked facts. `toolUsed`/`parseOk` keep a MECHANICAL failure (no verdict
 *  write / unparseable content) distinguishable from a genuine but wrong verdict — the scorers
 *  collapse both into a label, so without these a transport problem could masquerade as a miss. */
export interface TrialOutcome {
  toolUsed: boolean;
  parseOk: boolean;
  label: string;
  correct: boolean;
}

/** A scorer's reading of one verdict: the display label plus whether the fixture's predicates hold.
 *  `raw` is null when nothing was written or the content did not parse as a JSON object. */
export interface Score {
  label: string;
  correct: boolean;
}

export interface EvalSpec<F extends EvalFixtureBase> {
  /** Short name used in log prefixes and the report header (e.g. "critic"). */
  name: string;
  /** API snapshot id, pinned to the model the prompt actually runs on in production. */
  defaultModel: string;
  defaultTrials: number;
  defaultTemperature: number;
  /** PINNED overall-accuracy floor for the gating set — a literal, never computed at runtime. */
  floor: number;
  fixtures: F[];
  /** Ordered label universe, for stable distribution rendering. */
  labels: string[];
  tools: ToolDef[];
  /** Ends the loop only on a `Write` to this file. Undefined -> the first `Write` ends it. */
  verdictFile?: string;
  /** Maximum model turns per trial. Must admit every write the prompt's contract orders. */
  maxTurns: number;
  maxTokens: number;
  /** Extra header lines for the human-readable report (run-configuration provenance). */
  headerLines?: (run: RunOptions) => string[];
  /** The label a fixture is EXPECTED to produce, for the report's `exp=` column and the JSON's
   *  `expected` field. Absent for evals whose correctness is a predicate set with no single
   *  expected label (the rundown). */
  expectedLabel?: (fixture: F) => string;
  /** Extra per-fixture fields for the JSON report (e.g. the classifier's `lang`). */
  meta?: (fixture: F) => Record<string, unknown>;
  buildPrompt: (fixture: F, run: RunOptions) => string;
  /** Answers a non-verdict tool call from the fixture's environment. Absent -> empty result. */
  respond?: (fixture: F, name: string, input: Record<string, unknown>) => string;
  /** Reads a parsed verdict object (null = nothing written / unparseable) into a score. */
  score: (fixture: F, raw: Record<string, unknown> | null) => Score;
}

// ---------------------------------------------------------------------------
// Pure helpers (no network)
// ---------------------------------------------------------------------------

/** Tolerant JSON parse: strips an optional ```json fence and, failing that, extracts the first
 *  {...} object. Returns null on any parse failure (never repairs — a mechanical failure must stay
 *  visible, not be coerced into a spurious verdict). */
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

/** Every `tool_use` block in a response, in order. */
export function toolUses(response: AnthropicResponse): AnthropicContentBlock[] {
  return (response.content ?? []).filter((b) => b.type === "tool_use");
}

function inputOf(block: AnthropicContentBlock): Record<string, unknown> {
  return typeof block.input === "object" && block.input !== null
    ? (block.input as Record<string, unknown>)
    : {};
}

function isWrite(block: AnthropicContentBlock): boolean {
  return (block.name ?? "").toLowerCase() === "write";
}

/**
 * Does this `Write` carry the verdict? With no `verdictFile` the first write wins (the classifier's
 * behavior). With one, only a write whose `file_path` names it terminates — compared on the
 * trailing path segment, since the prompt names a bare filename but a model may write an absolute
 * or `./`-prefixed path.
 */
export function isVerdictWrite(block: AnthropicContentBlock, verdictFile?: string): boolean {
  if (!isWrite(block)) return false;
  if (verdictFile === undefined) return true;
  const filePath = inputOf(block).file_path;
  if (typeof filePath !== "string") return false;
  return filePath.split("/").pop() === verdictFile;
}

/** The string the model passed as the file CONTENT (not the `{file_path, content}` wrapper). */
export function writeContent(block: AnthropicContentBlock): string | null {
  const content = inputOf(block).content;
  return typeof content === "string" ? content : null;
}

/** Parse a captured verdict string into the object the scorers read. Null when absent or when the
 *  content is not a JSON OBJECT (a bare array/number is a mechanical failure, not a verdict). */
export function parseVerdict(content: string | null): Record<string, unknown> | null {
  if (content === null) return null;
  const parsed = tolerantParse(content);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The bounded tool loop
// ---------------------------------------------------------------------------

/** What a trial's conversation produced, before scoring. */
export interface TrialCapture {
  /** True iff a write to the verdict file was captured with a string `content`. */
  toolUsed: boolean;
  content: string | null;
  /** Model turns actually spent (for diagnosing budget exhaustion). */
  turns: number;
}

/** The capture a SINGLE response yields, for a prompt whose verdict arrives in one turn. Used by
 *  the unit tests and by any eval whose loop cannot need a second turn. */
export function captureFrom(response: AnthropicResponse, verdictFile?: string): TrialCapture {
  const verdict = toolUses(response).find((b) => isVerdictWrite(b, verdictFile));
  if (!verdict) return { toolUsed: false, content: null, turns: 1 };
  const content = writeContent(verdict);
  return { toolUsed: content !== null, content, turns: 1 };
}

export function buildRequestBody(
  tools: ToolDef[],
  maxTokens: number,
  model: string,
  temperature: number,
  messages: unknown[],
): Record<string, unknown> {
  return {
    model,
    max_tokens: maxTokens,
    temperature,
    tools,
    // `tool_choice` omitted -> API default `auto`, mirroring production's `dontAsk`, which denies
    // off-allowlist tools rather than compelling a call.
    messages,
  };
}

/**
 * Run one trial: send the prompt, answer every non-verdict tool call from the fixture's
 * environment, and stop at the verdict write or the turn budget.
 *
 * Budget exhaustion yields `toolUsed: false` — the same MECHANICAL-miss signal a model that never
 * called the tool produces, which is what it is: no verdict was obtained.
 */
export async function runTrial<F extends EvalFixtureBase>(
  send: Send,
  spec: EvalSpec<F>,
  fixture: F,
  prompt: string,
  model: string,
  temperature: number,
): Promise<TrialCapture> {
  const messages: unknown[] = [{ role: "user", content: prompt }];
  for (let turn = 1; turn <= spec.maxTurns; turn++) {
    const response = await send(
      buildRequestBody(spec.tools, spec.maxTokens, model, temperature, messages),
    );
    const uses = toolUses(response);
    if (uses.length === 0) return { toolUsed: false, content: null, turns: turn };

    const verdict = uses.find((b) => isVerdictWrite(b, spec.verdictFile));
    if (verdict) {
      const content = writeContent(verdict);
      // A verdict write whose `content` is not a string is a mechanical miss, not an empty verdict.
      return { toolUsed: content !== null, content, turns: turn };
    }

    // No verdict yet: answer everything the model asked for and let it continue. A non-verdict
    // WRITE (the critic's `.shepherd-review.md`) is acknowledged as a successful write — the
    // fixture environment never stores it, because nothing scores against it.
    messages.push({ role: "assistant", content: response.content ?? [] });
    messages.push({
      role: "user",
      content: uses.map((block) => ({
        type: "tool_result",
        tool_use_id: block.id ?? "",
        content: isWrite(block)
          ? "File written successfully."
          : (spec.respond?.(fixture, block.name ?? "", inputOf(block)) ?? ""),
      })),
    });
  }
  return { toolUsed: false, content: null, turns: spec.maxTurns };
}

/** Turn one trial's capture into a scored outcome. */
export function outcomeFrom<F extends EvalFixtureBase>(
  spec: EvalSpec<F>,
  fixture: F,
  capture: TrialCapture,
): TrialOutcome {
  const raw = capture.toolUsed ? parseVerdict(capture.content) : null;
  const { label, correct } = spec.score(fixture, raw);
  return { toolUsed: capture.toolUsed, parseOk: raw !== null, label, correct };
}

// ---------------------------------------------------------------------------
// Aggregation + decision (pure)
// ---------------------------------------------------------------------------

export interface FixtureResult<F extends EvalFixtureBase> {
  fixture: F;
  trials: number;
  outcomes: TrialOutcome[];
  counts: Record<string, number>;
  noTool: number;
  parseFail: number;
  majorityLabel: string | null;
  correct: number;
  majorityCorrect: boolean;
}

/** The label with strictly more than half the trials, else null (no majority). */
export function majority(counts: Record<string, number>, trials: number): string | null {
  for (const [label, n] of Object.entries(counts)) {
    if (n > trials / 2) return label;
  }
  return null;
}

/** Aggregate a fixture's trial outcomes into distributions + majority + correctness. PURE. */
export function aggregate<F extends EvalFixtureBase>(
  fixture: F,
  outcomes: TrialOutcome[],
  labels: string[],
): FixtureResult<F> {
  const counts: Record<string, number> = Object.fromEntries(labels.map((l) => [l, 0]));
  let noTool = 0;
  let parseFail = 0;
  let correct = 0;
  for (const o of outcomes) {
    // An unknown label still counts — a scorer that emits an unlisted label must not vanish from
    // the distribution.
    counts[o.label] = (counts[o.label] ?? 0) + 1;
    if (!o.toolUsed) noTool++;
    else if (!o.parseOk) parseFail++;
    if (o.correct) correct++;
  }
  const trials = outcomes.length;
  return {
    fixture,
    trials,
    outcomes,
    counts,
    noTool,
    parseFail,
    majorityLabel: majority(counts, trials),
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
export function decide<F extends EvalFixtureBase>(
  results: FixtureResult<F>[],
  floor: number,
): Decision {
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

function distStr(counts: Record<string, number>): string {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${label}:${n}`)
    .join(" ");
}

/** Human-readable report: per-fixture label distribution + no-tool/parse-fail + the verdict. */
export function formatReport<F extends EvalFixtureBase>(
  spec: EvalSpec<F>,
  results: FixtureResult<F>[],
  decision: Decision,
  run: RunOptions,
): string {
  const lines: string[] = [];
  lines.push(`${spec.name} eval — model=${run.model}`);
  lines.push(...(spec.headerLines?.(run) ?? []));
  lines.push(
    `fixtures=${results.length} (gating=${results.filter((r) => r.fixture.gating).length}, ` +
      `baseline=${results.filter((r) => !r.fixture.gating).length}); ` +
      `calls=${results.reduce((n, r) => n + r.trials, 0)}`,
  );
  lines.push(
    "Bounded coverage: samples T trials per curated fixture — NOT exhaustive over real inputs.",
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
      const expected = spec.expectedLabel?.(r.fixture);
      lines.push(
        `  [${seg ? mark : "····"}] ${r.fixture.id.padEnd(24)} ` +
          (expected === undefined ? "" : `exp=${expected.padEnd(18)} `) +
          `maj=${(r.majorityLabel ?? "—").padEnd(18)} ${r.correct}/${r.trials}  {${distStr(r.counts)}}` +
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
      "→ contingency (see docs/eval-harness.md): revise the fixture, or demote it to " +
        "non-gating baseline and record it as a known gap.",
    );
  }
  lines.push(`RESULT: ${decision.pass ? "PASS" : "FAIL"}`);
  return lines.join("\n");
}

/** Machine-readable report — the block transcribed into the docs' baseline tables. */
export function jsonReport<F extends EvalFixtureBase>(
  spec: EvalSpec<F>,
  results: FixtureResult<F>[],
  decision: Decision,
  run: RunOptions,
): Record<string, unknown> {
  return {
    model: run.model,
    temperature: run.temperature,
    gatingOnly: run.gatingOnly,
    flags: run.argv,
    decision,
    results: results.map((r) => ({
      id: r.fixture.id,
      expected: spec.expectedLabel?.(r.fixture),
      gating: r.fixture.gating,
      ...(spec.meta?.(r.fixture) ?? {}),
      origin: r.fixture.origin,
      trials: r.trials,
      counts: r.counts,
      noTool: r.noTool,
      parseFail: r.parseFail,
      majorityLabel: r.majorityLabel,
      correct: r.correct,
      majorityCorrect: r.majorityCorrect,
    })),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface RunOptions {
  model: string;
  temperature: number;
  trials: number;
  threshold: number;
  filter?: string;
  json: boolean;
  /** Run only the gating fixtures — what the PR gate uses; the schedule runs the full set. */
  gatingOnly: boolean;
  /** The raw flags, so an eval can read its own switches without re-parsing argv. */
  argv: string[];
}

export function parseArgs<F extends EvalFixtureBase>(
  spec: EvalSpec<F>,
  argv: string[],
): RunOptions {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    const value = i !== -1 ? argv[i + 1] : undefined;
    // An empty value falls back to the default: a CI expression that interpolates an absent
    // workflow input yields `--trials ""`, and `Number("")` is 0 — which would silently run zero
    // trials and report a vacuous 0% accuracy rather than failing loudly.
    return value === undefined || value.trim() === "" ? undefined : value;
  };
  const num = (flag: string, fallback: number): number => {
    const parsed = Number(get(flag) ?? fallback);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    model: get("--model") ?? spec.defaultModel,
    temperature: num("--temperature", spec.defaultTemperature),
    trials: num("--trials", spec.defaultTrials),
    threshold: num("--threshold", spec.floor),
    filter: get("--filter"),
    json: argv.includes("--json"),
    gatingOnly: argv.includes("--gating-only"),
    argv,
  };
}

/** Fixtures this run will execute: `--filter` by id substring, `--gating-only` drops baselines. */
export function selectFixtures<F extends EvalFixtureBase>(spec: EvalSpec<F>, run: RunOptions): F[] {
  let fixtures = spec.fixtures;
  if (run.gatingOnly) fixtures = fixtures.filter((f) => f.gating);
  if (run.filter) fixtures = fixtures.filter((f) => f.id.includes(run.filter as string));
  return fixtures;
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** The live transport. Not exercised by the unit tests — they inject their own `Send`. */
export function anthropicSend(apiKey: string): Send {
  return async (body) => {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    return (await res.json()) as AnthropicResponse;
  };
}

/**
 * Run the whole eval and exit with 0 (pass) / 1 (gating miss) / 2 (could not run). `send` is
 * injectable so a caller can drive the harness without network; the CLI path builds the real one.
 */
export async function runEval<F extends EvalFixtureBase>(
  spec: EvalSpec<F>,
  argv: string[],
  send?: Send,
): Promise<number> {
  const run = parseArgs(spec, argv);
  const tag = `[eval-${spec.name}]`;

  let transport = send;
  if (!transport) {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
    if (!apiKey) {
      console.error(
        `${tag} no ANTHROPIC_API_KEY — cannot run the live eval. Set the key (or dispatch ` +
          `.github/workflows/eval-prompts.yml) and retry.`,
      );
      return 2;
    }
    transport = anthropicSend(apiKey);
  }

  const fixtures = selectFixtures(spec, run);
  if (fixtures.length === 0) {
    console.error(`${tag} no fixtures selected (--filter ${run.filter ?? "—"})`);
    return 2;
  }

  const results: FixtureResult<F>[] = [];
  let firstCall = true;
  for (const fixture of fixtures) {
    const n = fixture.trials ?? run.trials;
    const prompt = spec.buildPrompt(fixture, run);
    const outcomes: TrialOutcome[] = [];
    for (let t = 0; t < n; t++) {
      try {
        const capture = await runTrial(
          transport,
          spec,
          fixture,
          prompt,
          run.model,
          run.temperature,
        );
        firstCall = false;
        outcomes.push(outcomeFrom(spec, fixture, capture));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (firstCall) {
          // Preflight: a dead key / transport failure on the very first call aborts immediately
          // rather than burning the rest of the run's spend.
          console.error(`${tag} first call failed — aborting before spending on the rest: ${msg}`);
          return 2;
        }
        // A later transient failure: record a mechanical no-tool miss and continue.
        console.error(`${tag} ${fixture.id} trial ${t + 1} error: ${msg}`);
        outcomes.push(outcomeFrom(spec, fixture, { toolUsed: false, content: null, turns: 0 }));
      }
    }
    results.push(aggregate(fixture, outcomes, spec.labels));
  }

  const decision = decide(results, run.threshold);
  // `--json` emits BOTH: the human report on stderr, the JSON block on stdout. A caller that wants
  // both (the workflows do — the report for the log, the JSON for the doc's baseline tables) must
  // never have to run the eval twice, which would double a paid run's spend.
  if (run.json) console.error(formatReport(spec, results, decision, run));
  console.log(
    run.json
      ? JSON.stringify(jsonReport(spec, results, decision, run), null, 2)
      : formatReport(spec, results, decision, run),
  );
  return decision.pass ? 0 : 1;
}

/** CLI entry: run and exit. Kept separate from `runEval` so tests never call `process.exit`. */
export async function main<F extends EvalFixtureBase>(spec: EvalSpec<F>): Promise<void> {
  process.exit(await runEval(spec, process.argv.slice(2)));
}
