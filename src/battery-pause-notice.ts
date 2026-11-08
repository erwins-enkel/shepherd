/**
 * Battery pause notice (Mac only). The app suspends this server on battery (`LocalBatteryPause`),
 * and a suspended server cannot answer — so a Shepherd that has this Mac connected would only see
 * it go unreachable. Right before the pause the app drops a `battery-pause` file into the private
 * app↔server directory (`SHEPHERD_APP_UPDATE_DIR`); this watcher tells every `/events` socket —
 * among them each peer's `?host=local` mirror — and then deletes the file. The deletion is the
 * app's acknowledgement; it starts the pause only after it (or after its own short timeout).
 */
import { existsSync, rmSync, watch } from "node:fs";
import { join } from "node:path";

/** The `/events` frame a peer reads as "this machine is pausing on battery". */
export const BATTERY_PAUSE_EVENT = "host:battery-pause";

/** The notice file's name in the app↔server directory, shared with the app. */
export const BATTERY_PAUSE_NOTICE = "battery-pause";

/** Watch `dir` for the notice; returns a stop function. A notice left from an earlier run (the app
 *  quit mid-handshake) is removed unannounced: no pause follows it any more. */
export function watchBatteryPauseNotice(
  dir: string,
  emit: (event: string, data: unknown) => void,
): () => void {
  const notice = join(dir, BATTERY_PAUSE_NOTICE);
  rmSync(notice, { force: true });
  try {
    const watcher = watch(dir, () => {
      if (!existsSync(notice)) return;
      emit(BATTERY_PAUSE_EVENT, {});
      rmSync(notice, { force: true });
    });
    watcher.on("error", (err) => console.warn("[battery-pause] watch failed:", err.message));
    return () => watcher.close();
  } catch (err) {
    console.warn(
      "[battery-pause] cannot watch the app directory:",
      err instanceof Error ? err.message : String(err),
    );
    return () => {};
  }
}
