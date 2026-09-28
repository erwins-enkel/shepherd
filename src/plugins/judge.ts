// `ctx.judge` (#2541): the decision-model seam for plugins. Armed only while the operator has the
// judge on; every call rides the shared daily spend ceiling. Untrusted text is fenced by core, and
// the instruction-hierarchy directive is stated once per state.

import type { Judge } from "../judge";
import type { JudgeSpendLedger } from "../judge-spend";
import { UNTRUSTED_CONTENT_DIRECTIVE, fenceUntrusted } from "../untrusted";
import {
  PluginJudgeError,
  type PluginJudge,
  type PluginJudgeChoiceOptions,
  type PluginUntrustedSection,
} from "./types";

/** Core seams backing `ctx.judge`. Both are read per call so the Settings toggle is live. */
export interface PluginJudgeDeps {
  judge: () => Judge | null;
  spend: () => Pick<JudgeSpendLedger, "allow" | "record"> | null;
  warn?: (message: string, err?: unknown) => void;
}

const MAX_INSTRUCTIONS = 4_000;
const MAX_OPTIONS = 8;
const MAX_UNTRUSTED_ITEMS = 20;
const MAX_TOTAL_CHARS = 32_000;

function invalid(message: string): never {
  throw new PluginJudgeError("invalid-args", message);
}

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

function checkUntrusted(u: unknown): PluginUntrustedSection[] {
  if (u === undefined) return [];
  if (!Array.isArray(u) || u.length > MAX_UNTRUSTED_ITEMS) {
    invalid(`untrusted must be an array of at most ${MAX_UNTRUSTED_ITEMS} items`);
  }
  for (const s of u as unknown[]) {
    const it = s as Partial<PluginUntrustedSection> | null;
    if (!it || !isStr(it.label) || !isStr(it.content)) {
      invalid("each untrusted item needs a string label and content");
    }
  }
  return u as PluginUntrustedSection[];
}

/** Validate a plugin's options; returns the checked parts. */
function checkOptions(o: PluginJudgeChoiceOptions) {
  if (!o || !isStr(o.instructions) || !o.instructions.trim()) invalid("instructions required");
  if (o.instructions.length > MAX_INSTRUCTIONS) invalid(`instructions exceed ${MAX_INSTRUCTIONS}`);
  const entries = o.options && typeof o.options === "object" ? Object.entries(o.options) : [];
  if (entries.length < 2 || entries.length > MAX_OPTIONS) {
    invalid(`options must have 2..${MAX_OPTIONS} entries`);
  }
  if (!entries.every(([k, v]) => k.trim() && isStr(v)))
    invalid("option descriptions must be strings");
  if (o.context !== undefined && !isStr(o.context)) invalid("context must be a string");
  const untrusted = checkUntrusted(o.untrusted);
  const total =
    o.instructions.length +
    (o.context?.length ?? 0) +
    untrusted.reduce((n, s) => n + s.label.length + s.content.length, 0);
  if (total > MAX_TOTAL_CHARS) invalid(`text exceeds ${MAX_TOTAL_CHARS} chars`);
  return { criteria: Object.fromEntries(entries), untrusted };
}

/** The judge state: trusted context, then each untrusted item fenced, directive once. */
export function pluginJudgeState(context: string, untrusted: PluginUntrustedSection[]): string {
  const parts: string[] = [];
  if (untrusted.length) parts.push(UNTRUSTED_CONTENT_DIRECTIVE, "");
  if (context.trim()) parts.push(context);
  for (const u of untrusted) parts.push(fenceUntrusted(u.label, u.content));
  return parts.join("\n");
}

/** Build the `ctx.judge` surface for one plugin. */
export function makePluginJudge(deps: PluginJudgeDeps | undefined): PluginJudge {
  return {
    async choice(o) {
      const { criteria, untrusted } = checkOptions(o);
      const judge = deps?.judge() ?? null;
      if (!judge) throw new PluginJudgeError("unavailable", "the judge is not armed");
      const spend = deps?.spend() ?? null;
      if (spend && !spend.allow()) {
        throw new PluginJudgeError("ceiling", "the judge's daily spend ceiling is reached");
      }
      let result;
      try {
        result = await judge.ask(pluginJudgeState(o.context ?? "", untrusted), {
          answer: { type: "choice", instructions: o.instructions, criteria },
        });
      } catch (err) {
        throw new PluginJudgeError("error", (err as Error)?.message ?? String(err));
      }
      try {
        spend?.record(result.costUsd);
      } catch (err) {
        deps?.warn?.("[plugins] judge spend record failed:", err);
      }
      const a = result.answers.answer;
      if (a?.type !== "choice") throw new PluginJudgeError("error", "judge returned no choice");
      return { choice: a.choice, probabilities: { ...a.probabilities } };
    },
  };
}
