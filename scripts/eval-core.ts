// Generic live-model eval harness (issue #2156).
//
// The reusable half of the stop-classifier eval (#1626), lifted out so four prompts share one
// runner: the autopilot stop-classifier, the plan-gate reviewer and the PR critic.
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

import { dollars } from "../src/pricing";

// ---------------------------------------------------------------------------
// Anthropic Messages API — the minimal shapes we read
// ---------------------------------------------------------------------------

/**
 * Running spend meter. These runs are paid and have already surprised us once — a sequential
 * first attempt burned ~$10 before anyone could see a number. So every run now counts its own
 * tokens, prices them through the repo's canonical `dollars()` formula, and STOPS at a ceiling.
 */
export interface Spend {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
}

export function emptySpend(): Spend {
  return { calls: 0, input: 0, output: 0, cacheRead: 0 };
}

export function addUsage(spend: Spend, response: AnthropicResponse): void {
  spend.calls++;
  const u = response.usage;
  if (!u) return;
  spend.input += u.input_tokens ?? 0;
  spend.output += u.output_tokens ?? 0;
  spend.cacheRead += u.cache_read_input_tokens ?? 0;
}

/** List-price USD for what a run has consumed so far, via `src/pricing.ts` — the same formula the
 *  usage lens prices real sessions with, so the two can never quietly disagree. */
export function spendUsd(spend: Spend, model: string): number {
  return dollars(
    {
      input: spend.input,
      output: spend.output,
      cacheRead: spend.cacheRead,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    },
    model,
  );
}

export function formatSpend(spend: Spend, model: string): string {
  return (
    `calls=${spend.calls} in=${spend.input.toLocaleString()} out=${spend.output.toLocaleString()} ` +
    `≈ $${spendUsd(spend, model).toFixed(2)}`
  );
}

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
  /** "end_turn" | "tool_use" | "max_tokens" | … — kept for diagnosing a verdict-less trial. */
  stop_reason?: string | null;
  /** Token counts, so a run can report what it actually cost instead of being estimated after
   *  the fact. Absent on a response the API did not price (or in tests). */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
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

/**
 * Operating-mode framing for the evals that declare inspection tools (plan-gate, critic).
 *
 * WHY IT EXISTS: production runs these prompts inside the interactive `claude` CLI, whose own
 * system prompt establishes that the model is an agent acting through tools. A bare Messages call
 * has none of that, and the first live run showed exactly what that costs — the model answered a
 * "review this PR" prompt the way a chat model does, in prose, and never called `Write`: `no-tool`
 * on 55/55 critic trials and 50/55 plan-gate trials, with zero transport errors. This is the
 * documented CLI-wrapper gap (caveat A/C), narrowed.
 *
 * IT DOES TWO THINGS, and the second is a real (small) divergence from production:
 *   1. Establishes tool-driven operation — the CLI's job, reproduced.
 *   2. Discloses that turns are FINITE. Production has no turn cap; the harness does, so the model
 *      is told about the harness's own constraint rather than being allowed to exhaust it silently.
 *      An earlier draft went further and told the model to "inspect only what you need" and to stop
 *      as soon as it could decide — that is an inspection-budget instruction, i.e. guidance about
 *      HOW to review, and it was removed for exactly that reason. What remains states the limit and
 *      the required final action, and nothing about what to look for or how to judge it.
 *
 * It still says nothing about findings, severity, or what any verdict should be. Recorded as
 * caveat F in `docs/eval-harness.md`.
 *
 * The classifier does NOT carry it: it scored 95.1% without one (single-tool, single-write), so
 * adding it would only invalidate a measurement already paid for.
 */
