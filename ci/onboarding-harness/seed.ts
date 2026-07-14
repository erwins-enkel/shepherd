import type { IncusDriver } from "./incus";
import type { Scenario } from "./types";

const SHEPHERD_DIR = "/opt/shepherd";

// `default` FIRST so the instance keeps its root disk + NIC, then `shep-onb`
// layers the harness limits/nesting/tun on top. Passing only `shep-onb` would
// replace default and leave the instance with no root device.
const PROFILES = ["default", "shep-onb"];

/** Take sole ownership of Arch's pacman keyring, then refresh it from the mirror.
 *
 *  WHY refresh at all (#1422): the base image's `archlinux-keyring` drifts behind the
 *  mirror; once a mirror package is signed by a packager key newer than the image's
 *  keyring, `pacman -Sy <pkg>` fails "signature … is unknown trust / invalid or corrupted
 *  package (PGP signature)" and the checked baseline aborts. So we rebuild trust and pull
 *  a current `archlinux-keyring` BEFORE any pacman install. Populate-before-sync is
 *  required — `-Sy` first would fail verification before the keyring is refreshed.
 *
 *  WHY stop units first (#1738): `images:archlinux` runs its OWN keyring init at boot —
 *  `/etc/systemd/system/pacman-init.service` (`ExecStart=pacman-key --init` + `--populate`,
 *  ordered `After=time-sync.target`). We only wait for DNS (waitForDns), which resolves
 *  long before time-sync, so the pre-#1738 version of this function raced that unit: two gpg
 *  processes writing /etc/pacman.d/gnupg, and the loser died with "can't open pubring.gpg /
 *  no writable keyring found / could not be locally signed". Reproduced 3/3 by exec'ing as
 *  soon as DNS resolved; 0/3 when run after the unit had settled. Since runScenario launches
 *  a FRESH instance per scenario, BOTH Arch scenarios are exposed — which one loses on a
 *  given night is jitter, which is exactly why the nightly looked flaky.
 *
 *  Enumerating `systemctl list-units --all '*keyring*' '*pacman*'` + `list-timers` on a
 *  fresh instance, pacman-init is not the only writer of that homedir:
 *   - `archlinux-keyring-wkd-sync.timer` (loaded, active, OnCalendar=weekly, Persistent=true)
 *     refreshes keys in the SAME homedir. On a fresh instance it sits ~6 days out and does not
 *     fire at boot — but Persistent=true means an aged image cache can fire a catch-up run
 *     right inside our window, so we stop it (and its service) defensively.
 *   - the socket-activated `gpg-agent@ / dirmngr@ / keyboxd@ etc-pacman.d-gnupg` daemons are
 *     separate units that SURVIVE stopping pacman-init, so one can linger holding the homedir
 *     we are about to delete; `gpgconf --kill all` releases them first.
 *  Nothing else in that enumeration touches the homedir.
 *
 *  We then rebuild UNCONDITIONALLY (`rm -rf` + init + populate) rather than probe-and-heal:
 *  after a race the unit finishes its own populate, so the homedir converges to healthy and a
 *  `pacman-key --list-keys` probe would exit 0 and skip the heal; and pacman-init's
 *  `ConditionPathIsDirectory=!/etc/pacman.d/gnupg` makes `systemctl start` a no-op once the dir
 *  exists, so it cannot repair a broken-but-present homedir either. Destroying and rebuilding is
 *  safe here — these are throw-away instances whose keyring we fully own. (For the same reason
 *  this shape must NOT be ported to the in-app remediation that runs on real user machines.)
 *
 *  `set -e` is load-bearing: `driver.exec` runs this via `sh -c`, which returns only the LAST
 *  command's status, and `pacman -Sy --needed archlinux-keyring` exits 0 ("nothing to do") when
 *  the version already matches — so without it, a failed init/populate would be swallowed and the
 *  step would report success on an EMPTY keyring, resurfacing later as a misleading `curl`/`unzip`
 *  install error. It is placed after the guard so non-Arch images still exit 0.
 *
 *  `timeout 120` bounds the stop: it blocks on the unit's job, and incus.ts's RUNNER_TIMEOUT_MS
 *  is 20min — unbounded, a wedged stop would turn a fast, legible failure into a hung run.
 *
 *  Guarded on `command -v pacman` so it's a clean no-op on apt/apk/dnf images (the 8 non-Arch
 *  scenarios). Runs as root — `driver.exec` → `incus exec` is root by default, which
 *  `pacman-key` and `systemctl` require. */
function archKeyringRefresh(): string {
  return [
    "command -v pacman >/dev/null 2>&1 || exit 0",
    "set -e",
    "timeout 120 systemctl stop pacman-init.service archlinux-keyring-wkd-sync.timer " +
      "archlinux-keyring-wkd-sync.service >/dev/null 2>&1 || true",
    "systemctl reset-failed pacman-init.service >/dev/null 2>&1 || true",
    "gpgconf --homedir /etc/pacman.d/gnupg --kill all >/dev/null 2>&1 || true",
    "rm -rf /etc/pacman.d/gnupg",
    "pacman-key --init",
    "pacman-key --populate archlinux",
    "pacman -Sy --needed --noconfirm archlinux-keyring",
  ].join("\n");
}

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

