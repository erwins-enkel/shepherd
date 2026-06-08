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

/** A cropped element capture awaiting pickup, tagged with the tab it came from. */
interface PendingCapture {
  tabId: number;
  result: CaptureResult;
}

/** Stash the cropped element capture (tagged with its tab) for pickup on reopen. */
export async function setPendingCapture(tabId: number, result: CaptureResult): Promise<void> {
  await chrome.storage.session.set({ [CAPTURE_KEY]: { tabId, result } satisfies PendingCapture });
}

/**
 * Consume (read + clear) the pending element capture, but only if it belongs to
 * `tabId`. A capture taken on another tab stays put — and its ✓ badge stays on
 * that tab — until the popup is opened back on its origin tab.
 */
export async function takePendingCapture(tabId: number): Promise<CaptureResult | null> {
  const got = await chrome.storage.session.get(CAPTURE_KEY);
  const pending = got[CAPTURE_KEY] as PendingCapture | undefined;
  if (!pending || pending.tabId !== tabId) return null;
  await chrome.storage.session.remove(CAPTURE_KEY);
  return pending.result;
}

/** Clear all picker hand-off state (on cancel, or after a capture is consumed). */
export async function clearPickerToggles(): Promise<void> {
  await chrome.storage.session.remove(TOGGLES_KEY);
}
