// Shared coarse wall-clock: a single 30s tick drives time-based UI (e.g. the critic
// badge escalating an abandoned final round from dimmed FINAL to orange STALLED)
// without each component spinning up its own interval. Read `clock.current` inside a
// $derived to make that computation re-run on each tick.
class Clock {
  current = $state(Date.now());
  constructor() {
    setInterval(() => (this.current = Date.now()), 30_000);
  }
}
export const clock = new Clock();