export const AGENT_SYSTEM_PROMPT = [
  "You are an autonomous agent working in a checked-out git worktree, not a chat assistant.",
  "You act ONLY through the provided tools: Bash, Read and Grep to inspect the repository, and",
  "Write to produce files. Do not reply in prose — a reply that is not a tool call accomplishes",
  "nothing and ends your turn. Carry out the task below exactly as written, and finish by writing",
  "the file or files it names.",
  "",
  "Your number of turns is limited, and the harness will tell you when you are on your last one.",
  "Write the file the task names before your turns run out.",
].join("\n");

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
  /** Operating-mode system prompt. Set for the evals whose prompts assume a tool-driven agent
   *  harness; omitted where the eval already obtains verdicts without one. */
  system?: string;
  /**
   * OBSERVATIONAL: run, score and report, but never fail the caller. For an eval whose fixtures
   * have no measured baseline yet — its floor is a guess, so failing a PR against it would gate on
   * a number nobody has observed. Reported loudly in the header so a green result is never mistaken
   * for a passed gate. Flip to `false` in the same commit that pins the floor from a real run.
   */
  observational?: boolean;
  maxTokens: number;
  /** Extra header lines for the human-readable report (run-configuration provenance). */
  headerLines?: (run: RunOptions) => string[];
  /** The label a fixture is EXPECTED to produce, for the report's `exp=` column and the JSON's
   *  `expected` field. Absent for evals whose correctness is a predicate set with no single
   *  expected label. */
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

/** Why a response carried no verdict: its stop reason plus a bounded slice of the prose it
 *  returned instead. */
