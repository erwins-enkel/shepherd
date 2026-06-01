// Tracks which connected clients are *actively in use* (a focused, visible
// window) so push delivery can suppress OS banners while the live UI is already
// showing the change. Focus/visibility is reported by the page over the /events
// socket — page-context APIs are reliable across platforms, unlike a service
// worker's WindowClient.focused, which mis-reports on Android.

export class Presence {
  private active = new Set<object>();

  /** Record a client's active state. `client` is any stable per-connection key. */
  set(client: object, active: boolean): void {
    if (active) this.active.add(client);
    else this.active.delete(client);
  }

  /** Forget a client entirely (call on disconnect). */
  drop(client: object): void {
    this.active.delete(client);
  }

  /** True while at least one client is actively in use. */
  isActive(): boolean {
    return this.active.size > 0;
  }
}
