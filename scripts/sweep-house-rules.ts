#!/usr/bin/env bun
/**
 * One-shot sweep of a repo's active house rules against the admission test (issue #2004).
 *
 * The flywheel now admits non-derivable repo FACTS, not behavioral rules (`src/learning-shape.ts`).
 * The distiller's fails-the-admission-test DELETE criterion keeps the corpus honest from here on;
 * this script is how the corpus that predates the re-target gets fixed in one pass, and how the
 * resulting shrink of the injected `<shepherd-house-rules>` block is measured.
 *
 * Read-only by default. Nothing is retired without `--apply`, and every retirement is reversible
 * through `POST /api/learnings/:id/restore` (the reason is stored as `not-a-gotcha`, so the sweep's
 * retirements stay distinguishable from Wilson auto-retires, expired trials and merges).
 *
 *   scripts/sweep-house-rules.ts --repo /path/to/repo
 *       Dry run: prints the admission test, every active rule, and the current block cost.
 *
 *   scripts/sweep-house-rules.ts --repo /path/to/repo --decisions drop.json
 *       Dry run + projected before/after for the drops in `{"drop":[{"id":"…","why":"…"}]}`.
 *
 *   scripts/sweep-house-rules.ts --repo /path/to/repo --decisions drop.json --apply
 *       Retires them and prints the measured before/after.
 *
 * Writes to the live DB directly (a second SQLite writer; WAL + busy_timeout make that safe — see
 * store.ts). The running server holds no learnings cache, but it does not learn of the change
 * either: the drawer refreshes on its next fetch. Snapshot first — note that even a dry run opens a
 * full `SessionStore`, which runs this build's additive schema migrations against the file:
 *   sqlite3 ~/.shepherd/shepherd.db "VACUUM INTO '/tmp/pre-sweep.db'"
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SessionStore } from "../src/store";
import { resolveDbPath } from "../src/backup-paths";
import { LEARNING_ADMISSION_TEST, SWEEP_RETIRE_REASON } from "../src/learning-shape";
import {
  parseDecisions,
  planSweep,
  priceBlock,
  type BlockCost,
  type SweepDecision,
  type SweepPlan,
} from "../src/learning-sweep";

/** Kept in step with `config.houseRulesBudgetChars`; config.ts is not imported here because loading
 *  it runs forge/node-bin resolution side effects a CLI has no use for (same reason backup.ts keeps
 *  its own path resolver). */
const BUDGET_CHARS = Number(process.env.SHEPHERD_HOUSE_RULES_BUDGET_CHARS ?? 4000);

interface Args {
  repo: string;
  decisions?: string;
  apply: boolean;
  db: string;
}

export function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = { apply: false, db: resolveDbPath() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--repo") out.repo = argv[++i];
    else if (a === "--decisions") out.decisions = argv[++i];
    else if (a === "--db") out.db = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.repo) throw new Error("--repo <path> is required");
  if (out.apply && !out.decisions) throw new Error("--apply requires --decisions <file>");
  return out as Args;
}

function fmt(c: BlockCost): string {
  return `${c.injectedRules} injected · ${c.chars} chars · ~${c.tokens} est-tokens`;
}

/** Print the outcome. `done` is what was actually retired (null on a dry run) and `after` the cost
 *  that goes with it — both passed in rather than read off the plan, so a run that aborts partway
 *  reports what really happened instead of what it intended. */
function report(plan: SweepPlan, done: SweepPlan["retire"] | null, after: BlockCost): void {
  for (const r of plan.refused) console.log(`REFUSED  ${r.id}  (${r.reason})`);
  const rows = done ?? plan.retire;
  for (const r of rows) console.log(`${done ? "RETIRED" : "WOULD RETIRE"}  ${r.id}  ${r.rule}`);
  console.log(`\nactive rules  ${plan.activeBefore} → ${plan.activeBefore - rows.length}`);
  console.log(`block before  ${fmt(plan.before)}`);
  console.log(`block after   ${fmt(after)}`);
  const saved = plan.before.chars - after.chars;
  const pct = plan.before.chars > 0 ? Math.round((saved / plan.before.chars) * 100) : 0;
  console.log(
    `saved         ${saved} chars (${pct}%) · ~${plan.before.tokens - after.tokens} est-tokens`,
  );
}

function main(argv: string[]): number {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    console.error(
      "usage: sweep-house-rules.ts --repo <path> [--decisions <file>] [--apply] [--db <path>]",
    );
    return 2;
  }
  const store = new SessionStore(args.db);
  const rules = store.listActiveLearnings(args.repo);
  if (rules.length === 0) {
    console.error(`no active house rules for ${args.repo} in ${args.db}`);
    return 1;
  }

  if (!args.decisions) {
    console.log(LEARNING_ADMISSION_TEST);
    console.log(`\n${rules.length} active rules for ${args.repo}:\n`);
    for (const r of rules) {
      const scope = r.scopeGlobs.length ? ` [scope: ${r.scopeGlobs.join(",")}]` : "";
      console.log(`${r.id}  (${r.status})${scope}\n  ${r.rule}\n`);
    }
    console.log(`block cost    ${fmt(planSweep(rules, [], BUDGET_CHARS).before)}`);
    return 0;
  }

  let decisions: SweepDecision[];
  try {
    decisions = parseDecisions(JSON.parse(readFileSync(args.decisions, "utf8")));
  } catch (e) {
    console.error(`decisions file: ${String(e instanceof Error ? e.message : e)}`);
    return 2;
  }
  const plan = planSweep(rules, decisions, BUDGET_CHARS);
  if (!args.apply) {
    report(plan, null, plan.after);
    console.log("\n(dry run — pass --apply to retire)");
    return 0;
  }
  // Retire one at a time and keep the successes: a rule that changed status between the plan and
  // now returns null, and the report must then describe the partial state, not the intent.
  const done: SweepPlan["retire"] = [];
  let failed: string | null = null;
  for (const r of plan.retire) {
    if (store.retireLearning(r.id, SWEEP_RETIRE_REASON) === null) {
      failed = r.id;
      break;
    }
    done.push(r);
  }
  // Price the state that now exists, rather than trusting the projection.
  report(plan, done, priceBlock(store.listActiveLearnings(args.repo), BUDGET_CHARS));
  if (failed !== null) {
    console.error(
      `\nFAILED to retire ${failed} (no longer active?) — stopped, earlier drops stand`,
    );
    return 1;
  }
  return 0;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
