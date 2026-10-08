/**
 * Browser Attach broker (ADR 0001): the token-gated CDP WebSocket an agent reaches on the
 * agent-ingress listener at `GET /api/sessions/<id>/browser?token=<hex>`.
 *
 * The gate runs BEFORE the upgrade, so a refused attach is a plain HTTP status the agent's
 * CDP client can report. After the upgrade every client message is handed to the repo's
 * `CdpPipe` through `SharedBrowserManager.attach`, which is async (it may launch Chromium):
 * messages arriving before it resolves are buffered under a byte cap.
 */
import type { ServerWebSocket } from "bun";
import type { BrowserTokenSigner } from "./browser-token";
import { resolvePreviewPort, type OriginPolicy } from "./browser-origin-policy";
import type { CdpPipeClient } from "./cdp-pipe";
import type { NetnsDevForwarder } from "./netns-dev-forward";
import { config } from "./config";
import { resolveProfile } from "./sandbox";
import {
  SharedBrowserError,
  type BrowserConfinement,
  type SharedBrowserManager,
} from "./shared-browser";
import type { SessionStore } from "./store";
import type { SessionPreviewState } from "./types";

export interface BrowserBrokerDeps {
  store: Pick<SessionStore, "get" | "getRepoConfig">;
  browserToken?: Pick<BrowserTokenSigner, "verify">;
  sharedBrowser?: Pick<SharedBrowserManager, "attach">;
  /** Session Preview listeners: an autonomous attach's one loopback origin. */
  preview?: {
    snapshot(): Record<string, SessionPreviewState>;
    devPortFor?(sessionId: string): number | null;
  };
  /** In-netns dev server forwards (#2889): an autonomous attach's `localhost:<devPort>`. */
  netnsDevForward?: Pick<NetnsDevForwarder, "devPort" | "forward">;
}

/** Per-socket state, attached via `server.upgrade(req, { data })`. */
export interface BrowserWsData {
  sessionId: string;
  repoPath: string;
  client: CdpPipeClient | null;
  /** Autonomous sessions (#2883): attach confined to a proxied context under this policy. */
  confine: BrowserConfinement | null;
  /** client→browser messages held until `attach` resolves. */
  pending: string[];
  pendingBytes: number;
  closed: boolean;
}

/** Pre-attach buffer cap and server→client send-buffer cap per socket; exceeding either → 1009. */
const MAX_PENDING_BYTES = 1024 * 1024;
const MAX_BUFFERED_SEND_BYTES = 8 * 1024 * 1024;

const CLOSE_UNSUPPORTED = 1003;
const CLOSE_POLICY = 1008;
const CLOSE_TOO_BIG = 1009;
const CLOSE_INTERNAL = 1011;
const CLOSE_TRY_AGAIN = 1013;
/** RFC 6455 caps a close reason at 123 bytes. */
const MAX_REASON_CHARS = 100;

function refuse(status: number, error: string): { ok: false; response: Response } {
  return { ok: false, response: Response.json({ error }, { status }) };
}

/** True for the broker's exact path shape: `["api","sessions",<id>,"browser"]`. */
export function isBrowserAttachPath(parts: string[]): boolean {
  return (
    parts.length === 4 && parts[0] === "api" && parts[1] === "sessions" && parts[3] === "browser"
  );
}

/**
 * The browser origin allowlist for an autonomous session (#2883), read live per connection: the
 * repo's `browserAllowedHosts`, the session's own validated Preview port, and its verified in-netns
 * dev port (#2889). Shepherd's main and agent-ingress ports are never a Preview origin, nor the
 * target its listener relays to.
 */
export function autonomousOriginPolicy(
  deps: Pick<BrowserBrokerDeps, "store" | "preview" | "netnsDevForward">,
  sessionId: string,
  repoPath: string,
): OriginPolicy {
  return {
    allowedHosts: () => deps.store.getRepoConfig(repoPath).browserAllowedHosts,
    previewPort: () =>
      resolvePreviewPort({
        previewPort: deps.preview?.snapshot()[sessionId]?.previewPort,
        devPort: deps.preview?.devPortFor?.(sessionId),
        rangeBase: config.previewPortBase,
        rangeCount: config.previewPortCount,
        denyPorts: [config.port, config.agentIngressPort],
      }),
    devPort: async () => (await deps.netnsDevForward?.devPort(sessionId)) ?? null,
    devForward: async (port) => (await deps.netnsDevForward?.forward(sessionId, port)) ?? null,
  };
}

