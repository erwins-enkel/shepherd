import type { Steer } from "./types";
import { getSteers, putSteers } from "./api";

/** Backfill surface scopes a pre-scopes payload may omit (e.g. an older backend
 *  during a rolling upgrade), so a steer missing inSteerBar/onIssues defaults to a
 *  bar chip instead of vanishing from every surface. Mirrors the server normalize();
 *  emoji stays optional (server-side migration assigns legacy defaults). */
function normalize(s: Steer & { inSteerBar?: boolean; onIssues?: boolean }): Steer {
  const agentProviders =
    s.agentProviders && s.agentProviders.length === 1 ? s.agentProviders : undefined;
  return {
    ...s,
    inSteerBar: s.inSteerBar ?? true,
    onIssues: s.onIssues ?? false,
    ...(agentProviders ? { agentProviders } : { agentProviders: undefined }),
  };
}

// Client cache of the saved canned steers. Loaded once on app start; every
// mutation persists to the server and adopts the normalized result.
class SteersStore {
  list = $state<Steer[]>([]);
  loaded = $state(false);
  error = $state<string | null>(null);

  // In-memory scratch slot for an in-progress, still-invalid new steer row carried across
  // a Settings-dialog close→reopen within the same page session. Never sent to the server
  // (an invalid steer can't persist) and never written to localStorage — a full page reload
  // intentionally discards a never-valid draft. Populated/consumed by SteersEditor teardown.
  draftBuffer = $state<Steer[]>([]);

  // ── serialized, seq-guarded whole-list writer ──
  // putSteers replaces the entire list and the server validates all-or-nothing, so two
  // overlapping autosaves must not race: a delayed OR failed older PUT must never clobber a
  // newer edit/order nor stall it. #pending holds only the newest queued payload; #seq is
  // bumped on every enqueue; #draining is the in-flight drain that every currently-queued
  // caller shares — so they settle together on the drain's FINAL outcome, not on their own
  // (possibly superseded) PUT.
  #pending: Steer[] | null = null;
  #seq = 0;
  #draining: Promise<void> | null = null;

  async load() {
    try {
      this.list = (await getSteers()).map(normalize);
    } catch (e) {
      this.error = e instanceof Error ? e.message : "failed to load steers";
    } finally {
      this.loaded = true;
    }
  }

  /** Replace the whole list (Settings editor). Coalescing serial writer: at most one PUT is
   *  in flight, the store converges to the latest payload, and a stale/failed older response
   *  is never adopted. The returned promise settles once the batch that included (or
   *  superseded) `next` reaches a terminal state — it rejects only if the final attempt fails
   *  with nothing newer queued. */
  save(next: Steer[]): Promise<void> {
    this.#pending = next;
    this.#seq++;
    if (!this.#draining) this.#draining = this.#drain();
    return this.#draining;
  }

  async #drain(): Promise<void> {
    let lastError: unknown = null;
    try {
      while (this.#pending !== null) {
        // consume BEFORE awaiting, so a re-entrant save() during the PUT is never lost
        const payload = this.#pending;
        this.#pending = null;
        const seqAtSend = this.#seq;
        try {
          const saved = (await putSteers(payload)).map(normalize);
          // adopt only if no newer save was enqueued while this PUT was in flight
          if (seqAtSend === this.#seq) {
            this.list = saved;
            this.error = null;
            lastError = null;
          }
          // else: superseded → discard this now-stale response; the loop sends #pending
        } catch (e) {
          // an older failure must not stop the drain: if a newer payload is already queued
          // the while-check sends it; only a final failure with nothing queued surfaces below
          lastError = e;
        }
      }
    } finally {
      this.#draining = null;
    }
    if (lastError) {
      this.error = lastError instanceof Error ? lastError.message : "failed to save steers";
      throw lastError;
    }
  }
}

export const steers = new SteersStore();
