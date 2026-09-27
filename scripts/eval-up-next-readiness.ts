// Live eval for the Up Next readiness rerank (#2535) — the go/no-go gate for building it.
//
// Scores fixtures (from `gen-up-next-readiness-fixtures.ts`) with a question VARIANT
// (`eval-up-next-readiness-variants.ts`; v4 = production) and the production state
// (`src/up-next-readiness-core.ts`) over the production transport (`src/judge-typesafe.ts`). Every
// `p` is cached back into the fixture file per (model, variant), so re-reports cost nothing. Then
// compares banded-JEV ordering against today's order inside simulated Up Next groups.
//
// Anti-overfit protocol: compare variants with `--split dev`; run the chosen one ONCE with
// `--split holdout`; the GO bar is read off `--split all`.
//
// Report RELATIVELY (lift ratios, AUROC) — never publish absolute vendor benchmark numbers.
//
// Usage: JEV_API_KEY=… bun run eval:up-next-readiness
//          [--variant v4|all] [--split dev|holdout|all] [--fixtures path] [--model id]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createTypeSafeJudge, judgeCostUsd } from "../src/judge-typesafe";
import type { Judge } from "../src/judge";
import {
  NOT_READY_BELOW,
  READY_AT,
  interpretReadiness,
  readinessState,
} from "../src/up-next-readiness-core";
import {
  DEFAULT_SIM,
  GO_MIN_AUROC,
  GO_MIN_LIFT,
  decide,
  readinessAuroc,
  scoreKey,
  simulate,
  splitOf,
  thresholdSweep,
  withScores,
  type ReadinessFixture,
  type SimResult,
} from "./eval-up-next-readiness-core";
import { VARIANTS, type ReadinessVariant } from "./eval-up-next-readiness-variants";
import { DEFAULT_FIXTURE_PATH } from "./gen-up-next-readiness-fixtures";

const DEFAULT_MODEL = "jev-1.13.0";
const CONCURRENCY = 4;
/** The variant `src/up-next-readiness-core.ts` ships. */
const PRODUCTION_VARIANT = "v4";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fmt(r: SimResult): string {
  return `lift ${r.lift === null ? "n/a" : `${r.lift.toFixed(2)}×`} over ${r.groups} groups`;
}

function makeJudge(model: string): Judge {
  const apiKey = process.env.JEV_API_KEY?.trim();
  if (!apiKey) throw new Error("no JEV_API_KEY — set it (~/.shepherd/eval.env) and retry");
  return createTypeSafeJudge({
    apiKey,
    baseUrl: process.env.SHEPHERD_JUDGE_BASE_URL?.trim() || "https://api.typesafe.ai",
    model,
    deadlineMs: 60_000,
  });
}

/** Mean of the variant's nouls; null when any answer is unusable. */
function variantScore(answers: Record<string, unknown>, v: ReadinessVariant): number | null {
  const ps = Object.keys(v.questions).map((k) =>
    interpretReadiness(answers[k] as { type?: string; p?: unknown } | undefined),
  );
  if (ps.some((p) => p === null)) return null;
  return (ps as number[]).reduce((a, b) => a + b, 0) / ps.length;
}

async function scoreVariant(
  fixtures: ReadinessFixture[],
  model: string,
  name: string,
): Promise<number> {
  const key = scoreKey(model, name);
  const todo = fixtures.filter((f) => !f.scores || !(key in f.scores));
  if (todo.length === 0) return 0;
  const judge = makeJudge(model);
  const v = VARIANTS[name]!;
  let inputTokens = 0;
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const f = todo[next++]!;
      try {
        const res = await judge.ask(readinessState(f), v.questions);
        inputTokens += res.usage.inputTokens;
        f.scores = { ...f.scores, [key]: variantScore(res.answers, v) };
      } catch (err) {
        console.warn(`#${f.number} (${f.repo}): ${(err as Error).message}`); // left unscored → retried
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(
    `${name}: scored ${todo.length} fixtures, spend $${judgeCostUsd(inputTokens).toFixed(4)}`,
  );
  return todo.length;
}

function report(scored: ReadinessFixture[], header: string, detail: boolean): void {
  const ready = scored.filter((f) => f.label === "ready").length;
  const opts = { ...DEFAULT_SIM, readyAt: READY_AT, notReadyBelow: NOT_READY_BELOW };
  const { overall, perRepo } = simulate(scored, opts);
  const roc = readinessAuroc(scored);
  const rocText = roc.auroc === null ? "insufficient support" : roc.auroc.toFixed(3);
  console.log(
    `\n${header} — ${scored.length} fixtures (${ready} ready / ${scored.length - ready} notReady)\n` +
      `  ready@${opts.topN} (${READY_AT}/${NOT_READY_BELOW}): ${fmt(overall)}; AUROC ${rocText}`,
  );
  if (!detail) return;
  for (const [repo, r] of perRepo) {
    if (r.groups === 0) continue;
    console.log(`    ${repo} (n=${scored.filter((f) => f.repo === repo).length}): ${fmt(r)}`);
  }
  console.log(`  threshold sweep (readyAt / notReadyBelow → lift):`);
  for (const row of thresholdSweep(scored)) {
    console.log(`    ${row.readyAt} / ${row.notReadyBelow} → ${fmt(row.result)}`);
  }
  const d = decide(scored, overall, roc);
  console.log(
    `  ${d.go ? "GO" : "NO-GO"} (bar: lift ≥ ${GO_MIN_LIFT}× AND AUROC ≥ ${GO_MIN_AUROC})` +
      (d.reasons.length ? ` — ${d.reasons.join("; ")}` : ""),
  );
}

async function run(): Promise<void> {
  const path = arg("--fixtures") ?? DEFAULT_FIXTURE_PATH;
  const model = arg("--model") ?? process.env.SHEPHERD_JUDGE_MODEL?.trim() ?? DEFAULT_MODEL;
  const split = arg("--split") ?? "dev";
  const variantArg = arg("--variant") ?? PRODUCTION_VARIANT;
  const names = variantArg === "all" ? Object.keys(VARIANTS) : [variantArg];
  if (names.some((n) => !VARIANTS[n]) || !["dev", "holdout", "all"].includes(split)) {
    console.error(`unknown --variant/--split; variants: ${Object.keys(VARIANTS).join(", ")}, all`);
    process.exit(2);
  }
  if (!existsSync(path)) {
    console.error(`no fixtures at ${path} — run scripts/gen-up-next-readiness-fixtures.ts first`);
    process.exit(2);
  }
  const all = JSON.parse(readFileSync(path, "utf8")) as ReadinessFixture[];
  const inSplit = split === "all" ? all : all.filter((f) => splitOf(f) === split);

  let changed = 0;
  for (const name of names) changed += await scoreVariant(inSplit, model, name);
  if (changed) writeFileSync(path, JSON.stringify(all, null, 2));

  console.log(`\nmodel ${model}, split ${split}`);
  for (const name of names) {
    const scored = withScores(inSplit, scoreKey(model, name));
    report(scored, `${name}: ${VARIANTS[name]!.describe}`, names.length === 1);
  }
  console.log(
    "\ncaveats: bodies are today's (may be edited after the work); abandoned ≠ always not-ready.",
  );
}

if (import.meta.main) await run();