/**
 * Pre-upgrade gate, in order: token → live session → repo opt-in → manager wired. 401 never says
 * which check failed, so a token cannot be probed against ids. An autonomous session's attach is
 * confined (#2883): its own browser context behind an egress proxy enforcing the origin allowlist,
 * seeded only with logins for allowed hosts (none → the attach closes with 1008 `no-login`).
 */
export function gateBrowserAttach(
  deps: BrowserBrokerDeps,
  sessionId: string,
  token: string | null,
): { ok: true; data: BrowserWsData } | { ok: false; response: Response } {
  if (!deps.browserToken?.verify(sessionId, token)) return refuse(401, "unauthorized");
  const s = deps.store.get(sessionId);
  if (!s || s.status === "archived") return refuse(401, "unauthorized");
  const repoCfg = deps.store.getRepoConfig(s.repoPath);
  if (!repoCfg.sharedBrowserEnabled) return refuse(403, "shared browser disabled for this repo");
  const profile = resolveProfile(
    s.sandboxApplied ?? undefined,
    repoCfg.sandboxProfile,
    config.sandboxDefaultProfile,
  );
  if (!deps.sharedBrowser) return refuse(503, "shared browser unavailable");
  const confine =
    profile === "autonomous"
      ? { policy: autonomousOriginPolicy(deps, sessionId, s.repoPath) }
      : null;
  return {
    ok: true,
    data: {
      sessionId,
      repoPath: s.repoPath,
      client: null,
      confine,
      pending: [],
      pendingBytes: 0,
      closed: false,
    },
  };
}

function safeClose(ws: ServerWebSocket<BrowserWsData>, code?: number, reason?: string): void {
  ws.data.closed = true;
  try {
    ws.close(code, reason?.slice(0, MAX_REASON_CHARS));
  } catch {
    // already closed
  }
}

function boundedSend(ws: ServerWebSocket<BrowserWsData>, text: string): void {
  if (ws.data.closed) return;
  try {
    ws.send(text);
  } catch {
    return;
  }
  // A client that stops reading must not grow the server's heap without bound.
  if (ws.getBufferedAmount() > MAX_BUFFERED_SEND_BYTES)
    safeClose(ws, CLOSE_TOO_BIG, "client not reading");
}

function attachFailure(err: unknown): { code: number; reason: string } {
  if (err instanceof SharedBrowserError) {
    if (err.code === "no-login")
      return {
        code: CLOSE_POLICY,
        reason: "no-login: ask the operator to log in to an allowlisted host",
      };
    return { code: err.code === "cap" ? CLOSE_TRY_AGAIN : CLOSE_INTERNAL, reason: err.code };
  }
  return { code: CLOSE_INTERNAL, reason: "attach failed" };
}

/** Bun `websocket` handlers for the broker. `manager()` is read at open (the gate proved it set). */
export function makeBrowserBrokerHandlers(
  manager: () => Pick<SharedBrowserManager, "attach"> | undefined,
) {
  return {
    open(ws: ServerWebSocket<BrowserWsData>) {
      const m = manager();
      if (!m) {
        safeClose(ws, CLOSE_INTERNAL, "shared browser unavailable");
        return;
      }
      const sink = {
        send: (text: string) => boundedSend(ws, text),
        close: (code?: number, reason?: string) => safeClose(ws, code, reason),
      };
      m.attach(ws.data.repoPath, sink, ws.data.confine ?? undefined).then(
        (client) => {
          const st = ws.data;
          if (st.closed) {
            client.detach();
            return;
          }
          st.client = client;
          const queued = st.pending.splice(0);
          st.pendingBytes = 0;
          for (const text of queued) client.receive(text);
        },
        (err: unknown) => {
          const { code, reason } = attachFailure(err);
          safeClose(ws, code, reason);
        },
      );
    },

    message(ws: ServerWebSocket<BrowserWsData>, msg: string | Buffer) {
      const st = ws.data;
      if (st.closed) return;
      if (typeof msg !== "string") {
        safeClose(ws, CLOSE_UNSUPPORTED, "binary frames not supported");
        return;
      }
      if (st.client) {
        st.client.receive(msg);
        return;
      }
      const bytes = Buffer.byteLength(msg);
      if (st.pendingBytes + bytes > MAX_PENDING_BYTES) {
        safeClose(ws, CLOSE_TOO_BIG, "too many messages before attach");
        return;
      }
      st.pendingBytes += bytes;
      st.pending.push(msg);
    },

    close(ws: ServerWebSocket<BrowserWsData>) {
      const st = ws.data;
      st.closed = true;
      st.pending = [];
      st.pendingBytes = 0;
      const client = st.client;
      st.client = null;
      client?.detach();
    },
  };
}
