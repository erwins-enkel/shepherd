#!/usr/bin/env bun
/**
 * The herdr compatibility check — the mechanised half of the SOP in
 * `.claude/rules/herdr-version-bump.md` (design: docs/superpowers/specs/
 * 2026-08-19-herdr-compat-sop-design.md; the gate #2032 asked for).
 *
 *   bun run herdr:compat -- --candidate <version> [--baseline <version>] [--static-only]
 *
 * Static half (no server): schema diff + #2032 record-shape gate from `api schema --json`,
 * plus a `--help` surface diff over every subcommand Shepherd drives. Live half: candidate and
 * baseline each run as an ISOLATED headless server (own HOME/XDG/socket — the operator's
 * daemon is never touched) and the L1–L9 probes are measured A/B. Output: a markdown report
 * at docs/herdr-compat/<candidate>.md (committed by the eventual bump PR) and exit 1 iff any
 * check FAILs (REVIEW items are triage work, not machine verdicts).
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HERDR_LAST_SUPPORTED_VERSION } from "../src/herdr-capabilities";
import { herdrAssetKey } from "../src/herdr-install";
import { SHEPHERD_HERDR_COMMANDS, diffHelp, type CliFinding } from "./herdr-compat/cli-surface";
import { ensureBinary, probeVersion } from "./herdr-compat/download";
import { startIsolatedServer, type IsolatedServer } from "./herdr-compat/isolated-server";
import { runProbes, type LiveObservations } from "./herdr-compat/probes";
import {
  overallExitCode,
  renderReport,
  reportFileName,
  type CheckResult,
  type Verdict,
} from "./herdr-compat/report";
import { diffSchemas, recordShapeGate, type SchemaFinding } from "./herdr-compat/schema-diff";

// ---------------------------------------------------------------------------- args

function parseArgs(argv: string[]): { candidate: string; baseline?: string; staticOnly: boolean } {
  let candidate: string | undefined;
  let baseline: string | undefined;
  let staticOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--candidate") candidate = argv[++i];
    else if (a === "--baseline") baseline = argv[++i];
    else if (a === "--static-only") staticOnly = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!candidate) {
    throw new Error(
      "usage: bun run herdr:compat -- --candidate <version> [--baseline <version>] [--static-only]",
    );
  }
  return { candidate, baseline, staticOnly };
}

// ------------------------------------------------------------------- static helpers

async function readSchema(bin: string): Promise<unknown> {
  const proc = Bun.spawn([bin, "api", "schema", "--json"], { stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`\`${bin} api schema --json\` exited ${code}`);
  return JSON.parse(out) as unknown;
}

/** The socket-protocol allowlist, read from src/config.ts SOURCE (importing config.ts would
 *  drag the whole boot config — env mutation included — into this script). Advisory only. */
async function readProtocolAllowlist(): Promise<number[] | null> {
  try {
    const text = await Bun.file(join(import.meta.dir, "..", "src", "config.ts")).text();
    const m = text.match(/HERDR_SOCKET_SUPPORTED_PROTOCOLS\s*=\s*new Set\(\[([^\]]*)\]\)/);
    if (!m?.[1]) return null;
    return m[1]
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n));
  } catch {
    return null;
  }
}

