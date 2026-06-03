// Post-action confirmation + undo queue.
//
// The undo toast is the safety net for destructive actions whose server side is
// irreversible (decommission removes the worktree). Instead of acting then
// rolling back, the action is DEFERRED: `undo()` holds the commit for `duration`
// ms and only runs it when the window expires. UNDO therefore just cancels a
// pending commit — there is nothing to undo on the server, because nothing ran.
//
// Timers and callbacks live in plain Maps (not $state); only `items` is reactive.

type ToastTone = "info" | "undo";

interface Toast {
  id: number;
  tone: ToastTone;
  text: string;
  /** UNDO button label (undo toasts only). */
  undoLabel?: string;
  /** Window length, fed to the depleting-bar animation (undo toasts only). */
  durationMs?: number;
  /** Dedupe key; on undo toasts it also lets the UI find the deferred target. */
  key?: string;
  /** Optional inline action on an info toast (e.g. Retry); runs via act(). */
  actionLabel?: string;
  /** Assertive announcement (role="alert") for failures; default polite. */
  alert?: boolean;
}

interface InfoOpts {
  /** Auto-dismiss delay in ms (default 4000). Pass `null` to stay until the
   *  operator retries or closes it (use for failures that must not vanish). */
  duration?: number | null;
  /** An inline action button (e.g. Retry on a failed operation). */
  action?: { label: string; run: () => void };
  /** Announce assertively (role="alert") rather than politely. For failures
   *  that must reach a screen-reader operator promptly. */
  alert?: boolean;
  /** Dedupe key: a repeated info with the same key refreshes the existing toast
   *  instead of stacking another (e.g. repeated failures to one target). */
  key?: string;
}

interface UndoOpts {
  undoLabel: string;
  /** Runs when the window expires un-cancelled. The real, irreversible action. */
  onCommit: () => void | Promise<void>;
  /** Runs when UNDO is pressed instead. */
  onUndo?: () => void;
  duration?: number;
  /** Dedupe: a new undo toast with the same key re-arms the existing one. */
  key?: string;
}

class ToastStore {
  items = $state<Toast[]>([]);

  #seq = 0;
  #timers = new Map<number, ReturnType<typeof setTimeout>>();
  #commits = new Map<number, () => void | Promise<void>>();
  #undos = new Map<number, () => void>();
  #actions = new Map<number, () => void>();
  #keyed = new Map<string, number>();

  /** Confirmation toast. Auto-dismisses after `duration` ms (default 4000);
   *  pass `duration: null` for a persistent toast that stays until retried or
   *  closed. `alert: true` announces it assertively (role="alert"). */
  info(text: string, opts: InfoOpts = {}): number {
    // Keyed dedupe: a repeated info with the same key refreshes the existing
    // toast (text / action / announcement / timer) instead of stacking another,
    // so e.g. repeated steer failures to one agent collapse to a single toast.
    if (opts.key !== undefined && this.#keyed.has(opts.key)) {
      const prev = this.#keyed.get(opts.key)!;
      this.#clearTimer(prev);
      if (opts.action) this.#actions.set(prev, opts.action.run);
      else this.#actions.delete(prev);
      this.items = this.items.map((t) =>
        t.id === prev ? { ...t, text, actionLabel: opts.action?.label, alert: opts.alert } : t,
      );
      this.#armInfo(prev, opts.duration);
      return prev;
    }
    const id = ++this.#seq;
    this.items = [
      ...this.items,
      { id, tone: "info", text, actionLabel: opts.action?.label, alert: opts.alert, key: opts.key },
    ];
    if (opts.action) this.#actions.set(id, opts.action.run);
    if (opts.key !== undefined) this.#keyed.set(opts.key, id);
    this.#armInfo(id, opts.duration);
    return id;
  }

  /** Arm an info toast's auto-dismiss timer. `null` duration = persistent (stays
   *  until the operator retries or closes it). */
  #armInfo(id: number, duration: number | null | undefined) {
    if (duration === null) return;
    this.#timers.set(
      id,
      setTimeout(() => this.#drop(id), duration ?? 4000),
    );
  }

  /** Inline action (e.g. Retry) pressed on an info toast: run it and dismiss. */
  act(id: number): void {
    const run = this.#actions.get(id);
    this.#drop(id);
    run?.();
  }

  /** Deferred destructive action with an undo window; commits on expiry. */
  undo(text: string, opts: UndoOpts): number {
    const duration = opts.duration ?? 5000;

    // Same target re-armed within its window: reset the timer + callbacks rather
    // than stacking two commits for one entity.
    if (opts.key && this.#keyed.has(opts.key)) {
      const prev = this.#keyed.get(opts.key)!;
      this.#clearTimer(prev);
      this.#commits.set(prev, opts.onCommit);
      if (opts.onUndo) this.#undos.set(prev, opts.onUndo);
      this.#arm(prev, duration);
      return prev;
    }

    const id = ++this.#seq;
    this.items = [
      ...this.items,
      { id, tone: "undo", text, undoLabel: opts.undoLabel, durationMs: duration, key: opts.key },
    ];
    this.#commits.set(id, opts.onCommit);
    if (opts.onUndo) this.#undos.set(id, opts.onUndo);
    if (opts.key) this.#keyed.set(opts.key, id);
    this.#arm(id, duration);
    return id;
  }

  /** UNDO pressed: cancel the pending commit, run the undo hook, drop the toast. */
  cancel(id: number): void {
    this.#clearTimer(id);
    this.#undos.get(id)?.();
    this.#drop(id);
  }

  /** Dismiss an info toast (no commit attached). */
  close(id: number): void {
    this.#drop(id);
  }

  /** Is a destructive action against `key` currently deferred in its undo window? */
  pendingUndo(key: string): boolean {
    return this.items.some((t) => t.tone === "undo" && t.key === key);
  }

  #arm(id: number, duration: number) {
    this.#timers.set(
      id,
      setTimeout(() => this.#commit(id), duration),
    );
  }

  async #commit(id: number) {
    const commit = this.#commits.get(id);
    this.#drop(id);
    await commit?.();
  }

  #clearTimer(id: number) {
    const t = this.#timers.get(id);
    if (t) clearTimeout(t);
    this.#timers.delete(id);
  }

  #drop(id: number) {
    this.#clearTimer(id);
    this.#commits.delete(id);
    this.#undos.delete(id);
    this.#actions.delete(id);
    for (const [k, v] of this.#keyed) if (v === id) this.#keyed.delete(k);
    this.items = this.items.filter((t) => t.id !== id);
  }
}

export const toasts = new ToastStore();
