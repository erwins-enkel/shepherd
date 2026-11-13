import { afterEach, expect, spyOn, test } from "bun:test";
import { serve, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { AccessTokenService } from "../src/access-tokens";
import { config } from "../src/config";
import { SocketPtyBridge } from "../src/socket-pty-bridge";
import { PtyBridge } from "../src/pty-bridge";
import { HerdrSocketClient } from "../src/herdr-socket-client";
import { CLEAN_TERMINAL_PREFIX as prefix } from "../shared/clean-terminal";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
const settle = () => Bun.sleep(40);

async function setup(terminal = true) {
  const old = { host: config.host, token: config.token, cookieSecret: config.cookieSecret };
  Object.assign(config, { host: "127.0.0.1", token: null, cookieSecret: "test-clean-terminal" });
  cleanup.push(() => Object.assign(config, old));
  const store = new SessionStore(":memory:");
  const accessTokens = new AccessTokenService(store);
  const minted = accessTokens.mint("test", null, "full", null);
  const session = store.create({
    name: "terminal",
    prompt: "",
    repoPath: "/repo",
    baseBranch: "main",
    worktreePath: "/repo",
    branch: null,
    isolated: false,
    herdrSession: "h",
    herdrAgentId: "shell",
    terminal,
    terminalPaneId: "w1:p1",
    terminalTabId: "w1:t1",
  });
  const writes: string[] = [];
  for (const proto of [SocketPtyBridge.prototype, PtyBridge.prototype]) {
    const open = spyOn(proto, "open").mockImplementation(function (this: SocketPtyBridge) {
      const instance = this as unknown as {
        ws: { send(data: string): void };
        hooks?: { onFirstFrame?(): void };
      };
      instance.ws.send("shell ready");
      instance.hooks?.onFirstFrame?.();
    });
    const write = spyOn(proto, "write").mockImplementation((data: string) => {
      writes.push(data);
    });
    cleanup.push(() => {
      open.mockRestore();
      write.mockRestore();
    });
  }
  const rpc = spyOn(HerdrSocketClient.prototype, "request").mockImplementation(async (method) => {
    if (method === "pane.get" || method === "pane.scroll")
      return {
        type: "pane_info",
        pane: { scroll: { offset_from_bottom: 0, max_offset_from_bottom: 270, viewport_rows: 30 } },
      } as never;
    if (method === "pane.copy_motion")
      return { type: "pane_copy_motion", content_revision: 12 } as never;
    if (method === "pane.selection.read") return { type: "pane_selection", text: "x" } as never;
    return { type: "pane_read", read: { text: "x", revision: 0 } } as never;
  });
  cleanup.push(() => rpc.mockRestore());
  const server = serve(
    {
      store,
      accessTokens,
      events: new EventHub(),
      service: {},
      resolveForge: () => null,
    } as unknown as AppDeps,
    0,
  );
  cleanup.push(() => server.stop(true));
  const connect = async () => {
    const output: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/pty/${session.id}`, {
      headers: { Authorization: `Bearer ${minted.token}` },
    } as never);
    ws.onmessage = (e) => {
      output.push(typeof e.data === "string" ? e.data : "binary");
    };
    cleanup.push(() => ws.close());
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = reject;
    });
    await settle();
    return { ws, output };
  };
  return { connect, rpc, writes, accessTokens, minted };
}

test("clean terminal control frames stay out of shell input; a takeover parks the old controller", async () => {
  const f = await setup();
  const first = await f.connect();
  first.ws.send(prefix + JSON.stringify({ id: 1, op: "init" }));
  await settle();
  expect(first.output.some((data) => data.startsWith(prefix))).toBe(true);
  expect(
    JSON.parse(first.output.find((data) => data.startsWith(prefix))!.slice(prefix.length)).scroll
      .max_offset_from_bottom,
  ).toBe(270);
  expect(
    f.rpc.mock.calls.every(([, params]) => (params as { pane_id: string }).pane_id === "w1:p1"),
  ).toBe(true);
  first.ws.send(prefix + "{bad}");
  first.ws.send("echo hello\r");
  await settle();
  expect(f.writes).toEqual(["echo hello\r"]);
  const second = await f.connect();
  expect(first.ws.readyState).toBe(WebSocket.CLOSED);
  second.ws.send(prefix + JSON.stringify({ id: 2, op: "init" }));
  await settle();
  expect(second.output.some((data) => data.startsWith(prefix))).toBe(true);
});

test("agent sessions swallow shell-only control messages without opting into the new behavior", async () => {
  const f = await setup(false);
  const { ws, output } = await f.connect();
  ws.send(prefix + JSON.stringify({ id: 1, op: "init" }));
  await settle();
  expect(f.rpc).not.toHaveBeenCalled();
  expect(f.writes).toEqual([]);
  expect(output.some((data) => data.startsWith(prefix))).toBe(false);
});

test("revoking the owner token suppresses an in-flight controller reply", async () => {
  const f = await setup();
  const { ws, output } = await f.connect();
  const pending = Promise.withResolvers<never>();
  f.rpc.mockImplementationOnce(() => pending.promise);
  ws.send(prefix + JSON.stringify({ id: 1, op: "init" }));
  for (let i = 0; i < 40 && f.rpc.mock.calls.length === 0; i++) await Bun.sleep(5);
  expect(f.rpc).toHaveBeenCalledTimes(1);
  f.accessTokens.revoke(f.minted.entry.id);
  pending.resolve({
    type: "pane_info",
    pane: { scroll: { offset_from_bottom: 0, max_offset_from_bottom: 270, viewport_rows: 30 } },
  } as never);
  await settle();
  expect(ws.readyState).toBe(WebSocket.CLOSED);
  expect(output.some((data) => data.startsWith(prefix))).toBe(false);
  expect(f.rpc).toHaveBeenCalledTimes(1);
});
