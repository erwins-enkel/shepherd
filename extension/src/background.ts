import { buildMetadata, dataUrlToBlob, type PageInfo } from "./lib/capture";
import { loadConfig } from "./lib/config";
import { spawnNow } from "./lib/transport";
import {
  TransportError,
  type CaptureResult,
  type WorkerRequest,
  type WorkerResponse,
} from "./lib/types";

/** Injected into the page to read viewport/UA/locale at capture time. */
function readPageInfo(): PageInfo {
  return {
    viewportW: window.innerWidth,
    viewportH: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    userAgent: navigator.userAgent,
    locale: navigator.language,
  };
}

async function captureActiveTab(): Promise<CaptureResult> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.windowId) throw new Error("no-active-tab");

  const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });

  const [{ result: info }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: readPageInfo,
  });

  const metadata = buildMetadata(
    { url: tab.url, title: tab.title },
    info as PageInfo,
    new Date().toISOString(),
  );
  return { screenshotDataUrl, metadata };
}

chrome.runtime.onMessage.addListener(
  (req: WorkerRequest, _sender, sendResponse: (r: WorkerResponse) => void) => {
    (async () => {
      try {
        if (req.type === "capture") {
          const result = await captureActiveTab();
          sendResponse({ ok: true, type: "capture", result });
          return;
        }
        if (req.type === "spawn") {
          const config = await loadConfig();
          const desig = await spawnNow((url, init) => fetch(url, init), config, {
            prompt: req.payload.prompt,
            metadata: req.payload.metadata,
            screenshot: dataUrlToBlob(req.payload.screenshotDataUrl),
          });
          sendResponse({ ok: true, type: "spawn", desig });
          return;
        }
      } catch (err) {
        if (err instanceof TransportError) {
          sendResponse({ ok: false, errorKind: err.kind, message: err.message });
        } else {
          sendResponse({ ok: false, errorKind: "capture", message: String(err) });
        }
      }
    })();
    return true; // keep the message channel open for the async response
  },
);