function findingsToMarkdown(findings: readonly SchemaFinding[] | readonly CliFinding[]): string {
  if (findings.length === 0) return "No drift.";
  return findings
    .map((f) => {
      if ("area" in f) return `- **${f.severity}** \`${f.area}\` ${f.kind}: ${f.detail}`;
      return `- **${f.severity}** \`herdr ${f.command}\` ${f.kind}${f.item ? `: \`${f.item}\`` : ""}`;
    })
    .join("\n");
}

function verdictFromFindings(findings: readonly { severity: string }[]): Verdict {
  if (findings.some((f) => f.severity === "fail")) return "FAIL";
  if (findings.some((f) => f.severity === "review")) return "REVIEW";
  return "PASS";
}

async function readHelp(bin: string, argv: readonly string[]): Promise<string | null> {
  const proc = Bun.spawn([bin, ...argv, "--help"], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // Some CLIs print help to stderr; accept either as long as the exit is clean-ish.
  const text = out || err;
  return code === 0 && text.trim() !== "" ? text : null;
}

// --------------------------------------------------------------------- live verdicts

interface AB {
  base: LiveObservations;
  cand: LiveObservations;
}

function abTable(rows: [string, string, string][]): string {
  return [
    "| Probe | baseline | candidate |",
    "| --- | --- | --- |",
    ...rows.map(([p, b, c]) => `| ${p} | ${b} | ${c} |`),
  ].join("\n");
}

function liveChecks({ base, cand }: AB, l9: { ran: boolean; exit: number | null }): CheckResult[] {
  const checks: CheckResult[] = [];
  const show = (v: unknown) => (v === null ? "undetermined" : String(v));

  checks.push({
    id: "L1",
    title: "tab.list labels non-null (reaper keying, #2029)",
    verdict:
      cand.labelsNonNull === true ? "PASS" : cand.labelsNonNull === false ? "FAIL" : "REVIEW",
    details: abTable([["all labels non-null", show(base.labelsNonNull), show(cand.labelsNonNull)]]),
  });
  checks.push({
    id: "L2",
    title: 'agentless tab reports agent_status "unknown"',
    verdict:
      cand.agentlessStatus === "unknown"
        ? "PASS"
        : cand.agentlessStatus === null
          ? "REVIEW"
          : "FAIL",
    details: abTable([["agent_status", show(base.agentlessStatus), show(cand.agentlessStatus)]]),
  });
  checks.push({
    id: "L3",
    title: "pane process-info returns foreground procs for a shell pane",
    verdict: cand.foregroundProcs === null ? "REVIEW" : cand.foregroundProcs > 0 ? "PASS" : "FAIL",
    details: abTable([
      ["foreground procs", show(base.foregroundProcs), show(cand.foregroundProcs)],
    ]),
  });
  checks.push({
    id: "L4",
    title: "tab_ids not reused across a close (#569)",
    verdict: cand.tabIdReused === false ? "PASS" : cand.tabIdReused === true ? "FAIL" : "REVIEW",
    details: abTable([["id reused", show(base.tabIdReused), show(cand.tabIdReused)]]),
  });
  checks.push({
    id: "L5",
    title: "last-tab close behaviour (#1760)",
    verdict:
      cand.lastTabClose === "undetermined"
        ? "REVIEW"
        : cand.lastTabClose === base.lastTabClose
          ? "PASS"
          : "REVIEW",
    details:
      abTable([["behaviour", base.lastTabClose, cand.lastTabClose]]) +
      "\n\nShepherd handles both refusal and workspace teardown since #2056 (last-tab guard + " +
      "ensureWorkspace rebuild); a THIRD behaviour, or a flip, needs a human look.",
  });
  const lostKeys =
    cand.agentRecordKeys && base.agentRecordKeys
      ? base.agentRecordKeys.filter((k) => !cand.agentRecordKeys?.includes(k))
      : null;
  checks.push({
    id: "L6",
    title: "external-registration spawn replay (#1890)",
    verdict:
      cand.agentRecordKeys === null
        ? "FAIL"
        : lostKeys && lostKeys.length > 0
          ? "FAIL"
          : cand.statusAfterWorking === "working"
            ? "PASS"
            : "REVIEW",
    details:
      abTable([
        [
          "agent record keys",
          show(base.agentRecordKeys?.length),
          show(cand.agentRecordKeys?.length),
        ],
        [
          "status after --state working",
          show(base.statusAfterWorking),
          show(cand.statusAfterWorking),
        ],
      ]) +
      (lostKeys && lostKeys.length > 0 ? `\n\nKeys LOST on candidate: ${lostKeys.join(", ")}` : ""),
  });
  checks.push({
    id: "L7",
    title: "report-agent --state idle lands on… (herdr #1716 / sandbox-status floor)",
    verdict: cand.statusAfterIdle === "done" ? "PASS" : "REVIEW",
    details:
      abTable([
        ["status after --state idle", show(base.statusAfterIdle), show(cand.statusAfterIdle)],
      ]) +
      (cand.statusAfterIdle === "done"
        ? "\n\n#1716 unchanged: `HERDR_LAST_FULL_SANDBOX_STATUS_VERSION` stays 0.7.4 and the two-path sandbox downgrade advisory keeps working."
        : "\n\n#1716 may have moved — re-verify by hand and consider `HERDR_LAST_FULL_SANDBOX_STATUS_VERSION`."),
  });
  checks.push({
    id: "L8",
    title: "`status server` stays parseable (running + version line)",
    verdict:
      cand.statusParseable === true ? "PASS" : cand.statusParseable === null ? "REVIEW" : "FAIL",
    details: abTable([["parseable", show(base.statusParseable), show(cand.statusParseable)]]),
  });
  checks.push({
    id: "L9",
    title: "terminal session control contract (scripts/verify-herdr-terminal.ts)",
    verdict: !l9.ran ? "REVIEW" : l9.exit === 0 ? "PASS" : "FAIL",
    details: l9.ran
      ? `Exit code ${l9.exit} against the candidate's isolated server.`
      : "Did not run (no workspace or earlier failure) — run it by hand against a candidate server.",
  });

  const notes = [
    ...base.notes.map((n) => `baseline: ${n}`),
    ...cand.notes.map((n) => `candidate: ${n}`),
  ];
  if (notes.length > 0) {
    checks.push({
      id: "L-notes",
      title: "probe notes",
      verdict: "REVIEW",
      details: notes.map((n) => `- ${n}`).join("\n"),
    });
  }
  return checks;
}

// ---------------------------------------------------------------------------- main

const args = parseArgs(process.argv.slice(2));
const installedBin = process.env.HERDR_BIN || "herdr";
const baselineVersion = args.baseline ?? HERDR_LAST_SUPPORTED_VERSION;

