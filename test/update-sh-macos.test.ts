import { test, expect } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

// deploy/update.sh runs under `set -e`. On macOS / core-only there is no systemd
// user manager, so a bare `systemctl --user restart` aborts the whole deploy after
// the build already succeeded (the original macOS crash). These assert the restart
// stays gated behind a systemctl-presence probe so it can never regress to that.
const src = readFileSync(new URL("../deploy/update.sh", import.meta.url), "utf8");

test("update.sh never invokes `systemctl --user restart` unguarded at column 0", () => {
  const unguarded = src.split("\n").filter((l) => /^systemctl --user restart/.test(l)); // column 0 = outside any if-block
  expect(unguarded).toEqual([]);
});

test("update.sh gates the restart on a systemctl-presence probe with a manual-start fallback", () => {
  expect(src).toContain("command -v systemctl");
  expect(src).toMatch(/no systemd user manager[\s\S]*not restarting/);
  expect(src).toContain("bun run start");
});

// provision.ts installs shepherd.service only on a fresh box, so an existing host would never
// pick up later unit changes — most consequentially the `After=herdr.service` boot-ordering that
// keeps the diagnostics probe from racing herdr's startup. update.sh must self-heal it, mirroring
// its herdr.service / timer syncs. Presence assertions (the existing text-grep pattern):
test("update.sh self-heals shepherd.service into the user unit dir with WorkingDirectory templated", () => {
  // writes the rendered unit to the user unit dir
  expect(src).toMatch(/"\$UNIT_DIR\/shepherd\.service"/);
  // templates WorkingDirectory to the checkout via the same rewrite templateUnit uses
  expect(src).toMatch(/s\|\^WorkingDirectory=\.\*\|WorkingDirectory=\$\{REPO\}\|/);
  // reloads so the restart below picks up the new unit
  expect(src).toContain("systemctl --user daemon-reload");
});

// Behavioral, not just grep: run the SAME WorkingDirectory rewrite update.sh uses against the
// real deploy/shepherd.service and assert the rendered unit is well-formed — a malformed sed that
// dropped the ordering or mangled WorkingDirectory would pass a text-grep but fail here.
// Coverage limit: this replicates the sed expression rather than extracting it from update.sh; the
// grep assertion above (that the script uses this exact ^WorkingDirectory= rewrite) is the bridge.
test("the shepherd.service WorkingDirectory rewrite renders a well-formed, correctly-ordered unit", () => {
  const unitPath = new URL("../deploy/shepherd.service", import.meta.url).pathname;
  const repo = "/tmp/some/checkout";
  const rendered = spawnSync(
    "sed",
    [`s|^WorkingDirectory=.*|WorkingDirectory=${repo}|`, unitPath],
    {
      encoding: "utf8",
    },
  );
  expect(rendered.status).toBe(0);
  const out = rendered.stdout;
  // WorkingDirectory rewritten to the given checkout, exactly once
  expect(out.match(/^WorkingDirectory=.*$/gm)).toEqual([`WorkingDirectory=${repo}`]);
  // boot ordering + Wants intact — this is the whole point of syncing the unit
  expect(out).toMatch(/^After=network-online\.target herdr\.service$/m);
  expect(out).toMatch(/^Wants=herdr\.service$/m);
});

// herdr.service's ExecStartPre (the session.json prune, #2031) runs a script from the checkout;
// update.sh must retarget it like templateHerdrUnit does. Same coverage limit as above: the grep
// bridges to the replicated sed expression.
test("update.sh retargets herdr.service's ExecStartPre to the checkout, leaving ExecStart alone", () => {
  expect(src).toContain(`-e "/^ExecStartPre=/s|%h/\\.shepherd/app/|\${REPO}/|"`);
  const unitPath = new URL("../deploy/herdr.service", import.meta.url).pathname;
  const rendered = spawnSync(
    "sed",
    [
      "-e",
      "s|^ExecStart=.*|ExecStart=/usr/local/bin/herdr server|",
      "-e",
      "/^ExecStartPre=/s|%h/\\.shepherd/app/|/tmp/some/checkout/|",
      unitPath,
    ],
    { encoding: "utf8" },
  );
  expect(rendered.status).toBe(0);
  expect(rendered.stdout.match(/^ExecStartPre=.*$/gm)).toEqual([
    "ExecStartPre=-%h/.bun/bin/bun /tmp/some/checkout/deploy/herdr-prune-session.ts",
  ]);
  expect(rendered.stdout.match(/^ExecStart=.*$/gm)).toEqual([
    "ExecStart=/usr/local/bin/herdr server",
  ]);
});

