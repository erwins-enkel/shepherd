import { test, expect } from "bun:test";
import { PtyBridge } from "../src/pty-bridge";

test("PtyBridge streams helper stdout to the socket", async () => {
  const got: string[] = [];
  let closed = false;
  const helper = new URL("./fixtures/echo-helper.mjs", import.meta.url).pathname;
  const bridge = new PtyBridge(
    "term_test",
    {
      send: (d) => got.push(typeof d === "string" ? d : new TextDecoder().decode(d)),
      close: () => {
        closed = true;
      },
    },
    helper,
  );
  bridge.open();
  await new Promise((r) => setTimeout(r, 300));
  expect(got.join("")).toContain("PTY-BRIDGE-OK");
  expect(closed).toBe(true); // onExit closed the socket
  bridge.close();
});

test("PtyBridge rejects an invalid terminalId", () => {
  const bridge = new PtyBridge("-rm-rf", { send: () => {}, close: () => {} });
  expect(() => bridge.open()).toThrow("invalid terminalId");
});
