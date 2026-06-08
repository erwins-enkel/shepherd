import { summarizeAxeResults, type AxeResults } from "./lib/a11y";
import { buildMetadata, dataUrlToBlob, type PageInfo } from "./lib/capture";
import { loadConfig } from "./lib/config";
import { fileIssue, spawnNow } from "./lib/transport";
import {
  TransportError,
  type CaptureResult,
  type WorkerRequest,
  type WorkerResponse,
} from "./lib/types";
import type {
  A11yFinding,
  CapturedSignals,
  ConsoleEntry,
  GatherSignal,
  NetworkEntry,
  SignalToggles,
} from "./lib/signals";

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

/**
 * Inject axe-core and run a violations-only audit. Best-effort: returns null on
 * failure (e.g. a restricted page where injection is blocked) so the caller can
 * surface the failure distinctly rather than report it as "0 findings".
 */
async function gatherA11y(tabId: number): Promise<A11yFinding[] | null> {
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
    return null; // best-effort: failure surfaces as a signalError, capture proceeds
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

/**
 * Read the recorder buffer for the enabled console/network toggles into the
 * `signals`/`errors` accumulators. A null buffer (recorder not active on this
 * tab — opened before the permission was granted, or a restricted page) records
 * an error rather than an empty result, so the popup can say "couldn't gather".
 */
async function gatherRecorderSignals(
  tabId: number,
  toggles: SignalToggles,
  signals: CapturedSignals,
  errors: GatherSignal[],
): Promise<void> {
  if (!toggles.console && !toggles.network) return;
  const buffer = await readRecorderBuffer(tabId);
  if (toggles.console) {
    if (buffer) signals.console = buffer.console ?? [];
    else errors.push("console");
  }
  if (toggles.network) {
    if (buffer) signals.network = buffer.network ?? [];
    else errors.push("network");
  }
}

/**
 * Gather the requested signals. Each gather is best-effort: a failure is recorded
 * in `errors` (so the popup can surface it distinctly from "found nothing") and
 * never throws, so the capture itself always succeeds.
 */
async function gatherSignals(
  tabId: number,
  toggles: SignalToggles,
): Promise<{ signals: CapturedSignals; errors: GatherSignal[] }> {
  const signals: CapturedSignals = {};
  const errors: GatherSignal[] = [];

  await gatherRecorderSignals(tabId, toggles, signals, errors);

  if (toggles.a11y) {
    const findings = await gatherA11y(tabId);
    if (findings === null) errors.push("a11y");
    else signals.a11y = findings;
  }

  return { signals, errors };
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

  const { signals, errors } = await gatherSignals(tabId, toggles);
  return {
    screenshotDataUrl,
    metadata,
    signals,
    signalErrors: errors.length ? errors : undefined,
  };
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
            repoPath: req.payload.repoPath,
          });
          sendResponse({ ok: true, type: "spawn", desig });
          return;
        }
        if (req.type === "file-issue") {
          const config = await loadConfig();
          const { number, url } = await fileIssue((u, init) => fetch(u, init), config, req.payload);
          sendResponse({ ok: true, type: "issue", number, url });
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
