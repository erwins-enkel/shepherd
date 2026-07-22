import { config } from "./config";
import { HERDR_LAST_SUPPORTED_VERSION } from "./herdr-capabilities";
import { herdrPinnedInstallCommand } from "./herdr-install";
import { buildUpdateScript } from "./herdr-update";
import type { DiagnosticsSnapshot } from "./types";

/** hintKey → verbatim shell remediation, keyed by the advice identifier Shepherd
 *  emits. Shipped product code so three consumers share one source of truth: the
 *  onboarding harness, the in-app Fix endpoint, and a future cold-start installer.
 *  The map is keyed by the shipped `hintKey` contract; only deterministically-
 *  fixable deficiencies get entries. Interactive/secret fixes (`gh auth login`,
 *  tailscale login/serve) are intentionally absent — they can't run unattended and
 *  stay on the agent/coaching path. */
// fnm installs node into its own versions dir (NOT on PATH) and exposes it only
// via a shell `eval` an `incus exec sh -c` never runs — so a bare `fnm install`
// leaves the running server still seeing the old node. Reference fnm by absolute
// path and symlink the installed node into ~/.local/bin, which the booted server
// has FIRST on PATH (see probe.ts), so the next probe resolves the new node.
const NODE_INSTALL =
  "curl -fsSL https://fnm.vercel.app/install | bash && " +
  'FNM="$HOME/.local/share/fnm/fnm" && "$FNM" install --lts && ' +
  'mkdir -p "$HOME/.local/bin" && ' +
  'ln -sf "$("$FNM" exec --using=lts-latest node -e \'console.log(process.execPath)\')" ' +
  '"$HOME/.local/bin/node"';
// PINNED to HERDR_LAST_SUPPORTED_VERSION (#1896), not `curl -fsSL https://herdr.dev/install.sh |
// bash`. The upstream installer is latest-only, and Shepherd's driver refuses to spawn on a herdr
// above the ceiling — so installing "latest" strands every fresh host the day herdr ships past it.
// One constant drives every install path: raise the ceiling and this follows.
//
// The IN-APP budget is the default because this constant's primary consumer is the diagnostics Fix
// endpoint, whose child is SIGKILLed at REMEDIATION_TIMEOUT_MS. deploy/provision.ts passes the
// upstream-comparable budget instead — it has no deadline, and it is the path where a failed
// install actually strands someone.
export const HERDR_INSTALL = herdrPinnedInstallCommand(HERDR_LAST_SUPPORTED_VERSION, {
  downloadBudget: "in-app",
});

/** Bring the herdr daemon up and PROVE it answers. herdr 0.7.3 does NOT auto-spawn its
 *  server on a CLI call (verified in a clean instance, #1574) — a host that never ran
 *  `herdr server` has a dead socket, which is exactly the `offline` state #1562 made red.
 *
 *  Shape, in order, and every clause is load-bearing:
 *   - `export PATH` — herdr installs to ~/.local/bin, absent from a non-login shell's PATH.
 *   - `H="${HERDR_BIN:-herdr}"` — the check this must CLEAR spawns `config.herdrBin`
 *     (`HERDR_BIN ?? "herdr"`, src/config.ts). A bare `herdr` here would start a DIFFERENT
 *     binary than the one diagnostics probes whenever HERDR_BIN is set, so the poll would
 *     time out and the in-app Fix would reject. Resolved by the shell at run time, so the
 *     static string still carries no env dependency of its own.
 *   - `agent list || { start }` — IDEMPOTENT: a live daemon short-circuits, so this never
 *     races a second server against a bound socket (a second `herdr server` against a bound
 *     socket exits 1 with "herdr server is already running" — verified, #1574).
 *   - `systemctl --user reset-failed herdr` THEN `restart herdr` WHEN THE UNIT EXISTS — on a
 *     provisioned host, `herdr: offline` means `herdr.service` itself cannot bind. Spawning a
 *     detached daemon there would put an unsupervised process on the socket, so the unit's
 *     ExecStart exits 1 forever (`StartLimitIntervalSec=0` means it never even parks in `failed`)
 *     while the check reads `ok` because the orphan answers — exactly the green-check/thrashing-unit
 *     state this whole change exists to eliminate. Drive the unit; never race it. The leading
 *     `reset-failed` mirrors provision's `HERDR_ADOPT_SOCKET`: on a host provisioned by the current
 *     `deploy/` the unit carries `StartLimitIntervalSec=0` and so NEVER parks in `failed` from the
 *     start-limiter, making `reset-failed` a strict no-op there — its only value is a LEGACY or
 *     hand-edited unit lacking that setting, which a crash-loop against a held socket can park in
 *     `failed` with the limiter tripped, whereupon a bare `restart` is refused ("start request
 *     repeated too quickly") until the failed state is cleared. `;`-sequenced, not `&&`: a non-zero
 *     `reset-failed` (nothing to clear) must NOT block the restart.
 *   - `setsid … || nohup …` — the FALLBACK, for hosts with no unit (macOS, `buildOnly`'s
 *     SHEPHERD_NO_SERVICE path, hand-rolled installs). Detach so the daemon outlives the shell
 *     (an `incus exec` session, or the in-app Fix endpoint's child). macOS has NO `setsid`, so
 *     the nohup branch is required, not decorative.
 *   - the poll — resolve only once the daemon actually ANSWERS. Without it the command
 *     exits 0 the instant the fork returns, and a caller (provision, the harness) would
 *     treat a still-binding — or crashed — server as success. Bounded at ~10s.
 *
 *  The detached fallback is NOT durable across a `systemctl restart shepherd` when spawned from
 *  Shepherd's cgroup; that is precisely why the unit branch is preferred where one exists. */