// Exercise the actual --pull script in a local git clone. Every child uses a
// temporary HOME; dependency/build calls are recorded instead of contacting a
// registry. The native supervisor verifies health only after it restarts.
test("app-managed update pulls, installs and builds without units or premature health checks", () => {
  const home = mkdtempSync(join(tmpdir(), "shepherd-mac-update-"));
  try {
    const origin = join(home, "origin");
    const checkout = join(home, "checkout");
    const bin = join(home, "bin");
    for (const directory of [join(origin, "deploy"), join(origin, "ui"), bin]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(join(origin, "deploy/update.sh"), src);
    copyFileSync(
      new URL("../deploy/install-cli.sh", import.meta.url),
      join(origin, "deploy/install-cli.sh"),
    );
    writeFileSync(join(origin, "ui/package.json"), "{}\n");
    const log = join(home, "calls");
    function stub(name: string, body: string): void {
      const path = join(bin, name);
      writeFileSync(
        path,
        `#!/bin/bash\nprintf '%s|%s\n' "$PWD" "${name} $*" >> "$UPDATE_TEST_LOG"\n${body}\n`,
      );
      chmodSync(path, 0o755);
    }
    stub("bun", "exit 0");
    stub("systemctl", '[ "$UPDATE_TEST_MANAGER" = "available" ] && exit 0; exit 1');
    stub("curl", "exit 99"); // No pre-restart probe may reach even a temporary listener.
    const env = {
      ...process.env,
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      SHEPHERD_NO_CLI: "1",
      UPDATE_TEST_LOG: log,
    };
    function git(cwd: string, ...args: string[]): string {
      return execFileSync(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          ...args,
        ],
        { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
    }
    git(origin, "init", "-b", "main");
    git(origin, "add", ".");
    git(origin, "commit", "-m", "initial");
    git(home, "clone", origin, checkout);
    writeFileSync(join(origin, "new-fix"), "new backend fix\n");
    git(origin, "add", ".");
    git(origin, "commit", "-m", "backend fix");
    for (const manager of ["available", "unavailable"]) {
      writeFileSync(log, "");
      const run = spawnSync("/bin/bash", [join(checkout, "deploy/update.sh"), "--pull"], {
        env: {
          ...env,
          UPDATE_TEST_MANAGER: manager,
          SHEPHERD_NO_SERVICE: manager === "available" ? "1" : "0",
        },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(run.status).toBe(0);
      expect(git(checkout, "rev-parse", "HEAD")).toBe(git(origin, "rev-parse", "HEAD"));
      const calls = readFileSync(log, "utf8");
      expect(calls).toContain(`${checkout}|bun install`);
      expect(calls).toContain(`${checkout}/ui|bun install`);
      expect(calls).toContain(`${checkout}/ui|bun run build`);
      expect(calls).not.toContain("systemctl --user restart");
      expect(calls).not.toContain("curl ");
      if (manager === "available") expect(calls).not.toContain("systemctl ");
    }
    writeFileSync(join(checkout, "ui/package.json"), '{"dirty":true}\n');
    writeFileSync(log, "");
    const dirty = spawnSync("/bin/bash", [join(checkout, "deploy/update.sh"), "--pull"], {
      env: { ...env, SHEPHERD_NO_SERVICE: "1" },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(dirty.status).not.toBe(0);
    expect(readFileSync(join(checkout, "ui/package.json"), "utf8")).toContain("dirty");
    expect(readFileSync(log, "utf8")).toBe("");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
