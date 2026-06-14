import type { IncusDriver } from "./incus";
import type { Scenario } from "./types";

const SHEPHERD_DIR = "/opt/shepherd";

// `default` FIRST so the instance keeps its root disk + NIC, then `shep-onb`
// layers the harness limits/nesting/tun on top. Passing only `shep-onb` would
// replace default and leave the instance with no root device.
const PROFILES = ["default", "shep-onb"];

/** Cross-distro "ensure package `$1` is installed" one-liner (apt/apk/dnf/pacman). */
function ensurePkg(pkg: string): string {
  return (
    `command -v ${pkg} >/dev/null 2>&1 || ` +
    `(apt-get update && apt-get install -y ${pkg}) || apk add --no-cache ${pkg} || ` +
    `dnf install -y ${pkg} || pacman -Sy --noconfirm ${pkg}`
  );
}

/** Cross-distro C/C++ toolchain + python3. `node-pty` (Shepherd's PTY dep) ships
 *  no prebuilt binary for every runtime, so `bun install` compiles it from source
 *  via node-gyp; without a compiler the install fails and Shepherd never boots. */
function ensureToolchain(): string {
  return (
    "command -v cc >/dev/null 2>&1 && command -v make >/dev/null 2>&1 || " +
    "(apt-get update && apt-get install -y build-essential python3) || " +
    "apk add --no-cache build-base python3 || " +
    "dnf install -y gcc-c++ make python3 || " +
    "pacman -Sy --noconfirm base-devel python3"
  );
}

/** Commands that turn a fresh instance into a bootable-Shepherd baseline: bun
 *  runtime + the pushed working-tree build + deps + the claude CLI (agent path).
 *  Defects are layered AFTER this so degraded Shepherd can still boot. */
function baselineCommands(): string[] {
  return [
    ensurePkg("curl"),
    // bun's installer hard-requires `unzip`; minimal images (debian/12) lack it,
    // and without it the bun install silently no-ops and Shepherd never boots.
    ensurePkg("unzip"),
    ensureToolchain(),
    "curl -fsSL https://bun.sh/install | bash",
    // node-gyp shells out to a BARE `bun` while building node-pty; the installer
    // only adds bun to shell rc files (not the non-login exec PATH), so expose it
    // on a system path or the native build fails with "bun: not found".
    'ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun',
    // node-pty's install is `node scripts/prebuild.js || node-gyp rebuild`. When no
    // prebuilt binary matches the instance (arch/fedora fall through to a rebuild),
    // it needs `node-gyp` — which is only a node-pty *dev*dependency, so it isn't in
    // node_modules/.bin. Install it globally + expose on PATH so the rebuild works.
    '~/.bun/bin/bun add -g node-gyp && ln -sf "$HOME/.bun/bin/node-gyp" /usr/local/bin/node-gyp',
    `mkdir -p ${SHEPHERD_DIR} && tar -xf /root/shepherd.tar -C ${SHEPHERD_DIR}`,
    `cd ${SHEPHERD_DIR} && ~/.bun/bin/bun install`,
    // claude CLI for the agent apply path; harmless if a scenario removes it later.
    "curl -fsSL https://claude.ai/install.sh | bash || true",
  ];
}

/** Launch a fresh instance for `scenario`, install the bootable baseline, push
 *  the Shepherd build, then run the scenario's messy-state seed commands. */
export async function seedInstance(
  driver: IncusDriver,
  scenario: Scenario,
  tarballPath: string,
): Promise<void> {
  await driver.launch(scenario.image, scenario.id, {
    vm: scenario.vm,
    profiles: PROFILES,
  });
  // Wait for the instance's network to actually resolve DNS before the baseline
  // hits the package mirrors. `/bin/sh` exists instantly, so the old test only
  // proved the rootfs unpacked — on Arch, systemd-resolved comes up slower than
  // on debian/fedora and `pacman -Sy` failed with "Could not resolve host". Poll
  // a real resolution instead (skip on images without glibc `getent`, e.g. musl).
  await driver.exec(scenario.id, [
    "sh",
    "-c",
    "for i in $(seq 1 60); do command -v getent >/dev/null 2>&1 || break; " +
      "getent hosts bun.sh >/dev/null 2>&1 && break; sleep 1; done",
  ]);
  await driver.push(scenario.id, tarballPath, "/root/shepherd.tar");
  // Baseline steps are infrastructure: a failure here (e.g. bun didn't install)
  // leaves a non-bootable instance, so surface it now instead of limping on to a
  // misleading "Shepherd did not come up" 60s later.
  for (const cmd of baselineCommands()) {
    const r = await driver.exec(scenario.id, ["sh", "-c", cmd]);
    if (r.code !== 0) {
      throw new Error(`baseline step failed (${scenario.id}): ${cmd}\n${r.stderr || r.stdout}`);
    }
  }
  // Scenario seed commands intentionally tolerate non-zero (e.g. removing a pkg
  // that isn't present), so they are NOT checked.
  for (const cmd of scenario.seed) {
    await driver.exec(scenario.id, ["sh", "-c", cmd]);
  }
}