export const HERDR_SERVE =
  'export PATH="$HOME/.local/bin:$PATH"; H="${HERDR_BIN:-herdr}"; ' +
  '"$H" agent list >/dev/null 2>&1 || ' +
  "{ if command -v systemctl >/dev/null 2>&1 && " +
  "systemctl --user cat herdr >/dev/null 2>&1; then " +
  "systemctl --user reset-failed herdr >/dev/null 2>&1; " +
  "systemctl --user restart herdr >/dev/null 2>&1; " +
  "elif command -v setsid >/dev/null 2>&1; then " +
  'setsid "$H" server </dev/null >/dev/null 2>&1 & ' +
  'else nohup "$H" server </dev/null >/dev/null 2>&1 & fi; }; ' +
  "for _ in 1 2 3 4 5 6 7 8 9 10; do " +
  '"$H" agent list >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1';

const CODEX_INSTALL =
  "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh";

// git has no user-space installer — it's a distro system package. One cross-distro
// chain (the same apt||apk||dnf||pacman shape the onboarding baseline's ensurePkg
// uses) covers ubuntu/debian/alpine/arch/fedora. NO `sudo`: the harness runs as root
// (and busybox alpine has no sudo); the in-app surface never auto-runs it (git is
// GUIDANCE_ONLY below), so this string is only ever executed with privilege.
// The pacman branch refreshes Arch's drifted archlinux-keyring first (#1422) — a fresh
// Arch host otherwise fails "unknown trust / invalid or corrupted package (PGP
// signature)". The refresh is reached only after apt/apk/dnf all miss (= an Arch host),
// and this whole string runs once per apply (not looped), so it's inherently lazy and
// needs no run-once memo — the keyring is refreshed at most once here; guarded on
// `command -v pacman` so it can't run on a non-Arch box.
const GIT_INSTALL =
  "command -v git >/dev/null 2>&1 || " +
  "(apt-get update && apt-get install -y git) || apk add --no-cache git || " +
  "dnf install -y git || " +
  "((command -v pacman >/dev/null 2>&1 && " +
  "pacman-key --init && pacman-key --populate archlinux && " +
  "pacman -Sy --needed --noconfirm archlinux-keyring); pacman -Sy --noconfirm git)";

