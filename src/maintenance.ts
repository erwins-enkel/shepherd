/**
 * Single source of truth for "herdr is mid-update — don't touch it." While
 * active, every periodic loop that shells out to herdr pauses (so the 1s poller
 * can't race a `herdr update --handoff` mid-flight as it hands off the running
 * targets) and the HerdrDriver runner fails fast. Exactly one instance is shared
 * across the process; callers only ever read `active` and toggle begin/end.
 */
class HerdrMaintenance {
  private _active = false;
  get active(): boolean {
    return this._active;
  }
  begin(): void {
    this._active = true;
  }
  end(): void {
    this._active = false;
  }
}

export const maintenance = new HerdrMaintenance();
