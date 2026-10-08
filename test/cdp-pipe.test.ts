import { expect, test } from "bun:test";
import { CdpPipe, cdpPolicyViolation, type CdpClient } from "../src/cdp-pipe";

type Msg = Record<string, any>;

interface FakeSession {
  kind: "browser" | "page";
  parent: string | null;
  targetId: string | null;
}

/**
 * Emulates Chromium's pipe end with per-DevTools-session Target state: every
 * attachToBrowserTarget creates an independent browser session; setAutoAttach
 * and attachToTarget create child page sessions owned by the calling session.
 * Replies are held in an outbox until `flush()` so tests control timing.
 */
class FakeBrowser {
  readonly targets = [
    { targetId: "T1", type: "page", url: "http://localhost:5173/" },
    { targetId: "T2", type: "page", url: "about:blank" },
  ];
  readonly sessions = new Map<string, FakeSession>();
  /** Every command the pipe wrote, parsed. */
  readonly received: Msg[] = [];
  outbox: Msg[] = [];
  pipe: CdpPipe;
  #inbuf = "";
  #seq = 0;

  constructor() {
    this.pipe = new CdpPipe({ write: (data) => this.#onWrite(data) });
  }

  flush(): void {
    while (this.outbox.length) {
      const batch = this.outbox;
      this.outbox = [];
      this.pipe.feed(batch.map((m) => `${JSON.stringify(m)}\0`).join(""));
    }
  }

  emit(sessionId: string | undefined, method: string, params: Msg = {}): void {
    this.outbox.push(sessionId ? { method, params, sessionId } : { method, params });
  }

  #onWrite(data: string): void {
    this.#inbuf += data;
    let nul = this.#inbuf.indexOf("\0");
    while (nul !== -1) {
      const msg = JSON.parse(this.#inbuf.slice(0, nul)) as Msg;
      this.#inbuf = this.#inbuf.slice(nul + 1);
      this.received.push(msg);
      this.#handle(msg);
      nul = this.#inbuf.indexOf("\0");
    }
  }

  #reply(msg: Msg, body: Msg): void {
    this.outbox.push(
      msg.sessionId ? { id: msg.id, ...body, sessionId: msg.sessionId } : { id: msg.id, ...body },
    );
  }

  #newSession(kind: FakeSession["kind"], parent: string | null, targetId: string | null): string {
    const id = `${kind === "browser" ? "B" : "C"}${++this.#seq}`;
    this.sessions.set(id, { kind, parent, targetId });
    return id;
  }

  #detachTree(sessionId: string): void {
    this.sessions.delete(sessionId);
    for (const [id, s] of this.sessions) if (s.parent === sessionId) this.#detachTree(id);
  }

  #handle(msg: Msg): void {
    if (!msg.sessionId) return this.#handleRoot(msg);
    const session = this.sessions.get(msg.sessionId);
    if (!session)
      return this.#reply(msg, {
        error: { code: -32001, message: "Session with given id not found." },
      });
    switch (msg.method) {
      case "Target.setAutoAttach":
        if (msg.params?.autoAttach && msg.params?.flatten) {
          for (const t of this.targets) {
            const child = this.#newSession("page", msg.sessionId, t.targetId);
            this.emit(msg.sessionId, "Target.attachedToTarget", {
              sessionId: child,
              targetInfo: t,
              waitingForDebugger: false,
            });
          }
        }
        return this.#reply(msg, { result: {} });
      case "Target.getTargets":
        return this.#reply(msg, { result: { targetInfos: this.targets } });
      case "Target.attachToTarget": {
        const child = this.#newSession("page", msg.sessionId, msg.params.targetId);
        return this.#reply(msg, { result: { sessionId: child } });
      }
      case "Target.detachFromTarget":
        this.#detachTree(msg.params.sessionId);
        this.emit(msg.sessionId, "Target.detachedFromTarget", { sessionId: msg.params.sessionId });
        return this.#reply(msg, { result: {} });
      case "Runtime.evaluate":
        return this.#reply(msg, {
          result: {
            result: { type: "string", value: `${msg.sessionId}:${msg.params.expression}` },
          },
        });
      default:
        return this.#reply(msg, { result: { method: msg.method, session: msg.sessionId } });
    }
  }

  #handleRoot(msg: Msg): void {
    if (msg.method === "Target.setDiscoverTargets") {
      for (const t of this.targets) this.emit(undefined, "Target.targetCreated", { targetInfo: t });
      return this.#reply(msg, { result: {} });
    }
    if (msg.method === "Target.attachToBrowserTarget") {
      const id = this.#newSession("browser", null, null);
      return this.#reply(msg, { result: { sessionId: id } });
    }
    if (msg.method === "Target.detachFromTarget") {
      this.#detachTree(msg.params.sessionId);
      this.emit(undefined, "Target.detachedFromTarget", { sessionId: msg.params.sessionId });
      return this.#reply(msg, { result: {} });
    }
    this.#reply(msg, { error: { code: -32601, message: "not allowed on root" } });
  }
}