export const REMEDIATIONS: Record<string, string> = {
  diagnostics_hint_bun_missing: "curl -fsSL https://bun.sh/install | bash",
  diagnostics_hint_node_missing: NODE_INSTALL,
  diagnostics_hint_node_outdated: NODE_INSTALL,
  // Install AND start: a bare binary leaves the daemon dead, which #1562 correctly reports
  // as `offline`/error. The harness's preflight scenario applies this hint ONCE with no
  // second round (run.ts:216), so installing without starting can never reach green.
  // The SUBSHELL is load-bearing: HERDR_SERVE's OWN first statement is
  // `export PATH=…;`, and that `;` terminates the `&&` chain — so a bare
  // `${HERDR_INSTALL} && ${HERDR_SERVE}` would gate only the export, and the liveness
  // check, spawn and poll would all run even when the install failed. `( … )` makes the
  // whole block one compound command whose status is what `&&` gates on.
  diagnostics_hint_herdr_missing: `${HERDR_INSTALL} && (${HERDR_SERVE})`,
  // Update AND hand off the running daemon (#1578). Reinstalling the binary alone (the
  // pre-#1578 behavior) cleared the outdated WARNING — the probe reads `herdr --version`,
  // the on-disk binary — but left the RUNNING daemon serving the old version: a degraded
  // split state. `herdr update --handoff` (reused verbatim from buildUpdateScript) updates
  // the binary AND hands the live targets to the new server ATOMICALLY, so a successful
  // update can't leave an old daemon behind; its 3× reachability retry + detached
  // `setsid server` relaunch keep a failed handoff from stranding the host offline.
  // Verification is the diagnostics RE-PROBE (DiagnosticsService.fix → check): a no-op
  // update leaves the binary old (still `warning`); a handoff that killed the server reads
  // `offline` (error). The running-server version is exposed only over the herdr socket
  // (`ping`), not a CLI verb, so the shell string cannot probe it directly — update
  // atomicity + the re-probe are the guarantee. Stays auto-fixable (not GUIDANCE_ONLY).
  // Executes in-app on the shepherd host only (the harness herdr-outdated scenario is
  // detection-only), so buildUpdateScript's baked `config.herdrBin` is always the right one.
  diagnostics_hint_herdr_outdated: buildUpdateScript(config.herdrUpdateLogPath),
  diagnostics_hint_herdr_offline: HERDR_SERVE,
  diagnostics_hint_claude_missing: "curl -fsSL https://claude.ai/install.sh | bash",
  diagnostics_hint_claude_optional: "curl -fsSL https://claude.ai/install.sh | bash",
  diagnostics_hint_codex_missing: CODEX_INSTALL,
  diagnostics_hint_codex_optional: CODEX_INSTALL,
  diagnostics_hint_tailscale_missing: "curl -fsSL https://tailscale.com/install.sh | sh",
  diagnostics_hint_git_missing: GIT_INSTALL,
};

/** Hints that have a verbatim REMEDIATIONS command but that the in-app Fix surface
 *  must NOT auto-run — it presents them as guidance, not a one-click fix. Two reasons
 *  qualify a hint:
 *   - running the command never clears the check unattended — tailscale: installing
 *     the binary leaves `resolveNodeHost` null until an interactive tailnet login;
 *   - the fix is a privileged system-package install — git: an apt/apk/dnf/pacman
 *     install that needs root/sudo we can't assume for the Shepherd service user,
 *     even though it DOES clear the check when run with privilege.
 *  This is the in-app analogue of the harness `detectionOnly` split in scenarios.ts.
 *  `remediationsFor` stays guidance-agnostic, so the harness (running as root) still
 *  applies these and reaches green. */
export const GUIDANCE_ONLY: ReadonlySet<string> = new Set([
  "diagnostics_hint_tailscale_missing",
  "diagnostics_hint_git_missing",
]);

/** One verbatim remediation resolved for a non-ok check. `optional` mirrors the
 *  check's `optional` state (an equivalent alternative is already healthy — e.g.
 *  `codex` when `claude` is present). The harness apply loop treats a failing
 *  optional remediation as NON-fatal (a broken third-party/optional installer must
 *  not red the release gate for an unrelated defect — #1577). */
export interface Remediation {
  id: string;
  cmd: string;
  optional: boolean;
}

/** Verbatim remediation entries for every non-ok check whose emitted hintKey has a
 *  known fix, each tagged with whether its check is in the (non-fatal) `optional` state. */
export function remediationEntriesFor(snapshot: DiagnosticsSnapshot): Remediation[] {
  return snapshot.checks
    .filter((c) => c.state !== "ok" && REMEDIATIONS[c.hintKey])
    .map((c) => ({ id: c.id, cmd: REMEDIATIONS[c.hintKey]!, optional: c.state === "optional" }));
}

/** Verbatim commands for every non-ok check whose emitted hintKey has a known fix.
 *  Thin projection of {@link remediationEntriesFor} — its `string[]` contract (and every
 *  caller/gate that reads `.length`) is unchanged. The optional-vs-required distinction that
 *  decides fatality lives in the consumer (`applyVerbatim`), which uses the richer entries. */
export function remediationsFor(snapshot: DiagnosticsSnapshot): string[] {
  return remediationEntriesFor(snapshot).map((r) => r.cmd);
}

/** The auto-fix gate for product surfaces (in-app Fix endpoint): the command for a
 *  hintKey iff one exists AND it actually clears the check when run unattended.
 *  Guidance-only hints (see GUIDANCE_ONLY) return undefined even though they have a
 *  REMEDIATIONS entry. `remediationsFor` stays raw/guidance-agnostic for the harness. */
export function autoFixCommandFor(hintKey: string): string | undefined {
  if (GUIDANCE_ONLY.has(hintKey)) return undefined;
  return REMEDIATIONS[hintKey];
}
