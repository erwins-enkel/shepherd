import type { SteeringReport, SteeringTrendPoint } from "./types";
import { getSteeringReport, markSteeringReportSeen, runSteeringReport } from "./api";

/** Client state of the steering report (#4175): the latest stored report and whether a run is in
 *  flight. The Usage → Steering lens loads it on open; the `steering:report` WS event (applied in
 *  store.svelte.ts) keeps it live (a finished run re-GETs the report), so a run started on any client shows up everywhere. */
class SteeringReportStore {
  running = $state(false);
  report = $state<SteeringReport | null>(null);
  /** Weekly digests reduced to trend points, oldest first (#4176). */
  trend = $state<SteeringTrendPoint[]>([]);
  /** A weekly digest arrived that the operator has not opened yet: the unread dots (#4176). */
  unread = $state(false);
  /** A GET has succeeded at least once (or a finished run arrived). */
  loaded = $state(false);
  loadError = $state(false);
  runError = $state(false);

  async load() {
    this.loadError = false;
    try {
      const snap = await getSteeringReport();
      this.running = snap.running;
      this.report = snap.report;
      this.trend = snap.trend ?? [];
      this.unread = snap.unread ?? false;
      this.loaded = true;
    } catch {
      this.loadError = true;
    }
  }

  async run() {
    this.runError = false;
    this.running = true;
    try {
      await runSteeringReport();
    } catch {
      this.running = false;
      this.runError = true;
    }
  }

  /** The lens is open: clear the dot now, tell the server (best effort; the next load re-syncs). */
  async markSeen() {
    this.unread = false;
    try {
      await markSteeringReportSeen();
    } catch {
      // a lost POST only means the dot can return on the next load
    }
  }

  /** The WS frame is a status signal (the report body is full-scope, the stream is not): a finished
   *  run re-fetches the stored report. */
  apply(d: { running: true } | { running: false; id: string; status: SteeringReport["status"] }) {
    this.running = d.running;
    if (!d.running) void this.load();
  }
}

export const steeringReport = new SteeringReportStore();
