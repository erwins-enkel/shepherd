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
  /** Window length, fed to the depleting-bar animation. Set for any timed toast
   *  (undo, and info with a finite duration) — drives the depleting countdown
   *  bar. Unset (undefined) for persistent info toasts, which draw no bar. */
  durationMs?: number;
  /** True while hover/focus has paused an info toast's auto-dismiss; drives the
   *  bar's animation-play-state so it freezes instead of draining. (Info only.) */
  held?: boolean;
  /** Bumped each time the auto-dismiss timer is (re-)armed. The countdown bar is
   *  keyed on it so a keyed refresh recreates the element, restarting its CSS
   *  drain animation in lockstep with the freshly re-armed timer. (Info only.) */
  armSeq?: number;
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
  // Caller key -> toast id. Namespaced by tone (#kk) so an info and an undo
  // toast may safely reuse the same caller key without cross-mutating state.
  #keyed = new Map<string, number>();
  // Arming info for timed info toasts, so hold() can pause and release() can
  // resume with the leftover time. While the timer runs, remaining counts from
  // `at`; while held (no timer), `remaining` IS the time left.
  #armed = new Map<number, { at: number; remaining: number }>();
  // Hold REF-COUNTS (not booleans): hover and keyboard focus are independent
  // holders that overlap, and neither leaving may re-arm while the other stays.
  #holds = new Map<number, number>();

  /** Internal dedupe key: tone-prefixed so info/undo keys never collide. The
   *  distinct "info"/"undo" prefix makes any cross-tone match impossible
   *  whatever the caller key contains. */
  #kk(tone: ToastTone, key: string): string {
    return `${tone}:${key}`;
  }

  /** Confirmation toast. Auto-dismisses after `duration` ms (default 4000);
   *  pass `duration: null` for a persistent toast that stays until retried or
   *  closed. `alert: true` announces it assertively (role="alert"). */
  info(text: string, opts: InfoOpts = {}): number {
    // Finite duration drives the depleting countdown bar (--ms); persistent
    // (`null`) toasts leave it undefined so no bar is drawn.
    const durationMs = opts.duration === null ? undefined : (opts.duration ?? 4000);
    // Keyed dedupe: a repeated info with the same key refreshes the existing
    // toast (text / action / announcement / timer) instead of stacking another,
    // so e.g. repeated steer failures to one agent collapse to a single toast.
    if (opts.key !== undefined && this.#keyed.has(this.#kk("info", opts.key))) {
      const prev = this.#keyed.get(this.#kk("info", opts.key))!;
      this.#clearTimer(prev);
      if (opts.action) this.#actions.set(prev, opts.action.run);
      else this.#actions.delete(prev);
      this.items = this.items.map((t) =>
        t.id === prev
          ? {
              ...t,
              text,
              actionLabel: opts.action?.label,
              alert: opts.alert,
              durationMs,
              armSeq: (t.armSeq ?? 0) + 1,
            }
          : t,
      );
      this.#armInfo(prev, opts.duration);
      return prev;
    }
    const id = ++this.#seq;
    this.items = [
      ...this.items,
      {
        id,
        tone: "info",
        text,
        actionLabel: opts.action?.label,
        alert: opts.alert,
        key: opts.key,
        durationMs,
        armSeq: 0,
      },
    ];
    if (opts.action) this.#actions.set(id, opts.action.run);
    if (opts.key !== undefined) this.#keyed.set(this.#kk("info", opts.key), id);
    this.#armInfo(id, opts.duration);
    return id;
  }

  /** Arm an info toast's auto-dismiss timer. `null` duration = persistent (stays
   *  until the operator retries or closes it). */
  #armInfo(id: number, duration: number | null | undefined) {
    if (duration === null) {
      this.#armed.delete(id); // a keyed refresh may turn a timed toast persistent
      return;
    }
    const ms = duration ?? 4000;
    this.#armed.set(id, { at: Date.now(), remaining: ms });
    // Keyed refresh landing while held (hovered/focused): don't start a timer
    // under the operator's pointer — release() arms the recorded duration.
    if ((this.#holds.get(id) ?? 0) > 0) return;
    this.#timers.set(
      id,
      setTimeout(() => this.#drop(id), ms),
    );
  }

  /** Pause auto-dismiss while the operator hovers or focuses the toast. Counted,
   *  not boolean: each holder (pointer, focus) pairs with its own release().
   *  No-op for undo toasts — their window is a commit deadline synced to the
   *  CSS depleting bar; pausing would desync bar and commit semantics. */
  hold(id: number): void {
    if (this.items.find((t) => t.id === id)?.tone !== "info") return;
    const count = (this.#holds.get(id) ?? 0) + 1;
    this.#holds.set(id, count);
    if (count !== 1) return; // already paused by another holder
    // First holder: freeze the countdown bar (harmless on persistent toasts).
    this.items = this.items.map((t) => (t.id === id ? { ...t, held: true } : t));
    const armed = this.#armed.get(id);
    if (!armed) return; // persistent: nothing to pause
    this.#clearTimer(id);
    armed.remaining = Math.max(0, armed.remaining - (Date.now() - armed.at));
  }

  /** Drop one hold; only when the LAST holder leaves does the leftover time
   *  re-arm. No-op when nothing is held (the count never goes negative). */
  release(id: number): void {
    const count = this.#holds.get(id) ?? 0;
    if (count === 0) return;
    if (count > 1) {
      this.#holds.set(id, count - 1);
      return;
    }
    this.#holds.delete(id);
    // Last holder left: resume the countdown bar.
    this.items = this.items.map((t) => (t.id === id ? { ...t, held: false } : t));
    const armed = this.#armed.get(id);
    if (!armed) return; // persistent — stays until closed
    armed.at = Date.now();
    this.#timers.set(
      id,
      setTimeout(() => this.#drop(id), armed.remaining),
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
    if (opts.key && this.#keyed.has(this.#kk("undo", opts.key))) {
      const prev = this.#keyed.get(this.#kk("undo", opts.key))!;
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
    if (opts.key) this.#keyed.set(this.#kk("undo", opts.key), id);
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
    this.#armed.delete(id);
    this.#holds.delete(id);
    for (const [k, v] of this.#keyed) if (v === id) this.#keyed.delete(k);
    this.items = this.items.filter((t) => t.id !== id);
  }
}

export const toasts = new ToastStore();
