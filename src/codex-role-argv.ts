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
 */
import { effortForSpawn } from "./default-effort";

export function codexRoleArgv(
  model: string | null,
  prompt: string,
  effort: string | null,
  lastMessageFile: string,
): string[] {
  const argv = ["codex", "exec", "--sandbox", "workspace-write"];
  if (model) argv.push("-m", model);
  const tier = effortForSpawn("codex", effort);
  if (tier) argv.push("-c", `model_reasoning_effort=${tier}`);
  argv.push("-o", lastMessageFile);
  argv.push(prompt);
  return argv;
}
