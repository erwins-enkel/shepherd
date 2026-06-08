import { summarizeAxeResults, type AxeResults } from "./lib/a11y";
import { buildMetadata, dataUrlToBlob, type PageInfo } from "./lib/capture";
import { loadConfig } from "./lib/config";
import {
  clearPickerToggles,
  getPickerToggles,
  setPendingCapture,
  setPickerToggles,
} from "./lib/picker-session";
import { computeStitchPlan, cropRegionForElement } from "./lib/screenshot";
import { fileIssue, spawnNow } from "./lib/transport";
import {
  TransportError,
  type CaptureResult,
  type PageMetadata,
  type PickerMessage,
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

/** captureVisibleTab is throttled to ~2 calls/sec; stay just under it between slices. */
const CAPTURE_THROTTLE_MS = 550;
/** Cap on full-page slices — bounds capture time; a taller page reports truncation. */
const MAX_TILES = 12;
/** No signals gathered (picker hand-off lost its stashed toggles — fail closed to none). */
const NO_GATHER: SignalToggles = { screenshot: false, console: false, network: false, a11y: false };

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Read in-page info and merge it with the tab fields into capture metadata. */
async function buildTabMetadata(
  tabId: number,
  tab: { url?: string; title?: string },
): Promise<PageMetadata> {
  const [{ result: info }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: readPageInfo,
  });
  return buildMetadata(
    { url: tab.url, title: tab.title },
    info as PageInfo,
    new Date().toISOString(),
  );
}

