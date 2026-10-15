import {
  ASSISTANT_ACTION_GROUPS,
  type AssistantPermissions,
  type OperatorAssistantUnavailableReason,
  type Session,
} from "./types";
import {
  ensureOperatorAssistant,
  operatorAssistantUnavailableReason,
  resetOperatorAssistant,
} from "./api";

/** A lifecycle request the Operator Assistant panel makes (#1446). */
export type AssistantAction = "ensure" | "reset";

/** Which body the panel renders. */
export type AssistantPanelView = "spawning" | "unavailable" | "error" | "live";

/** The store setters a request result lands in (HerdStore satisfies this). */
interface AssistantSink {
  setAssistant(session: Session | null): void;
  setAssistantUnavailable(reason: OperatorAssistantUnavailableReason): void;
}

/** The panel's ensure / New-conversation requests. One runs at a time: a second open or a reset
 *  clicked mid-spawn is dropped here (the server serializes them too). A 503 with a known reason
 *  marks the assistant unavailable; any other failure is kept so the panel can offer Retry, which
 *  re-runs the action that failed. */
export class AssistantLifecycle {
  pending = $state<AssistantAction | null>(null);
  failed = $state<AssistantAction | null>(null);

  constructor(private readonly sink: AssistantSink) {}

  ensure(): Promise<void> {
    return this.run("ensure");
  }

  reset(): Promise<void> {
    return this.run("reset");
  }

  retry(): Promise<void> {
    return this.run(this.failed ?? "ensure");
  }

  private async run(action: AssistantAction): Promise<void> {
    if (this.pending) return;
    this.pending = action;
    this.failed = null;
    try {
      const { session } =
        action === "ensure" ? await ensureOperatorAssistant() : await resetOperatorAssistant();
      this.sink.setAssistant(session);
    } catch (e) {
      const reason = operatorAssistantUnavailableReason(e);
      if (reason) this.sink.setAssistantUnavailable(reason);
      else this.failed = action;
    } finally {
      this.pending = null;
    }
  }
}

/** The panel body for the current state. Unavailable wins: it explains why nothing else can show.
 *  A failed request beats a spawn, and a reset hides the conversation it is replacing. */
export function assistantPanelView(s: {
  session: Session | null;
  available: boolean | null;
  pending: AssistantAction | null;
  failed: AssistantAction | null;
}): AssistantPanelView {
  if (s.available === false) return "unavailable";
  if (s.failed) return "error";
  if (!s.session || s.pending === "reset") return "spawning";
  return "live";
}

/** The panel chip's one-word mode — the server's rule (src/operator-assistant-permissions.ts):
 *  acts = something runs without asking (an allowed group, or the whole shell); readonly = no
 *  action group is on; asks = everything else. */
export type AssistantMode = "readonly" | "asks" | "acts";

export function assistantMode(p: AssistantPermissions): AssistantMode {
  if (p.shell === "all" || ASSISTANT_ACTION_GROUPS.some((g) => p[g] === "allow")) return "acts";
  if (ASSISTANT_ACTION_GROUPS.every((g) => p[g] === "off")) return "readonly";
  return "asks";
}
