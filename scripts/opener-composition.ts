/**
 * Opener composition report (issue #3778): per spawn kind, what the first request carries, block by
 * block, and what each block costs in re-reads. Logic: scripts/opener-blocks.ts.
 *
 *   bun run scripts/opener-composition.ts                     # every session + reviewer in the DB
 *   bun run scripts/opener-composition.ts --since 2026-11-08  # spawns created on/after a date
 *   bun run scripts/opener-composition.ts --md --top 12       # markdown, 12 blocks per kind
 *   bun run scripts/opener-composition.ts --repo /path/to/repo # one repo's sessions (no reviewers)
 *
 * READ-ONLY: opens the DB with `readonly: true` and only reads transcripts. Token figures are
 * calibrated estimates (chars × a fitted tokens/char, tool JSON and prose separately); the
 * reconciliation line shows how far they sit from the API-reported opener.
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { jsonlPathFor } from "../src/usage";
import { readSkillNames } from "../src/service";
import { AGENT_SKILL_NAMES } from "../src/agent-skills";
import {
  blockRows,
  fitCalibration,
  openerSample,
  quantile,
  reconcileError,
  type Calibration,
  type OpenerSample,
  type SkillSets,
} from "./opener-blocks";

interface Args {
  since: number;
  md: boolean;
  top: number;
  /** Only sessions of this repo (#3780, e.g. to measure its plugin/skill allowlists). */
  repo: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { since: 0, md: false, top: 15, repo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--md") args.md = true;
    else if (a === "--since") {
      const raw = argv[++i] ?? "";
      args.since = Date.parse(raw);
      if (!Number.isFinite(args.since)) throw new Error(`--since expects a date, got: ${raw}`);
    } else if (a === "--repo") {
      args.repo = argv[++i] ?? "";
      if (!args.repo) throw new Error("--repo expects a repo path");
    } else if (a === "--top") {
      args.top = Number(argv[++i]);
      if (!Number.isInteger(args.top) || args.top <= 0) throw new Error("--top expects a count");
    } else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

interface SessionRow {
  id: string;
  worktreePath: string;
  claudeSessionId: string;
  spawnAccountDir: string | null;
  auto: number;
  research: number;
  terminal: number;
  operatorAssistant: number;
  epicAuthoring: number;
}

interface ReviewerRow {
  reviewerSessionId: string;
  kind: string;
  worktreePath: string;
}

interface Sample extends OpenerSample {
  kind: string;
  /** Shepherd's prompt-budget row for this session (task sessions only). */
  budget?: { chars: number; tokens: number };
}

function sessionKind(r: SessionRow, s: OpenerSample): string {
  if (r.operatorAssistant) return "assistant";
  if (r.terminal) return "terminal";
  if (r.epicAuthoring) return "epic-authoring";
  if (r.research) return "research";
  if (r.auto) return "drain";
  return s.blocks.has("shepherd:plan-gate-directive") ? "attended+plan-gate" : "attended";
}

function readSample(path: string, sets: SkillSets): OpenerSample | null {
  if (!existsSync(path)) return null;
  return openerSample(readFileSync(path, "utf8").split("\n"), sets, homedir());
}

function sessionSamples(
  db: Database,
  since: number,
  repo: string | null,
  sets: SkillSets,
): Sample[] {
  const budgets = new Map(
    db
      .query<{ sessionId: string; totalChars: number; totalTokens: number }, []>(
        "SELECT sessionId, totalChars, totalTokens FROM session_prompt_budget",
      )
      .all()
      .map((b) => [b.sessionId, { chars: b.totalChars, tokens: b.totalTokens }]),
  );
  const rows = db
    .query<SessionRow, [number, string | null, string | null]>(
      `SELECT id, worktreePath, claudeSessionId, spawnAccountDir, auto, research, terminal,
              operatorAssistant, epicAuthoring
         FROM sessions
        WHERE agentProvider = 'claude' AND claudeSessionId != '' AND createdAt >= ?
          AND (? IS NULL OR repoPath = ?)`,
    )
    .all(since, repo, repo);
  return rows.flatMap((r) => {
    const s = readSample(jsonlPathFor(r.worktreePath, r.claudeSessionId, r.spawnAccountDir), sets);
    return s ? [{ ...s, kind: sessionKind(r, s), budget: budgets.get(r.id) }] : [];
  });
}

function reviewerSamples(db: Database, since: number, sets: SkillSets): Sample[] {
  const rows = db
    .query<ReviewerRow, [number]>(
      `SELECT reviewerSessionId, kind, worktreePath FROM reviewer_spawns
        WHERE COALESCE(reviewerProvider, 'claude') = 'claude' AND spawnedAt >= ?`,
    )
    .all(since);
  return rows.flatMap((r) => {
    const s = readSample(jsonlPathFor(r.worktreePath, r.reviewerSessionId), sets);
    return s ? [{ ...s, kind: `sat:${r.kind}` }] : [];
  });
}

// ── rendering ───────────────────────────────────────────────────────────────────────────────────

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function table(md: boolean, head: string[], rows: string[][]): string {
  if (!md) return [head, ...rows].map((r) => r.join("\t")).join("\n");
  const line = (r: string[]) => `| ${r.join(" | ")} |`;
  return [line(head), line(head.map(() => "---")), ...rows.map(line)].join("\n");
}

function groupByKind(samples: Sample[]): [string, Sample[]][] {
  const by = new Map<string, Sample[]>();
  for (const s of samples) by.set(s.kind, [...(by.get(s.kind) ?? []), s]);
  const reqs = (ss: Sample[]) => ss.reduce((n, s) => n + s.requests, 0);
  return [...by].sort((a, b) => reqs(b[1]) - reqs(a[1]));
}

function kindTable(groups: [string, Sample[]][], md: boolean): string {
  const rows = groups.map(([kind, ss]) => {
    const t = ss.map((s) => s.tokens);
    return [
      kind,
      fmt(ss.length),
      fmt(ss.reduce((n, s) => n + s.requests, 0)),
      `${fmt(quantile(t, 0.1))} / ${fmt(quantile(t, 0.5))} / ${fmt(quantile(t, 0.9))}`,
    ];
  });
  return table(md, ["Kind", "n", "Σ requests", "Opener p10 / p50 / p90"], rows);
}

/** Shepherd's own instrument against the transcript: its chars should match the `shepherd:*`
 *  blocks exactly; its chars/4 token estimate is compared with the calibrated count. */
function budgetLine(samples: Sample[], cal: Calibration): string {
  const pairs = samples.flatMap((s) => {
    if (!s.budget?.chars) return [];
    let chars = 0;
    for (const [name, c] of s.blocks) if (name.startsWith("shepherd:")) chars += c;
    return [{ charRatio: chars / s.budget.chars, tokRatio: (chars * cal.text) / s.budget.tokens }];
  });
  if (!pairs.length) return "prompt-budget: no rows to reconcile";
  return (
    `prompt-budget (n=${pairs.length}): transcript/budget chars p50 ${quantile(
      pairs.map((p) => p.charRatio),
      0.5,
    ).toFixed(3)}, ` +
    `calibrated/budget-estimate tokens p50 ${quantile(
      pairs.map((p) => p.tokRatio),
      0.5,
    ).toFixed(2)}×`
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = new Database(process.env.SHEPHERD_DB ?? join(homedir(), ".shepherd", "shepherd.db"), {
    readonly: true,
  });
  const sets: SkillSets = {
    personal: new Set((await readSkillNames(join(homedir(), ".claude", "skills"))) ?? []),
    shepherd: new Set(AGENT_SKILL_NAMES),
  };
  const samples = [
    ...sessionSamples(db, args.since, args.repo, sets),
    // Reviewer spawns carry no repo column; a per-repo run reports sessions only.
    ...(args.repo ? [] : reviewerSamples(db, args.since, sets)),
  ];
  if (samples.length === 0) throw new Error("no transcripts with recorded requests in the window");
  const cal = fitCalibration(samples);
  const errs = samples.map((s) => reconcileError(s, cal));
  const groups = groupByKind(samples);
  const out = [
    `Calibration: tool JSON ${(1 / cal.json).toFixed(2)} chars/token, text ${(1 / cal.text).toFixed(2)} chars/token`,
    `Reconciliation vs measured opener (n=${samples.length}): p10 ${pct(quantile(errs, 0.1))} / p50 ${pct(quantile(errs, 0.5))} / p90 ${pct(quantile(errs, 0.9))}`,
    budgetLine(samples, cal),
    "",
    kindTable(groups, args.md),
  ];
  for (const [kind, ss] of groups) {
    const rows = blockRows(ss, cal)
      .slice(0, args.top)
      .map((r) => [r.name, fmt(r.median), `${(r.weighted / 1e6).toFixed(1)}M`]);
    out.push(
      "",
      `${args.md ? "### " : "== "}${kind}`,
      table(args.md, ["Block", "Median tokens", "Σ tokens×requests"], rows),
    );
  }
  const all = blockRows(samples, cal);
  const total = all.reduce((n, r) => n + r.weighted, 0);
  out.push(
    "",
    `${args.md ? "### " : "== "}All kinds — share of Σ tokens×requests`,
    table(
      args.md,
      ["Block", "Σ tokens×requests", "Share"],
      all
        .slice(0, args.top * 2)
        .map((r) => [r.name, `${(r.weighted / 1e6).toFixed(1)}M`, pct(r.weighted / total)]),
    ),
  );
  console.log(out.join("\n"));
}

await main();