/** Write a network-free `herdr` STUB onto PATH so Shepherd's boot preflight
 *  (`herdr --version`) passes without a live `herdr.dev` fetch. Since #1313 a
 *  missing herdr fail-fasts (exit 78) BEFORE the HTTP server binds, so the 6
 *  non-herdr scenarios — which don't test herdr — just need preflight satisfied.
 *
 *  The stub emits a single VALID JSON line for EVERY invocation. This is
 *  load-bearing, not decorative:
 *   - diagnostics' `herdrProbe` extracts a semver via `SEMVER_RE` from the output,
 *     so the JSON's `99.99.99` (≥ HERDR_MIN_VERSION) reads `ok`;
 *   - on-loop `HerdrDriver.list()/tabs()/panes()` do an UNGUARDED `JSON.parse` then
 *     `parsed?.result?.… ?? []`. A plain-text `herdr 99.99.99` would throw a
 *     SyntaxError every tick (a different throw than the pre-#1313 ENOENT), so valid
 *     JSON is required — it parses cleanly to `[]` and never throws.
 *  A final `test -x` makes it a CHECKED step (fail-closes the baseline). */
function herdrStub(): string {
  return (
    'mkdir -p "$HOME/.local/bin"\n' +
    "cat > \"$HOME/.local/bin/herdr\" <<'HERDR_STUB'\n" +
    "#!/bin/sh\n" +
    'echo \'{"version":"99.99.99"}\'\n' +
    "HERDR_STUB\n" +
    'chmod +x "$HOME/.local/bin/herdr"\n' +
    'test -x "$HOME/.local/bin/herdr"'
  );
}

/** Commands that turn a fresh instance into a bootable-Shepherd baseline: bun
 *  runtime + the pushed working-tree build + deps + the claude CLI (agent path) +
 *  a herdr stub that satisfies the boot preflight (#1313). Defects are layered
 *  AFTER this so degraded Shepherd can still boot. */
function baselineCommands(): string[] {
  return [
    // Arch keyring rot (#1422) fails the first pacman install, and the image's own boot-time
    // keyring init races ours (#1738) — take ownership of the keyring and refresh it before any
    // package op. No-op on non-Arch images. See archKeyringRefresh().
    archKeyringRefresh(),
    ensurePkg("curl"),
    // busybox/minimal images (alpine) ship no `bash`; the bun installer pipes
    // to `bash` explicitly, so it must be present before the curl step runs.
    ensurePkg("bash"),
    // bun's installer hard-requires `unzip`; minimal images (debian/12) lack it,
    // and without it the bun install silently no-ops and Shepherd never boots.
    ensurePkg("unzip"),
    // minimal RPM images (rockylinux/9) ship no `tar`; we extract the working-tree
    // tarball in the next step, so tar must be present before it runs.
    ensurePkg("tar"),
    ensureToolchain(),
    "curl -fsSL https://bun.sh/install | bash",
    // node-gyp shells out to a BARE `bun` while building node-pty; the installer
    // only adds bun to shell rc files (not the non-login exec PATH), so expose it
    // on a system path or the native build fails with "bun: not found".
    'ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun',
    // node-pty's install is `node scripts/prebuild.js || node-gyp rebuild`. When no
    // prebuilt binary matches the instance (arch/rockylinux fall through to a rebuild),
    // it needs `node-gyp` — which is only a node-pty *dev*dependency, so it isn't in
    // node_modules/.bin. Install it globally + expose on PATH so the rebuild works.
    '~/.bun/bin/bun add -g node-gyp && ln -sf "$HOME/.bun/bin/node-gyp" /usr/local/bin/node-gyp',
    `mkdir -p ${SHEPHERD_DIR} && tar -xf /root/shepherd.tar -C ${SHEPHERD_DIR}`,
    `cd ${SHEPHERD_DIR} && ~/.bun/bin/bun install`,
    // claude CLI for the agent apply path; harmless if a scenario removes it later.
    "curl -fsSL https://claude.ai/install.sh | bash || true",
    // herdr stub so the boot preflight (#1313) passes with zero network; the
    // herdr-missing scenario removes it in its seed to exercise the real fail-fast.
    herdrStub(),
  ];
}

/** Wait for the instance's network to actually resolve DNS before anything hits
 *  the package mirrors. `/bin/sh` exists instantly, so a launch alone only proves
 *  the rootfs unpacked — on Arch, systemd-resolved comes up slower than on debian/
 *  fedora and `pacman -Sy` failed with "Could not resolve host". Poll a real
 *  resolution instead (skip on images without glibc `getent`, e.g. musl). */
async function waitForDns(driver: IncusDriver, name: string): Promise<void> {
  await driver.exec(name, [
    "sh",
    "-c",
    "for i in $(seq 1 60); do command -v getent >/dev/null 2>&1 || break; " +
      "getent hosts bun.sh >/dev/null 2>&1 && break; sleep 1; done",
  ]);
}

/** Launch a fresh instance for `scenario`, install the bootable baseline, push
 *  the Shepherd build, then run the scenario's messy-state seed commands.
 *
 *  installE2E scenarios are the inverse: a BARE instance with NO baseline + NO
 *  defect seed. We launch, wait for DNS (the real install.sh needs network), and
 *  push the tarball + install.sh; run.ts then runs the installer itself. */
export async function seedInstance(
  driver: IncusDriver,
  scenario: Scenario,
  tarballPath: string,
  installScriptPath?: string,
): Promise<void> {
  await driver.launch(scenario.image, scenario.id, {
    vm: scenario.vm,
    profiles: PROFILES,
  });
  await waitForDns(driver, scenario.id);
  await driver.push(scenario.id, tarballPath, "/root/shepherd.tar");

  if (scenario.installE2E) {
    // Bare host: skip the baseline (bun/extract/install) AND the defect seed — the
    // real deploy/install.sh does all provisioning. Just stage the installer.
    if (!installScriptPath) {
      throw new Error(`installE2E scenario ${scenario.id} requires installScriptPath`);
    }
    await driver.push(scenario.id, installScriptPath, "/root/install.sh");
    return;
  }

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
