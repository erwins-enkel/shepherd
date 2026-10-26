/**
 * Mid-session reasoning-effort switch for a plan-gated session (#3434): the PTY sequences that
 * change a RUNNING agent's effort for this session only, and the pane text that confirms it.
 *
 * Spike-verified (Claude Code 2.1.310, codex-cli 0.164.0):
 *   - Claude: a typed `/effort <tier>` PERSISTS the tier to the operator's user settings
 *     (`modelSettings.<model>.effortLevel`) — never send it. The session-only path is the picker:
 *     `/effort` opens it, `←`×5 clamps to `low`, `→`×idx walks to the tier, `s` applies it "for
 *     this session only". The picker cannot set `auto` session-only.
 *   - Codex: `/model --reasoning=<tier>` keeps the model and is session-only by construction.
 *
 * Pure: the service owns delivery, the lock and the pane reads. A step counts as confirmed only
 * when its marker's count in the visible pane RISES over the pre-send baseline, so a line left in
 * scrollback by an earlier switch can never confirm a new one.
 */

import type { AgentProvider, Session } from "./types";
import { effortsForProvider } from "./default-effort";

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
/** The Claude picker's levels, least→most; `←` stops at the first. */
const CLAUDE_PICKER = ["low", "medium", "high", "xhigh", "max"] as const;

/** One write-then-confirm step: `send` goes to the PTY (`paste` = bracket-paste + CR, `keys` =
 *  one raw text write), then `confirm` must newly appear in the visible pane. */
export interface EffortSwitchStep {
  kind: "paste" | "keys";
  text: string;
  confirm: RegExp;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The steps that switch a running `provider` agent to `tier` for this session only, or null when
 * the provider cannot reach that tier this way (unknown tier, Claude `ultra`).
 */
export function effortSwitchSteps(
  provider: AgentProvider,
  tier: string,
): EffortSwitchStep[] | null {
  if (!effortsForProvider(provider).includes(tier)) return null;
  if (provider === "codex") {
    return [
      {
        kind: "paste",
        text: `/model --reasoning=${tier}`,
        confirm: new RegExp(`Model changed to \\S+ ${escapeRe(tier)} for this session only`, "g"),
      },
    ];
  }
  const idx = (CLAUDE_PICKER as readonly string[]).indexOf(tier);
  if (idx === -1) return null;
  return [
    { kind: "paste", text: "/effort", confirm: /s for this session only/g },
    {
      kind: "keys",
      text: LEFT.repeat(CLAUDE_PICKER.length) + RIGHT.repeat(idx) + "s",
      confirm: new RegExp(`Set effort level to ${escapeRe(tier)} \\(this session only\\)`, "g"),
    },
  ];
}

/** Occurrences of `re` (a global regex) in `screen`. */
export function countMatches(screen: string, re: RegExp): number {
  return screen.match(new RegExp(re.source, "g"))?.length ?? 0;
}

/** The effort the session's CURRENT phase should run at: the execution selection while
 *  executing (when one is set), else the planning selection. */
export function phaseEffort(
  s: Pick<Session, "planPhase" | "effort" | "executionEffort">,
): string | null {
  return s.planPhase === "executing" && s.executionEffort ? s.executionEffort : s.effort;
}

/** The tier Shepherd last put in force for the running agent (`activeEffort`, falling back to the
 *  spawn selection for rows that predate it). */
export function inForceEffort(s: Pick<Session, "effort" | "activeEffort">): string | null {
  return s.activeEffort === undefined ? s.effort : s.activeEffort;
}

/** A tier `provider` offers, else null. For an execution effort null means inherit (no switch);
 *  for a planning effort, the provider default. */
export function effortForProvider(provider: AgentProvider, value: unknown): string | null {
  return typeof value === "string" && effortsForProvider(provider).includes(value) ? value : null;
}
