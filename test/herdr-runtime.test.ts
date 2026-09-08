import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isHerdrProtocolMismatch,
  parseHerdrRuntimeStatus,
  probeHerdrRuntime,
} from "../src/herdr-runtime";

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stub(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-herdr-runtime-"));
  sandboxes.push(dir);
  const path = join(dir, "herdr stub");
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

const modern = (server: Record<string, unknown>) => ({
  client: { version: "0.9.0", protocol: 22 },
  server,
  update: { restart_needed: false, server_binary_stale: false },
});

describe("parseHerdrRuntimeStatus", () => {
  test("reports a running matching and compatible server as ready", () => {
    expect(
      parseHerdrRuntimeStatus(
        modern({
          running: true,
          version: "0.9.0",
          compatible: true,
          endpoint_compatible: true,
        }),
      ),
    ).toEqual({ state: "ready", installedVersion: "0.9.0", serverVersion: "0.9.0" });
  });

  test("an explicitly running old server requires restart even when compatibility flags say yes", () => {
    expect(
      parseHerdrRuntimeStatus(
        modern({
          running: true,
          version: "0.8.2",
          compatible: true,
          endpoint_compatible: true,
        }),
      ),
    ).toEqual({
      state: "restart_required",
      installedVersion: "0.9.0",
      serverVersion: "0.8.2",
      reason: "version_mismatch",
    });
  });

  test("a protocol incompatibility requires restart", () => {
    expect(
      parseHerdrRuntimeStatus(
        modern({
          running: true,
          version: "0.9.0",
          compatible: false,
          endpoint_compatible: true,
        }),
      ),
    ).toEqual({
      state: "restart_required",
      installedVersion: "0.9.0",
      serverVersion: "0.9.0",
      reason: "protocol_mismatch",
    });
  });

  test("an explicit not-running status is offline", () => {
    expect(
      parseHerdrRuntimeStatus(
        modern({
          running: false,
          version: null,
          compatible: null,
          endpoint_compatible: null,
        }),
      ),
    ).toEqual({
      state: "offline",
      installedVersion: "0.9.0",
      serverVersion: null,
      reason: "unreachable",
    });
  });

  test("malformed or incomplete status is unknown rather than offline", () => {
    expect(parseHerdrRuntimeStatus({ client: { version: "0.9.0" }, server: {} })).toEqual({
      state: "unknown",
      installedVersion: "0.9.0",
      serverVersion: null,
      reason: "probe_failed",
    });
    expect(parseHerdrRuntimeStatus("not an object")).toEqual({
      state: "unknown",
      installedVersion: null,
      serverVersion: null,
      reason: "probe_failed",
    });
  });
});

describe("isHerdrProtocolMismatch", () => {
  test("recognizes a machine code and JSON envelopes embedded in process output", () => {
    expect(isHerdrProtocolMismatch({ code: "protocol_mismatch" })).toBe(true);
    expect(
      isHerdrProtocolMismatch({
        stderr:
          'request failed: {"id":"cli","error":{"code":"protocol_mismatch","message":"upgrade"}}\n',
      }),
    ).toBe(true);
  });

  test("does not broad-match prose or malformed JSON containing the words", () => {
    expect(isHerdrProtocolMismatch(new Error("protocol_mismatch while connecting"))).toBe(false);
    expect(isHerdrProtocolMismatch({ stderr: 'error code="protocol_mismatch"' })).toBe(false);
  });
});

describe("probeHerdrRuntime", () => {
  test("uses status plus a real agent-list function check and inherits the supplied environment", async () => {
    const bin = stub(`
if [ "$1 $2" = "status --json" ]; then
  printf '%s\\n' '{"client":{"version":"0.9.0"},"server":{"running":true,"version":"0.9.0","compatible":true,"endpoint_compatible":true}}'
  exit 0
fi
if [ "$1 $2" = "agent list" ] && [ "$HERDR_SESSION" = "custom herd" ]; then
  head -c 180000 /dev/zero | tr '\\000' x
  head -c 180000 /dev/zero | tr '\\000' y >&2
  exit 0
fi
exit 7`);

    await expect(
      probeHerdrRuntime({
        bin,
        env: { ...process.env, HERDR_SESSION: "custom herd" },
        timeoutMs: 2_000,
      }),
    ).resolves.toEqual({
      state: "ready",
      installedVersion: "0.9.0",
      serverVersion: "0.9.0",
    });
  });

  test("does not let a successful agent call override an explicit old running server", async () => {
    const bin = stub(`
if [ "$1 $2" = "status --json" ]; then
  printf '%s\\n' '{"client":{"version":"0.9.0"},"server":{"running":true,"version":"0.8.2","compatible":true,"endpoint_compatible":true}}'
  exit 0
fi
exit 0`);

    await expect(probeHerdrRuntime({ bin, timeoutMs: 500 })).resolves.toMatchObject({
      state: "restart_required",
      installedVersion: "0.9.0",
      serverVersion: "0.8.2",
      reason: "version_mismatch",
    });
  });

  test("falls back for a legacy binary without status", async () => {
    const bin = stub(`
if [ "$1" = "status" ]; then echo 'unknown command: status' >&2; exit 2; fi
if [ "$1" = "--version" ]; then echo 'herdr 0.8.2'; exit 0; fi
if [ "$1 $2" = "agent list" ]; then echo '[]'; exit 0; fi
exit 9`);

    await expect(probeHerdrRuntime({ bin, timeoutMs: 500 })).resolves.toEqual({
      state: "ready",
      installedVersion: "0.8.2",
      serverVersion: null,
    });
  });

  test("recognizes legacy protocol mismatch and explicit socket absence", async () => {
    const mismatch = stub(`
if [ "$1" = "status" ]; then exit 2; fi
if [ "$1" = "--version" ]; then echo 'herdr 0.9.0'; exit 0; fi
echo '{"error":{"code":"protocol_mismatch","message":"old daemon"}}' >&2
exit 1`);
    await expect(probeHerdrRuntime({ bin: mismatch, timeoutMs: 500 })).resolves.toEqual({
      state: "restart_required",
      installedVersion: "0.9.0",
      serverVersion: null,
      reason: "protocol_mismatch",
    });

    const offline = stub(`
if [ "$1" = "status" ]; then exit 2; fi
if [ "$1" = "--version" ]; then echo 'herdr 0.8.2'; exit 0; fi
echo 'failed to connect to herdr socket: Connection refused' >&2
exit 1`);
    await expect(probeHerdrRuntime({ bin: offline, timeoutMs: 500 })).resolves.toEqual({
      state: "offline",
      installedVersion: "0.8.2",
      serverVersion: null,
      reason: "unreachable",
    });
  });

  test("malformed successful output and timeouts stay unknown", async () => {
    const malformed = stub(`echo 'not-json'; exit 0`);
    await expect(probeHerdrRuntime({ bin: malformed, timeoutMs: 500 })).resolves.toEqual({
      state: "unknown",
      installedVersion: null,
      serverVersion: null,
      reason: "probe_failed",
    });

    const hung = stub(`sleep 5`);
    const started = Date.now();
    await expect(probeHerdrRuntime({ bin: hung, timeoutMs: 40 })).resolves.toMatchObject({
      state: "unknown",
      reason: "probe_failed",
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
