/**
 * Delivery-metrics report (#2151 R1) — the same numbers the Usage modal's Delivery lens shows,
 * on the command line.
 *
 *   bun run delivery-report                 # last 7 days
 *   bun run delivery-report --range 30d     # 24h | 7d | 30d | all
 *   bun run delivery-report --md            # GitHub-flavored markdown tables
 *
 * Opens the live DB READ-ONLY and satisfies the builder's store surface with plain queries, so it
 * can never migrate or write to a database a running server owns.
 *
 * Delivery instrumentation is forward-only: a task that merged before it shipped has no fact row
 * and is invisible here. The "measuring since" line reports where the record actually begins.
 */
import { Database } from "bun:sqlite";
import { buildDeliveryMetrics, type DeliveryMetricsStore } from "../src/delivery-metrics";
import type {
  DeliveryFact,
  DeliveryMetrics,
  DeliverySample,
  DeliveryStats,
  ReviewerSpawnRow,
  SignalKind,
  UsageRange,
} from "../src/types";

const RANGES: UsageRange[] = ["24h", "7d", "30d", "all"];

function parseArgs(argv: string[]): { range: UsageRange; md: boolean } {
  const md = argv.includes("--md");
  const i = argv.indexOf("--range");
  const raw = i >= 0 ? argv[i + 1] : undefined;
  if (raw !== undefined && !RANGES.includes(raw as UsageRange)) {
    console.error(`unknown --range "${raw}" (expected ${RANGES.join(" | ")})`);
    process.exit(1);
  }
  return { range: (raw as UsageRange) ?? "7d", md };
}

function openStore(): DeliveryMetricsStore {
  const path = process.env.SHEPHERD_DB ?? `${process.env.HOME}/.shepherd/shepherd.db`;
  const db = new Database(path, { readonly: true });
  // A DB that predates this feature has no delivery_facts table, and the read is READONLY so it
  // cannot create one. Say that plainly instead of throwing a SQLite stack trace at the operator —
  // the table appears the first time a server carrying the migration boots.
  const migrated =
    db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='delivery_facts'`).get() !=
    null;
  if (!migrated) {
    console.log("No delivery metrics yet — this database predates delivery instrumentation.");
    console.log("It is recorded from the first server boot that carries the migration.");
    process.exit(0);
  }
  return {
    listMergedDeliveryFacts: (since) =>
      db
        .query(
          `SELECT * FROM delivery_facts WHERE mergedAt IS NOT NULL AND mergedAt >= ?
           ORDER BY mergedAt DESC`,
        )
        .all(since) as DeliveryFact[],
    listReviewerSpawns: () =>
      db.query(`SELECT * FROM reviewer_spawns ORDER BY spawnedAt`).all() as ReviewerSpawnRow[],
    earliestDeliveryFactAt: () =>
      (db.query(`SELECT MIN(createdAt) AS t FROM delivery_facts`).get() as { t: number | null })
        ?.t ?? null,
    countSignalsByKind: (since) =>
      db
        .query(
          `SELECT kind, COUNT(*) AS occurrences, COUNT(DISTINCT sessionId) AS sessions
           FROM signals WHERE ts >= ? GROUP BY kind ORDER BY occurrences DESC, kind ASC`,
        )
        .all(since) as { kind: SignalKind; occurrences: number; sessions: number }[],
  };
}

/** An em dash for an empty sample — never a zero, which would read as a real measurement. */
const EMPTY = "—";

function pct(s: DeliverySample): string {
  return s.value == null ? EMPTY : `${Math.round(s.value * 100)}% (n=${s.n})`;
}

function num(s: DeliverySample, digits = 1): string {
  return s.value == null ? EMPTY : `${s.value.toFixed(digits)} (n=${s.n})`;
}

function dur(s: DeliverySample): string {
  return s.value == null ? EMPTY : `${humanMs(s.value)} (n=${s.n})`;
}

function humanMs(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${String(mins % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Label/value pairs for one scope, in the order the report reads best. */
function rows(st: DeliveryStats): [string, string][] {
  return [
    ["Merged tasks", String(st.mergedTasks)],
    ["First-pass rate", pct(st.firstPassRate)],
    ["Unreviewed", String(st.unreviewed)],
    ["Rework cycles (median)", num(st.reworkCyclesMedian)],
    ["Rework cycles (mean)", num(st.reworkCyclesMean, 2)],
    ["Critic errors", String(st.criticErrors)],
    ["Plan rounds (median)", num(st.planRoundsMedian)],
    ["Plan rework rate", pct(st.planReworkRate)],
    ["Time to first review", dur(st.timeToFirstReviewMs)],
    ["Lead time", dur(st.leadTimeMs)],
  ];
}

function mdTable(header: string[], body: string[][]): string {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

function renderMarkdown(m: DeliveryMetrics): string {
  const out = [
    `## Delivery metrics — ${m.range}`,
    "",
    mdTable(["Indicator", "Value"], rows(m.totals)),
  ];
  if (m.repos.length > 0) {
    out.push(
      "",
      "### Per repo",
      "",
      mdTable(
        ["Repo", "Merged", "First-pass", "Rework", "Lead time"],
        m.repos.map((r) => [
          r.repo,
          String(r.mergedTasks),
          pct(r.firstPassRate),
          num(r.reworkCyclesMedian),
          dur(r.leadTimeMs),
        ]),
      ),
    );
  }
  if (m.incidents.length > 0) {
    out.push(
      "",
      "### Repeat incidents",
      "",
      mdTable(
        ["Kind", "Occurrences", "Sessions"],
        m.incidents.map((i) => [i.kind, String(i.occurrences), String(i.sessions)]),
      ),
    );
  }
  return out.join("\n");
}

function renderText(m: DeliveryMetrics): string {
  const width = Math.max(...rows(m.totals).map(([label]) => label.length));
  const out = [`Delivery metrics — ${m.range}`, ""];
  for (const [label, value] of rows(m.totals)) out.push(`  ${label.padEnd(width)}  ${value}`);
  if (m.repos.length > 0) {
    out.push("", "Per repo:");
    for (const r of m.repos)
      out.push(
        `  ${r.repo}: ${r.mergedTasks} merged, first-pass ${pct(r.firstPassRate)}, lead ${dur(r.leadTimeMs)}`,
      );
  }
  if (m.incidents.length > 0) {
    out.push("", "Repeat incidents:");
    for (const i of m.incidents)
      out.push(`  ${i.kind}: ${i.occurrences} occurrence(s) across ${i.sessions} session(s)`);
  }
  return out.join("\n");
}

const { range, md } = parseArgs(process.argv.slice(2));
const metrics = buildDeliveryMetrics({ store: openStore(), range, now: Date.now() });
console.log(md ? renderMarkdown(metrics) : renderText(metrics));
console.log(
  metrics.measuringSince == null
    ? "\nNo delivery data recorded yet — instrumentation is forward-only."
    : `\nMeasuring since ${new Date(metrics.measuringSince).toISOString().slice(0, 10)}.`,
);
