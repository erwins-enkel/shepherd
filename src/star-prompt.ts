import type { SessionStore } from "./store";

/** The repo we ask the operator to star. Owner/name only — the gh PUT below
 *  prefixes `/user/starred/`. Module-local (not config) because it is the
 *  identity of *this* product, not a per-install knob. */
const STAR_REPO_SLUG = "erwins-enkel/shepherd";

/** Don't nudge until Shepherd has been in use for this long — a gentle ask that
 *  only lands once the tool has had a chance to prove useful (mirrors herdr's
 *  "if herdr has been useful, star it?" after an update). */
export const STAR_ELIGIBLE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

/** "Remind me in 3 days" pushes the next prompt out by this long. */
export const STAR_SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;

/** Settings KV key holding the JSON-encoded `StarPromptState`. */
export const STAR_SETTING_KEY = "starPrompt";

/** What the client needs to decide whether (and what) to render. */
export interface StarPromptStatus {
  /** Show the nudge right now? False once dismissed/starred/snoozed or still inside the grace window. */
  shouldPrompt: boolean;
  /** Already starred — terminal state, so the nudge never returns. (The thank-you
   *  is shown client-side off the star action's result, not this flag.) */
  starred: boolean;
}

/** Durable per-install state. `firstSeenAt` is stamped on first ever boot and is
 *  the anchor for the grace window; the rest are terminal/temporary flags set by
 *  the operator's choice in the nudge. */
export interface StarPromptState {
  firstSeenAt: number;
  /** Operator chose "no thanks" — never ask again. */
  dismissed?: boolean;
  /** The repo was starred — never ask again. */
  starred?: boolean;
  /** Operator chose "remind me later" — suppress until this timestamp. */
  snoozeUntil?: number;
}

/** Pure decision: is the nudge eligible to show at `now`? Terminal flags win,
 *  then an active snooze, then the grace window. Exported for direct unit tests. */
export function computeShouldPrompt(state: StarPromptState, now: number): boolean {
  if (state.dismissed || state.starred) return false;
  if (state.snoozeUntil && now < state.snoozeUntil) return false;
  return now - state.firstSeenAt >= STAR_ELIGIBLE_AFTER_MS;
}

export interface StarPromptDeps {
  /** Durable KV; only the two settings methods are used. */
  store: Pick<SessionStore, "getSetting" | "setSetting">;
  /** Async `gh` runner — same shape index.ts already injects elsewhere. Throws on
   *  a non-zero exit (e.g. gh not authed), which surfaces as a failed star. */
  gh: (args: string[]) => Promise<string>;
  /** Clock injection for tests; defaults to Date.now. */
  now?: () => number;
  /** Fired after any state mutation so the server can push the fresh status to
   *  every connected client (closing the prompt everywhere once it's resolved). */
  onChange?: (status: StarPromptStatus) => void;
}

/**
 * Tracks a once-per-install "star us on GitHub?" nudge. After the operator has
 * used Shepherd for {@link STAR_ELIGIBLE_AFTER_MS} it asks — gently, non-blocking
 * — whether to star {@link STAR_REPO_SLUG} with their `gh` account. The operator
 * can star (one-click via their existing gh auth), snooze 3 days, or dismiss for
 * good. State is durable in the settings KV so the choice survives restarts and
 * is shared across browsers/devices (it's about the install, not the tab).
 *
 * Constructing the service seeds `firstSeenAt` on the very first boot, so the
 * grace window is anchored to first use.
 */
export class StarPromptService {
  private readonly store: StarPromptDeps["store"];
  private readonly gh: StarPromptDeps["gh"];
  private readonly now: () => number;
  private readonly onChange: (status: StarPromptStatus) => void;

  constructor(deps: StarPromptDeps) {
    this.store = deps.store;
    this.gh = deps.gh;
    this.now = deps.now ?? (() => Date.now());
    this.onChange = deps.onChange ?? (() => {});
    // Seed first-use on the first ever construction so the grace window starts now.
    this.read();
  }

  /** Read the persisted state, self-seeding `firstSeenAt` on first boot or if the
   *  stored value is missing/corrupt. Always returns a usable state. */
  private read(): StarPromptState {
    const raw = this.store.getSetting(STAR_SETTING_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as StarPromptState;
        if (parsed && typeof parsed.firstSeenAt === "number") return parsed;
      } catch {
        // corrupt JSON — fall through and re-seed
      }
    }
    const seeded: StarPromptState = { firstSeenAt: this.now() };
    this.write(seeded);
    return seeded;
  }

  private write(state: StarPromptState): void {
    this.store.setSetting(STAR_SETTING_KEY, JSON.stringify(state));
  }

  private statusFrom(state: StarPromptState): StarPromptStatus {
    return { shouldPrompt: computeShouldPrompt(state, this.now()), starred: !!state.starred };
  }

  /** Persist `state`, emit the recomputed status, and return it. */
  private commit(state: StarPromptState): StarPromptStatus {
    this.write(state);
    const status = this.statusFrom(state);
    this.onChange(status);
    return status;
  }

  /** Current nudge status for GET / client bootstrap. */
  status(): StarPromptStatus {
    return this.statusFrom(this.read());
  }

  /** "No thanks" — never ask again. */
  dismiss(): StarPromptStatus {
    return this.commit({ ...this.read(), dismissed: true });
  }

  /** "Remind me in 3 days" — suppress the nudge for {@link STAR_SNOOZE_MS}. */
  snooze(): StarPromptStatus {
    return this.commit({ ...this.read(), snoozeUntil: this.now() + STAR_SNOOZE_MS });
  }

  /** Star the repo with the operator's gh account, then mark it starred so the
   *  nudge never returns. Throws if the gh call fails (caller maps to an error
   *  response); state is only flipped after a successful star. */
  async star(): Promise<StarPromptStatus> {
    await this.gh(["api", "--method", "PUT", `/user/starred/${STAR_REPO_SLUG}`]);
    return this.commit({ ...this.read(), starred: true });
  }
}
