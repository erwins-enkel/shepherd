import { EventsSocket } from "./events";
import { PtySocket } from "./pty/socket";
import { handleApi } from "./router";

// The single entry seam for demo mode. Called once under `__DEMO__` from
// hooks.client.ts. Replaces `globalThis.fetch` + `globalThis.WebSocket` with the
// in-browser fakes and neutralises the service worker so a returning visitor is
// never served a stale cached demo build. Idempotent — a second call is a no-op.

let installed = false;

function base(): string {
  return (globalThis as { location?: { href?: string } }).location?.href ?? "http://localhost/";
}

/** Resolve the request URL from any fetch input, tolerating relative paths. */
function resolveUrl(input: RequestInfo | URL): URL {
  const raw = input instanceof Request ? input.url : String(input);
  return new URL(raw, base());
}

async function readBody(init: RequestInit | undefined, req: Request | null): Promise<unknown> {
  const raw = init?.body ?? (req ? await req.clone().text() : undefined);
  if (typeof raw !== "string" || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function patchFetch(): void {
  const original = globalThis.fetch?.bind(globalThis);
  globalThis.fetch = async function demoFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = resolveUrl(input);
    if (url.pathname.startsWith("/api/")) {
      const req = input instanceof Request ? input : null;
      const method = init?.method ?? req?.method ?? "GET";
      const body = await readBody(init, req);
      return handleApi(method, url, body);
    }
    // Non-API traffic (assets, external) still hits the real network.
    if (!original) throw new TypeError("fetch is not available in this environment");
    return original(input, init);
  } as typeof fetch;
}

function patchWebSocket(): void {
  const OriginalWebSocket = globalThis.WebSocket;

  class DemoWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    constructor(url: string | URL, protocols?: string | string[]) {
      const u = new URL(String(url), base());
      if (u.pathname === "/events") {
        return new EventsSocket(String(url)) as unknown as DemoWebSocket;
      }
      if (u.pathname.startsWith("/pty/")) {
        return new PtySocket(String(url)) as unknown as DemoWebSocket;
      }
      // Anything else (should not happen in demo) → a real socket, if one exists.
      if (!OriginalWebSocket) {
        throw new TypeError(`No WebSocket transport for ${u.pathname} in demo mode`);
      }
      return new OriginalWebSocket(url, protocols) as unknown as DemoWebSocket;
    }
  }

  globalThis.WebSocket = DemoWebSocket as unknown as typeof WebSocket;
}

function neutraliseServiceWorker(): void {
  try {
    const sw = (globalThis as { navigator?: Navigator }).navigator?.serviceWorker;
    if (!sw?.getRegistrations) return;
    // Drop any SW a previous (non-demo) visit registered so its cache can't serve
    // a stale build. `push.ts` is separately guarded to never (re)register in demo.
    sw.getRegistrations()
      .then((regs) => regs.forEach((r) => r.unregister().catch(() => {})))
      .catch(() => {});
  } catch {
    /* no service-worker environment (node/jsdom) */
  }
}

export function installDemoBackend(): void {
  if (installed) return;
  installed = true;
  patchFetch();
  patchWebSocket();
  neutraliseServiceWorker();
}
