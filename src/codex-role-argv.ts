/**
 * Build the argv for a headless, sandboxed Codex CLI role spawn — the Codex counterpart to the
 * Claude argv each helper role (recap, PR critic, standalone critic, plan reviewer, doc-agent,
 * namer, autopilot stop-classifier) builds for itself.
 *
 * - `codex exec` runs NON-INTERACTIVELY to completion and exits — the lifecycle the role services
 *   expect (they poll for a result file with a timeout).
 * - `--sandbox workspace-write` allows the verdict/result write into the disposable cwd while
 *   blocking network egress and writes outside the workspace — the Codex analog of the Claude
 *   reviewer's read-only allowlist + `dontAsk` for UNTRUSTED input.
 * - `--thread-source shepherd_role` tags every helper thread (rollout `session_meta.source` stays
 *   `exec`).
 * - The role prompt already says "write your verdict/result to <file>", so it is the positional
 *   argument verbatim — the result contract is identical across CLIs.
 * - `-o <lastMessageFile>` writes the FINAL message to a file at exit, the fallback when Codex
 *   answers in chat without writing the result file. The caller picks the name (per-spawn
 *   unguessable in untrusted checkouts, fixed in disposable tmpdirs — see codex-last-message.ts);
 *   the relative path resolves against the spawn's cwd.
 *
 * Codex produces no Claude JSONL transcript, so token totals + live tool-use surfacing are null
 * for a Codex role (callers handle it); the file-based result is unaffected.
 *
 * CONFIG ISOLATION (unconditional, every kind): `--ignore-user-config --ignore-rules
 * --skip-git-repo-check -c project_doc_fallback_filenames=["CLAUDE.md"]`; `--ephemeral` and
 * `--dangerously-bypass-hook-trust` are deliberately NOT used. Per-kind rationale, why each flag is
 * needed, and the accepted residuals: docs/sandbox-security.md#r4--prompt-injection-posture.
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
  outputSchemaFile: string | null = null,
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
  const tier = effortForSpawn(effort);
  if (tier) argv.push("-c", `model_reasoning_effort=${tier}`);
  // `-o` is emitted ONLY for roles that READ the last-message fallback. A role that never consumes it
  // (the `doc` kind) passes null: emitting a fixed `-o` target into its worktree — which in retarget
  // mode is an UNTRUSTED PR-head checkout — would let a committed symlink at that path redirect the
  // CLI's final-message write onto a real file. No consumer ⇒ no `-o` ⇒ no such surface.
  if (lastMessageFile !== null) argv.push("-o", lastMessageFile);
  // Shape and destination are independent: the schema constrains the final response, while `-o`
  // still delivers it to the existing fallback reader. Only structured-result consumers opt in.
  if (outputSchemaFile !== null) argv.push("--output-schema", outputSchemaFile);
  argv.push(prompt);
  return argv;
}
