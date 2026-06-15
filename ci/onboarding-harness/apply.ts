import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IncusDriver } from "./incus";
import { remediationsFor } from "../../src/remediations";
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

/** Run each harness-catalog remediation (keyed by Shepherd's emitted hintKeys)
 *  verbatim inside the instance. Returns false if any command exits non-zero. */
export async function applyVerbatim(
  driver: IncusDriver,
  name: string,
  snapshot: DiagnosticsSnapshot,
): Promise<boolean> {
  for (const cmd of remediationsFor(snapshot)) {
    const r = await driver.exec(name, ["sh", "-c", cmd]);
    if (r.code !== 0) return false;
  }
  return true;
}
