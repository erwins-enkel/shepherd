/**
 * Single source of truth for "an operator has not yet picked a repo root — don't start
 * background work." `pending` starts false; index.ts flips it to true at boot when the
 * run-once store migration (see SessionStore#migrateFirstRunMarker) classifies the install
 * as fresh. server.ts calls `resolve()` on the first root-pick, which flips `pending` back
 * to false and (exactly once) runs the deferred background starter registered via
 * `onResolve`. Exactly one instance is shared across the process.
 */
class FirstRunGate {
  pending = false;
  private cb: (() => void) | null = null;

  onResolve(cb: () => void): void {
    this.cb = cb;
  }

  resolve(): void {
    if (!this.pending) return;
    this.pending = false;
    const cb = this.cb;
    if (!cb) return;
    queueMicrotask(() => {
      try {
        cb();
      } catch (err) {
        console.warn("[first-run] startBackground failed:", err);
      }
    });
  }
}

export const firstRun = new FirstRunGate();
