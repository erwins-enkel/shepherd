import { randomUUID } from "node:crypto";
import { apiKeySettingsFragment } from "./spawn-auth";
import { codexRoleArgv } from "./codex-role-argv";
import { CODEX_LAST_MESSAGE_FILE, codexLastMessageFile } from "./codex-last-message";
import { effortForSpawn } from "./default-effort";
import type { AgentProvider } from "./types";

/**
 * One home for the transient-`claude` argv shape that 10 spawn sites used to re-assemble
 * byte-for-byte (issue #1093). A transient agent is a short-lived, non-interactive-to-the-operator
 * `claude` spawned in a herdr pane to do one unattended job (review, name, classify, distill,
 * recap, …) and then be torn down. They all share the SAME hard-won invocation posture; only the
 * tool allowlist and MCP isolation vary, and that variation is captured in {@link PRESETS}.
 *
 * ── The MECHANICAL invariant (universal — this is why it lives here ONCE) ───────────────────────
 *
 *   claude
 *     --session-id <uuid>          forced so the transcript lands at a predictable path
 *     --settings <json>            { disableAllHooks:true, [enableAllProjectMcpServers:true],
 *                                    ...apiKeySettingsFragment() }
 *     --disable-slash-commands
 *     [--safe-mode]                emitted IFF the preset is mcpIsolated (see coupling note)
 *     --allowedTools <tools…>      VARIADIC — swallows every following token until the next --flag
 *     [--model <model>]            emitted IFF opts.model is truthy
 *     --permission-mode dontAsk    single-value flag — MUST sit between the variadic allowlist
 *                                  and the trailing prompt positional, or `claude` folds the prompt
 *                                  into the allowlist, launches with no task, and the unattended
 *                                  pane hangs until timeout. DON'T REORDER.
 *     <prompt>                     trailing positional, last
 *
 * NOT --dangerously-skip-permissions and NOT --bare:
 *   - dontAsk auto-denies anything off the allowlist (an unattended PTY would otherwise hang on a
 *     permission prompt) without granting blanket exec.
 *   - --bare refuses OAuth/keychain auth (strictly ANTHROPIC_API_KEY); shepherd defaults to
 *     subscription OAuth with no API key, so --bare would break auth. In api-key auth mode the key
 *     arrives via `apiKeyHelper` folded into --settings (NOT --bare) plus a credential-less
 *     CLAUDE_CONFIG_DIR supplied by the caller's spawn env (see spawn-auth / spawn-membrane).
 * disableAllHooks strips inherited global hooks (notably a superpowers SessionStart "you MUST
 * invoke a skill" preamble that would thrash an agent whose allowlist lacks Skill);
 * --disable-slash-commands removes skills entirely.
 *
 * --settings key order is preserved (disableAllHooks first, then enableAllProjectMcpServers, then
 * the apiKeySettingsFragment() spread) so subscription mode stays BYTE-FOR-BYTE identical to the
 * historical per-site output — the consumer argv tests are the byte-identity regression gate.
 *
 * ── MCP isolation: ONE coupled field, not two independent flags ─────────────────────────────────
 *
 * `--safe-mode` and `enableAllProjectMcpServers` MUST travel together and are modeled as a single
 * preset field, `mcpIsolated`, so they cannot drift apart:
 *   (1) --safe-mode disables MCP *loading* (file + plugin sources) and other customizations while
 *       keeping Auth/tools/permissions normal — the OAuth-safe alternative to --bare. It is a
 *       boolean flag and MUST precede the variadic --allowedTools.
 *   (2) enableAllProjectMcpServers pre-approves the repo's project .mcp.json so Claude's interactive
 *       "N new MCP servers found" gate never renders (that gate is SEPARATE from loading; neither
 *       --safe-mode nor dontAsk suppresses it on an interactive pane, and a fresh disposable-worktree
 *       path makes the servers look "newly discovered" every time → invisible hang).
 * COUPLING: dropping --safe-mode while enableAllProjectMcpServers is true would auto-LOAD every
 * project MCP server into an untrusted-input sandbox. Safety rests on two independent axes —
 * --safe-mode (servers don't load) and dontAsk (any MCP tool call is denied off the allowlist).
 * VERSION: gate-clearing is verified on the Claude CLI in use and depends on Claude's project-MCP
 * approval semantics, which no unit test can assert. Re-run the manual repro (temp repo with a
 * committed .mcp.json → reviewer launches with no gate and runs to completion) on every CLI upgrade.
 */

export type TransientAgentKind = "reviewer" | "doc" | "writer-ro" | "writer-only";

