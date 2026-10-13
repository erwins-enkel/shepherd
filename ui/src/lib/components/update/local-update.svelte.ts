import type { DeployState, DirtyStatus, UpdateStatus } from "#lib/types.js";
import { applyUpdate, getUpdateDirty, StaleDirtyError } from "#lib/api.js";
import { m } from "#lib/paraglide/messages.js";

export type LocalMode =
  "progress" | "loading" | "clean" | "dirty" | "toolarge" | "nowclean" | "rawlog";

export interface LocalUpdateInputs {
  update: UpdateStatus;
  updating: boolean;
  /** set once a launched deploy reports failure → show the captured reason */
  deploy: DeployState | null;
  onconfirm?: () => void;
}

/**
 * This Shepherd's own self-update as the update window drives it — the same flow whether the
 * window shows it alone or as one row among the connected machines. Construct it while a
 * component initializes: it registers the effects that probe the tree.
 */
export class LocalUpdate {
  readonly #inputs: () => LocalUpdateInputs;

  submitting = $state(false);
  error = $state<string | null>(null);

  // ── dirty-repo flow ──────────────────────────────────────────────────────
  // The tracked dirty state is volatile, so we always fetch it FRESH (never from
  // the cached update status): once proactively when the dialog opens, and again
  // reactively if a deploy fails because the tree blocked the pull / drifted.
  dirtyProbe = $state<"idle" | "pending" | "clean" | "dirty" | "error">("idle");
  dirty = $state<DirtyStatus | null>(null);
  // two-click destructive confirm: the first click only arms (no API call)
  arming = $state(false);
  // shown when the deploy failed because the tree changed since confirmation
  staleHint = $state(false);

  constructor(inputs: () => LocalUpdateInputs) {
    this.#inputs = inputs;
    // proactive: probe once when the dialog mounts on an available update
    $effect(() => {
      if (this.update.behind > 0 && this.dirtyProbe === "idle") void this.probe();
    });
    // reactive: a failed deploy classified dirty/stale → re-probe fresh and route
    // through the same dirty UI (with a "changed since shown" hint for stale)
    $effect(() => {
      if (this.dirtyReactive) {
        this.staleHint = this.deploy?.reason === "stale";
        void this.probe();
      }
    });
  }

  get update(): UpdateStatus {
    return this.#inputs().update;
  }
  get deploy(): DeployState | null {
    return this.#inputs().deploy;
  }

  // Plain getters over reactive state: cheap, and readable before the constructor body ran.
  get busy(): boolean {
    return this.submitting || this.#inputs().updating;
  }
  get failed(): boolean {
    return this.deploy?.phase === "failed";
  }
  /** While the deploy is in flight, its captured output, so the user sees real progress
   *  (install → build → restart) instead of a frozen spinner. */
  get liveLog(): string | null {
    return this.busy && !this.failed && this.deploy?.log ? this.deploy.log : null;
  }
  get dirtyReactive(): boolean {
    return this.failed && (this.deploy?.reason === "dirty" || this.deploy?.reason === "stale");
  }

  get mode(): LocalMode {
    if (this.busy) return "progress";
    if (this.dirtyReactive) {
      if (this.dirtyProbe === "error") return "rawlog"; // couldn't probe → raw log fallback
      if (this.dirtyProbe === "clean") return "nowclean"; // tree got cleaned meanwhile
      return this.probeMode();
    }
    if (this.failed) return "rawlog";
    return this.probeMode(); // probe error degrades to the normal (clean) update UI
  }

  /** Once a fresh probe has resolved: still pending → loading; dirty → dirty (or toolarge when
   *  the signature was unavailable); anything else → the normal update UI. */
  private probeMode(): LocalMode {
    if (this.dirtyProbe === "pending" || this.dirtyProbe === "idle") return "loading";
    if (this.dirtyProbe === "dirty") return this.dirty?.sig == null ? "toolarge" : "dirty";
    return "clean";
  }

  async probe() {
    this.dirtyProbe = "pending";
    this.arming = false;
    try {
      const d = await getUpdateDirty();
      this.dirty = d;
      this.dirtyProbe = d.dirty ? "dirty" : "clean";
    } catch {
      this.dirty = null;
      this.dirtyProbe = "error"; // degrade to the normal update UI — never a stuck button
    }
  }

  /** Clean/retry path: a plain (non-destructive) update. */
  async runUpdate() {
    this.submitting = true;
    this.error = null;
    try {
      await applyUpdate(false);
      this.#inputs().onconfirm?.(); // store marks `updating`; the page reloads once live
    } catch (e) {
      this.error = e instanceof Error ? e.message : m.updatemodal_update_failed();
      this.submitting = false;
    }
  }

  /** Destructive path, second click: send the discard with the DISPLAYED sig. */
  async confirmDiscard() {
    this.submitting = true;
    this.error = null;
    try {
      await applyUpdate(true, this.dirty?.sig ?? undefined);
      this.#inputs().onconfirm?.();
    } catch (e) {
      this.submitting = false;
      if (e instanceof StaleDirtyError) {
        // the tree drifted since we showed the list → re-render fresh + re-confirm
        this.dirty = e.dirty;
        this.dirtyProbe = e.dirty.dirty ? "dirty" : "clean";
        this.arming = false;
        this.staleHint = true;
      } else {
        this.error = e instanceof Error ? e.message : m.updatemodal_update_failed();
      }
    }
  }
}

/** The newest non-empty line of a deploy log, for a one-line progress readout. */
export const lastLogLine = (log: string): string | null =>
  log
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1)
    ?.slice(0, 160) ?? null;
