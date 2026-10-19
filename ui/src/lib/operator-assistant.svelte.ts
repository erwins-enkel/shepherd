import { SvelteMap } from "svelte/reactivity";
import {
  ASSISTANT_ACTION_GROUPS,
  type AssistantPermissions,
  type OperatorAssistantUnavailableReason,
  type Session,
} from "./types";
import {
  closeOperatorAssistant,
  ensureOperatorAssistant,
  operatorAssistantUnavailableReason,
  resetOperatorAssistant,
} from "./api";

/** A lifecycle request the Operator Assistant panel makes (#1446). `close` ends a repo assistant. */
export type AssistantAction = "ensure" | "reset" | "close";

/** Which body the panel renders. */
export type AssistantPanelView = "spawning" | "unavailable" | "error" | "live";

/** The store setters a request result lands in (HerdStore satisfies this). */
interface AssistantSink {
  setAssistant(session: Session | null): void;
  setAssistantUnavailable(reason: OperatorAssistantUnavailableReason): void;
  dropAssistantScope(repo: string): void;
}

/** An assistant's scope as a map key: a repo assistant's repo path, "" for the global one. */
const key = (repo: string | null) => repo ?? "";

/** The panel's ensure / New-conversation / end requests, per scope (the global assistant, or one
 *  repo's). One runs at a time per scope: a second open or a reset clicked mid-spawn is dropped
 *  here (the server serializes them too). A 503 with a known reason marks the assistant
 *  unavailable; any other failure is kept so the panel can offer Retry, which re-runs the action
 *  that failed. */
export class AssistantLifecycle {
  private readonly pendingBy = new SvelteMap<string, AssistantAction>();
  private readonly failedBy = new SvelteMap<string, AssistantAction>();

  constructor(private readonly sink: AssistantSink) {}

  /** The global assistant's request in flight. */
  get pending(): AssistantAction | null {
    return this.pendingFor(null);
  }

  /** The global assistant's last failed request. */
  get failed(): AssistantAction | null {
    return this.failedFor(null);
  }

  pendingFor(repo: string | null): AssistantAction | null {
    return this.pendingBy.get(key(repo)) ?? null;
  }

  failedFor(repo: string | null): AssistantAction | null {
    return this.failedBy.get(key(repo)) ?? null;
  }

  ensure(repo: string | null = null): Promise<void> {
    return this.run("ensure", repo);
  }

  reset(repo: string | null = null): Promise<void> {
    return this.run("reset", repo);
  }

  /** End a repo's assistant. */
  close(repo: string): Promise<void> {
    return this.run("close", repo);
  }

  retry(repo: string | null = null): Promise<void> {
    return this.run(this.failedFor(repo) ?? "ensure", repo);
  }

  /** Forget a scope's failed request (its entry left the dock). */
  forget(repo: string | null): void {
    this.failedBy.delete(key(repo));
  }

  private async run(action: AssistantAction, repo: string | null): Promise<void> {
    const k = key(repo);
    if (this.pendingBy.has(k)) return;
    this.pendingBy.set(k, action);
    this.failedBy.delete(k);
    try {
      if (action === "close" && repo !== null) {
        await closeOperatorAssistant(repo);
        this.sink.dropAssistantScope(repo);
      } else {
        const { session } =
          action === "reset"
            ? await resetOperatorAssistant(repo)
            : await ensureOperatorAssistant(repo);
        this.sink.setAssistant(session);
      }
    } catch (e) {
      const reason = operatorAssistantUnavailableReason(e);
      if (reason) this.sink.setAssistantUnavailable(reason);
      else this.failedBy.set(k, action);
    } finally {
      this.pendingBy.delete(k);
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

/** One assistant in the dock: the global one (`repo` null) or a repo's. `session` is null while it
 *  spawns, or before the global one was ever opened. */
export interface AssistantEntry {
  repo: string | null;
  session: Session | null;
}

/**
 * The dock's assistants, top to bottom: the global one always first, then every live repo
 * assistant in the order it started, then the repo assistants the operator asked for that have
 * no row yet (spawning, or a failed start) — so a start shows at once, and its error stays put.
 */
export function assistantEntries(
  assistants: Session[],
  requested: readonly string[],
): AssistantEntry[] {
  const global = assistants.find((s) => !s.assistantRepo) ?? null;
  const repos = assistants.filter((s) => s.assistantRepo);
  const live = repos.map((s) => s.assistantRepo);
  return [
    { repo: null, session: global },
    ...repos.map((s) => ({ repo: s.assistantRepo!, session: s })),
    ...requested.filter((r) => !live.includes(r)).map((repo) => ({ repo, session: null })),
  ];
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
