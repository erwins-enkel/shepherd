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
 *
 * Codex produces no Claude JSONL transcript, so token totals + live tool-use surfacing degrade to
 * null for a Codex role (handled by the callers); the file-based result is unaffected.
 */
import { effortForSpawn } from "./default-effort";

export function codexRoleArgv(
  model: string | null,
  prompt: string,
  effort: string | null = null,
): string[] {
  const argv = ["codex", "exec", "--sandbox", "workspace-write"];
  if (model) argv.push("-m", model);
  const tier = effortForSpawn("codex", effort);
  if (tier) argv.push("-c", `model_reasoning_effort=${tier}`);
  argv.push(prompt);
  return argv;
}