export interface TransientAgentArgvOptions {
  /** Which CLI to spawn. Defaults to "claude" (the historical posture below). "codex" routes to a
   *  headless `codex exec` instead — the file-based result contract is identical across CLIs, so the
   *  caller's verdict/result reading is unchanged; only the spawn argv differs. */
  provider?: AgentProvider;
  /** Model to pin, or null to inherit the spawn default. `--model` is emitted only when truthy. */
  model: string | null;
  /** The agent's task — the trailing positional. */
  prompt: string;
  /** Optional reasoning-effort tier; emits `--effort` (Claude) / `-c model_reasoning_effort=`
   *  (Codex) when set. Opt-in per call site — most transient roles omit it. In-repo the plan
   *  reviewer (plan-gate.ts) and both PR-critic sites (review.ts, standalone-critic.ts) pass it;
   *  on the critic this is the reasoning channel that replaced the retired thinking-budget env
   *  channel (issue #1419), running at `--effort high` by default. */
  effort?: string | null;
  /** OPT-IN: emit the Codex `-o` last-message file so the CLI captures the agent's final message even
   *  when it answers in chat instead of writing the result file (see codex-last-message.ts). Set ONLY
   *  by roles that actually READ that fallback (recap, autopilot, rundown, distiller, optimizer,
   *  merge-suggest, and the reviewers). Roles that read only their own sentinel/result file — the
   *  namer (`.shepherd-name`), verify-key (`.shepherd-verify`), doc-agent (edits + sentinel) — leave
   *  it unset so they carry NO `-o`, and thus no Codex `-o`/version-floor dependency they don't need
   *  (nor, for the checkout-running kinds, a fixed `-o` target a committed symlink could redirect).
   *  Claude spawns ignore it (Claude has no `-o`). Default false. */
  captureLastMessage?: boolean;
}

/** Read-only git grounding — diff/log/show/status only. NO add/commit/push. Shared by reviewer+doc. */
const READONLY_GIT = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff *)",
  "Bash(git log *)",
  "Bash(git show *)",
  "Bash(git status)",
];

interface KindPreset {
  /** The exact --allowedTools set for this kind. */
  allowedTools: string[];
  /** true → emit BOTH --safe-mode AND enableAllProjectMcpServers (the coupled MCP-isolation pair). */
  mcpIsolated: boolean;
}

/**
 * Per-kind variation. The SECURITY rationale lives here (not flattened into the header) because
 * input trust differs by kind:
 *
 *  - `reviewer`  UNTRUSTED input (PR diff / agent-written plan text). Closed read-only allowlist —
 *                a prompt-injection hidden in the input must not exec, commit, push, or escape the
 *                disposable worktree. Bare `Write` (NOT path-scoped — scoped Write is silently denied
 *                under dontAsk) lets it write its verdict; the worktree is detached + disposable.
 *  - `doc`       UNTRUSTED input (recent source history). Same posture as reviewer; the ONLY widening
 *                is bare `Edit` — it edits existing prose pages. NO git mutation / gh / network / general
 *                Bash; all publishing is done by the trusted server, never the agent.
 *  - `writer-ro` UNTRUSTED input (agent/repo text: learnings, agent-authored rule text). Read-only
 *                inspection + bare `Write`. Not mcpIsolated: runs in a scratch dir with no project
 *                .mcp.json, so the MCP gate never arises.
 *  - `writer-only` MIXED trust — do NOT assume untrusted input here. Some callers pass the operator's
 *                OWN text (namer: the task prompt; verify-key: a fixed sentinel), others pass untrusted
 *                text (autopilot: agent-stop tail; recap / herd-digest: session transcript). Bare
 *                `Write` is acceptable across all of them because of the SANDBOX SHAPE — a disposable
 *                temp dir, dontAsk, and no exec/Edit/network on the allowlist — which holds regardless
 *                of input trust, NOT because the input is untrusted.
 */
const PRESETS: Record<TransientAgentKind, KindPreset> = {
  reviewer: { allowedTools: [...READONLY_GIT, "Write"], mcpIsolated: true },
  doc: { allowedTools: [...READONLY_GIT, "Write", "Edit"], mcpIsolated: true },
  "writer-ro": { allowedTools: ["Read", "Grep", "Glob", "Write"], mcpIsolated: false },
  "writer-only": { allowedTools: ["Write"], mcpIsolated: false },
};

/** The exact `--allowedTools` set a transient kind runs with. Exported as the SINGLE SOURCE for
 *  tests that must assert a prompt only names commands the role can actually run: the critic runs
 *  under `--permission-mode dontAsk`, so a command outside this list is auto-DENIED (silently — not
 *  a prompt), which would make the instruction that names it inert. `PRESETS` itself stays private.
 *  Returns a copy — callers must not mutate the preset. */
