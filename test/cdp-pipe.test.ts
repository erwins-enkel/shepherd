import { expect, test } from "bun:test";
import { CdpPipe, type CdpClient } from "../src/cdp-pipe";

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
  expect(fake.received).toHaveLength(1); // only the attach handshake so far
  fake.flush();
  await handle.ready;
  expect(fake.received.slice(1).map((m) => m.method)).toEqual([
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
  expect(methods).toEqual(["Target.attachToBrowserTarget", "Target.detachFromTarget"]);
  expect(fake.sessions.size).toBe(0);
  expect(sink.messages).toHaveLength(0);
  expect(fake.pipe.clientCount).toBe(0);
});

test("cdp pipe: failed attach closes the client with 1011", async () => {
  const sink = new FakeClient();
  const writes: string[] = [];
  const pipe = new CdpPipe({ write: (d) => writes.push(d) });
  const handle = pipe.addClient(sink);
  const { id } = JSON.parse(writes[0]!.slice(0, -1)) as Msg;
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
    "Target.attachToBrowserTarget",
    "Target.detachFromTarget",
  ]);
});

test("cdp pipe: partial frames and split multi-byte UTF-8 are reassembled", async () => {
  const writes: string[] = [];
  const pipe = new CdpPipe({ write: (d) => writes.push(d) });
  const sink = new FakeClient();
  const handle = pipe.addClient(sink);
  const attachId = (JSON.parse(writes[0]!.slice(0, -1)) as Msg).id;
  pipe.feed(`${JSON.stringify({ id: attachId, result: { sessionId: "B1" } })}\0`);
  await handle.ready;
  handle.receive(JSON.stringify({ id: 1, method: "Runtime.evaluate" }));
  const wireId = (JSON.parse(writes[1]!.slice(0, -1)) as Msg).id;
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
