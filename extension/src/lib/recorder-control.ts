// Lifecycle for the opt-in console/network recorder: request <all_urls> and
// register the MAIN-world content script when enabled; unregister + drop the
// permission when disabled. Used by the options page.
const RECORDER_ID = "shepherd-recorder";
const ALL_URLS = "<all_urls>";

/** True if the recorder content script is currently registered. */
export async function recorderRegistered(): Promise<boolean> {
  const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: [RECORDER_ID] });
  return scripts.length > 0;
}

/** True if the extension currently holds the broad host permission. */
export function hasAllUrls(): Promise<boolean> {
  return chrome.permissions.contains({ origins: [ALL_URLS] });
}

/**
 * Request <all_urls> (user gesture required) and register the recorder.
 * Returns false if the user denied the permission prompt (nothing registered).
 */
export async function enableRecorder(): Promise<boolean> {
  const granted = await chrome.permissions.request({ origins: [ALL_URLS] });
  if (!granted) return false;
  if (!(await recorderRegistered())) {
    await chrome.scripting.registerContentScripts([
      {
        id: RECORDER_ID,
        js: ["recorder.js"],
        matches: [ALL_URLS],
        runAt: "document_start",
        world: "MAIN",
        allFrames: false,
        persistAcrossSessions: true,
      },
    ]);
  }
  return true;
}

/** Unregister the recorder and release the broad host permission. */
export async function disableRecorder(): Promise<void> {
  if (await recorderRegistered()) {
    await chrome.scripting.unregisterContentScripts({ ids: [RECORDER_ID] });
  }
  await chrome.permissions.remove({ origins: [ALL_URLS] });
}
