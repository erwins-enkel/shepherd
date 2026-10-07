import { expect, test } from "bun:test";
import type { CdpClient, CdpPipeClient } from "../src/cdp-pipe";
import {
  BrowserViewSession,
  gateBrowserView,
  inputCommand,
  openBrowserView,
} from "../src/browser-view";

type Json = Record<string, any>;

const page = (targetId: string, url = `http://localhost:5173/${targetId}`, title = targetId) => ({
  targetId,
  type: "page",
  url,
  title,
});

function harness(opts: { preferred?: string | null } = {}) {
  const toUi: Json[] = [];
  const sinkClosed: { code?: number; reason?: string }[] = [];
  const toCdp: Json[] = [];
  let detached = 0;
  const view = new BrowserViewSession({
    sink: {
      send: (t) => toUi.push(JSON.parse(t)),
      close: (code, reason) => sinkClosed.push({ code, reason }),
    },
    preferredTarget: () => opts.preferred ?? null,
  });
  const client: CdpPipeClient = {
    receive: (t) => toCdp.push(JSON.parse(t)),
    detach: () => detached++,
    ready: Promise.resolve(),
  };
  const sent = (method: string) => toCdp.filter((m) => m.method === method);
  const reply = (method: string, result: Json, nth = 0) => {
    const m = sent(method)[nth];
    if (!m) throw new Error(`no ${method} sent`);
    view.cdp.send(JSON.stringify({ id: m.id, result }));
  };
  const event = (method: string, params: Json, sessionId?: string) =>
    view.cdp.send(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
  const ui = (msg: Json) => view.handle(JSON.stringify(msg));
  const lastTargets = () => toUi.filter((m) => m.type === "targets").at(-1);
  return {
    view,
    client,
    toUi,
    toCdp,
    sinkClosed,
    sent,
    reply,
    event,
    ui,
    lastTargets,
    detached: () => detached,
  };
}

/** Started, initial tabs listed, `targetId` selected and attached as child session `C1`. */
function attached(targets = [page("T1"), page("T2")], preferred: string | null = null) {
  const h = harness({ preferred });
  h.view.start(h.client);
  h.reply("Target.getTargets", { targetInfos: targets });
  h.reply("Target.attachToTarget", { sessionId: "C1" });
  return h;
}

test("gate: 404 unknown/archived, 409 repo off, 503 unwired, ok with repoPath", () => {
  const sessions: Record<string, any> = {
    live: { repoPath: "/r", status: "idle" },
    gone: { repoPath: "/r", status: "archived" },
  };
  let enabled = false;
  const store = {
    get: (id: string) => sessions[id],
    getRepoConfig: () => ({ sharedBrowserEnabled: enabled }),
  } as any;
  const status = (r: ReturnType<typeof gateBrowserView>) => (r.ok ? 200 : r.response.status);
  expect(status(gateBrowserView({ store, sharedBrowser: {} }, "nope"))).toBe(404);
  expect(status(gateBrowserView({ store, sharedBrowser: {} }, "gone"))).toBe(404);
  expect(status(gateBrowserView({ store, sharedBrowser: {} }, "live"))).toBe(409);
  enabled = true;
  expect(status(gateBrowserView({ store }, "live"))).toBe(503);
  expect(gateBrowserView({ store, sharedBrowser: {} }, "live")).toEqual({
    ok: true,
    repoPath: "/r",
  });
});

test("start: lists web page tabs only, selects the first, then screencasts it", () => {
  const h = harness();
  h.view.start(h.client);
  expect(h.sent("Target.setDiscoverTargets")[0]!.params).toEqual({ discover: true });
  h.reply("Target.getTargets", {
    targetInfos: [
      { targetId: "SW", type: "service_worker", url: "http://localhost/sw.js" },
      page("DT", "devtools://devtools/x"),
      page("T1"),
      page("T2"),
    ],
  });
  expect(h.lastTargets()).toEqual({
    type: "targets",
    targets: [
      { id: "T1", title: "T1", url: "http://localhost:5173/T1" },
      { id: "T2", title: "T2", url: "http://localhost:5173/T2" },
    ],
    selected: "T1",
  });
  expect(h.sent("Target.attachToTarget")[0]!.params).toEqual({ targetId: "T1", flatten: true });
  h.reply("Target.attachToTarget", { sessionId: "C1" });
  const after = h.toCdp.slice(-3).map((m) => [m.method, m.sessionId]);
  expect(after).toEqual([
    ["Target.activateTarget", undefined],
    ["Page.enable", "C1"],
    ["Page.startScreencast", "C1"],
  ]);
  expect(h.sent("Page.startScreencast")[0]!.params.format).toBe("jpeg");
});

test("start: discovery events before the initial listing neither select nor broadcast", () => {
  const h = harness({ preferred: "T2" });
  h.view.start(h.client);
  h.event("Target.targetCreated", { targetInfo: page("T1") });
  h.event("Target.targetCreated", { targetInfo: page("T2") });
  expect(h.toUi).toHaveLength(0);
  expect(h.sent("Target.attachToTarget")).toHaveLength(0);
  h.reply("Target.getTargets", { targetInfos: [page("T1"), page("T2")] });
  expect(h.lastTargets()!.selected).toBe("T2");
  expect(h.sent("Target.attachToTarget")).toHaveLength(1);
});

test("start: prefers the session's own tab when it is still open", () => {
  const h = harness({ preferred: "T2" });
  h.view.start(h.client);
  h.reply("Target.getTargets", { targetInfos: [page("T1"), page("T2")] });
  expect(h.lastTargets()!.selected).toBe("T2");
});

test("start: a stale preferred tab falls back; no tabs → empty list, nothing attached", () => {
  const h = harness({ preferred: "gone" });
  h.view.start(h.client);
  h.reply("Target.getTargets", { targetInfos: [] });
  expect(h.lastTargets()).toEqual({ type: "targets", targets: [], selected: null });
  expect(h.sent("Target.attachToTarget")).toHaveLength(0);
});

test("frames: forwarded with page size; acked only after the UI's frameAck", () => {
  const h = attached();
  h.event(
    "Page.screencastFrame",
    { data: "AAA", sessionId: 7, metadata: { deviceWidth: 1280, deviceHeight: 720 } },
    "C1",
  );
  expect(h.toUi.at(-1)).toEqual({ type: "frame", data: "AAA", width: 1280, height: 720 });
  expect(h.sent("Page.screencastFrameAck")).toHaveLength(0);
  h.ui({ type: "frameAck" });
  h.ui({ type: "frameAck" }); // duplicate: nothing outstanding
  expect(h.sent("Page.screencastFrameAck")).toEqual([
    expect.objectContaining({ params: { sessionId: 7 }, sessionId: "C1" }),
  ]);
});

test("frames from another session are ignored", () => {
  const h = attached();
  h.event("Page.screencastFrame", { data: "AAA", sessionId: 1, metadata: {} }, "OTHER");
  expect(h.toUi.some((m) => m.type === "frame")).toBe(false);
});

test("input: mouse, key, text, navigate, reload go to the selected tab", () => {
  const h = attached();
  h.ui({ type: "mouse", action: "down", x: 10, y: 20, button: "left", clickCount: 1 });
  h.ui({ type: "key", action: "down", key: "a", code: "KeyA", text: "a", keyCode: 65 });
  h.ui({ type: "text", text: "hunter2" });
  h.ui({ type: "navigate", url: "https://example.com/login" });
  h.ui({ type: "reload" });
  const out = h.toCdp.slice(-5);
  expect(out.map((m) => [m.method, m.sessionId])).toEqual([
    ["Input.dispatchMouseEvent", "C1"],
    ["Input.dispatchKeyEvent", "C1"],
    ["Input.insertText", "C1"],
    ["Page.navigate", "C1"],
    ["Page.reload", "C1"],
  ]);
  expect(out[0]!.params).toEqual({
    type: "mousePressed",
    x: 10,
    y: 20,
    button: "left",
    clickCount: 1,
    modifiers: 0,
  });
  expect(out[2]!.params).toEqual({ text: "hunter2" });
});

test("input before a tab is attached is dropped", () => {
  const h = harness();
  h.view.start(h.client);
  h.ui({ type: "text", text: "x" });
  expect(h.sent("Input.insertText")).toHaveLength(0);
});

test("navigate errors are reported to the UI", () => {
  const h = attached();
  h.ui({ type: "navigate", url: "https://example.com/" });
  const nav = h.sent("Page.navigate")[0]!;
  h.view.cdp.send(JSON.stringify({ id: nav.id, error: { message: "blocked" } }));
  expect(h.toUi.at(-1)).toEqual({ type: "error", message: "blocked" });
});

test("inputCommand: validates and clamps, never passes raw CDP", () => {
  expect(inputCommand({ type: "mouse", action: "click" })).toBeNull();
  expect(
    inputCommand({ type: "mouse", action: "wheel", x: -5, y: 1e9, deltaY: 1e9, button: "evil" }),
  ).toEqual({
    method: "Input.dispatchMouseEvent",
    params: {
      type: "mouseWheel",
      x: 0,
      y: 100_000,
      button: "none",
      clickCount: 0,
      modifiers: 0,
      deltaX: 0,
      deltaY: 10_000,
    },
  });
  expect(
    inputCommand({ type: "key", action: "down", key: "Enter", text: "\r", keyCode: 13 }),
  ).toMatchObject({ params: { type: "keyDown", text: "\r", windowsVirtualKeyCode: 13 } });
  expect(inputCommand({ type: "key", action: "down", key: "Backspace", keyCode: 8 })).toMatchObject(
    {
      params: { type: "rawKeyDown" },
    },
  );
  expect(
    inputCommand({ type: "key", action: "up", key: "a", text: "a" })!.params,
  ).not.toHaveProperty("text");
  expect(inputCommand({ type: "key", action: "down", key: "x".repeat(33) })).toBeNull();
  expect(inputCommand({ type: "text", text: "" })).toBeNull();
  expect(inputCommand({ type: "text", text: "x".repeat(10_001) })).toBeNull();
  expect(inputCommand({ type: "navigate", url: "file:///etc/passwd" })).toBeNull();
  expect(inputCommand({ type: "navigate", url: "javascript:alert(1)" })).toBeNull();
  expect(inputCommand({ type: "raw", method: "Browser.close" })).toBeNull();
  expect(inputCommand({ type: "Runtime.evaluate" })).toBeNull();
  expect(inputCommand({ type: "constructor" })).toBeNull();
  expect(inputCommand({ type: "toString" })).toBeNull();
});

test("select: switches tabs, detaching the old session; unknown ids ignored", () => {
  const h = attached();
  h.ui({ type: "select", targetId: "nope" });
  expect(h.sent("Target.attachToTarget")).toHaveLength(1);
  h.ui({ type: "select", targetId: "T2" });
  expect(h.sent("Target.detachFromTarget").at(-1)!.params).toEqual({ sessionId: "C1" });
  expect(h.lastTargets()!.selected).toBe("T2");
  h.reply("Target.attachToTarget", { sessionId: "C2" }, 1);
  h.ui({ type: "text", text: "x" });
  expect(h.sent("Input.insertText")[0]!.sessionId).toBe("C2");
});

test("select: a late attach reply for an abandoned selection is released", () => {
  const h = harness();
  h.view.start(h.client);
  h.reply("Target.getTargets", { targetInfos: [page("T1"), page("T2")] });
  h.ui({ type: "select", targetId: "T2" }); // before T1's attach reply
  h.reply("Target.attachToTarget", { sessionId: "C1" }, 0);
  expect(h.sent("Target.detachFromTarget").at(-1)!.params).toEqual({ sessionId: "C1" });
  expect(h.sent("Page.startScreencast")).toHaveLength(0);
  h.reply("Target.attachToTarget", { sessionId: "C2" }, 1);
  expect(h.sent("Page.startScreencast")[0]!.sessionId).toBe("C2");
});

test("targets: destroyed selected tab deselects; created tab auto-selects into an empty view", () => {
  const h = attached([page("T1")]);
  h.event("Target.targetDestroyed", { targetId: "T1" });
  expect(h.lastTargets()).toEqual({ type: "targets", targets: [], selected: null });
  h.ui({ type: "text", text: "x" });
  expect(h.sent("Input.insertText")).toHaveLength(0);
  h.event("Target.targetCreated", { targetInfo: page("T9") });
  expect(h.lastTargets()!.selected).toBe("T9");
  expect(h.sent("Target.attachToTarget").at(-1)!.params.targetId).toBe("T9");
});

test("targets: title/url updates broadcast; a tab leaving the web drops out", () => {
  const h = attached();
  h.event("Target.targetInfoChanged", { targetInfo: page("T2", "https://x.test/", "Login") });
  expect(h.lastTargets()!.targets[1]).toEqual({ id: "T2", title: "Login", url: "https://x.test/" });
  h.event("Target.targetInfoChanged", { targetInfo: page("T1", "chrome://settings") });
  expect(h.lastTargets()).toMatchObject({ selected: null });
  expect(h.lastTargets()!.targets.map((t: Json) => t.id)).toEqual(["T2"]);
});

test("broker detaching the child (tab left the web) deselects", () => {
  const h = attached();
  h.event("Target.detachedFromTarget", { sessionId: "C1" });
  expect(h.lastTargets()!.selected).toBeNull();
});

test("invalid JSON closes the view with 1003; close() detaches once", () => {
  const h = attached();
  h.view.handle("not json");
  expect(h.sinkClosed).toEqual([{ code: 1003, reason: "invalid message" }]);
  expect(h.detached()).toBe(1);
  h.view.close();
  expect(h.detached()).toBe(1);
});

test("pipe closing the client closes the operator socket", () => {
  const h = attached();
  h.view.cdp.close(1011, "browser stopped");
  expect(h.sinkClosed).toEqual([{ code: 1011, reason: "browser stopped" }]);
});

test("openBrowserView: attach failure closes the socket with the error code", async () => {
  const closed: { code?: number; reason?: string }[] = [];
  const sink = {
    send: () => {},
    close: (code?: number, reason?: string) => closed.push({ code, reason }),
  };
  const err = Object.assign(new Error("full"), { code: "cap" });
  openBrowserView({ attach: () => Promise.reject(err), sessionTab: () => null }, "/r", "s1", sink);
  await Bun.sleep(0);
  expect(closed).toEqual([{ code: 1013, reason: "cap" }]);
});

test("openBrowserView: a socket closed before attach resolves detaches the late client", async () => {
  let resolve!: (c: CdpPipeClient) => void;
  let seen: CdpClient | null = null;
  let detached = 0;
  const view = openBrowserView(
    {
      attach: (_repo, sink) => {
        seen = sink;
        return new Promise((r) => (resolve = r));
      },
      sessionTab: () => "T1",
    },
    "/r",
    "s1",
    { send: () => {}, close: () => {} },
  );
  expect(seen).not.toBeNull();
  view.close();
  resolve({ receive: () => {}, detach: () => detached++, ready: Promise.resolve() });
  await Bun.sleep(0);
  expect(detached).toBe(1);
});
