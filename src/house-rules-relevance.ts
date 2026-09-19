/**
 * Relevance-gating the house-rules block with the decision-model seam (issue #2376).
 *
 * WHAT THIS REPLACES, AND WHAT IT DOES NOT. `planHouseRulesInjection` already gates injection on
 * the session's target paths (#842) — a rule with globs that no target path matches is never
 * injected and never charged to the budget. That gate is real, and this does not remove it. What it
 * cannot do is three things: it only covers rules that CARRY globs (`scopeGlobs.length === 0` is an
 * Always-rule, injected unconditionally — ungated by construction); the globs are hand-authored, so
 * a rule nobody scoped IS an Always-rule; and a path glob answers "does this rule touch a file this
 * session touches", which is a good proxy for, and not the same question as, "is this rule about
 * what the operator just asked for". This module asks that question directly, of the SAME candidate
 * set {@link candidateRules} produces — so it can only SUBTRACT. A scope-gated rule stays gated; the
 * judge never resurrects one, and the two gates therefore cannot disagree about a rule.
 *
 * ONE CALL PER SPAWN, NOT PER PROMPT. The mechanism this is modelled on (`jev-rules`) is a Claude
 * Code hook that fires on every user prompt, and pays for a per-session delivery fingerprint so a
 * rule is not re-sent or re-judged. Shepherd has no per-prompt hook: house rules are injected ONCE,
 * into the system prompt, at spawn (`service.ts` → `recordInjectedHouseRules`). So there is one
 * delivery per session by construction, nothing to dedupe, and the whole feature costs one request
 * per spawn.
 *
 * LEAF MODULE, deliberately: types-only imports plus `./house-rules` (itself env-only), no store, no
 * config, no filesystem, and all I/O injected through {@link RelevanceDeps}. Importing it must stay
 * free so the unit tests can drive every branch against a stub {@link Judge} with no network.
 */

import type { Judge, JudgeNoulQuestion } from "./judge";
import type { JudgeSpendLedger } from "./judge-spend";
import type { Learning } from "./types";
import { envNum } from "./house-rules";

/**
 * A candidate is dropped only when the judge is CONFIDENT it is irrelevant — `p` below this.
 *
 * Asymmetric on purpose, and the asymmetry is what makes an uncalibrated default safe: everything
 * the judge is unsure about keeps today's behaviour, so the gate can only act where it has a strong
 * opinion. 0.35 is a starting point to be calibrated from shadow-mode data, not a measured value —
 * every verdict's raw `p` is persisted precisely so the threshold can be swept offline afterwards.
 *
 * CLAMPED TO [0,1], and the clamp is load-bearing rather than defensive. `envNum` only rejects
 * non-finite values, and the bounds declared in `.env.schema` are documentation — nothing reads that
 * file at runtime. So a percent-for-probability typo (`=35`) would put the threshold above every
 * possible `p`, judge out EVERY candidate, and in `enforce` leave `injected` empty —
 * `renderHouseRulesBlock` then returns null and the entire house-rules block vanishes from the
 * system prompt, silently, which is exactly the outcome this module promises cannot happen. It
 * would also skew {@link SessionStore.learningRelevanceStats}, which re-derives `relevant` from
 * this same constant. Clamped inline rather than via `config.ts`'s `clampFraction`: this is a leaf
 * (`store.ts` imports it) and `./config` reads the forge map off disk at import time.
 */
export const RELEVANCE_DROP_BELOW = Math.min(
  1,
  Math.max(0, envNum("SHEPHERD_LEARNINGS_RELEVANCE_DROP_BELOW", 0.35)),
);

/**
 * How many candidates one call may ask about.
 *
 * Every rule is its own parallel `noul` against one shared state, so the call count does not grow
 * with the rule count — but the PAYLOAD does, and an unbounded payload on a path that runs at every
 * spawn is how a cheap call becomes an expensive one. Overflow is KEPT, unjudged (see
 * {@link judgeHouseRuleRelevance}): the cap costs the feature its effect on a large corpus, never a
 * rule that would otherwise have been injected.
 */
export const MAX_JUDGED_RULES = Math.max(
  1,
  Math.floor(envNum("SHEPHERD_LEARNINGS_RELEVANCE_MAX", 32)),
);

