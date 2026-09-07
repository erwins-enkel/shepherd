/**
 * Build the argv for a headless, sandboxed Codex CLI role spawn — the Codex counterpart to the
 * Claude argv each helper role (recap, PR critic, standalone critic, plan reviewer, doc-agent,
 * namer, autopilot stop-classifier) builds for itself.
 *
 * - `codex exec` runs the agent NON-INTERACTIVELY: it consumes the prompt, runs to completion, and
 *   exits — exactly the lifecycle the role services already expect (they poll for a result file
 *   with a timeout after launching the pane).
 * - `--sandbox workspace-write` lets the agent write its verdict/result file into its disposable
 *   working directory while blocking network egress and writes outside the workspace. This is the
 *   Codex analog of the Claude reviewer's read-only allowlist + `--permission-mode dontAsk` sandbox
 *   for inspecting UNTRUSTED input (a PR diff / agent-written plan).
 * - `--thread-source shepherd_role` identifies every newly created helper thread explicitly. This
 *   is separate from rollout `session_meta.source`, which remains `exec` for headless role spawns.
 * - The role PROMPT already instructs the agent to "write your verdict/result to <file>", so it is
 *   reused verbatim as the positional argument — the result contract is identical across CLIs.
 * - `-o <lastMessageFile>` makes the CLI write the agent's FINAL message to a file at exit,
 *   independent of the model calling a write tool. Codex sometimes answers the verdict in chat and
 *   never writes the result file (the recap black-hole in codex-last-message.ts); the role read path
 *   falls back to this file when the result file is absent. The caller supplies the exact filename —
 *   a PER-SPAWN unguessable name for reviewer roles that run in an untrusted checkout, the fixed name
 *   for disposable-tmpdir roles (see codex-last-message.ts). The relative path resolves against the
 *   spawn's cwd, so this stays a plain argv addition (no cwd threading needed).
 *
 * Codex produces no Claude JSONL transcript, so token totals + live tool-use surfacing degrade to
 * null for a Codex role (handled by the callers); the file-based result is unaffected.
 *
 * ── CONFIG ISOLATION — what a role does NOT inherit (issue #2134) ───────────────────────────────
 *
 * `--sandbox workspace-write` constrains what the agent may WRITE. It does not constrain what the
 * agent is WIRED TO. Without the flags below a role loaded the operator's ENTIRE
 * `$CODEX_HOME/config.toml` — MCP servers, connector apps, hooks, exec policy, and the model/effort
 * defaults. Every Claude role has been isolated from the equivalent surface all along
 * (`disableAllHooks`, `--disable-slash-commands`, a per-kind `--allowedTools`, `--permission-mode
 * dontAsk`, plus `--safe-mode` for the mcpIsolated presets — see transient-agent-argv.ts). This
 * closes the Codex side of that asymmetry.
 *
 * The four flags are UNCONDITIONAL: the posture is uniform across every transient kind. The
 * RATIONALE is per-kind, and the MCP consequence differs in kind, not in degree:
 *
 *   reviewer     Untrusted git worktree (the PR head; the trusted merge-base for the plan gate).
 *                `--ignore-user-config` drops `[mcp_servers.*]` — the direct analog of the Claude
 *                reviewer's `--safe-mode`, which likewise disables MCP LOADING. Codex has no
 *                interactive project-MCP approval gate, so there is nothing here for
 *                `enableAllProjectMcpServers` to pre-approve and no analog is emitted.
 *   doc          Same cwd shape, same posture, same MCP consequence as reviewer.
 *   writer-ro    Disposable mkdtemp cwd. STRICTER than its Claude counterpart, deliberately: the
 *   writer-only  Claude writer kinds are NOT mcpIsolated because `dontAsk` + a closed
 *                `--allowedTools` deny every `mcp__*` call at the call site, so a loaded server is
 *                inert there. Codex has NO tool allowlist — nothing would deny that call — so
 *                dropping the config is the ONLY thing keeping these roles away from the operator's
 *                MCP servers and connector apps.
 *
 * Flag by flag:
 *
 *   --ignore-user-config   Do not load `$CODEX_HOME/config.toml`; auth still resolves via
 *                          CODEX_HOME, so role spawns authenticate unchanged. `-m` and `-c`
 *                          overrides still apply on top, so the effort channel below is unaffected.
 *   --ignore-rules         Do not load user OR project execpolicy `.rules`. The PROJECT half is the
 *                          load-bearing one: a `.rules` file committed into an untrusted PR head
 *                          would otherwise widen what the reviewer may run without approval.
 *   --skip-git-repo-check  REQUIRED, not cosmetic. Codex refuses to start unless the cwd is inside a
 *                          git repo or covered by a `[projects.*]` trust entry — and those entries
 *                          live in the config we just stopped loading. Without this flag every
 *                          tmpdir role (writer-ro / writer-only) dies at spawn with "Not inside a
 *                          trusted directory and --skip-git-repo-check was not specified". It is a
 *                          PRECONDITION skip, not a security control: the recorded turn context is
 *                          identical with and without it (approval_policy "never", sandbox
 *                          workspace-write, network_access false, workspace_roots = cwd). Emitted
 *                          unconditionally rather than per-kind so it never rests on an assumption
 *                          about a caller's cwd. It also fixes a LATENT bug that predates this
 *                          change: the tmpdir roles only ever worked on hosts whose config happened
 *                          to carry a trust entry covering the tmp root.
 *   -c project_doc_fallback_filenames=["CLAUDE.md"]
 *                          Re-asserts the ONE inheritance that is wanted. A Claude role reads the
 *                          repo's CLAUDE.md; without this a Codex role in a CLAUDE.md-only repo
 *                          would read no project instructions at all — closing one asymmetry while
 *                          opening another. Dropping it would buy no isolation either:
 *                          `$CODEX_HOME/AGENTS.md` and a repo `AGENTS.md` load either way (residual
 *                          1), so the project-instruction injection surface is unchanged. The key is
 *                          a filename MAPPING — it carries no MCP servers, hooks, connectors or exec
 *                          policy.
 *
 * Two available flags are deliberately NOT used:
 *   --ephemeral                      Would run without persisting session files. Role activity and
 *                                    token totals are read from exactly those rollout files
 *                                    (codex-activity.ts, CodexRolloutResolver — issue #1816), so
 *                                    this would silently zero the telemetry that work exists to
 *                                    provide.
 *   --dangerously-bypass-hook-trust  GRANTS enabled hooks without persisted trust — the opposite of
 *                                    isolation. `--ignore-user-config` already removes user hooks,
 *                                    which is what is actually wanted.
 *
 * ACCEPTED RESIDUALS (documented, not closed — see docs/sandbox-security.md §R4):
 *   1. `$CODEX_HOME/AGENTS.md` still loads. No flag drops it; `--ignore-user-config` covers
 *      `config.toml` only. Symmetric with a Claude role still reading `~/.claude/CLAUDE.md`, so this
 *      is a SHARED residual rather than a new asymmetry.
 *   2. There is no `--allowedTools` analog. A Codex role can still run arbitrary shell inside its
 *      workspace-write sandbox; it cannot be narrowed to the reviewer's read-only tool set, because
 *      `--sandbox read-only` would also block the verdict-file write the result contract needs.
 *      This is the largest remaining Claude↔Codex asymmetry and these flags cannot close it.
 *   3. An operator on a custom `model_provider` (or `--oss`) loses that wiring and falls back to the
 *      default provider. Not guarded: a guard would mean re-reading the very config we ignore.
 *
 * VERSION: verified against codex-cli 0.152.0. The flag names, the trust precondition and the
 * `project_doc_fallback_filenames` key are CLI surface no unit test can assert — re-verify them on a
 * codex upgrade, exactly as the Claude side re-verifies its `tui` and `--safe-mode` gate-clearing.
 */
