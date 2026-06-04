import { EventEmitter } from "node:events";

/**
 * Single source of truth for "herdr is mid-update — don't touch it." While
 * active, every periodic loop that shells out to herdr pauses (so the 1s poller
 * can't resurrect the herdr server between `herdr server stop` and `herdr
 * update`) and the HerdrDriver runner fails fast. Exactly one instance is shared
 * across the process. `on("change", fn)` returns an unsubscribe so callers don't
 * leak listeners.
 */
class HerdrMaintenance extends EventEmitter {
  private _active = false;
  get active(): boolean {
    return this._active;
  }
  begin(): void {
    if (this._active) return;
    this._active = true;
    this.emit("change", true);
  }
  end(): void {
    if (!this._active) return;
    this._active = false;
    this.emit("change", false);
  }
  /** Subscribe to active-state transitions; returns an unsubscribe fn. */
  on(event: "change", fn: (active: boolean) => void): () => void {
    super.on(event, fn);
    return () => void super.off(event, fn);
  }
}

export const maintenance = new HerdrMaintenance();
