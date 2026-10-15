/**
 * The `<bootstrap-directive>` (#3109, epic #3114): an attended BOOTSTRAP session (P1+P2) turns a
 * PRD + design export into a runnable scaffold with every guardrail, as ONE PR to the default
 * branch, before any epic branch exists.
 *
 * Every version in it comes from the House Stack resolution Shepherd made at spawn (#3108) — none
 * from model memory; without one it fails closed and tells the agent to stop. The guardrail
 * checklist is the Readiness analyzer's own prescription tables (`bootstrapGuardrailChecklist`), so
 * the two never drift. Agent-facing prompt text → fixed English, no i18n (same precedent as the
 * other spawn directives).
 */
import type { AgentProvider } from "./types";
import { renderHouseStackRules, type ResolvedHouseStack } from "./house-stack";
import {
  bootstrapGuardrailChecklist,
  GUARDRAIL_BLIND_SPOTS,
  type PackageManager,
} from "./readiness";

const PACKAGE_MANAGERS: readonly PackageManager[] = ["bun", "pnpm", "npm", "yarn"];

/** The package manager the stack pins (its `packageManager` field), npm when it names none. */
function pinnedPackageManager(packageManager: string | undefined): PackageManager {
  const name = packageManager?.split("@")[0];
  return PACKAGE_MANAGERS.find((pm) => pm === name) ?? "npm";
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => (l ? `    ${l}` : l))
    .join("\n");
}

/** The pin section: the rendered rules plus where each artifact goes. */
function pinsSection(stack: ResolvedHouseStack): string {
  const rules = renderHouseStackRules(stack);
  const lines = [
    rules.directive,
    "",
    "Write this section VERBATIM into the project's CLAUDE.md:",
    indent(rules.claudeMd),
  ];
  if (rules.packageJson.packageManager) {
    lines.push(
      `Set \`"packageManager": "${rules.packageJson.packageManager}"\` and \`"engines": ${JSON.stringify(rules.packageJson.engines)}\` in the root package.json.`,
    );
  }
  if (rules.rustToolchainToml) {
    lines.push(
      "When the project has Rust, write `rust-toolchain.toml`:",
      indent(rules.rustToolchainToml),
    );
  }
  lines.push(
    "Apply only the pins for the ecosystems the PRD needs. ANY package not listed above: query its " +
      "current stable version from the registry first (`npm view <pkg> version`, " +
      "`cargo search <crate> --limit 1`) and use that — never a version from memory, and never an " +
      "older major than the registry's current stable.",
  );
  return lines.join("\n");
}

/** The guardrail checklists for each ecosystem the stack covers. */
function checklistSection(stack: ResolvedHouseStack): string {
  const parts: string[] = [];
  if (stack.npm.length > 0) {
    const pm = pinnedPackageManager(renderHouseStackRules(stack).packageJson.packageManager);
    parts.push(`JS/TS (${pm}):\n${bootstrapGuardrailChecklist("js-ts", pm)}`);
  }
  if (stack.crates.length > 0 || stack.rustToolchain) {
    parts.push(`Rust:\n${bootstrapGuardrailChecklist("rust", "npm")}`);
  }
  return parts.join("\n\n");
}

const NO_STACK =
  "Shepherd has NO resolved stack for this session, so you have no version you may use. Do NOT " +
  "pick versions yourself: tell the operator to relaunch the task so Shepherd re-resolves the " +
  "House Stack, then stop.";

export function bootstrapDirective(args: {
  stack: ResolvedHouseStack | null;
  agentProvider: AgentProvider;
}): string {
  if (!args.stack) return `You are running as an attended BOOTSTRAP task.\n${NO_STACK}`;
  const ask =
    args.agentProvider === "codex"
      ? "ask the operator in chat and wait for the answer"
      : "use AskUserQuestion";
  return [
    "You are running as an attended BOOTSTRAP task (P1+P2): turn the PRD and the design export " +
      "into a runnable scaffold that carries every guardrail, delivered as exactly ONE pull " +
      "request to the default branch. No epic branch exists yet; do not create issues or epics " +
      "(the backlog is a later phase).",
    "",
    "## Inputs",
    "- PRD: `docs/prd/`, `docs/prd.md` or `PRD.md`. Design export: `docs/design/`. If either is " +
      `missing, ${ask} before scaffolding anything.`,
    "",
    "## Pinned stack",
    pinsSection(args.stack),
    "",
    "## P1 — decisions that shape the scaffold",
    `Before writing code, ${ask} — one focused question at a time, proposing a default from the ` +
      "PRD — about:",
    "- i18n: languages, message catalog, and the URL language strategy (prefix, domain, none).",
    "- App shell and the shared components every screen reuses.",
    "- CI database strategy: a service container on the SAME major version as production.",
    "- Preview environments (per PR or none).",
    "- Worktree-safe tests: ports and temp paths must never collide between parallel worktrees " +
      "(ephemeral/env-derived ports, per-run temp dirs — no fixed port like 4173).",
    "Record every answer in CLAUDE.md under `## Foundation decisions` and in " +
      "`docs/decisions/0001-foundation.md`.",
    "",
    "## P2 — scaffold",
    "- The framework on the pinned versions; it must build and its checks must pass.",
    "- Design tokens and `app.css` taken from `docs/design` (not reinvented); the app shell from P1.",
    "- i18n catalog per P1 plus a drift gate (catalog key parity) in CI and the pre-push hook.",
    "- A CI workflow with a `quality` job (lint, typecheck, test, dead-code audit) and, when there " +
      "is a database, a `db` job on the P1 service container.",
    "- An env schema; an intent-shaped issue template; dependency automation.",
    "- Every guardrail below — the install steps are Shepherd's Readiness prescriptions:",
    indent(checklistSection(args.stack)),
    "- CLAUDE.md: project orientation, the pinned stack section above, the foundation decisions, " +
      "the exact verify commands, and this design-conformance rule: every UI change ships a light " +
      "AND dark screenshot next to the matching reference screen from `docs/design`. Add this " +
      "section verbatim:",
    indent(GUARDRAIL_BLIND_SPOTS),
    "  Never use the heading `# House rules for AI agents` (Shepherd's Readiness owns it).",
    "",
    "## Done",
    "- The PR is green in CI and leaves the Readiness greenfield must-haves satisfiable: pinned " +
      "stack, scaffold builds, CI on the default branch, git hooks + pre-push, dead-code audit. " +
      "Forge settings are applied by the operator from the Readiness tab — say so in the PR.",
    "- You are attended: ask on genuine product decisions; otherwise keep going until the PR is up.",
  ].join("\n");
}