export function diagnose(response: AnthropicResponse): {
  stopReason?: string | null;
  text?: string;
} {
  const text = (response.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return { stopReason: response.stop_reason ?? null, text: text.slice(0, 300) };
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
  /** Why the last response ended, and the prose it returned instead of a verdict. Both exist to
   *  make a verdict-less trial DIAGNOSABLE from a log — "no-tool" alone cost a full paid run to
   *  interpret once already. */
  stopReason?: string | null;
  text?: string;
}

/** The capture a SINGLE response yields, for a prompt whose verdict arrives in one turn. Used by
 *  the unit tests and by any eval whose loop cannot need a second turn. */
export function captureFrom(response: AnthropicResponse, verdictFile?: string): TrialCapture {
  const verdict = toolUses(response).find((b) => isVerdictWrite(b, verdictFile));
  if (!verdict) return { toolUsed: false, content: null, turns: 1, ...diagnose(response) };
  const content = writeContent(verdict);
  return { toolUsed: content !== null, content, turns: 1 };
}

export function buildRequestBody(
  tools: ToolDef[],
  maxTokens: number,
  model: string,
  temperature: number,
  messages: unknown[],
  system?: string,
): Record<string, unknown> {
  return {
    model,
    max_tokens: maxTokens,
    temperature,
    tools,
    ...(system === undefined ? {} : { system }),
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
  spend?: Spend,
): Promise<TrialCapture> {
  const messages: unknown[] = [{ role: "user", content: prompt }];
  for (let turn = 1; turn <= spec.maxTurns; turn++) {
    const response = await send(
      buildRequestBody(spec.tools, spec.maxTokens, model, temperature, messages, spec.system),
    );
    if (spend) addUsage(spend, response);
    const uses = toolUses(response);
    if (uses.length === 0) {
      return { toolUsed: false, content: null, turns: turn, ...diagnose(response) };
    }

    const verdict = uses.find((b) => isVerdictWrite(b, spec.verdictFile));
    if (verdict) {
      const content = writeContent(verdict);
      // A verdict write whose `content` is not a string is a mechanical miss, not an empty verdict.
      return { toolUsed: content !== null, content, turns: turn };
    }

    // On the LAST turn the model will get, say so. Production has no turn cap — this is a harness
    // artifact, so the harness is the right place to compensate for it. Without the nudge a
    // thorough reviewer explores until the budget runs out and the trial is scored `no-tool`,
    // which is a measurement of the cap, not of the prompt.
    const lastTurn = turn === spec.maxTurns - 1 && spec.verdictFile !== undefined;
    const nudge = lastTurn
      ? `\n\n[harness] This is your FINAL turn. Write \`${spec.verdictFile}\` now, then stop.`
      : "";

    // No verdict yet: answer everything the model asked for and let it continue. A non-verdict
    // WRITE (the critic's `.shepherd-review.md`) is acknowledged as a successful write — the
    // fixture environment never stores it, because nothing scores against it.
    messages.push({ role: "assistant", content: response.content ?? [] });
    messages.push({
      role: "user",
      content: uses.map((block) => ({
        type: "tool_result",
        tool_use_id: block.id ?? "",
        content:
          (isWrite(block)
            ? "File written successfully."
            : (spec.respond?.(fixture, block.name ?? "", inputOf(block)) ?? "(no output)")) + nudge,
      })),
    });
  }
  return { toolUsed: false, content: null, turns: spec.maxTurns, stopReason: "turn-budget" };
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

/** How many trials a fixture gets. A per-fixture `trials` override normally wins — it exists so an
 *  abstain-critical bucket can run thicker. In SMOKE mode `--trials` CAPS it instead: the leg is
 *  bounded by cost, and an override would otherwise run 9 trials against a flag asking for 1. */
export function trialsFor<F extends EvalFixtureBase>(fixture: F, run: RunOptions): number {
  const own = fixture.trials ?? run.trials;
  return run.smoke ? Math.min(own, run.trials) : own;
}

/** SMOKE verdict: did every trial produce a verdict the parser could read? PURE. A fixture with a
 *  `no-tool` or `parse-fail` trial is a MECHANICAL failure — the prompt stopped producing a
 *  well-formed verdict — which is a real regression and blocks, unlike a wrong-but-well-formed one
 *  at a sample size too small to judge. */
export function smokeDecide<F extends EvalFixtureBase>(
  results: FixtureResult<F>[],
): { pass: boolean; malformed: string[] } {
  const malformed = results
    .filter((r) => r.noTool > 0 || r.parseFail > 0)
    .map((r) => `${r.fixture.id}(no-tool:${r.noTool} parse-fail:${r.parseFail})`);
  return { pass: malformed.length === 0, malformed };
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
  if (run.smoke) {
    lines.push(
      "SMOKE — gates on WELL-FORMEDNESS only: every trial must obtain a parseable verdict.",
      "Accuracy below is reported, NOT gated: at this trial count a majority is a coin flip.",
    );
  }
  if (spec.observational === true) {
    lines.push(
      "OBSERVATIONAL — this eval reports but does NOT gate: its floor has never been pinned from a",
      "measured run. Read the numbers; do not read a green result as a passed gate.",
    );
  }
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
    lines.push(
      `gating fixtures below majority: ${decision.failures.join(", ")}` +
        (run.smoke ? "  (reported only — smoke mode gates on well-formedness)" : ""),
    );
    lines.push(
      "→ contingency (see docs/eval-harness.md): revise the fixture, or demote it to " +
        "non-gating baseline and record it as a known gap.",
    );
  }
  lines.push(
    `RESULT: ${decision.pass ? "PASS" : "FAIL"}` +
      (spec.observational === true ? " (observational — not gating)" : ""),
  );
  return lines.join("\n");
}

/** Machine-readable report — the block transcribed into the docs' baseline tables. */
export function jsonReport<F extends EvalFixtureBase>(
  spec: EvalSpec<F>,
  results: FixtureResult<F>[],
  decision: Decision,
  run: RunOptions,
  spendReport?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    model: run.model,
    temperature: run.temperature,
    gatingOnly: run.gatingOnly,
    flags: run.argv,
    spend: spendReport,
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
  /** Hard ceiling on list-price spend, in USD. The run STOPS when the meter crosses it. */
  maxSpend: number;
  /** Trials in flight at once. Trials are independent, and a critic trial is a multi-turn
   *  conversation, so running them one at a time makes a full set take hours — far too slow for a
   *  PR gate. Bounded to stay well inside the API's rate limits. */
  concurrency: number;
  /**
   * SMOKE mode: assert the prompt still produces a WELL-FORMED verdict, and nothing statistical.
   *
   * The per-fixture rule is majority-correct, which needs an odd T > 1 to mean anything. The PR leg
   * runs T=1 to stay cheap, and at one sample "majority" is a coin flip: `gate-commit-now`'s own
   * recorded baseline is `gate:4 finished:1`, so a correctness gate at T=1 would red roughly one
   * run in five on model noise alone. The smoke leg therefore gates on the MECHANICAL fact — every
   * trial obtained a parseable verdict — which is noise-free, and is exactly what broke in every
   * harness failure so far. Accuracy is still computed and reported; it just does not decide.
   */
  smoke: boolean;
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
    concurrency: Math.max(1, num("--concurrency", DEFAULT_CONCURRENCY)),
    maxSpend: Math.max(0, num("--max-spend", DEFAULT_MAX_SPEND_USD)),
    smoke: argv.includes("--smoke"),
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

/** Default hard spend ceiling per run, in list-price USD. Deliberately low: these runs are paid,
 *  a full set costs a couple of dollars, and the first attempt burned ~$10 before anyone could see
 *  a number. Raise it explicitly with `--max-spend` when a bigger run is actually intended. */
const DEFAULT_MAX_SPEND_USD = 5;
/** Default trials in flight. Modest on purpose: enough to turn an hours-long sequential run into
 *  minutes, low enough not to trip API rate limits on a small account. Override: `--concurrency`. */
const DEFAULT_CONCURRENCY = 4;
/**
 * Attempts per trial, and the backoff between them. A transport failure is not a verdict: recorded
 * as a mechanical miss it silently corrupts the measurement the eval exists to produce.
 *
 * Sized from a real failure. One retry at 2s was not enough for a sustained `529 overloaded_error`:
 * ~30 of 52 classifier trials failed twice, were scored as misses, and reported 42.3% for a prompt
 * that had measured 91.8% an hour earlier. A run that cannot execute a third of its trials is not a
 * bad result — it is not a result.
 */
const ATTEMPTS_PER_TRIAL = 3;
const RETRY_BACKOFF_MS = [2_000, 6_000];

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
 * An observational eval REPORTS but never fails the caller. Called at every point that would
 * otherwise return a failing code, so the guarantee is unconditional rather than depending on which
 * internal failure mode happened to fire — the first version of this only covered a scoring miss
 * and let a verdict-less preflight red the PR anyway.
 *
 * Returns null for a gating eval, so the caller falls through to its real exit code.
 */
function observationalPass<F extends EvalFixtureBase>(
  spec: EvalSpec<F>,
  tag: string,
  what: string,
): typeof EXIT.PASS | null {
  if (spec.observational !== true) return null;
  console.error(
    `${tag} the above does NOT fail the gate (${what}) — this eval is observational until its ` +
      `floor is pinned from a measured run.`,
  );
  return EXIT.PASS;
}

/**
 * Exit codes, split so a CALLER can tell the three outcomes apart. The distinction is the whole
 * point: a gate that reds because billing is exhausted says nothing about the prompt, and would
 * block every unrelated PR until someone tops up.
 */
export const EXIT = {
  /** Every gating fixture held. */
  PASS: 0,
  /** The eval RAN and the prompt missed — the real regression signal. */
  GATE_FAIL: 1,
  /** The eval COULD NOT RUN: no key, or an auth/billing/transport failure at the preflight.
   *  Nothing was measured, so there is nothing to gate on. Callers should warn, not fail. */
  CANNOT_RUN: 2,
  /** The HARNESS is broken (no fixtures matched, or the preflight obtained no verdict at all).
   *  Not a prompt result either — but it is our bug, and it must fail loudly. */
  HARNESS_FAIL: 3,
} as const;

/** Does this transport error mean "the account cannot make calls right now"? Those are outages to
 *  wait out, not prompt regressions: an exhausted usage limit, an invalid/expired key, a revoked
 *  permission, or rate limiting that survived the retry. Matched on the API's own error text. */
export function isCannotRun(message: string): boolean {
  return /\b(401|403|429)\b|usage limits?|credit balance|quota|billing|rate.?limit|invalid x-api-key|authentication_error|permission_error/i.test(
    message,
  );
}

/**
 * Run the whole eval. See {@link EXIT} for the exit codes. `send` is injectable so a caller can
 * drive the harness without network; the CLI path builds the real one.
 */
export async function runEval<F extends EvalFixtureBase>(
  spec: EvalSpec<F>,
  argv: string[],
  send?: Send,
): Promise<number> {
  const run = parseArgs(spec, argv);
  const tag = `[eval-${spec.name}]`;
  // Declared out here and printed in the `finally` below: a run that ABORTS still spent money, and
  // the first probe of this harness reported none because every abort returned before the report.
  const spend = emptySpend();
  try {
    return await runEvalInner(spec, run, tag, spend, send);
  } finally {
    console.error(`${tag} spend: ${formatSpend(spend, run.model)}`);
  }
}

async function runEvalInner<F extends EvalFixtureBase>(
  spec: EvalSpec<F>,
  run: RunOptions,
  tag: string,
  spend: Spend,
  send?: Send,
): Promise<number> {
  let transport = send;
  if (!transport) {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
    if (!apiKey) {
      console.error(
        `${tag} no ANTHROPIC_API_KEY — cannot run the live eval. Set the key (or dispatch ` +
          `.github/workflows/eval-prompts.yml) and retry.`,
      );
      return EXIT.CANNOT_RUN;
    }
    transport = anthropicSend(apiKey);
  }

  const fixtures = selectFixtures(spec, run);
  if (fixtures.length === 0) {
    // Deliberately NOT suppressed for an observational eval: this is CLI misuse (a filter that
    // matches nothing), not an outcome of running the eval, and silently answering PASS would hide
    // a typo that ran zero trials.
    console.error(`${tag} no fixtures selected (--filter ${run.filter ?? "—"})`);
    return EXIT.HARNESS_FAIL;
  }

  // One task per trial, flattened across fixtures, so the pool below keeps every worker busy even
  // when fixtures have different trial counts.
  type Task = { fixture: F; index: number; prompt: string; trial: number };
  const tasks: Task[] = [];
  for (const [index, fixture] of fixtures.entries()) {
    const prompt = spec.buildPrompt(fixture, run);
    const n = trialsFor(fixture, run);
    for (let trial = 0; trial < n; trial++) tasks.push({ fixture, index, prompt, trial });
  }

  const outcomes: TrialOutcome[][] = fixtures.map(() => []);
  const attemptTrial = (task: Task): Promise<TrialCapture> =>
    runTrial(transport, spec, task.fixture, task.prompt, run.model, run.temperature, spend);
  const overBudget = (): boolean => spendUsd(spend, run.model) >= run.maxSpend;

  // PREFLIGHT, deliberately alone and before the pool. It guards TWO failures, both of which
  // otherwise cost a whole paid run to discover:
  //   1. a dead key / broken transport;
  //   2. a harness that cannot obtain a verdict at all. The first live run spent ~$10 and an hour
  //      to report `no-tool` on 105/110 plan-gate+critic trials — a mode problem, not a model
  //      result. Two consecutive verdict-less preflights now abort in seconds instead, and say why.
  const first = tasks[0];
  if (first) {
    const captures: TrialCapture[] = [];
    for (let tryNo = 1; tryNo <= 2; tryNo++) {
      try {
        captures.push(await attemptTrial(first));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isCannotRun(msg)) {
          // The account cannot make calls at all (exhausted usage limit, dead key, rate limit that
          // survived the retry). NOTHING was measured, so there is no verdict to gate on — say so
          // and let the caller decide. Failing here would red every PR on a billing state.
          console.error(
            `${tag} CANNOT RUN — the eval never executed, so nothing was measured: ${msg}`,
          );
          return EXIT.CANNOT_RUN;
        }
        console.error(`${tag} first call failed — aborting before spending on the rest: ${msg}`);
        return EXIT.CANNOT_RUN;
      }
      if (captures[captures.length - 1]!.toolUsed) break;
    }
    const preflight = captures[captures.length - 1]!;
    if (!preflight.toolUsed) {
      console.error(
        `${tag} the first ${captures.length} trials produced NO verdict — aborting before spending ` +
          `on the rest. This is a harness/mode failure, not a model result: the prompt names a ` +
          `verdict file the model never wrote.\n` +
          `${tag}   fixture=${first.fixture.id} turns=${preflight.turns} ` +
          `stop_reason=${preflight.stopReason ?? "?"}\n` +
          `${tag}   model said instead: ${preflight.text || "(nothing)"}`,
      );
      // An observational eval cannot fail the caller — INCLUDING here. A verdict-less preflight is
      // exactly the state plan-gate and critic have ended in twice, and it is the eval not working
      // yet rather than a prompt regression; blocking every PR in the repo on an eval we have
      // explicitly marked "not ready" would be the same mistake as gating on an unpinned floor.
      // The diagnosis above is still printed in full, and the workflow still surfaces it.
      return observationalPass(spec, tag, "its harness obtained no verdict") ?? EXIT.HARNESS_FAIL;
    }
    outcomes[first.index]!.push(outcomeFrom(spec, first.fixture, preflight));
  }

  let next = 1;
  // Set when a trial fails twice with an error meaning the account cannot make calls. The pool
  // then stops taking work and the run reports CANNOT_RUN. Without this the SAME billing state
  // that aborts cleanly at the preflight becomes a pile of mechanical misses one trial later, and
  // the run exits GATE_FAIL — reddening a PR on an account condition, which is exactly what the
  // exit-code contract exists to prevent.
  let cannotRun: string | null = null;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (cannotRun !== null || overBudget()) return;
      const task = tasks[next++];
      if (!task) return;
      let capture: TrialCapture | null = null;
      let lastError = "";
      for (let attempt = 1; attempt <= ATTEMPTS_PER_TRIAL && capture === null; attempt++) {
        try {
          capture = await attemptTrial(task);
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          // A permanent condition — exhausted usage limit, dead key, revoked permission — will not
          // recover, so retrying it just burns the backoff once per trial across the whole pool.
          if (isCannotRun(lastError)) break;
          if (attempt < ATTEMPTS_PER_TRIAL) {
            console.error(
              `${tag} ${task.fixture.id} trial ${task.trial + 1} attempt ${attempt} failed ` +
                `(retrying): ${lastError}`,
            );
            await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt - 1] ?? 6_000));
          }
        }
      }
      if (capture === null) {
        // Survived every retry. Whatever the code — 529, 500, a dropped socket, an exhausted usage
        // limit — the trial did not execute, and a run with unexecuted trials cannot be scored.
        // Recording it as a miss is how a green prompt reports 42%.
        cannotRun = lastError;
        return;
      }
      outcomes[task.index]!.push(outcomeFrom(spec, task.fixture, capture));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(run.concurrency, Math.max(tasks.length - 1, 1)) }, worker),
  );

  if (overBudget()) {
    // A deliberate budget stop, not an outage — but the run is INCOMPLETE either way, so its
    // partial results are discarded rather than reported as a measurement.
    console.error(
      `${tag} STOPPED at the spend ceiling — the run is incomplete and its partial results are ` +
        `discarded. ${formatSpend(spend, run.model)} (ceiling $${run.maxSpend.toFixed(2)}). ` +
        `Re-run with --max-spend to raise it deliberately.`,
    );
    return EXIT.CANNOT_RUN;
  }

  if (cannotRun !== null) {
    console.error(
      `${tag} CANNOT RUN — a trial failed ${ATTEMPTS_PER_TRIAL} times, so the run is INCOMPLETE ` +
        `and its partial results are discarded rather than scored as misses: ${cannotRun}`,
    );
    return EXIT.CANNOT_RUN;
  }

  const results: FixtureResult<F>[] = fixtures.map((fixture, i) =>
    aggregate(fixture, outcomes[i]!, spec.labels),
  );

  const decision = decide(results, run.threshold);
  // In smoke mode the RESULT line must reflect what actually gates, or a green run would read as a
  // passed correctness gate.
  const smoke = run.smoke ? smokeDecide(results) : null;
  if (smoke) decision.pass = smoke.pass;
  // `--json` emits BOTH: the human report on stderr, the JSON block on stdout. A caller that wants
  // both (the workflows do — the report for the log, the JSON for the doc's baseline tables) must
  // never have to run the eval twice, which would double a paid run's spend.
  if (run.json) console.error(formatReport(spec, results, decision, run));
  console.log(
    run.json
      ? JSON.stringify(
          jsonReport(spec, results, decision, run, {
            ...spend,
            usd: Number(spendUsd(spend, run.model).toFixed(4)),
          }),
          null,
          2,
        )
      : formatReport(spec, results, decision, run),
  );
  if (smoke) {
    if (smoke.pass) return EXIT.PASS;
    console.error(
      `${tag} SMOKE FAIL — these fixtures produced a malformed or missing verdict: ` +
        `${smoke.malformed.join(", ")}. That is a mechanical failure, not a close call.`,
    );
    return observationalPass(spec, tag, "the eval is unmeasured") ?? EXIT.GATE_FAIL;
  }
  if (decision.pass) return EXIT.PASS;
  // A miss on an unpinned floor is a number to read, not a verdict to block on.
  return observationalPass(spec, tag, "the floor is unpinned") ?? EXIT.GATE_FAIL;
}

/** CLI entry: run and exit. Kept separate from `runEval` so tests never call `process.exit`. */
export async function main<F extends EvalFixtureBase>(spec: EvalSpec<F>): Promise<void> {
  process.exit(await runEval(spec, process.argv.slice(2)));
}
