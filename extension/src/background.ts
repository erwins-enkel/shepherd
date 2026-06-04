import { summarizeAxeResults, type AxeResults } from "./lib/a11y";
import { buildMetadata, dataUrlToBlob, type PageInfo } from "./lib/capture";
import { loadConfig } from "./lib/config";
import { spawnNow } from "./lib/transport";
import {
  TransportError,
  type CaptureResult,
  type WorkerRequest,
  type WorkerResponse,
} from "./lib/types";
import type { CapturedSignals, ConsoleEntry, NetworkEntry, SignalToggles } from "./lib/signals";

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

/** Inject axe-core and run a violations-only audit. Best-effort: [] on failure. */
async function gatherA11y(tabId: number) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["axe.min.js"] });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () =>
        (
          window as unknown as { axe: { run: (ctx: Document, opts: unknown) => Promise<unknown> } }
        ).axe.run(document, { resultTypes: ["violations"] }),
    });
    return summarizeAxeResults(result as AxeResults);
  } catch {
    return []; // best-effort: omit on failure
  }
}

/** Read the MAIN-world recorder buffer. null if absent (recorder not active). */
async function readRecorderBuffer(
  tabId: number,
): Promise<{ console: ConsoleEntry[]; network: NetworkEntry[] } | null> {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () =>
        (window as unknown as { __shepherdCapture?: { console: unknown[]; network: unknown[] } })
          .__shepherdCapture ?? null,
    });
    return (result as { console: ConsoleEntry[]; network: NetworkEntry[] } | null) ?? null;
  } catch {
    return null;
  }
}

async function captureActiveTab(toggles: SignalToggles): Promise<CaptureResult> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.windowId) throw new Error("no-active-tab");
  const tabId = tab.id;

  const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });

  const [{ result: info }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: readPageInfo,
  });

  const metadata = buildMetadata(
    { url: tab.url, title: tab.title },
    info as PageInfo,
    new Date().toISOString(),
  );

  const signals: CapturedSignals = {};
  if (toggles.console || toggles.network) {
    const buffer = await readRecorderBuffer(tabId);
    if (toggles.console) signals.console = buffer?.console ?? [];
    if (toggles.network) signals.network = buffer?.network ?? [];
  }
  if (toggles.a11y) signals.a11y = await gatherA11y(tabId);

  return { screenshotDataUrl, metadata, signals };
}

chrome.runtime.onMessage.addListener(
  (req: WorkerRequest, _sender, sendResponse: (r: WorkerResponse) => void) => {
    (async () => {
      try {
        if (req.type === "capture") {
          const result = await captureActiveTab(req.toggles);
          sendResponse({ ok: true, type: "capture", result });
          return;
        }
        if (req.type === "spawn") {
          const config = await loadConfig();
          const desig = await spawnNow((url, init) => fetch(url, init), config, {
            prompt: req.payload.prompt,
            metadata: req.payload.metadata,
            attachScreenshot: req.payload.attachScreenshot,
            screenshot: req.payload.attachScreenshot
              ? dataUrlToBlob(req.payload.screenshotDataUrl)
              : undefined,
            signals: req.payload.signals,
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
