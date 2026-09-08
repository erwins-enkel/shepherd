import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHerdrRecovery } from "../src/herdr-recovery";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(
  options: {
    startWorks?: boolean;
    stopWorks?: boolean;
    stopDelay?: number;
    stopIgnoresTerm?: boolean;
    agentListDelay?: number;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-herdr-recovery-"));
  dirs.push(dir);
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  const bin = join(binDir, "herdr custom");
  const state = join(dir, "state");
  const calls = join(dir, "calls");
  const stopped = join(dir, "stopped");
  const stopping = join(dir, "stopping");
  const started = join(dir, "started");
  const logPath = join(dir, "recovery log");
  writeFileSync(state, "old");
  writeFileSync(
    bin,
    `#!/bin/sh
state=$(cat '${state}')
printf '%s|%s|%s\\n' "$HERDR_SESSION" "$HERDR_SOCKET_PATH" "$*" >> '${calls}'
if [ "$1" = "--version" ]; then echo 'herdr 0.9.0'; exit 0; fi
if [ "$1 $2" = "status --json" ]; then
  if [ "$state" = "old" ]; then
    echo '{"client":{"version":"0.9.0"},"server":{"running":true,"version":"0.8.2","compatible":false,"endpoint_compatible":false}}'
  elif [ "$state" = "ready" ]; then
    echo '{"client":{"version":"0.9.0"},"server":{"running":true,"version":"0.9.0","compatible":true,"endpoint_compatible":true}}'
  else
    echo '{"client":{"version":"0.9.0"},"server":{"running":false,"version":null,"compatible":null,"endpoint_compatible":null}}'
  fi
  exit 0
fi
if [ "$1 $2" = "agent list" ]; then
  [ "$state" = "ready" ] && { ${options.agentListDelay ? `sleep ${options.agentListDelay};` : ""} echo '[]'; exit 0; }
  [ "$state" = "old" ] && { echo '{"error":{"code":"protocol_mismatch"}}' >&2; exit 1; }
  echo 'failed to connect to herdr socket: Connection refused' >&2; exit 1
fi
if [ "$1 $2" = "server stop" ]; then
  touch '${stopping}'
  ${options.stopIgnoresTerm ? "trap '' TERM" : ":"}
  ${options.stopDelay ? `sleep ${options.stopDelay}` : ":"}
  ${options.stopWorks === false ? "exit 23" : ":"}
  echo offline > '${state}'
  touch '${stopped}'
  exit 0
fi
if [ "$1" = "server" ]; then
  touch '${started}'
  ${options.startWorks === false ? ":" : `echo ready > '${state}'`}
  exit 0
fi
exit 19
`,
  );
  chmodSync(bin, 0o755);
  writeFileSync(join(binDir, "systemctl"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(binDir, "systemctl"), 0o755);
  const env = {
    ...process.env,
    PATH: `${binDir}:/usr/bin:/bin`,
    HERDR_SESSION: "herd with spaces",
    HERDR_SOCKET_PATH: join(dir, "socket path"),
    SHEPHERD_HERDR_RECOVERY_TIMEOUT_MS: "180",
    SHEPHERD_HERDR_RECOVERY_POLL_MS: "10",
  };
  return { dir, bin, state, calls, stopped, stopping, started, logPath, env, binDir };
}

test("restart recovery guards, stops the selected server, starts it detached, and verifies it", async () => {
  const f = fixture();
  await runHerdrRecovery({
    restart: true,
    logPath: f.logPath,
    signal: new AbortController().signal,
    bin: f.bin,
    env: f.env,
  });

  const calls = readFileSync(f.calls, "utf8").trim().split("\n");
  const stop = calls.findIndex((line) => line.endsWith("|server stop"));
  const start = calls.findIndex((line) => line.endsWith("|server"));
  expect(stop).toBeGreaterThanOrEqual(0);
  expect(start).toBeGreaterThan(stop);
  expect(
    calls.every((line) => line.startsWith(`herd with spaces|${f.env.HERDR_SOCKET_PATH}|`)),
  ).toBe(true);
  expect(readFileSync(f.state, "utf8").trim()).toBe("ready");
  expect(readFileSync(f.logPath, "utf8")).toContain("recovery verified");
});

test("restart=false starts only after an independent confirmed-offline guard", async () => {
  const f = fixture();
  writeFileSync(f.state, "offline");
  await runHerdrRecovery({
    restart: false,
    logPath: f.logPath,
    signal: new AbortController().signal,
    bin: f.bin,
    env: f.env,
  });
  const calls = readFileSync(f.calls, "utf8");
  expect(calls).not.toContain("server stop");
  expect(calls).toContain("|server\n");
});

test("a failed runtime guard performs no stop or start", async () => {
  const f = fixture();
  writeFileSync(f.bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${f.calls}'\necho malformed\nexit 0\n`);
  await expect(
    runHerdrRecovery({
      restart: true,
      logPath: f.logPath,
      signal: new AbortController().signal,
      bin: f.bin,
      env: f.env,
    }),
  ).rejects.toBeInstanceOf(Error);
  const calls = readFileSync(f.calls, "utf8");
  expect(calls).not.toContain("server stop");
  expect(calls).not.toMatch(/^server$/m);
  expect(readFileSync(f.logPath, "utf8")).toContain("runtime guard rejected");
});

test("a changed runtime snapshot is rejected immediately before mutation", async () => {
  const f = fixture();
  await expect(
    runHerdrRecovery({
      restart: true,
      logPath: f.logPath,
      signal: new AbortController().signal,
      bin: f.bin,
      env: f.env,
      expected: {
        state: "restart_required",
        installedVersion: "0.9.0",
        serverVersion: "0.8.1",
        reason: "version_mismatch",
      },
    }),
  ).rejects.toBeInstanceOf(Error);
  expect(readFileSync(f.calls, "utf8")).not.toContain("server stop");
  expect(readFileSync(f.logPath, "utf8")).toContain("runtime changed since confirmation");
});

test("a start that never becomes healthy is bounded and rejected", async () => {
  const f = fixture({ startWorks: false });
  writeFileSync(f.state, "offline");
  const started = Date.now();
  await expect(
    runHerdrRecovery({
      restart: false,
      logPath: f.logPath,
      signal: new AbortController().signal,
      bin: f.bin,
      env: f.env,
    }),
  ).rejects.toBeInstanceOf(Error);
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(readFileSync(f.logPath, "utf8")).toContain("failed runtime verification");
});

test("a failed addressed stop never proceeds to server start", async () => {
  const f = fixture({ stopWorks: false });
  await expect(
    runHerdrRecovery({
      restart: true,
      logPath: f.logPath,
      signal: new AbortController().signal,
      bin: f.bin,
      env: f.env,
    }),
  ).rejects.toThrow("selected herdr server stop failed");
  const calls = readFileSync(f.calls, "utf8");
  expect(calls).toContain("server stop");
  expect(calls).not.toMatch(/\|server$/m);
  expect(readFileSync(f.state, "utf8").trim()).toBe("old");
});

test("a matching user unit is restarted instead of launching an unsupervised server", async () => {
  const f = fixture();
  writeFileSync(f.state, "offline");
  const systemctlCalls = join(f.dir, "systemctl-calls");
  const unitEnv = join(f.dir, "unit.env");
  writeFileSync(
    unitEnv,
    `HERDR_SESSION="${f.env.HERDR_SESSION}"\nHERDR_SOCKET_PATH="${f.env.HERDR_SOCKET_PATH}"\n`,
  );
  writeFileSync(
    join(f.binDir, "systemctl"),
    `#!/bin/sh
echo "$*" >> '${systemctlCalls}'
if [ "$1 $2" = "--user show" ]; then
  echo 'LoadState=loaded'
  echo 'ExecStart={ path=${f.bin} ; argv[]=${f.bin} server ; }'
  echo 'Environment=PATH=/usr/bin:/bin'
  echo 'EnvironmentFiles=${unitEnv} (ignore_errors=yes)'
  exit 0
fi
if [ "$1 $2" = "--user show-environment" ]; then echo "HOME=$HOME"; exit 0; fi
case "$*" in
  *start*) echo ready > '${f.state}'; exit 0 ;;
  *reset-failed*) exit 0 ;;
esac
exit 1
`,
  );
  await runHerdrRecovery({
    restart: false,
    logPath: f.logPath,
    signal: new AbortController().signal,
    bin: f.bin,
    env: f.env,
  });
  expect(readFileSync(systemctlCalls, "utf8")).toContain("start herdr");
  expect(readFileSync(systemctlCalls, "utf8")).not.toContain("restart herdr");
  expect(readFileSync(f.calls, "utf8")).not.toMatch(/\|server$/m);
});

test("a matching unit that recovers during ownership discovery is not restarted", async () => {
  const f = fixture();
  writeFileSync(f.state, "offline");
  const unitEnv = join(f.dir, "unit-race.env");
  writeFileSync(
    unitEnv,
    `HERDR_SESSION="${f.env.HERDR_SESSION}"\nHERDR_SOCKET_PATH="${f.env.HERDR_SOCKET_PATH}"\n`,
  );
  const systemctlCalls = join(f.dir, "systemctl-race");
  writeFileSync(
    join(f.binDir, "systemctl"),
    `#!/bin/sh
echo "$*" >> '${systemctlCalls}'
if [ "$1 $2" = "--user show" ]; then
  echo 'LoadState=loaded'
  echo 'ExecStart={ path=${f.bin} ; argv[]=${f.bin} server ; }'
  echo 'EnvironmentFiles=${unitEnv} (ignore_errors=yes)'
  echo ready > '${f.state}'
  exit 0
fi
if [ "$1 $2" = "--user show-environment" ]; then echo "HOME=$HOME"; exit 0; fi
exit 91
`,
  );
  await runHerdrRecovery({
    restart: false,
    expected: {
      state: "offline",
      installedVersion: "0.9.0",
      serverVersion: null,
      reason: "unreachable",
    },
    logPath: f.logPath,
    signal: new AbortController().signal,
    bin: f.bin,
    env: f.env,
  });
  expect(readFileSync(systemctlCalls, "utf8")).not.toContain("start herdr");
  expect(readFileSync(f.calls, "utf8")).not.toMatch(/\|server$/m);
});

test("restart snapshot is rechecked after slow ownership discovery and before stop", async () => {
  const f = fixture();
  const unitEnv = join(f.dir, "unit-stop-race.env");
  writeFileSync(
    unitEnv,
    `HERDR_SESSION="${f.env.HERDR_SESSION}"\nHERDR_SOCKET_PATH="${f.env.HERDR_SOCKET_PATH}"\n`,
  );
  writeFileSync(
    join(f.binDir, "systemctl"),
    `#!/bin/sh
if [ "$1 $2" = "--user show" ]; then
  echo 'LoadState=loaded'
  echo 'ExecStart={ path=${f.bin} ; argv[]=${f.bin} server ; }'
  echo 'EnvironmentFiles=${unitEnv} (ignore_errors=yes)'
  echo ready > '${f.state}'
  exit 0
fi
if [ "$1 $2" = "--user show-environment" ]; then echo "HOME=$HOME"; exit 0; fi
exit 91
`,
  );
  await expect(
    runHerdrRecovery({
      restart: true,
      expected: {
        state: "restart_required",
        installedVersion: "0.9.0",
        serverVersion: "0.8.2",
        reason: "version_mismatch",
      },
      logPath: f.logPath,
      signal: new AbortController().signal,
      bin: f.bin,
      env: f.env,
    }),
  ).rejects.toBeInstanceOf(Error);
  expect(readFileSync(f.calls, "utf8")).not.toContain("server stop");
});

test("a related unit with a different binary fails closed before stopping the selected server", async () => {
  const f = fixture();
  writeFileSync(
    join(f.binDir, "systemctl"),
    `#!/bin/sh
if [ "$1 $2" = "--user show" ]; then
  echo 'LoadState=loaded'
  echo 'ExecStart={ path=${f.bin}-other ; argv[]=${f.bin}-other server ; }'
  printf 'Environment="HERDR_SESSION=%s" "HERDR_SOCKET_PATH=%s"\\n' "$HERDR_SESSION" "$HERDR_SOCKET_PATH"
  exit 0
fi
if [ "$1 $2" = "--user show-environment" ]; then echo "HOME=$HOME"; exit 0; fi
exit 1
`,
  );
  await expect(
    runHerdrRecovery({
      restart: true,
      logPath: f.logPath,
      signal: new AbortController().signal,
      bin: f.bin,
      env: f.env,
    }),
  ).rejects.toBeInstanceOf(Error);
  expect(readFileSync(f.calls, "utf8")).not.toContain("server stop");
  expect(readFileSync(f.logPath, "utf8")).toContain("different settings");
});

test("a unit configured for a non-default herd is never restarted for the default herd", async () => {
  const f = fixture();
  writeFileSync(f.state, "offline");
  const defaultHome = join(f.dir, "home");
  const defaultSocket = join(defaultHome, ".config", "herdr", "herdr.sock");
  const env = {
    ...f.env,
    HOME: defaultHome,
    HERDR_SESSION: "default",
    HERDR_SOCKET_PATH: defaultSocket,
  };
  const systemctlCalls = join(f.dir, "systemctl-other-herd");
  writeFileSync(
    join(f.binDir, "systemctl"),
    `#!/bin/sh
echo "$*" >> '${systemctlCalls}'
if [ "$1 $2" = "--user show" ]; then
  echo 'LoadState=loaded'
  echo 'ExecStart={ path=${f.bin} ; argv[]=${f.bin} server ; }'
  echo 'Environment=HERDR_SESSION=other HERDR_SOCKET_PATH=${f.dir}/other.sock'
  exit 0
fi
if [ "$1 $2" = "--user show-environment" ]; then echo "HOME=$HOME"; exit 0; fi
exit 91
`,
  );
  await runHerdrRecovery({
    restart: false,
    logPath: f.logPath,
    signal: new AbortController().signal,
    bin: f.bin,
    env,
  });
  expect(readFileSync(systemctlCalls, "utf8")).not.toContain("restart herdr");
  expect(readFileSync(f.calls, "utf8")).toContain("|server\n");
});

test("a unit inheriting a non-default herd from the user manager is not used for default", async () => {
  const f = fixture();
  writeFileSync(f.state, "offline");
  const defaultHome = join(f.dir, "home");
  const env = {
    ...f.env,
    HOME: defaultHome,
    HERDR_SESSION: "default",
    HERDR_SOCKET_PATH: join(defaultHome, ".config", "herdr", "herdr.sock"),
  };
  const systemctlCalls = join(f.dir, "systemctl-manager-herd");
  writeFileSync(
    join(f.binDir, "systemctl"),
    `#!/bin/sh
echo "$*" >> '${systemctlCalls}'
if [ "$1 $2" = "--user show" ]; then
  echo 'LoadState=loaded'
  echo 'ExecStart={ path=${f.bin} ; argv[]=${f.bin} server ; }'
  echo 'Environment=PATH=/usr/bin:/bin'
  echo 'EnvironmentFiles='
  exit 0
fi
if [ "$1 $2" = "--user show-environment" ]; then
  echo "HOME=$HOME"
  echo 'HERDR_SESSION=other'
  exit 0
fi
exit 91
`,
  );
  await runHerdrRecovery({
    restart: false,
    logPath: f.logPath,
    signal: new AbortController().signal,
    bin: f.bin,
    env,
  });
  expect(readFileSync(systemctlCalls, "utf8")).not.toContain("restart herdr");
  expect(readFileSync(f.calls, "utf8")).toContain("|server\n");
});

test("an unreadable nonmissing unit environment file makes ownership fail closed", async () => {
  const f = fixture();
  writeFileSync(f.state, "offline");
  const invalidEnvFile = join(f.dir, "not-an-env-file");
  mkdirSync(invalidEnvFile);
  writeFileSync(
    join(f.binDir, "systemctl"),
    `#!/bin/sh
if [ "$1 $2" = "--user show" ]; then
  echo 'LoadState=loaded'
  echo 'ExecStart={ path=${f.bin} ; argv[]=${f.bin} server ; }'
  echo 'EnvironmentFiles=${invalidEnvFile} (ignore_errors=no)'
  exit 0
fi
if [ "$1 $2" = "--user show-environment" ]; then echo "HOME=$HOME"; exit 0; fi
exit 91
`,
  );
  await expect(
    runHerdrRecovery({
      restart: false,
      logPath: f.logPath,
      signal: new AbortController().signal,
      bin: f.bin,
      env: f.env,
    }),
  ).rejects.toBeInstanceOf(Error);
  expect(readFileSync(f.calls, "utf8")).not.toMatch(/\|server$/m);
});

test("aborting before start terminates the worker group and prevents a later competing start", async () => {
  const f = fixture({ stopDelay: 0.05 });
  const controller = new AbortController();
  const recovery = runHerdrRecovery({
    restart: true,
    logPath: f.logPath,
    signal: controller.signal,
    bin: f.bin,
    env: f.env,
  });
  const deadline = Date.now() + 2_000;
  while (!existsSync(f.stopped) && Date.now() < deadline) await Bun.sleep(10);
  controller.abort();
  await expect(recovery).rejects.toBeInstanceOf(Error);
  await Bun.sleep(300);
  expect(readFileSync(f.state, "utf8").trim()).toBe("offline");
  expect(readFileSync(f.calls, "utf8")).not.toMatch(/\|server$/m);
});

test("abort kills a signal-ignoring stop descendant before releasing the caller", async () => {
  const f = fixture({ stopDelay: 0.4, stopIgnoresTerm: true });
  const controller = new AbortController();
  const recovery = runHerdrRecovery({
    restart: true,
    logPath: f.logPath,
    signal: controller.signal,
    bin: f.bin,
    env: f.env,
  });
  const deadline = Date.now() + 2_000;
  while (!existsSync(f.stopping) && Date.now() < deadline) await Bun.sleep(10);
  expect(existsSync(f.stopping)).toBe(true);
  controller.abort();
  await expect(recovery).rejects.toBeInstanceOf(Error);
  await Bun.sleep(500);
  expect(readFileSync(f.state, "utf8").trim()).toBe("old");
  expect(existsSync(f.stopped)).toBe(false);
  expect(readFileSync(f.calls, "utf8")).not.toMatch(/\|server$/m);
});

test("aborting after detached launch leaves the recovered daemon alive", async () => {
  const f = fixture({ agentListDelay: 0.2 });
  writeFileSync(f.state, "offline");
  const controller = new AbortController();
  const recovery = runHerdrRecovery({
    restart: false,
    logPath: f.logPath,
    signal: controller.signal,
    bin: f.bin,
    env: f.env,
  });
  const deadline = Date.now() + 2_000;
  while (!existsSync(f.started) && Date.now() < deadline) await Bun.sleep(10);
  expect(existsSync(f.started)).toBe(true);
  controller.abort();
  await expect(recovery).rejects.toBeInstanceOf(Error);
  expect(readFileSync(f.state, "utf8").trim()).toBe("ready");
});

test("the detached worker completes start after its initiating process dies", async () => {
  const f = fixture({ stopDelay: 0.05 });
  const driver = join(f.dir, "driver.ts");
  writeFileSync(
    driver,
    `import { runHerdrRecovery } from ${JSON.stringify(join(process.cwd(), "src/herdr-recovery.ts"))};
await runHerdrRecovery({ restart: true, logPath: ${JSON.stringify(f.logPath)}, signal: new AbortController().signal, bin: ${JSON.stringify(f.bin)}, env: process.env });
`,
  );
  const parent = spawn(process.execPath, [driver], { env: f.env, stdio: "ignore" });
  const deadline = Date.now() + 2_000;
  while (!existsSync(f.stopped) && Date.now() < deadline) await Bun.sleep(10);
  expect(existsSync(f.stopped)).toBe(true);
  parent.kill("SIGKILL");

  while (readFileSync(f.state, "utf8").trim() !== "ready" && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  expect(readFileSync(f.state, "utf8").trim()).toBe("ready");
});