class FakeClient implements CdpClient {
  readonly messages: Msg[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(text: string): void {
    this.messages.push(JSON.parse(text) as Msg);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  byId(id: number): Msg | undefined {
    return this.messages.find((m) => m.id === id);
  }
  events(method: string): Msg[] {
    return this.messages.filter((m) => m.method === method);
  }
}

async function attached(fake: FakeBrowser) {
  const sink = new FakeClient();
  const handle = fake.pipe.addClient(sink);
  fake.flush();
  await handle.ready;
  const send = (msg: Msg) => {
    handle.receive(JSON.stringify(msg));
    fake.flush();
  };
  return { sink, handle, send };
}

test("cdp pipe: each client gets its own browser session via attachToBrowserTarget", async () => {
  const fake = new FakeBrowser();
  await attached(fake);
  await attached(fake);
  const attaches = fake.received.filter((m) => m.method === "Target.attachToBrowserTarget");
  expect(attaches).toHaveLength(2);
  for (const a of attaches) expect(a.sessionId).toBeUndefined();
  expect([...fake.sessions.values()].filter((s) => s.kind === "browser")).toHaveLength(2);
  expect(fake.pipe.clientCount).toBe(2);
});

test("cdp pipe: messages before ready are queued and flushed in order", async () => {
  const fake = new FakeBrowser();
  const sink = new FakeClient();
  const handle = fake.pipe.addClient(sink);
  handle.receive(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
  handle.receive(JSON.stringify({ id: 2, method: "Target.getTargets" }));
  expect(fake.received).toHaveLength(2); // only root discovery + the attach handshake so far
  fake.flush();
  await handle.ready;
  expect(fake.received.slice(2).map((m) => m.method)).toEqual([
    "Browser.getVersion",
    "Target.getTargets",
  ]);
  expect(sink.messages.map((m) => m.id)).toEqual([1, 2]);
});

test("cdp pipe: same ids from two clients are rewritten and never cross", async () => {
  const fake = new FakeBrowser();
  const a = await attached(fake);
  const b = await attached(fake);
  a.handle.receive(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
  b.handle.receive(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
  fake.flush();
  const wireIds = fake.received.slice(-2).map((m) => m.id);
  expect(new Set(wireIds).size).toBe(2);
  expect(a.sink.messages).toHaveLength(1);
  expect(b.sink.messages).toHaveLength(1);
  const [ra] = a.sink.messages;
  const [rb] = b.sink.messages;
  expect(ra!.id).toBe(1);
  expect(rb!.id).toBe(1);
  expect(ra!.result.session).not.toBe(rb!.result.session);
});

test("cdp pipe: unsessioned commands are stamped and responses stripped", async () => {
  const fake = new FakeBrowser();
  const a = await attached(fake);
  a.send({ id: 7, method: "Target.getTargets" });
  const wire = fake.received.at(-1)!;
  expect(wire.sessionId).toMatch(/^B/);
  expect(fake.sessions.get(wire.sessionId)?.kind).toBe("browser");
  const res = a.sink.byId(7)!;
  expect(res.sessionId).toBeUndefined();
  expect(res.result.targetInfos).toHaveLength(2);
});

test("cdp pipe: setAutoAttach children are owned and routed to the right client", async () => {
  const fake = new FakeBrowser();
  const a = await attached(fake);
  a.send({
    id: 1,
    method: "Target.setAutoAttach",
    params: { autoAttach: true, flatten: true, waitForDebuggerOnStart: false },
  });
  const events = a.sink.events("Target.attachedToTarget");
  expect(events).toHaveLength(2);
  for (const e of events) expect(e.sessionId).toBeUndefined(); // arrived on browser session
  const child = events[0]!.params.sessionId as string;
  a.send({ id: 2, method: "Runtime.evaluate", params: { expression: "1+1" }, sessionId: child });
  const res = a.sink.byId(2)!;
  expect(res.sessionId).toBe(child); // explicit sessionId is preserved
  expect(res.result.result.value).toBe(`${child}:1+1`);
  // Events on a child session are delivered unchanged.
  fake.emit(child, "Page.loadEventFired", { timestamp: 1 });
  fake.flush();
  expect(a.sink.events("Page.loadEventFired")[0]!.sessionId).toBe(child);
});

test("cdp pipe: attachToTarget response grants ownership of the child session", async () => {
  const fake = new FakeBrowser();
  const a = await attached(fake);
  a.send({ id: 1, method: "Target.attachToTarget", params: { targetId: "T1", flatten: true } });
  const child = a.sink.byId(1)!.result.sessionId as string;
  expect(child).toMatch(/^C/);
  a.send({ id: 2, method: "Runtime.evaluate", params: { expression: "x" }, sessionId: child });
  expect(a.sink.byId(2)!.result.result.value).toBe(`${child}:x`);
  // Detaching the child revokes ownership.
  a.send({ id: 3, method: "Target.detachFromTarget", params: { sessionId: child } });
  expect(a.sink.events("Target.detachedFromTarget")).toHaveLength(1);
  const before = fake.received.length;
  a.send({ id: 4, method: "Runtime.evaluate", params: { expression: "y" }, sessionId: child });
  expect(fake.received).toHaveLength(before);
  expect(a.sink.byId(4)!.error.code).toBe(-32001);
});

test("cdp pipe: foreign sessionId is rejected and not forwarded", async () => {
  const fake = new FakeBrowser();
  const a = await attached(fake);
  const b = await attached(fake);
  a.send({ id: 1, method: "Target.attachToTarget", params: { targetId: "T1", flatten: true } });
  const aChild = a.sink.byId(1)!.result.sessionId as string;
  const aBrowser = fake.received.find((m) => m.method === "Target.attachToTarget")!.sessionId;
  for (const [id, sessionId] of [
    [10, aChild],
    [11, aBrowser],
    [12, "made-up"],
  ] as const) {
    const before = fake.received.length;
    b.send({ id, method: "Runtime.evaluate", params: { expression: "steal" }, sessionId });
    expect(fake.received).toHaveLength(before);
    expect(b.sink.byId(id)).toEqual({
      id,
      error: { code: -32001, message: "Session not owned by this client" },
      sessionId,
    });
  }
  expect(a.sink.messages.filter((m) => m.id !== 1)).toHaveLength(0);
});

test("cdp pipe: two clients both setAutoAttach and each sees the existing page targets", async () => {
  const fake = new FakeBrowser();
  const a = await attached(fake);
  const b = await attached(fake);
  const params = { autoAttach: true, flatten: true, waitForDebuggerOnStart: false };
  a.send({ id: 1, method: "Target.setAutoAttach", params });
  b.send({ id: 1, method: "Target.setAutoAttach", params });
  const aEvents = a.sink.events("Target.attachedToTarget");
  const bEvents = b.sink.events("Target.attachedToTarget");
  expect(aEvents.map((e) => e.params.targetInfo.targetId).sort()).toEqual(["T1", "T2"]);
  expect(bEvents.map((e) => e.params.targetInfo.targetId).sort()).toEqual(["T1", "T2"]);
  const aChildren = new Set(aEvents.map((e) => e.params.sessionId));
  for (const e of bEvents) expect(aChildren.has(e.params.sessionId)).toBe(false);
  // Each drives its own child session on the same target.
  const aT1 = aEvents.find((e) => e.params.targetInfo.targetId === "T1")!.params.sessionId;
  const bT1 = bEvents.find((e) => e.params.targetInfo.targetId === "T1")!.params.sessionId;
  a.send({ id: 2, method: "Runtime.evaluate", params: { expression: "a" }, sessionId: aT1 });
  b.send({ id: 2, method: "Runtime.evaluate", params: { expression: "b" }, sessionId: bT1 });
  expect(a.sink.byId(2)!.result.result.value).toBe(`${aT1}:a`);
  expect(b.sink.byId(2)!.result.result.value).toBe(`${bT1}:b`);
});

test("cdp pipe: one client's detach leaves the other's sessions working", async () => {
  const fake = new FakeBrowser();
  const a = await attached(fake);
  const b = await attached(fake);
  const params = { autoAttach: true, flatten: true, waitForDebuggerOnStart: false };
  a.send({ id: 1, method: "Target.setAutoAttach", params });
  b.send({ id: 1, method: "Target.setAutoAttach", params });
  const aBrowser = fake.received.filter((m) => m.method === "Target.setAutoAttach")[0]!.sessionId;
  const bChild = b.sink.events("Target.attachedToTarget")[0]!.params.sessionId as string;
  const aMessages = a.sink.messages.length;

  a.handle.detach();
  a.handle.detach(); // idempotent
  fake.flush();
  const detaches = fake.received.filter(
    (m) => m.method === "Target.detachFromTarget" && !m.sessionId,
  );
  expect(detaches).toHaveLength(1);
  expect(detaches[0]!.params.sessionId).toBe(aBrowser);
  expect(fake.sessions.has(aBrowser)).toBe(false);
  expect(fake.pipe.clientCount).toBe(1);
  expect(a.sink.closed).toBeNull(); // detach is the client's own disconnect

  b.send({ id: 2, method: "Runtime.evaluate", params: { expression: "still" }, sessionId: bChild });
  expect(b.sink.byId(2)!.result.result.value).toBe(`${bChild}:still`);
  b.send({ id: 3, method: "Browser.getVersion" });
  expect(b.sink.byId(3)!.result).toBeDefined();
  expect(a.sink.messages).toHaveLength(aMessages);
  // Root-session events (the detach notification) reach nobody.
  expect(b.sink.events("Target.detachedFromTarget")).toHaveLength(0);
});

test("cdp pipe: detach before attach resolves releases the browser session afterwards", async () => {
  const fake = new FakeBrowser();
  const sink = new FakeClient();
  const handle = fake.pipe.addClient(sink);
  handle.receive(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
  handle.detach();
  fake.flush();
  await expect(handle.ready).rejects.toThrow();
  const methods = fake.received.map((m) => m.method);
  expect(methods).toEqual([
    "Target.setDiscoverTargets",
    "Target.attachToBrowserTarget",
    "Target.detachFromTarget",
  ]);
  expect(fake.sessions.size).toBe(0);
  expect(sink.messages).toHaveLength(0);
  expect(fake.pipe.clientCount).toBe(0);
});

test("cdp pipe: failed attach closes the client with 1011", async () => {
  const sink = new FakeClient();
  const writes: string[] = [];
  const pipe = new CdpPipe({ write: (d) => writes.push(d) });
  const handle = pipe.addClient(sink);
  const { id } = JSON.parse(writes[1]!.slice(0, -1)) as Msg; // [0] = root discovery
  pipe.feed(`${JSON.stringify({ id, error: { code: -32000, message: "nope" } })}\0`);
  await expect(handle.ready).rejects.toThrow();
  expect(sink.closed?.code).toBe(1011);
  expect(pipe.clientCount).toBe(0);
});

test("cdp pipe: invalid client message closes with 1003", async () => {
  const fake = new FakeBrowser();
  const a = await attached(fake);
  const before = fake.received.length;
  a.send({ method: "Browser.getVersion" } as Msg);
  expect(a.sink.closed?.code).toBe(1003);
  expect(fake.received.slice(before).map((m) => m.method)).toEqual(["Target.detachFromTarget"]);
  const b = await attached(fake);
  b.handle.receive("not json");
  expect(b.sink.closed?.code).toBe(1003);
});

test("cdp pipe: oversized pre-ready queue closes with 1009", () => {
  const fake = new FakeBrowser();
  const sink = new FakeClient();
  const handle = fake.pipe.addClient(sink);
  for (let i = 0; i <= 1000; i++) handle.receive(JSON.stringify({ id: i, method: "X" }));
  expect(sink.closed?.code).toBe(1009);
  fake.flush();
  expect(fake.received.map((m) => m.method)).toEqual([
    "Target.setDiscoverTargets",
    "Target.attachToBrowserTarget",
    "Target.detachFromTarget",
  ]);
});

test("cdp pipe: partial frames and split multi-byte UTF-8 are reassembled", async () => {
  const writes: string[] = [];
  const pipe = new CdpPipe({ write: (d) => writes.push(d) });
  const sink = new FakeClient();
  const handle = pipe.addClient(sink);
  const attachId = (JSON.parse(writes[1]!.slice(0, -1)) as Msg).id; // [0] = root discovery
  pipe.feed(`${JSON.stringify({ id: attachId, result: { sessionId: "B1" } })}\0`);
  await handle.ready;
  handle.receive(JSON.stringify({ id: 1, method: "Runtime.evaluate" }));
  const wireId = (JSON.parse(writes[2]!.slice(0, -1)) as Msg).id;
  const text = "Grüße 🐑 – ok";
  const bytes = new TextEncoder().encode(
    `${JSON.stringify({ id: wireId, result: { value: text }, sessionId: "B1" })}\0${JSON.stringify({ method: "Page.frameNavigated", params: { url: "ü" }, sessionId: "B1" })}\0`,
  );
  // Feed one byte at a time: every multi-byte sequence gets split.
  for (let i = 0; i < bytes.length; i++) pipe.feed(bytes.subarray(i, i + 1));
  expect(sink.messages).toEqual([
    { id: 1, result: { value: text } },
    { method: "Page.frameNavigated", params: { url: "ü" } },
  ]);
});

test("cdp pipe: unknown response ids and root events are dropped", async () => {
  const fake = new FakeBrowser();
  const a = await attached(fake);
  fake.outbox.push({ id: 99_999, result: {} });
  fake.emit(undefined, "Target.targetCreated", { targetInfo: fake.targets[0] });
  fake.emit("someone-else", "Page.loadEventFired", {});
  fake.flush();
  expect(a.sink.messages).toHaveLength(0);
});

test("cdp pipe: close() closes every client and rejects pending readiness", async () => {
  const fake = new FakeBrowser();
  const a = await attached(fake);
  const pendingSink = new FakeClient();
  const pending = fake.pipe.addClient(pendingSink);
  fake.pipe.close("browser exited");
  expect(a.sink.closed).toEqual({ code: 1011, reason: "browser exited" });
  expect(pendingSink.closed?.code).toBe(1011);
  await expect(pending.ready).rejects.toThrow("browser exited");
  expect(fake.pipe.clientCount).toBe(0);
  // Late replies and new clients after close are inert.
  fake.flush();
  const late = new FakeClient();
  fake.pipe.addClient(late);
  expect(late.closed?.code).toBe(1011);
});

test("cdp pipe: policy-blocked methods are refused and never forwarded", async () => {
  const fake = new FakeBrowser();
  const a = await attached(fake);
  const blocked: Msg[] = [
    { method: "Browser.setDownloadBehavior", params: { behavior: "allow", downloadPath: "/" } },
    { method: "Page.setDownloadBehavior", params: { behavior: "allow", downloadPath: "/" } },
    { method: "DOM.setFileInputFiles", params: { files: ["/home/u/.ssh/id_ed25519"] } },
    { method: "Tracing.start" },
    { method: "SystemInfo.getProcessInfo" },
    { method: "Browser.close" },
    { method: "Page.navigate", params: { url: "file:///etc/passwd" } },
    { method: "Target.createTarget", params: { url: "chrome://settings" } },
    { method: "Network.loadNetworkResource", params: { url: "file:///etc/passwd" } },
    { method: "Target.createBrowserContext", params: { proxyServer: "http://evil:8080" } },
    { method: "Page.handleFileChooser", params: { action: "accept", files: ["/etc/shadow"] } },
    {
      method: "Input.dispatchDragEvent",
      params: {
        type: "drop",
        x: 1,
        y: 1,
        data: { items: [], files: ["/etc/passwd"], dragOperationsMask: 1 },
      },
    },
    { method: "Fetch.continueRequest", params: { requestId: "r1", url: "file:///etc/passwd" } },
    {
      method: "Target.sendMessageToTarget",
      params: {
        sessionId: "C9",
        message: JSON.stringify({ id: 1, method: "DOM.setFileInputFiles", params: {} }),
      },
    },
    { method: "Target.attachToTarget", params: { targetId: "T1", flatten: false } },
    { method: "Target.attachToTarget", params: { targetId: "T1" } },
    { method: "Target.setAutoAttach", params: { autoAttach: true, flatten: false } },
    { method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: false } },
  ];
  let id = 100;
  for (const msg of blocked) {
    const before = fake.received.length;
    a.send({ id: ++id, ...msg });
    expect(fake.received).toHaveLength(before);
    expect(a.sink.byId(id)!.error.code).toBe(-32000);
  }
});

test("cdp pipe: web navigation and ordinary methods pass the policy", () => {
  expect(cdpPolicyViolation("Page.navigate", { url: "http://localhost:5173/login" })).toBeNull();
  expect(
    cdpPolicyViolation("Target.createTarget", { url: "https://accounts.example.com" }),
  ).toBeNull();
  expect(cdpPolicyViolation("Target.createTarget", { url: "about:blank" })).toBeNull();
  expect(cdpPolicyViolation("Target.createBrowserContext", {})).toBeNull();
  expect(cdpPolicyViolation("Runtime.evaluate", { expression: "1" })).toBeNull();
  expect(cdpPolicyViolation("Target.setAutoAttach", { flatten: true })).toBeNull();
  expect(cdpPolicyViolation("Target.attachToTarget", { targetId: "T1", flatten: true })).toBeNull();
  expect(cdpPolicyViolation("Target.attachToBrowserTarget", {})).toBeNull();
  expect(cdpPolicyViolation("Fetch.continueRequest", { requestId: "r1" })).toBeNull();
  expect(
    cdpPolicyViolation("Input.dispatchDragEvent", {
      type: "drop",
      data: { items: [{ mimeType: "text/plain", data: "x" }], dragOperationsMask: 1 },
    }),
  ).toBeNull();
});

test("cdp pipe: non-flat session tunnelling is refused per method", () => {
  expect(
    cdpPolicyViolation("Target.sendMessageToTarget", { sessionId: "C1", message: "{}" }),
  ).toMatch(/blocked/);
  expect(cdpPolicyViolation("Target.attachToTarget", { targetId: "T1", flatten: false })).toMatch(
    /flatten/,
  );
  expect(cdpPolicyViolation("Target.attachToTarget", { targetId: "T1" })).toMatch(/flatten/);
  expect(cdpPolicyViolation("Target.setAutoAttach", { autoAttach: true })).toMatch(/flatten/);
  expect(cdpPolicyViolation("Target.setAutoAttach", { autoAttach: true, flatten: "true" })).toMatch(
    /flatten/,
  );
  expect(cdpPolicyViolation("Target.setAutoAttach", undefined)).toMatch(/flatten/);
});

test("cdp policy: allowlist refuses unlisted domains (PWA file handlers, extensions, …)", () => {
  for (const method of [
    "PWA.install",
    "PWA.launchFilesInApp",
    "PWA.openCurrentPageInApp",
    "Extensions.loadUnpacked",
    "Tracing.start",
    "SystemInfo.getProcessInfo",
    "HeapProfiler.takeHeapSnapshot",
    "Browser.close",
    "Browser.grantPermissions",
    "Browser.setDownloadBehavior",
    "Browser.getBrowserCommandLine",
    "SomeFutureDomain.doThing",
    "nodot",
  ])
    expect(cdpPolicyViolation(method, {})).toMatch(/blocked/);
  expect(cdpPolicyViolation(undefined, {})).toMatch(/method name/);
});

test("cdp policy: every method agent-browser 0.32 uses is allowed", () => {
  // Recorded through the real broker while driving tab new/snapshot/fill/click/select/eval/
  // screenshot/scroll/hover/press/cookies/network/viewport/pdf/reload/tab close.
  for (const method of [
    "Browser.getVersion",
    "Browser.setContentsSize",
    "Browser.getWindowForTarget",
    "Runtime.evaluate",
    "Runtime.runIfWaitingForDebugger",
    "Runtime.enable",
    "Runtime.callFunctionOn",
    "Page.enable",
    "Page.reload",
    "Page.printToPDF",
    "Page.captureScreenshot",
    "Network.enable",
    "Network.getCookies",
    "Input.dispatchMouseEvent",
    "Input.dispatchKeyEvent",
    "Input.insertText",
    "Target.setDiscoverTargets",
    "Target.getTargets",
    "Target.closeTarget",
    "Emulation.setDeviceMetricsOverride",
    "DOM.enable",
    "Accessibility.getFullAXTree",
    "Accessibility.enable",
  ])
    expect(cdpPolicyViolation(method, {})).toBeNull();
  expect(
    cdpPolicyViolation("Target.setAutoAttach", { autoAttach: true, flatten: true }),
  ).toBeNull();
  expect(cdpPolicyViolation("Target.attachToTarget", { targetId: "T", flatten: true })).toBeNull();
  expect(cdpPolicyViolation("Target.createTarget", { url: "about:blank" })).toBeNull();
});

test("cdp pipe: Target.openDevTools is refused", async () => {
  const fake = new FakeBrowser();
  const a = await attached(fake);
  const before = fake.received.length;
  a.send({ id: 1, method: "Target.openDevTools", params: { targetId: "T1" } });
  expect(fake.received).toHaveLength(before);
  expect(a.sink.byId(1)!.error.code).toBe(-32000);
});

test("cdp pipe: attach to devtools:// / chrome:// / unknown targets is refused", async () => {
  const fake = new FakeBrowser();
  fake.targets.push(
    { targetId: "DT", type: "page", url: "devtools://devtools/bundled/devtools_app.html" },
    { targetId: "CS", type: "page", url: "chrome://settings/" },
  );
  const a = await attached(fake);
  let id = 0;
  for (const targetId of ["DT", "CS", "NOPE"]) {
    const before = fake.received.length;
    a.send({ id: ++id, method: "Target.attachToTarget", params: { targetId, flatten: true } });
    expect(fake.received).toHaveLength(before);
    expect(a.sink.byId(id)!.error.code).toBe(-32000);
  }
  a.send({ id: 9, method: "Target.attachToTarget", params: { targetId: "T1", flatten: true } });
  expect(a.sink.byId(9)!.result.sessionId).toBeString();
});

test("cdp pipe: auto-attach to a non-web target is detached and never shown", async () => {
  const fake = new FakeBrowser();
  fake.targets.push({ targetId: "DT", type: "page", url: "devtools://devtools/x.html" });
  const a = await attached(fake);
  a.send({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true, flatten: true } });
  fake.flush();
  const shown = a.sink.events("Target.attachedToTarget").map((e) => e.params.targetInfo.targetId);
  expect(shown).toEqual(["T1", "T2"]);
  expect(a.sink.events("Target.detachedFromTarget")).toHaveLength(0);
  const dtSessions = [...fake.sessions.values()].filter((s) => s.targetId === "DT");
  expect(dtSessions).toHaveLength(0);
});

test("cdp pipe: a tab navigating to chrome:// loses its agent sessions", async () => {
  const fake = new FakeBrowser();
  const a = await attached(fake);
  a.send({ id: 1, method: "Target.attachToTarget", params: { targetId: "T1", flatten: true } });
  const child = a.sink.byId(1)!.result.sessionId as string;
  fake.emit(undefined, "Target.targetInfoChanged", {
    targetInfo: { targetId: "T1", type: "page", url: "chrome://settings/" },
  });
  fake.flush();
  expect(fake.sessions.has(child)).toBe(false);
  expect(a.sink.events("Target.detachedFromTarget").map((e) => e.params.sessionId)).toEqual([
    child,
  ]);
  const before = fake.received.length;
  a.send({ id: 2, method: "Runtime.evaluate", params: { expression: "1" }, sessionId: child });
  expect(fake.received).toHaveLength(before);
  expect(a.sink.byId(2)!.error.code).toBe(-32001);
});

// ── confined clients (#2883) ─────────────────────────────────────────────────

/** A browser with two default-context tabs (T1, T2) and one tab (O1) in context "CTX". */
function confinedBrowser(): FakeBrowser {
  const fake = new FakeBrowser();
  for (const t of fake.targets) Object.assign(t, { browserContextId: "DEFAULT" });
  fake.targets.push({
    targetId: "O1",
    type: "page",
    url: "about:blank",
    browserContextId: "CTX",
  } as (typeof fake.targets)[number]);
  // Root discovery already ran in the constructor: replay it with the contexts set.
  for (const t of fake.targets) fake.emit(undefined, "Target.targetInfoChanged", { targetInfo: t });
  fake.flush();
  return fake;
}

async function confined(fake: FakeBrowser) {
  const sink = new FakeClient();
  const handle = fake.pipe.addClient(sink, { contextId: "CTX" });
  fake.flush();
  await handle.ready;
  const send = (msg: Msg) => {
    handle.receive(JSON.stringify(msg));
    fake.flush();
  };
  return { sink, handle, send };
}

test("cdp pipe confined: getTargets lists only the client's own context", async () => {
  const fake = confinedBrowser();
  const c = await confined(fake);
  c.send({ id: 1, method: "Target.getTargets" });
  expect(c.sink.byId(1)!.result.targetInfos.map((t: Msg) => t.targetId)).toEqual(["O1"]);
  const u = await attached(fake);
  u.send({ id: 1, method: "Target.getTargets" });
  expect(u.sink.byId(1)!.result.targetInfos).toHaveLength(3);
});

test("cdp pipe confined: createTarget and cookie calls are forced into the own context", async () => {
  const fake = confinedBrowser();
  const c = await confined(fake);
  c.send({ id: 1, method: "Target.createTarget", params: { url: "about:blank" } });
  c.send({
    id: 2,
    method: "Target.createTarget",
    params: { url: "about:blank", browserContextId: "DEFAULT" },
  });
  c.send({ id: 3, method: "Storage.getCookies", params: {} });
  c.send({ id: 4, method: "Storage.setCookies", params: { cookies: [], browserContextId: "X" } });
  const sent = fake.received.filter((m) =>
    ["Target.createTarget", "Storage.getCookies", "Storage.setCookies"].includes(m.method),
  );
  expect(sent).toHaveLength(4);
  for (const m of sent) expect(m.params.browserContextId).toBe("CTX");
});

test("cdp pipe confined: foreign targets cannot be attached, activated or closed", async () => {
  const fake = confinedBrowser();
  const c = await confined(fake);
  let id = 0;
  for (const method of ["Target.attachToTarget", "Target.activateTarget", "Target.closeTarget"]) {
    const before = fake.received.length;
    c.send({ id: ++id, method, params: { targetId: "T1", flatten: true } });
    expect(fake.received).toHaveLength(before);
    expect(c.sink.byId(id)!.error.code).toBe(-32000);
  }
  c.send({ id: 9, method: "Target.attachToTarget", params: { targetId: "O1", flatten: true } });
  expect(c.sink.byId(9)!.result.sessionId).toBeString();
});

test("cdp pipe confined: context escapes and browser-wide domains are refused", async () => {
  const fake = confinedBrowser();
  const c = await confined(fake);
  const refused = [
    { method: "Target.createBrowserContext", params: {} },
    { method: "Target.disposeBrowserContext", params: { browserContextId: "DEFAULT" } },
    { method: "Target.attachToBrowserTarget", params: {} },
    { method: "Fetch.enable", params: { patterns: [{ urlPattern: "*" }] } },
    { method: "Storage.clearDataForOrigin", params: { origin: "http://localhost:7330" } },
    { method: "Network.enable", params: {} },
  ];
  let id = 0;
  for (const m of refused) {
    const before = fake.received.length;
    c.send({ id: ++id, ...m });
    expect(fake.received).toHaveLength(before);
    expect(c.sink.byId(id)!.error.code).toBe(-32000);
  }
  // Page-level domains still work on an own child session.
  c.send({ id: 20, method: "Target.attachToTarget", params: { targetId: "O1", flatten: true } });
  const child = c.sink.byId(20)!.result.sessionId as string;
  c.send({ id: 21, method: "Fetch.enable", params: {}, sessionId: child });
  expect(c.sink.byId(21)!.result).toBeDefined();
});

test("cdp pipe confined: auto-attach and discovery hide other contexts", async () => {
  const fake = confinedBrowser();
  const c = await confined(fake);
  c.send({ id: 1, method: "Target.setAutoAttach", params: { autoAttach: true, flatten: true } });
  fake.flush();
  const shown = c.sink.events("Target.attachedToTarget").map((e) => e.params.targetInfo.targetId);
  expect(shown).toEqual(["O1"]);
  expect(c.sink.events("Target.detachedFromTarget")).toHaveLength(0);
  expect(
    [...fake.sessions.values()].filter((s) => s.kind === "page").map((s) => s.targetId),
  ).toEqual(["O1"]);
  const browserSession = fake.received.find((m) => m.method === "Target.setAutoAttach")!.sessionId;
  fake.emit(browserSession, "Target.targetCreated", { targetInfo: fake.targets[0] });
  fake.emit(browserSession, "Target.targetCreated", { targetInfo: fake.targets[2] });
  fake.emit(browserSession, "Target.targetDestroyed", { targetId: "T1" });
  fake.emit(browserSession, "Target.targetDestroyed", { targetId: "O1" });
  fake.flush();
  expect(c.sink.events("Target.targetCreated").map((e) => e.params.targetInfo.targetId)).toEqual([
    "O1",
  ]);
  expect(c.sink.events("Target.targetDestroyed").map((e) => e.params.targetId)).toEqual(["O1"]);
});

test("cdp pipe: call() resolves results, rejects errors and rejects on close", async () => {
  const fake = new FakeBrowser();
  const ok = fake.pipe.call("Target.attachToBrowserTarget");
  const bad = fake.pipe.call("Browser.close");
  fake.flush();
  expect((await ok).sessionId).toBeString();
  expect(bad).rejects.toThrow("not allowed on root");
  const pending = fake.pipe.call("Target.setDiscoverTargets", { discover: true });
  fake.pipe.close("gone");
  expect(pending).rejects.toThrow("gone");
  expect(fake.pipe.call("Target.getTargets")).rejects.toThrow("browser closed");
});