/** Encode a Blob (stitched/cropped PNG) as a data URL for messaging + preview. */
async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000; // chunk so String.fromCharCode doesn't blow the arg limit
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type || "image/png"};base64,${btoa(binary)}`;
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

/** Page dimensions needed to plan a full-page stitch. */
interface PageDims {
  pageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  dpr: number;
  scrollY: number;
}

/** Injected: measure the page + current scroll for the stitch plan. */
function readPageDims(): PageDims {
  const doc = document.documentElement;
  return {
    pageHeight: Math.max(doc.scrollHeight, document.body?.scrollHeight ?? 0, doc.clientHeight),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
    scrollY: window.scrollY,
  };
}

/** Scroll the page (instant) to a given top offset, awaiting the script round-trip. */
async function scrollPageTo(tabId: number, top: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (y: number) =>
      window.scrollTo({ top: y, left: 0, behavior: "instant" as ScrollBehavior }),
    args: [top],
  });
}

type HiddenOverlay = { el: HTMLElement; prev: string };
type OverlayStore = { __shepherdStitchHidden?: HiddenOverlay[] };

/** Injected: hide `fixed`/`sticky` elements, remembering their prior inline visibility. */
function hideStitchOverlays(): void {
  const store = window as unknown as OverlayStore;
  const hidden: HiddenOverlay[] = [];
  for (const el of document.body?.querySelectorAll<HTMLElement>("*") ?? []) {
    const pos = getComputedStyle(el).position;
    if (pos === "fixed" || pos === "sticky") {
      hidden.push({ el, prev: el.style.visibility });
      el.style.setProperty("visibility", "hidden", "important");
    }
  }
  store.__shepherdStitchHidden = hidden;
}

/** Injected: restore whatever `hideStitchOverlays` hid (no-op if nothing was hidden). */
function restoreStitchOverlays(): void {
  const store = window as unknown as OverlayStore;
  for (const { el, prev } of store.__shepherdStitchHidden ?? []) {
    if (prev) el.style.setProperty("visibility", prev);
    else el.style.removeProperty("visibility");
  }
  store.__shepherdStitchHidden = undefined;
}

/**
 * Hide/restore `fixed` & `sticky` elements so a pinned header/banner is captured
 * once (in the top slice) instead of repeating down every stitched slice. Restore
 * is a no-op if nothing was hidden, so it's safe to call unconditionally.
 */
async function setStitchOverlays(tabId: number, hide: boolean): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: hide ? hideStitchOverlays : restoreStitchOverlays,
  });
}

/**
 * Stitch a full-page screenshot: measure the page, scroll through it in
 * viewport-height slices, capture each, and compose them onto one tall canvas.
 * Restores the original scroll position. `truncated` is true when the page
 * exceeded MAX_TILES and the bottom was left uncaptured.
 */
async function captureFullPage(
  tabId: number,
  windowId: number,
): Promise<{ dataUrl: string; truncated: boolean }> {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: readPageDims,
  });
  const dims = result as PageDims;
  const plan = computeStitchPlan({
    pageHeight: dims.pageHeight,
    viewportHeight: dims.viewportHeight,
    maxTiles: MAX_TILES,
  });

  // Page already fits the viewport — one plain visible capture, no scroll dance.
  if (plan.steps.length <= 1) {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    return { dataUrl, truncated: false };
  }

  const canvas = new OffscreenCanvas(
    Math.round(dims.viewportWidth * dims.dpr),
    Math.round(plan.coveredHeight * dims.dpr),
  );
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no-canvas-context");

  try {
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      await scrollPageTo(tabId, step);
      // Throttle to stay under the captureVisibleTab quota; the wait also lets the
      // page paint after the scroll (lazy images settling, overlays hidden below).
      await delay(i === 0 ? 80 : CAPTURE_THROTTLE_MS);
      const tileUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
      const bitmap = await createImageBitmap(dataUrlToBlob(tileUrl));
      ctx.drawImage(bitmap, 0, Math.round(step * dims.dpr));
      bitmap.close();
      // After the top slice, hide pinned overlays so they aren't repeated in the
      // slices below. The next slice's throttle delay covers the repaint.
      if (i === 0) await setStitchOverlays(tabId, true);
    }
  } finally {
    await setStitchOverlays(tabId, false);
    await scrollPageTo(tabId, dims.scrollY);
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  return { dataUrl: await blobToDataUrl(blob), truncated: plan.truncated };
}

/**
 * Capture the visible tab and crop it to a picked element's bounds. Falls back to
 * the full visible capture if the clamped region is empty (element offscreen) or
 * a canvas context is unavailable — the user still gets a usable screenshot.
 */
async function captureElement(
  windowId: number,
  pick: Extract<PickerMessage, { type: "picker-pick" }>,
): Promise<string> {
  const fullUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  const region = cropRegionForElement(pick.rect, pick.viewport, pick.dpr);
  if (!region) return fullUrl;

  const bitmap = await createImageBitmap(dataUrlToBlob(fullUrl));
  const canvas = new OffscreenCanvas(region.sw, region.sh);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return fullUrl;
  }
  ctx.drawImage(bitmap, region.sx, region.sy, region.sw, region.sh, 0, 0, region.sw, region.sh);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return blobToDataUrl(blob);
}

async function captureActiveTab(
  toggles: SignalToggles,
  mode: "visible" | "fullpage",
): Promise<CaptureResult> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.windowId) throw new Error("no-active-tab");
  const tabId = tab.id;

  let screenshotDataUrl: string;
  let fullPageTruncated = false;
  if (mode === "fullpage") {
    const stitched = await captureFullPage(tabId, tab.windowId);
    screenshotDataUrl = stitched.dataUrl;
    fullPageTruncated = stitched.truncated;
  } else {
    screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  }

  const metadata = await buildTabMetadata(tabId, tab);

  const { signals, errors } = await gatherSignals(tabId, toggles);
  return {
    screenshotDataUrl,
    metadata,
    mode,
    signals,
    signalErrors: errors.length ? errors : undefined,
    fullPageTruncated: fullPageTruncated || undefined,
  };
}

/** Mark the toolbar icon so the user knows an element capture is waiting to be opened. */
async function setPendingBadge(tabId: number): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color: "#2563eb", tabId });
  await chrome.action.setBadgeText({ text: "✓", tabId });
}

async function clearPendingBadge(tabId: number): Promise<void> {
  await chrome.action.setBadgeText({ text: "", tabId });
}

/**
 * Inject the picker overlay into the active tab and stash the toggles for the
 * deferred capture. The localized instruction text is resolved in the popup (its
 * locale) and handed to the overlay via an isolated-world global, so the picker
 * content script needn't bundle Paraglide.
 */
async function startPicker(toggles: SignalToggles, instructions: string): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("no-active-tab");
  await setPickerToggles(toggles);
  await clearPendingBadge(tab.id);
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (text: string) => {
      (window as unknown as { __shepherdPickerLabel?: string }).__shepherdPickerLabel = text;
    },
    args: [instructions],
  });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["picker.js"] });
}

/** Handle the picker's click: capture + crop, gather signals, stash for the popup. */
async function onPickerPick(
  pick: Extract<PickerMessage, { type: "picker-pick" }>,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const tab = sender.tab;
  if (!tab?.id || tab.windowId === undefined) return;
  const tabId = tab.id;

  const screenshotDataUrl = await captureElement(tab.windowId, pick);
  const metadata = await buildTabMetadata(tabId, tab);
  const toggles = (await getPickerToggles()) ?? NO_GATHER;
  const { signals, errors } = await gatherSignals(tabId, toggles);

  const result: CaptureResult = {
    screenshotDataUrl,
    metadata,
    mode: "element",
    signals,
    signalErrors: errors.length ? errors : undefined,
  };
  await setPendingCapture(result);
  await clearPickerToggles();
  await setPendingBadge(tabId);
}

chrome.runtime.onMessage.addListener(
  (req: WorkerRequest | PickerMessage, sender, sendResponse: (r: WorkerResponse) => void) => {
    (async () => {
      try {
        if (req.type === "capture") {
          const result = await captureActiveTab(req.toggles, req.mode);
          sendResponse({ ok: true, type: "capture", result });
          return;
        }
        if (req.type === "start-picker") {
          await startPicker(req.toggles, req.instructions);
          sendResponse({ ok: true, type: "picker-started" });
          return;
        }
        if (req.type === "picker-pick") {
          await onPickerPick(req, sender);
          return; // fire-and-forget: the popup is closed, the result is stashed
        }
        if (req.type === "picker-cancel") {
          await clearPickerToggles();
          if (sender.tab?.id !== undefined) await clearPendingBadge(sender.tab.id);
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
