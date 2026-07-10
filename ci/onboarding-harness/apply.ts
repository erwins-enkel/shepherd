import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IncusDriver } from "./incus";
import { remediationEntriesFor } from "../../src/remediations";
import type { DiagnosticsSnapshot } from "../../src/types";

export interface CoachingLine {
  id: string;
  text: string;
}

/** Pure: resolve every non-ok check's hintKey to the user-visible EN string
 *  (falling back to the raw key). This is exactly the coaching a new user reads. */
export function resolveCoaching(
  snapshot: DiagnosticsSnapshot,
  messages: Record<string, string>,
): CoachingLine[] {
  return snapshot.checks
    .filter((c) => c.state !== "ok")
    .map((c) => ({ id: c.id, text: messages[c.hintKey] ?? c.hintKey }));
}

/** Pure: the proxy-user prompt — only what a real user sees, plus the goal. */
export function buildAgentPrompt(lines: CoachingLine[]): string {
  const coaching = lines.map((l) => `- (${l.id}) ${l.text}`).join("\n");
  return [
    "You are a new user setting up Shepherd on this machine.",
    "Shepherd's onboarding screen shows these issues and advice:",
    "",
    coaching,
    "",
    "Follow this advice to get the machine to a healthy state. Use the shell.",
    "Do not invent steps beyond what the advice implies. Stop when done.",
  ].join("\n");
}

/** Load the EN catalog once (the user-visible coaching source of truth). */
function loadEnMessages(): Record<string, string> {
  const p = join(import.meta.dir, "..", "..", "ui", "messages", "en.json");
  return JSON.parse(readFileSync(p, "utf8")) as Record<string, string>;
}

/** Run the proxy-user agent inside the instance to act on the coaching. Returns
 *  the agent's exit code (0 ⇒ it believes it finished). Auth is provided by a
 *  ~/.claude credential mounted into the instance by run.ts. */
export async function applyAgent(
  driver: IncusDriver,
  name: string,
  snapshot: DiagnosticsSnapshot,
): Promise<number> {
  const lines = resolveCoaching(snapshot, loadEnMessages());
  if (lines.length === 0) return 0;
  const prompt = buildAgentPrompt(lines);
  const r = await driver.exec(name, [
    "sh",
    "-c",
    `claude -p ${shellQuote(prompt)} --permission-mode dontAsk --allowedTools Bash`,
  ]);
  return r.code;
}

/** Minimal single-quote shell escape for embedding the prompt safely. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Run one remediation inside the instance with a bounded retry, so a single transient
 *  network/mirror flake in a download-and-install command doesn't fail the apply (#1577).
 *  Returns the final exit code (0 ⇒ it eventually succeeded within `attempts`). */
async function runWithRetry(
  driver: IncusDriver,
  name: string,
  cmd: string,
  attempts: number,
  delayMs: number,
): Promise<number> {
  let code = 0;
  for (let i = 1; i <= attempts; i++) {
    const r = await driver.exec(name, ["sh", "-c", cmd]);
    code = r.code;
    if (code === 0) return 0;
    if (i < attempts) await sleep(delayMs);
  }
  return code;
}

/** Options for {@link applyVerbatim}. `attempts`/`delayMs` bound the per-remediation
 *  transient-flake retry; tests pass `delayMs: 0` to stay instant. */
export interface ApplyVerbatimOpts {
  attempts?: number;
  delayMs?: number;
}

/** Run each harness-catalog remediation (keyed by Shepherd's emitted hintKeys) verbatim
 *  inside the instance, each with a bounded retry. Returns false when a REQUIRED
 *  (non-optional) remediation still fails after its retries — that's a real regression and
 *  must gate. A failing OPTIONAL-state remediation (an equivalent alternative is already
 *  healthy — e.g. a broken third-party `codex` installer while `claude` is present) is
 *  logged and skipped, never fatal: it must not red the release gate for an unrelated
 *  defect (#1577). */
export async function applyVerbatim(
  driver: IncusDriver,
  name: string,
  snapshot: DiagnosticsSnapshot,
  opts: ApplyVerbatimOpts = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 2;
  const delayMs = opts.delayMs ?? 3000;
  for (const { id, cmd, optional } of remediationEntriesFor(snapshot)) {
    // Retry guards a REQUIRED remediation against a transient flake that would red the
    // gate. An optional remediation's failure is non-fatal anyway, so retrying a
    // structurally-broken optional installer (e.g. codex) only burns a needless attempt +
    // sleep every run — attempt it once, then skip. (#1577)
    const code = await runWithRetry(driver, name, cmd, optional ? 1 : attempts, delayMs);
    if (code !== 0) {
      if (optional) {
        console.log(
          `[${name}] optional remediation for ${id} failed (exit ${code}); ` +
            `continuing — not fatal to the apply`,
        );
        continue;
      }
      return false;
    }
  }
  return true;
}