/** How the operator has armed the gate. `shadow` asks and records but does not act — the disabled
 *  state still produces the data that justifies enabling it. */
export type HouseRuleRelevanceMode = "off" | "shadow" | "enforce";

export function isRelevanceMode(v: unknown): v is HouseRuleRelevanceMode {
  return v === "off" || v === "shadow" || v === "enforce";
}

/** Env-seed reader: anything unrecognised (including a case variant) reads as `off` rather than
 *  arming a mode nobody asked for. Same forgiving contract as the other `normalize*Setting`
 *  helpers; the PUT handler uses {@link isRelevanceMode} instead, because an operator typing a
 *  wrong value into the API deserves a 400, not a silent default. */
export function normalizeRelevanceMode(raw: string | undefined): HouseRuleRelevanceMode {
  const v = raw?.trim();
  return isRelevanceMode(v) ? v : "off";
}

/** What the session knows about the task, in the order the state blob presents it. */
export interface RelevanceContext {
  prompt: string;
  issueTitle?: string;
  issueBody?: string;
  /** The session's target paths, as `extractTargetPaths` already derived them for the glob gate. */
  targetPaths: string[];
}

/** One rule's verdict. `p` is the raw probability, kept unrounded so a later threshold sweep sees
 *  what the model actually said. */
export interface RelevanceVerdict {
  learningId: string;
  p: number;
  relevant: boolean;
}

export interface RelevanceOutcome {
  verdicts: RelevanceVerdict[];
  /** Ids to gate out — empty in `shadow`, so one field drives the planner in every mode. */
  judgedOutIds: ReadonlySet<string>;
  costUsd: number;
}

export interface RelevanceDeps {
  /** Read per call, not captured: the Settings toggle must take effect on the next spawn. Null
   *  whenever the judge is unarmed, which is the default. */
  judge: Judge | null;
  /** Shared with the stop classifier — one armed capability, one daily ceiling. */
  spend?: Pick<JudgeSpendLedger, "allow" | "record"> | null;
  mode: HouseRuleRelevanceMode;
  warn?: (message: string, err?: unknown) => void;
}

/** Question keys go over the wire as `r0, r1, …` and are mapped back by position. Rule ids are
 *  UUIDs — legal keys today — but they are also data the operator can influence through the store,
 *  and a positional key cannot leak one or collide with the wire format's own naming. */
function questionKey(index: number): string {
  return `r${index}`;
}

/**
 * The state blob, as text.
 *
 * FIELD ORDER IS A TUNABLE, not cosmetics: the vendor's own reports and `pi-heed`'s bench both find
 * the model anchoring on what it reads first. The operator's request leads, the attached issue
 * follows, and the files the session is expected to touch come last — the path signal is a
 * tie-breaker for a vague request, not the primary question. Each part is clipped so one enormous
 * issue body cannot crowd out the request itself.
 */
