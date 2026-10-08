/**
 * Browser View (CONTEXT.md): the operator's live, interactive picture of a session's Shared
 * Browser tab, served on the operator app at `GET /browser-view/<sessionId>` (WebSocket).
 *
 * One view = one `CdpPipe` client via `SharedBrowserManager.attach`, so it runs under the same
 * CDP policy as agents and keeps the browser from idling out while watched. The UI never sends
 * raw CDP: it speaks the small typed protocol below, which this module validates and translates
 * (`Page.startScreencast` frames out; `Input.dispatch*` / `Input.insertText` in).
 *
 * server → client: `{type:"targets", targets:[{id,title,url}], selected}`,
 *                  `{type:"frame", data, width, height}` (base64 jpeg; CSS px of the page),
 *                  `{type:"error", message}`.
 * client → server: `select{targetId}`, `frameAck`, `mouse{…}`, `key{…}`, `text{text}`,
 *                  `navigate{url}`, `reload`, `viewport{width,height,dpr}`.
 *
 * `viewport` is the panel's CSS size: the selected tab is laid out at it via
 * `Emulation.setDeviceMetricsOverride` (last writer wins against an agent's own override), so the
 * page renders ~1:1 whatever the host window's size. Cleared when the view leaves the tab.
 */
import type { CdpClient, CdpPipeClient } from "./cdp-pipe";
import { isWebTargetUrl } from "./cdp-pipe";
import type { SharedBrowserManager } from "./shared-browser";
import type { SessionStore } from "./store";

export interface BrowserViewGateDeps {
  store: Pick<SessionStore, "get" | "getRepoConfig">;
  sharedBrowser?: unknown;
}

/** Pre-upgrade gate: live session → repo opt-in → manager wired. Auth + origin run before it. */
export function gateBrowserView(
  deps: BrowserViewGateDeps,
  sessionId: string,
): { ok: true; repoPath: string } | { ok: false; response: Response } {
  const s = deps.store.get(sessionId);
  if (!s || s.status === "archived")
    return { ok: false, response: Response.json({ error: "session not found" }, { status: 404 }) };
  if (!deps.store.getRepoConfig(s.repoPath).sharedBrowserEnabled)
    return {
      ok: false,
      response: Response.json({ error: "shared browser disabled for this repo" }, { status: 409 }),
    };
  if (!deps.sharedBrowser)
    return {
      ok: false,
      response: Response.json({ error: "shared browser unavailable" }, { status: 503 }),
    };
  return { ok: true, repoPath: s.repoPath };
}