import { effortForSpawn } from "./default-effort";

export function codexRoleArgv(
  model: string | null,
  prompt: string,
  effort: string | null,
  lastMessageFile: string | null,
): string[] {
  const argv = [
    "codex",
    "exec",
    "--sandbox",
    "workspace-write",
    "--thread-source",
    "shepherd_role",
    // Config isolation — see the header. Unconditional: the posture is uniform across every
    // transient kind. Each is boolean or a single `key=value` pair, so unlike Claude's VARIADIC
    // `--allowedTools` their order carries no correctness meaning; they are grouped here to read as
    // one block, ahead of the optional `-m`/effort/`-o` tail so that tail keeps its relative order.
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "-c",
    'project_doc_fallback_filenames=["CLAUDE.md"]',
  ];
  if (model) argv.push("-m", model);
  const tier = effortForSpawn("codex", effort);
  if (tier) argv.push("-c", `model_reasoning_effort=${tier}`);
  // `-o` is emitted ONLY for roles that READ the last-message fallback. A role that never consumes it
  // (the `doc` kind) passes null: emitting a fixed `-o` target into its worktree — which in retarget
  // mode is an UNTRUSTED PR-head checkout — would let a committed symlink at that path redirect the
  // CLI's final-message write onto a real file. No consumer ⇒ no `-o` ⇒ no such surface.
  if (lastMessageFile !== null) argv.push("-o", lastMessageFile);
  argv.push(prompt);
  return argv;
}
