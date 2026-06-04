// Page-side recorder, registered dynamically (MAIN world, document_start) only
// while the user has opted into console/network capture. Keeps a bounded ring
// buffer on window.__shepherdCapture that background.ts reads at capture time.
// Buffer + failure-classification logic lives in lib/recorder-core (unit-tested).
import { isFailedResponse, normalizeConsoleArgs, pushCapped } from "./lib/recorder-core";
import type { ConsoleEntry, NetworkEntry } from "./lib/signals";

const CAP = 50;

interface CaptureBuffer {
  console: ConsoleEntry[];
  network: NetworkEntry[];
}

declare global {
  interface Window {
    __shepherdCapture?: CaptureBuffer;
  }
}

(() => {
  if (window.__shepherdCapture) return; // idempotent across re-injection
  const buf: CaptureBuffer = { console: [], network: [] };
  window.__shepherdCapture = buf;
  const now = () => new Date().toISOString();

  // --- console.error / console.warn ---
  for (const level of ["error", "warn"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      pushCapped(buf.console, { level, text: normalizeConsoleArgs(args), ts: now() }, CAP);
      orig(...args);
    };
  }

  // --- uncaught errors + resource load failures ---
  window.addEventListener(
    "error",
    (event) => {
      const target = event.target as (HTMLElement & { src?: string; href?: string }) | null;
      if (target && target !== (window as unknown) && "tagName" in target) {
        const url = target.src || target.href || "";
        pushCapped(buf.network, { method: "GET", url, status: "load-error", ts: now() }, CAP);
      } else {
        pushCapped(
          buf.console,
          { level: "error", text: event.message || "Uncaught error", ts: now() },
          CAP,
        );
      }
    },
    true, // capture phase so resource errors (which don't bubble) are seen
  );

  // --- unhandled promise rejections ---
  window.addEventListener("unhandledrejection", (event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    const text = reason instanceof Error ? reason.message : String(reason);
    pushCapped(
      buf.console,
      { level: "error", text: `Unhandled rejection: ${text}`, ts: now() },
      CAP,
    );
  });

  // --- fetch failures ---
  const origFetch = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const input = args[0];
    const url =
      typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    const method = args[1]?.method || (input instanceof Request ? input.method : "GET");
    try {
      const res = await origFetch(...args);
      if (isFailedResponse(res.status)) {
        pushCapped(buf.network, { method, url, status: res.status, ts: now() }, CAP);
      }
      return res;
    } catch (err) {
      pushCapped(buf.network, { method, url, status: "error", ts: now() }, CAP);
      throw err;
    }
  };

  // --- XHR failures ---
  const OrigXHR = window.XMLHttpRequest;
  const meta = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
  const origOpen = OrigXHR.prototype.open;
  const origSend = OrigXHR.prototype.send;
  OrigXHR.prototype.open = function (method: string, url: string | URL, ...rest: unknown[]) {
    meta.set(this, { method, url: String(url) });

    return origOpen.apply(this, [method, url, ...rest] as never);
  };
  OrigXHR.prototype.send = function (...args: unknown[]) {
    this.addEventListener("loadend", () => {
      const m = meta.get(this);
      if (!m) return;
      if (this.status === 0) {
        pushCapped(buf.network, { method: m.method, url: m.url, status: "error", ts: now() }, CAP);
      } else if (isFailedResponse(this.status)) {
        pushCapped(
          buf.network,
          { method: m.method, url: m.url, status: this.status, ts: now() },
          CAP,
        );
      }
    });
    return origSend.apply(this, args as never);
  };
})();
