import { appendFileSync, realpathSync } from "node:fs";

let journalPath: string | null = null;
const recorded = new Set<string>();

/** Enabled by the real Mac server only; fake drivers never touch the operator's state. */
export function enablePowerPaneJournal(databasePath: string): void {
  journalPath = realpathSync(databasePath) + ".power-panes";
  appendFileSync(journalPath, "", { mode: 0o600 });
  recorded.clear();
}

/** Record before pane.run: a paused server cannot leave a running but unrecorded auxiliary. */
export function recordPowerPane(paneId: string): void {
  if (!journalPath || recorded.has(paneId)) return;
  appendFileSync(journalPath, JSON.stringify(paneId) + "\n", { mode: 0o600 });
  recorded.add(paneId);
}