/** WebSocket-like sink to the operator's view socket. */
export interface ViewSink {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

interface ViewTarget {
  id: string;
  title: string;
  url: string;
}

type Json = Record<string, unknown>;

const SCREENCAST = { format: "jpeg", quality: 70, maxWidth: 1920, maxHeight: 1200 } as const;
const MAX_TEXT_CHARS = 10_000;
const MAX_URL_CHARS = 2048;
const MAX_KEY_CHARS = 32;
const MAX_KEY_TEXT_CHARS = 4;
const MAX_COORD = 100_000;
const MAX_DELTA = 10_000;
const CLOSE_UNSUPPORTED = 1003;
const MIN_VIEWPORT = 100;
const MAX_VIEWPORT = 10_000;
const MIN_DPR = 0.5;
const MAX_DPR = 4;

const MOUSE_TYPES: Record<string, string> = {
  down: "mousePressed",
  up: "mouseReleased",
  move: "mouseMoved",
  wheel: "mouseWheel",
};
const MOUSE_BUTTONS = new Set(["none", "left", "middle", "right", "back", "forward"]);

function obj(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function parseJson(text: string): Json | null {
  try {
    return obj(JSON.parse(text));
  } catch {
    return null;
  }
}

function str(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

/** A finite number clamped to [lo, hi]; `fallback` when absent or not a number. */
function num(value: unknown, lo: number, hi: number, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(hi, Math.max(lo, value));
}

const int = (value: unknown, lo: number, hi: number) => Math.round(num(value, lo, hi));

function isHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** A tab the view may show: a page target on the web. */
function viewTarget(info: Json | null): ViewTarget | null {
  if (!info || info.type !== "page") return null;
  const id = typeof info.targetId === "string" ? info.targetId : null;
  const url = typeof info.url === "string" ? info.url : "";
  if (!id || !isWebTargetUrl(url)) return null;
  return { id, title: typeof info.title === "string" ? info.title : "", url };
}

type Command = { method: string; params: Json } | null;

function mouseCommand(msg: Json): Command {
  const type = typeof msg.action === "string" ? MOUSE_TYPES[msg.action] : undefined;
  if (!type) return null;
  const button =
    typeof msg.button === "string" && MOUSE_BUTTONS.has(msg.button) ? msg.button : "none";
  const params: Json = {
    type,
    x: num(msg.x, 0, MAX_COORD),
    y: num(msg.y, 0, MAX_COORD),
    button,
    clickCount: int(msg.clickCount, 0, 3),
    modifiers: int(msg.modifiers, 0, 15),
  };
  if (type === "mouseWheel") {
    params.deltaX = num(msg.deltaX, -MAX_DELTA, MAX_DELTA);
    params.deltaY = num(msg.deltaY, -MAX_DELTA, MAX_DELTA);
  }
  return { method: "Input.dispatchMouseEvent", params };
}

function keyCommand(msg: Json): Command {
  if (msg.action !== "down" && msg.action !== "up") return null;
  const key = str(msg.key, MAX_KEY_CHARS);
  if (key === null) return null;
  const text = msg.action === "down" ? str(msg.text, MAX_KEY_TEXT_CHARS) : null;
  const params: Json = {
    type: msg.action === "up" ? "keyUp" : text ? "keyDown" : "rawKeyDown",
    key,
    code: str(msg.code, MAX_KEY_CHARS) ?? "",
    windowsVirtualKeyCode: int(msg.keyCode, 0, 255),
    modifiers: int(msg.modifiers, 0, 15),
  };
  if (text) {
    params.text = text;
    params.unmodifiedText = text;
  }
  return { method: "Input.dispatchKeyEvent", params };
}

function textCommand(msg: Json): Command {
  const text = str(msg.text, MAX_TEXT_CHARS);
  return text ? { method: "Input.insertText", params: { text } } : null;
}

function navigateCommand(msg: Json): Command {
  const url = str(msg.url, MAX_URL_CHARS);
  return url && isHttpUrl(url) ? { method: "Page.navigate", params: { url } } : null;
}

const INPUT_COMMANDS: Record<string, (msg: Json) => Command> = {
  mouse: mouseCommand,
  key: keyCommand,
  text: textCommand,
  navigate: navigateCommand,
  reload: () => ({ method: "Page.reload", params: {} }),
};

/** Translates one validated UI input message into its CDP command, or null when invalid. */
export function inputCommand(msg: Json): Command {
  const build =
    typeof msg.type === "string" && Object.hasOwn(INPUT_COMMANDS, msg.type)
      ? INPUT_COMMANDS[msg.type]
      : undefined;
  return build ? build(msg) : null;
}

const inRange = (value: unknown, lo: number, hi: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= lo && value <= hi;

/**
 * A `viewport` message → `Emulation.setDeviceMetricsOverride` params, or null when out of range.
 * Not clamped: a hidden panel reports 0×0, which must be ignored rather than applied.
 */
export function viewportOverride(msg: Json): Json | null {
  const { width, height, dpr } = msg;
  if (
    !inRange(width, MIN_VIEWPORT, MAX_VIEWPORT) ||
    !inRange(height, MIN_VIEWPORT, MAX_VIEWPORT) ||
    !inRange(dpr, MIN_DPR, MAX_DPR)
  )
    return null;
  return {
    width: Math.round(width),
    height: Math.round(height),
    deviceScaleFactor: dpr,
    mobile: false,
  };
}

export interface BrowserViewDeps {
  sink: ViewSink;
  /** The session's own tab (from the operator "Open"), preferred as the initial selection. */
  preferredTarget: () => string | null;
}

/** One operator view on one repo's Shared Browser. Wire `cdp` into `attach`, then `start`. */
export class BrowserViewSession {
  readonly #sink: ViewSink;
  readonly #preferred: () => string | null;
  #client: CdpPipeClient | null = null;
  #closed = false;
  #nextId = 0;
  readonly #replies = new Map<number, (msg: Json) => void>();
  readonly #targets = new Map<string, ViewTarget>();
  #selected: string | null = null;
  /** The child CDP session on the selected tab, once attached. */
  #child: string | null = null;
  /** Bumped per selection, so a late attach reply for an old selection is released. */
  #generation = 0;
  /** The screencast frame awaiting the UI's `frameAck`. */
  #pendingAck: number | null = null;
  /** The initial `getTargets` listing is in; until then discovery events only update the map. */
  #listed = false;
  /** The panel's last valid `viewport`, applied to every tab the view attaches. */
  #viewport: Json | null = null;

  /** Pass to `SharedBrowserManager.attach`: the browser's messages for this view. */
  readonly cdp: CdpClient;

  constructor(deps: BrowserViewDeps) {
    this.#sink = deps.sink;
    this.#preferred = deps.preferredTarget;
    this.cdp = {
      send: (text) => this.#onCdp(text),
      close: (code, reason) => {
        this.#closed = true;
        this.#sink.close(code, reason);
      },
    };
  }

  /** The pipe client resolved: discover tabs and select the initial one. */
  start(client: CdpPipeClient): void {
    if (this.#closed) {
      client.detach();
      return;
    }
    this.#client = client;
    this.#command("Target.setDiscoverTargets", { discover: true });
    this.#command("Target.getTargets", {}, undefined, (reply) => {
      const infos = obj(reply.result)?.targetInfos;
      for (const info of Array.isArray(infos) ? infos : []) this.#upsert(obj(info));
      this.#listed = true;
      const preferred = this.#preferred();
      const first = preferred && this.#targets.has(preferred) ? preferred : this.#firstTarget();
      if (first) this.#select(first);
      else this.#broadcastTargets();
    });
  }

  /** One text frame from the operator's socket. */
  handle(text: string): void {
    if (this.#closed) return;
    const msg = parseJson(text);
    if (!msg) {
      this.close();
      this.#sink.close(CLOSE_UNSUPPORTED, "invalid message");
      return;
    }
    if (msg.type === "viewport") {
      this.#setViewport(msg);
      return;
    }
    if (!this.#client) return; // not attached yet: the UI waits for `targets` first
    if (msg.type === "select") {
      const id = typeof msg.targetId === "string" ? msg.targetId : null;
      if (id && this.#targets.has(id)) this.#select(id);
      return;
    }
    if (msg.type === "frameAck") {
      this.#ack();
      return;
    }
    const cmd = inputCommand(msg);
    if (!cmd || !this.#child) return;
    const report = cmd.method === "Page.navigate" || cmd.method === "Page.reload";
    this.#command(
      cmd.method,
      cmd.params,
      this.#child,
      report ? (r) => this.#reportError(r) : undefined,
    );
  }

  /** The operator's socket closed: release the browser session (and with it the screencast). */
  close(): void {
    if (this.#closed && !this.#client) return;
    this.#closed = true;
    if (this.#child) this.#command("Emulation.clearDeviceMetricsOverride", {}, this.#child);
    const client = this.#client;
    this.#client = null;
    this.#replies.clear();
    client?.detach();
  }

  #command(method: string, params: Json, sessionId?: string, onReply?: (msg: Json) => void): void {
    if (!this.#client) return;
    const id = ++this.#nextId;
    if (onReply) this.#replies.set(id, onReply);
    this.#client.receive(
      JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
    );
  }

  #send(msg: Json): void {
    if (!this.#closed) this.#sink.send(JSON.stringify(msg));
  }

  #reportError(reply: Json): void {
    const message = obj(reply.error)?.message;
    if (typeof message === "string") this.#send({ type: "error", message });
  }

  #onCdp(text: string): void {
    if (this.#closed) return;
    let msg: Json | null;
    try {
      msg = obj(JSON.parse(text));
    } catch {
      return;
    }
    if (!msg) return;
    if (typeof msg.id === "number") {
      const onReply = this.#replies.get(msg.id);
      this.#replies.delete(msg.id);
      onReply?.(msg);
      return;
    }
    this.#onEvent(msg);
  }

  #onEvent(msg: Json): void {
    const params = obj(msg.params) ?? {};
    switch (msg.method) {
      case "Target.targetCreated":
      case "Target.targetInfoChanged":
        this.#onTargetInfo(obj(params.targetInfo), msg.method === "Target.targetCreated");
        return;
      case "Target.targetDestroyed": {
        const id = typeof params.targetId === "string" ? params.targetId : null;
        if (!id || !this.#targets.delete(id)) return;
        if (id === this.#selected) this.#deselect();
        this.#broadcastTargets();
        return;
      }
      case "Target.detachedFromTarget":
        if (params.sessionId === this.#child && this.#child !== null) {
          this.#deselect();
          this.#broadcastTargets();
        }
        return;
      case "Page.screencastFrame":
        if (msg.sessionId !== this.#child) return;
        this.#onFrame(params);
        return;
    }
  }

  /** A tab appeared or changed; one that left the web (or isn't a page) drops out of the list. */
  #onTargetInfo(info: Json | null, created: boolean): void {
    const id = typeof info?.targetId === "string" ? info.targetId : null;
    if (!id) return;
    if (!this.#listed) {
      // Discovery replays existing tabs before the initial listing: record, don't select yet.
      if (!this.#upsert(info)) this.#targets.delete(id);
      return;
    }
    if (!this.#upsert(info)) {
      if (!this.#targets.delete(id)) return;
      if (id === this.#selected) this.#deselect();
    } else if (created && this.#selected === null) {
      this.#select(id); // e.g. the operator's "Open tab" from an empty view
      return;
    }
    this.#broadcastTargets();
  }

  #onFrame(params: Json): void {
    const frameSession = params.sessionId;
    const data = params.data;
    if (typeof frameSession !== "number" || typeof data !== "string") return;
    const meta = obj(params.metadata) ?? {};
    this.#pendingAck = frameSession;
    this.#send({
      type: "frame",
      data,
      width: num(meta.deviceWidth, 0, MAX_COORD),
      height: num(meta.deviceHeight, 0, MAX_COORD),
    });
  }

  /** Kept even before attach: the panel sends its size as soon as the socket opens. */
  #setViewport(msg: Json): void {
    const viewport = viewportOverride(msg);
    if (!viewport) return;
    this.#viewport = viewport;
    this.#applyViewport();
  }

  #applyViewport(): void {
    if (this.#viewport && this.#child)
      this.#command("Emulation.setDeviceMetricsOverride", { ...this.#viewport }, this.#child);
  }

  #ack(): void {
    if (this.#pendingAck === null || !this.#child) return;
    const sessionId = this.#pendingAck;
    this.#pendingAck = null;
    this.#command("Page.screencastFrameAck", { sessionId }, this.#child);
  }

  /** Adds/updates a viewable tab; false when `info` is not one. */
  #upsert(info: Json | null): boolean {
    const t = viewTarget(info);
    if (!t) return false;
    this.#targets.set(t.id, t);
    return true;
  }

  #firstTarget(): string | null {
    return this.#targets.keys().next().value ?? null;
  }

  #broadcastTargets(): void {
    this.#send({ type: "targets", targets: [...this.#targets.values()], selected: this.#selected });
  }

  #deselect(): void {
    this.#generation++;
    this.#selected = null;
    this.#child = null;
    this.#pendingAck = null;
  }

  #select(targetId: string): void {
    const old = this.#child;
    this.#deselect();
    if (old) {
      this.#command("Emulation.clearDeviceMetricsOverride", {}, old);
      this.#command("Target.detachFromTarget", { sessionId: old });
    }
    this.#selected = targetId;
    this.#broadcastTargets();
    const generation = this.#generation;
    this.#command("Target.attachToTarget", { targetId, flatten: true }, undefined, (reply) => {
      const child = obj(reply.result)?.sessionId;
      if (typeof child !== "string") {
        this.#reportError(reply);
        return;
      }
      if (generation !== this.#generation) {
        this.#command("Target.detachFromTarget", { sessionId: child });
        return;
      }
      this.#child = child;
      // A hidden headful tab does not paint, so it would never produce a frame.
      this.#command("Target.activateTarget", { targetId });
      this.#command("Page.enable", {}, child);
      this.#applyViewport();
      this.#command("Page.startScreencast", { ...SCREENCAST }, child);
    });
  }
}

/** Opens a view: attaches to the repo's Shared Browser and returns the socket-side handle. */
export function openBrowserView(
  manager: Pick<SharedBrowserManager, "attach" | "sessionTab">,
  repoPath: string,
  sessionId: string,
  sink: ViewSink,
): BrowserViewSession {
  const view = new BrowserViewSession({
    sink,
    preferredTarget: () => manager.sessionTab(repoPath, sessionId),
  });
  manager.attach(repoPath, view.cdp).then(
    (client) => view.start(client),
    (err: unknown) => {
      view.close();
      const code = (err as { code?: unknown }).code;
      sink.close(code === "cap" ? 1013 : 1011, typeof code === "string" ? code : "attach failed");
    },
  );
  return view;
}
