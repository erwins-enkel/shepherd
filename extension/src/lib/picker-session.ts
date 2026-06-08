// Hand-off state for the element-picker flow, kept in chrome.storage.session
// (not a background module variable): the MV3 service worker can be torn down
// between starting the picker and the user's click, and session storage survives
// that while still clearing on browser restart.
import type { CaptureResult } from "./types";
import type { SignalToggles } from "./signals";

const TOGGLES_KEY = "pickerToggles";
const CAPTURE_KEY = "pendingCapture";

/** Remember which signal toggles the popup had on, for the deferred pick capture. */
export async function setPickerToggles(toggles: SignalToggles): Promise<void> {
  await chrome.storage.session.set({ [TOGGLES_KEY]: toggles });
}

/** Read the toggles stashed at start-picker (null if the picker wasn't armed). */
export async function getPickerToggles(): Promise<SignalToggles | null> {
  const got = await chrome.storage.session.get(TOGGLES_KEY);
  return (got[TOGGLES_KEY] as SignalToggles | undefined) ?? null;
}

/** Stash the cropped element capture for the popup to pick up on next open. */
export async function setPendingCapture(result: CaptureResult): Promise<void> {
  await chrome.storage.session.set({ [CAPTURE_KEY]: result });
}

/** Consume (read + clear) the pending element capture, if any. */
export async function takePendingCapture(): Promise<CaptureResult | null> {
  const got = await chrome.storage.session.get(CAPTURE_KEY);
  const result = (got[CAPTURE_KEY] as CaptureResult | undefined) ?? null;
  if (result) await chrome.storage.session.remove(CAPTURE_KEY);
  return result;
}

/** Clear all picker hand-off state (on cancel, or after a capture is consumed). */
export async function clearPickerToggles(): Promise<void> {
  await chrome.storage.session.remove(TOGGLES_KEY);
}
