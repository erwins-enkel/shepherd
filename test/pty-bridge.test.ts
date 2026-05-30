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

test("pty-attach invokes herdr with --takeover so browser refresh bumps a stale client", async () => {
  const attach = new URL("../src/pty-attach.mjs", import.meta.url).pathname;
  const fakeHerdr = new URL("./fixtures/fake-herdr.mjs", import.meta.url).pathname;
  const proc = Bun.spawn(["node", attach, "term_test", "100", "30"], {
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, HERDR_BIN: fakeHerdr },
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const line = out.split("\n").find((l) => l.startsWith("HERDR-ARGV:"));
  expect(line).toBeDefined();
  const argv = JSON.parse(line!.slice("HERDR-ARGV:".length));
  expect(argv).toEqual(["agent", "attach", "term_test", "--takeover"]);
});