export function allowedToolsFor(kind: TransientAgentKind): string[] {
  return [...PRESETS[kind].allowedTools];
}

/** child_process.spawn rejects any argv arg containing a NUL. Keep one shared prompt sanitizer so
 *  Claude and Codex transient roles have the same contract. */
function sanitizePromptArg(prompt: string): string {
  return prompt.replaceAll("\0", "\\0");
}

/**
 * Build the argv (and the forced session id) for a transient `claude` agent of the given kind.
 * Returns the pinned `--session-id` so callers can locate the spawn's transcript. Pure: no I/O,
 * no spawn, no membrane wrapping — those stay at each call site (the auth seam is unchanged).
 */
export function buildTransientAgentArgv(
  kind: TransientAgentKind,
  opts: TransientAgentArgvOptions,
): { argv: string[]; sessionId: string } {
  const preset = PRESETS[kind];
  const sessionId = randomUUID();

  // Codex CLI path: a headless, workspace-write-sandboxed `codex exec` runs the same prompt (which
  // writes the kind's result/verdict file). None of the Claude-only flags (--settings, --safe-mode,
  // --allowedTools) have a Codex equivalent; the sandbox shape is enforced by
  // `--sandbox workspace-write`.
  //
  // The `-o` last-message file is emitted ONLY when the CALLER opts in (`captureLastMessage`) — i.e.
  // the role actually READS the fallback. Capture is a per-ROLE property, orthogonal to `kind` (which
  // governs the tool allowlist / MCP isolation): the shared `writer-only` kind covers both consumers
  // (recap/autopilot/rundown) and non-consumers (namer, verify-key), so the kind alone can't decide.
  // When capture is on, the NAME is chosen for the kind's trust posture:
  //   - `reviewer` runs in an UNTRUSTED checkout (the PR critics) → a PER-SPAWN unguessable name, so a
  //     PR can't pre-commit a file matching what the real run writes/reads (see codex-last-message.ts).
  //     The read side reconstructs it from the `sessionId` returned here.
  //   - every consuming tmpdir kind (`writer-ro`/`writer-only`) → the fixed name, safe in a fresh dir.
  // Non-consumers (namer, verify-key, doc) never set the flag → NO `-o`, so they carry no Codex
  // `-o`/version-floor dependency, and a checkout-running non-consumer (doc, retarget = PR head sha)
  // exposes no fixed `-o` target a committed symlink could redirect onto a real file.
  if (opts.provider === "codex") {
    const lastMessageFile = !opts.captureLastMessage
      ? null
      : kind === "reviewer"
        ? codexLastMessageFile(sessionId)
        : CODEX_LAST_MESSAGE_FILE;
    return {
      argv: codexRoleArgv(
        opts.model,
        sanitizePromptArg(opts.prompt),
        opts.effort ?? null,
        lastMessageFile,
      ),
      sessionId,
    };
  }

  const settings: Record<string, unknown> = { disableAllHooks: true };
  if (preset.mcpIsolated) settings.enableAllProjectMcpServers = true;
  // api-key mode folds in `apiKeyHelper` AFTER the existing keys (stable order; subscription spreads
  // {} → byte-identical JSON). The membrane masks the operator's OAuth credential in place.
  Object.assign(settings, apiKeySettingsFragment());

  const argv = [
    "claude",
    "--session-id",
    sessionId,
    "--settings",
    JSON.stringify(settings),
    "--disable-slash-commands",
  ];
  if (preset.mcpIsolated) argv.push("--safe-mode");
  argv.push("--allowedTools", ...preset.allowedTools);
  if (opts.model) argv.push("--model", opts.model);
  const effortTier = effortForSpawn("claude", opts.effort ?? null);
  if (effortTier) argv.push("--effort", effortTier);
  argv.push("--permission-mode", "dontAsk");
  // child_process.spawn REJECTS any argv arg containing a NUL ("must be a string without null
  // bytes") — a hard throw, not a transient failure. The prompt is the ONLY argv slot that carries
  // untrusted free text (plan / PR diff / issue body / repo rule / recap), and a stray \0 in
  // agent-written text (e.g. the composite-key idiom `${slug}\0${forkOwner}`) would crash EVERY
  // transient spawn site (issue #1235). Replace each NUL with its visible 2-char escape `\0` rather
  // than stripping it, so the surrounding text's meaning survives for the reading agent. NUL is the
  // only spawn-illegal char; other control chars are legal in argv and left untouched.
  argv.push(sanitizePromptArg(opts.prompt));

  return { argv, sessionId };
}