console.log(`[herdr-compat] candidate ${args.candidate}, baseline ${baselineVersion}`);

const installedVersion = await probeVersion(installedBin);
const candidateBin =
  installedVersion === args.candidate ? installedBin : await ensureBinary(args.candidate);
const baselineBin =
  installedVersion === baselineVersion ? installedBin : await ensureBinary(baselineVersion);

const [baseSchema, candSchema] = await Promise.all([
  readSchema(baselineBin),
  readSchema(candidateBin),
]);
const schemaDiff = diffSchemas(baseSchema, candSchema);

const checks: CheckResult[] = [];

// S1 — protocol number vs. the socket allowlist.
const allowlist = await readProtocolAllowlist();
const protocolKnown = allowlist?.includes(schemaDiff.candidateProtocol) ?? false;
checks.push({
  id: "S1",
  title: "wire protocol number vs. HERDR_SOCKET_SUPPORTED_PROTOCOLS",
  verdict: protocolKnown ? "PASS" : "REVIEW",
  details:
    `Baseline protocol ${schemaDiff.baseProtocol}, candidate protocol ${schemaDiff.candidateProtocol}; ` +
    `allowlist in src/config.ts: {${allowlist?.join(", ") ?? "unreadable"}}.` +
    (protocolKnown
      ? ""
      : " Admit the new protocol BY NAME (the set is an explicit allowlist, not a floor — 18 never shipped stable and stays out)."),
});

// S2 — general schema diff (protocol movement is S1's job).
const s2 = schemaDiff.findings.filter((f) => f.area !== "protocol");
checks.push({
  id: "S2",
  title: "schema diff (methods, params, results, enums)",
  verdict: verdictFromFindings(s2),
  details: findingsToMarkdown(s2),
});

// S3 — the #2032 record-shape gate.
const s3 = recordShapeGate(baseSchema, candSchema);
checks.push({
  id: "S3",
  title: "record-shape gate: TabInfo / PaneInfo / AgentInfo (#2032)",
  verdict: verdictFromFindings(s3),
  details: findingsToMarkdown(s3),
});

// S4 — the CLI surface Shepherd drives.
const s4: CliFinding[] = [];
for (const cmd of SHEPHERD_HERDR_COMMANDS) {
  const [baseHelp, candHelp] = await Promise.all([
    readHelp(baselineBin, cmd),
    readHelp(candidateBin, cmd),
  ]);
  s4.push(...diffHelp(cmd.join(" "), baseHelp, candHelp));
}
checks.push({
  id: "S4",
  title: "CLI surface of the subcommands Shepherd invokes",
  verdict: verdictFromFindings(s4),
  details: findingsToMarkdown(s4),
});

// Live half.
if (!args.staticOnly) {
  let baseServer: IsolatedServer | null = null;
  let candServer: IsolatedServer | null = null;
  const l9 = { ran: false, exit: null as number | null };
  try {
    console.log("[herdr-compat] starting isolated baseline server…");
    baseServer = await startIsolatedServer(baselineBin, "baseline");
    const baseObs = await runProbes(baseServer);
    console.log("[herdr-compat] starting isolated candidate server…");
    candServer = await startIsolatedServer(candidateBin, "candidate");
    const candObs = await runProbes(candServer, {
      beforeDestructive: async () => {
        console.log("[herdr-compat] running verify-herdr-terminal against the candidate…");
        const proc = Bun.spawn(["bun", join(import.meta.dir, "verify-herdr-terminal.ts")], {
          env: { ...candServer!.env, HERDR_BIN: candidateBin },
          stdout: "inherit",
          stderr: "inherit",
        });
        l9.exit = await proc.exited;
        l9.ran = true;
      },
    });
    checks.push(...liveChecks({ base: baseObs, cand: candObs }, l9));
  } finally {
    await candServer?.stop();
    await baseServer?.stop();
  }
}

// Report.
const reportDir = join(import.meta.dir, "..", "docs", "herdr-compat");
mkdirSync(reportDir, { recursive: true });
const fileName = reportFileName(args.candidate);
const md = renderReport({
  candidate: args.candidate,
  baseline: baselineVersion,
  candidateProtocol: schemaDiff.candidateProtocol,
  baselineProtocol: schemaDiff.baseProtocol,
  date: new Date().toISOString().slice(0, 10),
  platform: herdrAssetKey() ?? `${process.platform}-${process.arch}`,
  commandLine: `bun run herdr:compat -- ${process.argv.slice(2).join(" ")}`,
  checks,
});
await Bun.write(join(reportDir, fileName), md);

const exit = overallExitCode(checks);
console.log(`\n[herdr-compat] report: docs/herdr-compat/${fileName}`);
for (const c of checks) console.log(`  ${c.verdict.padEnd(6)} ${c.id} ${c.title}`);
console.log(`[herdr-compat] overall: ${exit === 0 ? "OK (no FAIL)" : "FAIL"}`);
process.exit(exit);
