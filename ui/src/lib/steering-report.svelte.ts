import type { SteeringReport } from "./types";
import { getSteeringReport, runSteeringReport } from "./api";

/** Client state of the steering report (#4175): the latest stored report and whether a run is in
 *  flight. The Usage → Steering lens loads it on open; the `steering:report` WS event (applied in
 *  store.svelte.ts) keeps it live (a finished run re-GETs the report), so a run started on any client shows up everywhere. */
class SteeringReportStore {
  running = $state(false);
  report = $state<SteeringReport | null>(null);
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

  /** The WS frame is a status signal (the report body is full-scope, the stream is not): a finished
   *  run re-fetches the stored report. */
  apply(d: { running: true } | { running: false; id: string; status: SteeringReport["status"] }) {
    this.running = d.running;
    if (!d.running) void this.load();
  }
}

export const steeringReport = new SteeringReportStore();
