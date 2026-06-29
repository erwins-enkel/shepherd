// Tracks which connected clients are *actively in use* (a focused, visible
// window) so push delivery can suppress OS banners while the live UI is already
// showing the change. Focus/visibility is reported by the page over the /events
// socket — page-context APIs are reliable across platforms, unlike a service
// worker's WindowClient.focused, which mis-reports on Android.

export class Presence {
  private active = new Set<object>();
  /** Every currently-connected /events client, focused or not. A connection means
   *  a dashboard is *open* (so background pollers should run at full cadence) even
   *  when its window is backgrounded — distinct from `active` (focused+visible). */
  private connected = new Set<object>();
  /** Latched so `onActivate` fires only on the empty→non-empty edge, re-armed
   *  once `connected` drains back to empty. */
  private activatedAtZero = true;

  /** Fired on the 0→1 `connected` transition (a fresh dashboard appeared after a
   *  quiet spell) so the caller can kick a one-off catch-up poll. */
  constructor(private onActivate?: () => void) {}

  /** Record a client's active state. `client` is any stable per-connection key. */
  set(client: object, active: boolean): void {
    if (active) this.active.add(client);
    else this.active.delete(client);
  }

  /** Register an open connection (call on /events socket open). Invokes
   *  `onActivate` once on the empty→non-empty edge so a dashboard reappearing
   *  after an idle spell triggers an immediate catch-up sweep. */
  connect(client: object): void {
    const wasEmpty = this.connected.size === 0;
    this.connected.add(client);
    if (wasEmpty && this.activatedAtZero) {
      this.activatedAtZero = false;
      this.onActivate?.();
    }
  }

  /** Forget a client entirely (call on disconnect). Removes it from BOTH the
   *  focus (`active`) and connection (`connected`) sets; re-arms `onActivate`
   *  once `connected` empties. */
  drop(client: object): void {
    this.active.delete(client);
    this.connected.delete(client);
    if (this.connected.size === 0) this.activatedAtZero = true;
  }

  /** True while at least one client is actively in use (focused + visible). */
  isActive(): boolean {
    return this.active.size > 0;
  }

  /** True while at least one client is connected (a dashboard is open), regardless
   *  of focus — the cadence gate for background pollers. */
  hasClients(): boolean {
    return this.connected.size > 0;
  }
}