export function relevanceState(ctx: RelevanceContext): string {
  const parts = [
    `The operator asked a coding agent to do this, in this repository:\n${ctx.prompt.slice(0, 2000)}`,
  ];
  const title = ctx.issueTitle?.trim();
  if (title) parts.push(`The task is attached to this issue: ${title.slice(0, 300)}`);
  const body = ctx.issueBody?.trim();
  if (body) parts.push(`The issue says:\n${body.slice(0, 1500)}`);
  if (ctx.targetPaths.length > 0) {
    parts.push(
      `Files named in that request, which the session is likely to touch:\n${ctx.targetPaths
        .slice(0, 40)
        .join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

/**
 * One rule's question.
 *
 * The rule line IS the description. `jev-rules` reads a one-sentence frontmatter `description`;
 * Shepherd has no such field, but `LEARNING_FACT_SHAPE` (`learning-shape.ts`) already requires every
 * stored rule to be one self-contained line naming the artifact it applies to — the same thing
 * under a different name, capped at 240 chars.
 *
 * `criteria.false` is load-bearing rather than symmetry. The vendor's documented first failure mode
 * is literal reading: asked "is the request about X", a model will happily answer about the words in
 * X. The false branch says what the question is NOT — a rule is not irrelevant merely because the
 * operator did not mention it, and "about" includes the work the request implies.
 */
export function relevanceQuestion(rule: Learning): JudgeNoulQuestion {
  return {
    type: "noul",
    instructions: `The work the operator just asked for is about, or will require touching, what this repository rule describes: ${rule.rule}`,
    criteria: {
      true:
        "The rule concerns the same code, files, tooling, workflow or subject matter that this " +
        "request involves — including work the request clearly implies but does not spell out. " +
        "A rule the agent would need to know before finishing this task is relevant.",
      false:
        "The rule is about a different part of this repository than the request concerns. Judge " +
        "the SUBJECT, not the wording: the operator not having mentioned the rule is not itself a " +
        "reason to answer no, and neither is the rule being general, obvious or already followed.",
    },
  };
}

/** Interpret one call's answers. An answer that is missing, the wrong shape, or carries a `p`
 *  outside [0,1] is treated as RELEVANT — the whole module can only subtract, so a defective
 *  answer must cost nothing. */
export function interpretRelevance(
  rules: Learning[],
  answers: Record<string, { type: string; p?: number } | undefined>,
  dropBelow: number = RELEVANCE_DROP_BELOW,
): RelevanceVerdict[] {
  return rules.map((rule, i) => {
    const answer = answers[questionKey(i)];
    const p = answer?.type === "noul" ? answer.p : undefined;
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
      return { learningId: rule.id, p: 1, relevant: true };
    }
    return { learningId: rule.id, p, relevant: p >= dropBelow };
  });
}

/** Every failure lands here: no verdicts, nothing gated, nothing billed — i.e. today's injection. */
const FAIL_OPEN: RelevanceOutcome = {
  verdicts: [],
  judgedOutIds: new Set<string>(),
  costUsd: 0,
};

/**
 * Ask the judge which of `candidates` this session's request is about.
 *
 * FAIL-OPEN EVERYWHERE. Unarmed judge, `off`, no candidates, a refused ceiling, a transport error, a
 * deadline abort, a locked database inside the ledger read — every one of them returns
 * {@link FAIL_OPEN}, and the caller then plans exactly the injection it would have planned before
 * this existed. There is no path on which arming this costs a rule.
 *
 * `candidates` beyond {@link MAX_JUDGED_RULES} are not judged and not returned as verdicts, so they
 * inject on the pre-#2376 rules. Pass them in priority order and the cap falls on the rules least
 * likely to have been injected anyway.
 */
export async function judgeHouseRuleRelevance(
  candidates: Learning[],
  ctx: RelevanceContext,
  deps: RelevanceDeps,
): Promise<RelevanceOutcome> {
  const warn = deps.warn ?? ((message: string, err?: unknown) => console.warn(message, err));
  if (deps.mode === "off" || !deps.judge || candidates.length === 0) return FAIL_OPEN;

  const judged = candidates.slice(0, MAX_JUDGED_RULES);
  try {
    // Inside the try: `allow` reads the DB, and a locked database must degrade to today's injection
    // like every other failure rather than escape to the spawn path.
    if (deps.spend && !deps.spend.allow()) return FAIL_OPEN;

    const questions: Record<string, JudgeNoulQuestion> = {};
    judged.forEach((rule, i) => {
      questions[questionKey(i)] = relevanceQuestion(rule);
    });

    const result = await deps.judge.ask(relevanceState(ctx), questions);

    // Booked before the answers are inspected: an unusable answer was still billed, and a ceiling
    // that only counts answers it liked is not a ceiling. Best-effort — a ledger write must not
    // lose a verdict already paid for.
    try {
      deps.spend?.record(result.costUsd);
    } catch (err) {
      warn("[house-rules] relevance spend record failed:", err);
    }

    const verdicts = interpretRelevance(
      judged,
      result.answers as Record<string, { type: string; p?: number } | undefined>,
    );
    const judgedOutIds =
      deps.mode === "enforce"
        ? new Set(verdicts.filter((v) => !v.relevant).map((v) => v.learningId))
        : new Set<string>();
    return { verdicts, judgedOutIds, costUsd: result.costUsd };
  } catch (err) {
    warn("[house-rules] relevance judge failed (injecting the unfiltered set):", err);
    return FAIL_OPEN;
  }
}
