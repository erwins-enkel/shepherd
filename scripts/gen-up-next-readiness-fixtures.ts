// Builds the Up Next readiness fixture set (#2535) from the live Shepherd DB + the forge.
//
// NOT COMMITTED OUTPUT: fixtures carry issue bodies from private repos and this repo is public, so
// they land in ~/.shepherd/eval-fixtures/up-next-readiness.json and nowhere else.
//
// Labels, per issue (all sessions for the same repo+issue aggregated):
//   ready    — a session merged, ≤2 critic review spawns in total, plan-gate round ≤1 (if gated)
//   notReady — no merge and every session archived by the operator/drain (abandoned),
//              OR plan-gate round ≥2, OR ≥4 critic review spawns
//   anything else is excluded (ambiguous middle).
// Caveat: the body is today's body, which may have been edited after the work was done.
//
// Usage: bun run scripts/gen-up-next-readiness-fixtures.ts [--db path] [--out path]

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { standaloneKind } from "../src/up-next-core";
import type { ReadinessFixture, ReadinessLabel } from "./eval-up-next-readiness-core";

export const DEFAULT_FIXTURE_PATH = join(
  homedir(),
  ".shepherd",
  "eval-fixtures",
  "up-next-readiness.json",
);

interface Row {
  repoPath: string;
  issueNumber: number;
  merged: number;
  open: number;
  abandoned: number;
  sessions: number;
  reviews: number;
  planRound: number | null;
  epic: number;
}

const SQL = `
SELECT s.repoPath, s.issueNumber,
  MAX(CASE WHEN s.archiveReason = 'merged' OR d.mergedAt IS NOT NULL THEN 1 ELSE 0 END) AS merged,
  MAX(CASE WHEN s.archivedAt IS NULL THEN 1 ELSE 0 END) AS open,
  SUM(CASE WHEN s.archiveReason IN ('operator','drain') THEN 1 ELSE 0 END) AS abandoned,
  COUNT(*) AS sessions,
  SUM((SELECT COUNT(*) FROM reviewer_spawns r WHERE r.taskSessionId = s.id AND r.kind = 'review')) AS reviews,
  MAX((SELECT g.round FROM plan_gates g WHERE g.sessionId = s.id)) AS planRound,
  MAX(CASE WHEN s.epicParent IS NOT NULL THEN 1 ELSE 0 END) AS epic
FROM sessions s LEFT JOIN delivery_facts d ON d.sessionId = s.id
WHERE s.issueNumber IS NOT NULL AND s.research = 0 AND s.terminal = 0 AND s.epicAuthoring = 0
GROUP BY s.repoPath, s.issueNumber`;

/** PURE: the label rule above, or null for the excluded middle. */
export function labelFor(r: Omit<Row, "repoPath" | "issueNumber" | "epic">): ReadinessLabel | null {
  const round = r.planRound ?? 0;
  if (round >= 2 || r.reviews >= 4) return "notReady";
  if (r.merged) return r.reviews <= 2 && round <= 1 ? "ready" : null;
  if (!r.open && r.abandoned === r.sessions) return "notReady";
  return null;
}

interface GhIssue {
  title: string;
  body: string;
  createdAt: string;
  labels: { name: string }[];
}

function ghIssue(repoPath: string, n: number): GhIssue | null {
  if (!existsSync(repoPath)) return null;
  const p = Bun.spawnSync(
    ["gh", "issue", "view", String(n), "--json", "title,body,createdAt,labels"],
    { cwd: repoPath, stdout: "pipe", stderr: "pipe" },
  );
  if (p.exitCode !== 0) return null;
  try {
    return JSON.parse(p.stdout.toString()) as GhIssue;
  } catch {
    return null;
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function run(): Promise<void> {
  const dbPath = arg("--db") ?? join(homedir(), ".shepherd", "shepherd.db");
  const out = arg("--out") ?? DEFAULT_FIXTURE_PATH;
  const db = new Database(dbPath, { readonly: true });
  const rows = db.query(SQL).all() as Row[];
  db.close();

  // Keep already-scored p across regenerations: a fixture whose content is unchanged need not be
  // paid for twice.
  const prior = new Map<string, ReadinessFixture>();
  if (existsSync(out)) {
    for (const f of JSON.parse(readFileSync(out, "utf8")) as ReadinessFixture[]) {
      prior.set(`${f.repo}#${f.number}`, f);
    }
  }

  const fixtures: ReadinessFixture[] = [];
  let excluded = 0;
  let unreachable = 0;
  for (const r of rows) {
    const label = labelFor(r);
    if (!label) {
      excluded++;
      continue;
    }
    const gh = ghIssue(r.repoPath, r.issueNumber);
    if (!gh) {
      unreachable++;
      continue;
    }
    const labels = gh.labels.map((l) => l.name);
    const f: ReadinessFixture = {
      repo: r.repoPath,
      number: r.issueNumber,
      title: gh.title,
      body: gh.body ?? "",
      labels,
      createdAt: Date.parse(gh.createdAt) || 0,
      kind: r.epic ? "epic" : standaloneKind(labels),
      label,
    };
    const old = prior.get(`${f.repo}#${f.number}`);
    const same =
      old?.title === f.title && old.body === f.body && old.labels.join() === labels.join();
    if (old?.scores && same) f.scores = old.scores;
    fixtures.push(f);
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(fixtures, null, 2));
  const ready = fixtures.filter((f) => f.label === "ready").length;
  console.log(
    `wrote ${fixtures.length} fixtures (${ready} ready / ${fixtures.length - ready} notReady) → ${out}\n` +
      `excluded ${excluded} ambiguous, ${unreachable} unreachable on the forge`,
  );
}

if (import.meta.main) await run();
