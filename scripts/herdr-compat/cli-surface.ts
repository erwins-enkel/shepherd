/**
 * CLI-surface half of the herdr compatibility check (SOP: .claude/rules/herdr-version-bump.md).
 *
 * Shepherd drives herdr through a fixed set of subcommands (grep for asyncRunner argv arrays in
 * src/herdr.ts / src/herdr-update.ts / deploy/). A candidate herdr that drops one of those
 * subcommands or one of their flags breaks Shepherd even when the wire protocol is untouched —
 * #2039 caught `worktree --json` disappearing from help this way. The parse/diff functions are
 * pure (unit-tested offline); only the runner in herdr-compat.ts executes `--help`.
 */

import type { Severity } from "./schema-diff";

/** Every herdr subcommand Shepherd invokes (src/herdr.ts, src/herdr-update.ts, src/version-probe.ts,
 *  src/preflight.ts, deploy/provision.ts, scripts/verify-herdr-terminal.ts). Keep in sync with the
 *  argv arrays those files pass to their runners; test/herdr-compat-cli-surface.test.ts spot-checks
 *  the known surface. */
export const SHEPHERD_HERDR_COMMANDS: readonly (readonly string[])[] = [
  ["tab", "create"],
  ["tab", "close"],
  ["tab", "list"],
  ["tab", "rename"],
  ["pane", "run"],
  ["pane", "close"],
  ["pane", "list"],
  ["pane", "process-info"],
  ["pane", "send-keys"],
  ["pane", "send-text"],
  ["pane", "report-agent"],
  ["pane", "report-agent-session"],
  ["agent", "list"],
  ["agent", "rename"],
  ["agent", "send"],
  ["workspace", "list"],
  ["workspace", "create"],
  ["worktree", "add"],
  ["worktree", "list"],
  ["worktree", "prune"],
  ["worktree", "remove"],
  ["api", "schema"],
  ["status"],
  ["server", "stop"],
  ["update"],
];

export interface HelpSurface {
  /** Long flags declared in the Options block (definition lines only, deduped, in order). */
  flags: string[];
  /** Subcommand names from the Commands block (first token per line, in order). */
  subcommands: string[];
}

export interface CliFinding {
  command: string;
  kind:
    "flag-removed" | "flag-added" | "subcommand-removed" | "subcommand-added" | "command-missing";
  item?: string;
  severity: Severity;
}

/**
 * Extract the comparable surface from a `--help` text: long flags from their DEFINITION lines
 * (a line whose first non-space token starts with `-`, so prose mentions of `--x` inside
 * description lines don't count) and subcommand names from the `Commands:` block.
 */
export function parseHelpSurface(helpText: string): HelpSurface {
  const flags: string[] = [];
  const subcommands: string[] = [];
  let inCommands = false;
  for (const line of helpText.split("\n")) {
    if (/^\S.*:$/.test(line.trim()) || /^[A-Z][A-Za-z ]*:$/.test(line.trimEnd())) {
      inCommands = /^Commands:/.test(line.trim());
    }
    const trimmed = line.trim();
    if (inCommands && /^ {2,}\S/.test(line) && trimmed !== "") {
      const name = trimmed.split(/\s+/)[0];
      if (name && !name.startsWith("-")) subcommands.push(name);
      continue;
    }
    // Flag definition line: first token is a short or long flag.
    if (/^\s*-{1,2}[A-Za-z]/.test(line)) {
      for (const m of trimmed.matchAll(/--[a-z0-9][a-z0-9-]*/g)) {
        if (!flags.includes(m[0])) flags.push(m[0]);
      }
    }
  }
  return { flags, subcommands };
}

/** Diff one command's help surface. `null` help = the command errored / vanished. */
export function diffHelp(
  command: string,
  baseHelp: string | null,
  candidateHelp: string | null,
): CliFinding[] {
  if (baseHelp === null) return []; // baseline can't run it — nothing to compare against
  if (candidateHelp === null) {
    return [{ command, kind: "command-missing", severity: "fail" }];
  }
  const base = parseHelpSurface(baseHelp);
  const cand = parseHelpSurface(candidateHelp);
  const findings: CliFinding[] = [];
  for (const flag of base.flags) {
    if (!cand.flags.includes(flag)) {
      findings.push({ command, kind: "flag-removed", item: flag, severity: "fail" });
    }
  }
  for (const flag of cand.flags) {
    if (!base.flags.includes(flag)) {
      findings.push({ command, kind: "flag-added", item: flag, severity: "info" });
    }
  }
  for (const sub of base.subcommands) {
    if (!cand.subcommands.includes(sub)) {
      findings.push({ command, kind: "subcommand-removed", item: sub, severity: "fail" });
    }
  }
  for (const sub of cand.subcommands) {
    if (!base.subcommands.includes(sub)) {
      findings.push({ command, kind: "subcommand-added", item: sub, severity: "info" });
    }
  }
  return findings;
}
