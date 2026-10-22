// Restart live Claude sessions whose claude.ai-connector setting no longer matches their repo's.
//
// A repo's `claudeAiConnectorsEnabled` is baked into a Claude agent's `--settings` overlay at spawn
// and resume (spawnSettingsOverlay); a live agent cannot pick up a change. So when the operator
// flips the switch, every live Claude session of the repo is force-resumed — the conversation is
// restored, the new overlay applies. Each session records what it was spawned with
// (`Session.claudeAiConnectors`), so the mismatch survives a Shepherd restart and this sweep finds it
// on the next tick.
//
// Only SETTLED sessions are restarted (idle/done for at least `settleMs`): a working or blocked
// session waits until its turn ends, so no turn is cut off. The first idle tick is not "settled",
// per the house rule the build-queue reminder follows too.

import { isOperatorAssistant } from "./operator-assistant-core";
import type { LivenessState, Session } from "./types";
import type { SessionStore } from "./store";

/** Default settle window before a live session is restarted (one 15s tick). */
export const CONNECTOR_RESTART_SETTLE_MS = 15_000;
/** Failed restarts per session and target value before the sweep gives up on it. */
export const CONNECTOR_RESTART_MAX_ATTEMPTS = 3;

export interface ConnectorRestartDeps {
  store: Pick<SessionStore, "list" | "getRepoConfig">;
  /** The poller's folded liveness verdict; only `alive` sessions are restarted. */
  livenessOf: (id: string) => LivenessState | undefined;
  /** SessionService.resume(id, { force: true }); truthy = respawned. */
  resume: (id: string) => Promise<unknown>;
  now?: () => number;
  settleMs?: number;
}

export class ConnectorRestartService {
  private sweeping = false;
  /** Failed attempts per session, keyed to the target value they were for. */
  private attempts = new Map<string, { target: boolean; count: number }>();
  private readonly now: () => number;
  private readonly settleMs: number;

  constructor(private deps: ConnectorRestartDeps) {
    this.now = deps.now ?? Date.now;
    this.settleMs = deps.settleMs ?? CONNECTOR_RESTART_SETTLE_MS;
  }

  /**
   * One pass over the active sessions: restart each settled, live Claude session whose spawn-time
   * connector setting differs from its repo's current one. An overlapping call is dropped (a
   * restart is awaited, and the next tick re-evaluates from fresh state). Resumes run one at a
   * time; a rejected resume counts as a failed attempt rather than aborting the pass.
   */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const active = this.deps.store.list({ activeOnly: true });
      const seen = new Set<string>();
      for (const s of active) {
        seen.add(s.id);
        await this.consider(s);
      }
      for (const id of [...this.attempts.keys()]) if (!seen.has(id)) this.attempts.delete(id);
    } finally {
      this.sweeping = false;
    }
  }

  private async consider(s: Session): Promise<void> {
    if (s.agentProvider === "codex" || isOperatorAssistant(s) || s.terminal) return;
    const target = this.deps.store.getRepoConfig(s.repoPath).claudeAiConnectorsEnabled;
    if ((s.claudeAiConnectors ?? false) === target) {
      this.attempts.delete(s.id);
      return;
    }
    // An exited agent picks the current value up on its next resume; nothing to restart.
    if (this.deps.livenessOf(s.id) !== "alive") return;
    if (s.status !== "idle" && s.status !== "done") return;
    if (s.settledAt == null || this.now() - s.settledAt < this.settleMs) return;

    const prior = this.attempts.get(s.id);
    const count = prior && prior.target === target ? prior.count : 0;
    if (count >= CONNECTOR_RESTART_MAX_ATTEMPTS) return;

    let ok = false;
    try {
      ok = Boolean(await this.deps.resume(s.id));
    } catch (e) {
      console.warn(`[connector-restart] resume of ${s.id} threw:`, e);
    }
    if (ok) {
      this.attempts.delete(s.id);
      console.log(`[connector-restart] restarted ${s.id} with claude.ai connectors ${target}`);
      return;
    }
    this.attempts.set(s.id, { target, count: count + 1 });
    if (count + 1 >= CONNECTOR_RESTART_MAX_ATTEMPTS) {
      console.warn(
        `[connector-restart] giving up on ${s.id} after ${count + 1} failed restarts; ` +
          `it keeps claude.ai connectors ${!target} until its next resume`,
      );
    }
  }
}
