import { githubBudget, type GithubBackoff } from "./agent-control";
import { isOperatorAssistant } from "./operator-assistant-core";
import { isShelved } from "./shelve";
import { isUsagePaused } from "./schedule-pause";
import type { Session } from "./types";

/** A window lifting sooner than this is not worth interrupting anyone for. */
const MIN_WINDOW_MS = 60_000;

/** How long past the reset a session was told it stays unsteered. A re-engagement or extension
 *  inside that gap (e.g. the 240s and 480s strikes of an escalating cooldown) sends nothing; a
 *  session still blocked after it is steered again, with the later reset. */
const EPISODE_GAP_MS = 5 * 60_000;

/**
 * The agent-facing backoff steer (#2946). Typed into the PTY, so fixed English — same precedent as
 * ciFinishedSteer. Exported for tests.
 */
export function rateLimitSteer(blockedUntil: string): string {
  return (
    `Shepherd: GitHub's API budget is drained until ${blockedUntil}. Make no \`gh\` calls ` +
    "before then — keep working locally; `git commit` and `git push` are fine. " +
    "`self_status` `github.blockedUntil` has the live reset."
  );
}

export interface RateLimitSteerDeps {
  /** The three trackers, read live — the same snapshot `self_status` reports from. */
  backoff: () => GithubBackoff;
  /** Active sessions (store.list({ activeOnly: true })). */
  sessions: () => Session[];
  /** Steer a LIVE pane only — never resume an exited agent for this. */
  reply: (id: string, text: string) => Promise<boolean>;
  now: () => number;
}

/** A working agent that has `self_status` and the rate-limit notice: Claude-family, non-plain,
 *  not the operator assistant, not shelved. Idle/blocked sessions are never woken. */
function steerable(s: Session): boolean {
  return (
    s.status === "running" &&
    !s.terminal &&
    !s.plain &&
    s.agentProvider !== "codex" &&
    !isOperatorAssistant(s) &&
    !isUsagePaused(s) &&
    !isShelved(s)
  );
}

/**
 * Push one steer per GraphQL backoff episode to each working agent (#2946), so an agent mid-retry or
 * about to start a `gh`-heavy step learns the real reset without its own call failing first. Any
 * GraphQL engagement counts — a limit error or Shepherd's own floor. The reset shown (and the 60s
 * minimum) is `githubBudget`'s combined `blockedUntil`, the value `self_status` reports.
 *
 * Dedup is per session on the reset it was told: no new steer until that reset is
 * {@link EPISODE_GAP_MS} past. So a long outage steers at most once per told reset + gap — an
 * escalating 120s→240s→480s→15m cooldown steers twice (120s, then 15m). Call
 * `tick()` periodically: a session that starts working mid-episode is steered on the next tick, and
 * a window that first lifts within {@link MIN_WINDOW_MS} is steered once it is extended. In-memory.
 */
export function createRateLimitSteer(deps: RateLimitSteerDeps): { tick: () => void } {
  /** Session id → the reset (epoch ms) it was last steered with. */
  const told = new Map<string, number>();

  return {
    tick() {
      const now = deps.now();
      for (const [id, until] of told) if (now >= until + EPISODE_GAP_MS) told.delete(id);
      const b = deps.backoff();
      if (!b.graphql.blocked) return;
      const until = githubBudget(b, now).blockedUntil;
      const untilMs = until === null ? 0 : Date.parse(until);
      if (until === null || untilMs - now < MIN_WINDOW_MS) return;
      const text = rateLimitSteer(until);
      for (const s of deps.sessions()) {
        if (told.has(s.id) || !steerable(s)) continue;
        told.set(s.id, untilMs); // before the send: no retry spam, no double send on an overlapping tick
        void deps.reply(s.id, text).catch((err) => console.warn("[rate-limit-steer] steer:", err));
      }
    },
  };
}
