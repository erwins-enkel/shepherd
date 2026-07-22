// Version-PINNED herdr installation (#1896).
//
// herdr.dev/install.sh is latest-only (verified live: it resolves latest.json's asset, downloads,
// `mv`s it to ~/.local/bin, and does nothing else — no checksum, no signature, no version knob).
// Shepherd refuses to drive a herdr above HERDR_LAST_SUPPORTED_VERSION, so installing "latest"
// means every fresh onboarding breaks the day herdr ships past the ceiling — exactly the nightly
// regression #1896 reported. This module builds the replacement: a version-addressable download of
// the ceiling, so raising the ceiling propagates to every install path with no second edit.
//
// LEAF MODULE — imports nothing but the capability constant. src/preflight.ts is documented as
// side-effect-free at import, and reaching these helpers through remediations.ts would drag
// config.ts (which loads the forge config at import) into the boot preflight and its tests.
// herdr-update.ts re-exports herdrAssetKey/herdrReleaseUrl from here, so existing importers are
// unaffected.
import { HERDR_LAST_SUPPORTED_VERSION } from "./herdr-capabilities";

/** Versions are regex-captured (digits + dots) before they reach here, but they ultimately
 *  originate from herdr.dev/latest.json — an external source. Strip anything that isn't a version
 *  char before embedding in a shell program so a poisoned payload can never inject commands.
 *  Empty → "unknown". */
export function sanitizeVersion(v: string | null | undefined): string {
  const clean = (v ?? "").replace(/[^0-9.]/g, "");
  return clean || "unknown";
}

/** Map this host onto latest.json's asset key (`linux-x86_64`, `macos-aarch64`, …);
 *  null when herdr publishes no binary for the platform. */
export function herdrAssetKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const os = platform === "linux" ? "linux" : platform === "darwin" ? "macos" : null;
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
  return os && cpu ? `${os}-${cpu}` : null;
}

/** The GitHub release-tag page for a version — the manual-install pointer the loud failure
 *  branches (and the preflight banner's no-asset fallback) hand the operator. */
export function herdrReleaseTagUrl(version: string): string {
  return `https://github.com/ogulcancelik/herdr/releases/tag/v${sanitizeVersion(version)}`;
}

/** The version-addressable release-asset URL, built from a HARDCODED template (the same GitHub
 *  slug the modal's release-notes link uses). The DOWNGRADE flow (#1898) additionally cross-checks
 *  this against latest.json's `releases` map before running — the template guarantees shape (no
 *  injection), the manifest guarantees currency. The FRESH-INSTALL path below deliberately does
 *  NOT: that cross-check protects a working install about to be swapped, whereas a fresh install
 *  has nothing to protect, and a static remediation string (or a bare-host provision run, with no
 *  Shepherd process) has no service to call. */
export function herdrReleaseUrl(version: string, assetKey: string): string {
  return `https://github.com/ogulcancelik/herdr/releases/download/v${sanitizeVersion(version)}/herdr-${assetKey}`;
}

/**
 * `curl` transfer flags for the pinned download, sized to the CONSUMER's deadline.
 *
 * The artifact is ~20.3 MiB (measured: 21,315,048 bytes for v0.7.5 linux-x86_64, served via one
 * 302 to release-assets.githubusercontent.com), so an attempt must cover connect + two TLS
 * handshakes + the redirect + the body. That makes the cap a bandwidth floor, not a formality:
 *
 *  - `"upstream"` — `--max-time 120`, i.e. the same tolerance (≈1.4 Mbit/s) upstream's own
 *    installer allows. Used where nothing kills the process: deploy/provision.ts (a fresh
 *    install.sh) and the preflight banner's copy-pasteable line.
 *  - `"in-app"` — must fit inside REMEDIATION_TIMEOUT_MS (120s), where defaultRunRemediation
 *    SIGKILLs the whole process group, ALONGSIDE the HERDR_SERVE clause it is composed with
 *    (≤22s: initial probe + spawn + its 10 × (probe + sleep 1) poll) and the local verify (~1s).
 *    That leaves 90s for one attempt ⇒ a ≈1.9 Mbit/s floor, with 7s of slack against the
 *    group-kill. See HERDR_IN_APP_DOWNLOAD_WORST_CASE_MS.
 *
 * The in-app path is deliberately the tight one: src/index.ts fail-fasts (exit 78) on a missing
 * herdr, so the in-app `herdr_missing` fix is only reachable with Shepherd already running — the
 * UI is up and a failed fix is visible and retryable. Nobody is stranded by the tighter cap.
 */
export type HerdrDownloadBudget = "upstream" | "in-app";

/** Per-budget `curl` timing. `--retry-max-time` bars a NEW attempt after N seconds; an attempt
 *  starting just under it still gets its full `--max-time`, so the worst case is
 *  `retryMaxTime + maxTime` (and simply `maxTime` when retries are off).
 *
 *  The in-app budget deliberately runs a SINGLE attempt. When a hard deadline is the binding
 *  constraint, splitting it into retries shrinks each attempt's cap and therefore RAISES the
 *  bandwidth floor — the opposite of what a slow link needs. One 90s attempt admits ≈1.9 Mbit/s;
 *  two 45s attempts would demand ≈3.8. Retrying the whole apply is the harness's job
 *  (runWithRetry), and the operator can simply click Fix again. */
const DOWNLOAD_BUDGETS = {
  upstream: { connectTimeout: 10, maxTime: 120, retry: 1, retryDelay: 1, retryMaxTime: 121 },
  "in-app": { connectTimeout: 5, maxTime: 90, retry: 0, retryDelay: 0, retryMaxTime: 0 },
} as const satisfies Record<
  HerdrDownloadBudget,
  {
    connectTimeout: number;
    maxTime: number;
    retry: number;
    retryDelay: number;
    retryMaxTime: number;
  }
>;

/** Worst-case wall clock of the IN-APP pinned download, in ms. Exported so the budget arithmetic
 *  is machine-checked against the real REMEDIATION_TIMEOUT_MS (see test/herdr-install.test.ts)
 *  rather than asserted in prose — raising a timeout or adding a retry then fails the suite
 *  instead of silently pushing the composed remediation past the group-kill. */
export const HERDR_IN_APP_DOWNLOAD_WORST_CASE_MS =
  (DOWNLOAD_BUDGETS["in-app"].retryMaxTime + DOWNLOAD_BUDGETS["in-app"].maxTime) * 1000;

/** Worst case of the HERDR_SERVE clause the in-app remediation is composed with: initial probe
 *  (1s) + spawn/`systemctl restart` (1s) + its poll loop of 10 × (probe 1s + `sleep 1`). Derived
 *  from that loop's actual shape, not a round number chosen to fit. */
export const HERDR_SERVE_WORST_CASE_MS = (1 + 1 + 10 * 2) * 1000;

/** Local `--version` exec + atomic rename. */
export const HERDR_VERIFY_WORST_CASE_MS = 1000;

function curlFlags(budget: HerdrDownloadBudget): string {
  const b = DOWNLOAD_BUDGETS[budget];
  const retry = b.retry
    ? ` --retry ${b.retry} --retry-delay ${b.retryDelay} --retry-max-time ${b.retryMaxTime}`
    : "";
  return `-fsSL${retry} --connect-timeout ${b.connectTimeout} --max-time ${b.maxTime}`;
}

/**
 * The shell program that installs the PINNED herdr, as a single line.
 *
 * SINGLE LINE is load-bearing, not style: this string is carried on `check.remediation` and
 * rendered verbatim by DiagnoseRows.svelte's confirm modal as `<code class="cmd">` with
 * `white-space: pre` and only `overflow-x: auto`, inside a `.card` that has no desktop
 * `max-height`/`overflow-y`. A long single line scrolls horizontally; a multi-line one grows the
 * card past the viewport with no scrollbar and clips the CANCEL/RUN buttons.
 *
 * SUBSHELL-WRAPPED, also load-bearing: REMEDIATIONS composes this as
 * `${HERDR_INSTALL} && (${HERDR_SERVE})`, and an unwrapped multi-statement program would let `&&`
 * bind to only its LAST command — the exact trap remediations.ts already documents for
 * HERDR_SERVE.
 *
 * Ordering mirrors buildDowngradeScript (download → verify → atomic swap), but its TIMEOUTS and
 * TEMP PATH deliberately do not: that script has an existing binary to anchor a temp beside and
 * never runs under defaultRunRemediation's group-kill.
 *
 * Failure policy — governing rule is NEVER WORSE THAN today's `curl | bash`, which performs no
 * verification at all. Verification therefore BLOCKS only on positive evidence the artifact is
 * wrong; everything else warns and proceeds exactly as today would:
 *
 *  - `uname` miss (either arm) ⇒ loud failure naming the release tag. No point deferring to
 *    upstream: its installer has the identical `case` arms and fails the same way with less
 *    information.
 *  - download failure after the budgeted retries ⇒ loud failure, non-zero. Byte-parity with
 *    today: provision's installPrereqs calls run() (NOT runWithRetry) and defaultRunner throws,
 *    so a failed herdr install already aborts install.sh.
 *  - cannot exec (126/127 — the glibc-asset-on-musl case; herdrAssetKey has no musl key, so
 *    alpine gets the glibc asset exactly as upstream does) ⇒ WARN and swap anyway. A hard abort
 *    here would kill install.sh on Alpine hosts that install fine today.
 *  - exits 0 but the version is unparseable ⇒ WARN and swap anyway. That is evidence about our
 *    PARSER (herdr emits JSON on some paths, and this pin is meant to propagate on a ceiling bump
 *    with no second edit), not about the artifact.
 *  - exits 0, parses, and differs from the pin ⇒ loud failure, temp removed, NO swap. The only
 *    case with positive evidence the artifact is mislabeled.
 *  - mkdir/chmod/mv failure ⇒ loud failure, non-zero, and NO success line.
 *
 * Two details that keep the above honest:
 *  - the exec status is captured from the BINARY (`>"$OUT"; rc=$?`), never from a pipeline —
 *    `V="$(… | head -n 1)"; rc=$?` would capture `head`'s status (always 0) and make the
 *    exec-failure branch unreachable;
 *  - the temp lives NEXT TO the install target, so `mv` is an atomic same-filesystem rename. A
 *    /tmp temp would make it a copy+unlink, and on a `noexec` /tmp would make the `--version`
 *    probe fail for reasons that have nothing to do with the artifact.
 */
export function herdrPinnedInstallCommand(
  version: string = HERDR_LAST_SUPPORTED_VERSION,
  opts: { downloadBudget?: HerdrDownloadBudget } = {},
): string {
  const v = sanitizeVersion(version);
  const tag = herdrReleaseTagUrl(v);
  // Asset key assembled by the shell from `uname`, NOT baked from process.platform: this string is
  // built on the Shepherd host but can execute elsewhere (the harness applies it inside an Incus
  // instance), and provision.ts runs it on hosts Shepherd has never introspected. The arms must
  // agree with herdrAssetKey() — test/herdr-install.test.ts asserts that for every mapped pair.
  const url = `https://github.com/ogulcancelik/herdr/releases/download/v${v}/herdr-$O-$A`;
  return [
    "(",
    `case "$(uname -s)" in Linux) O=linux ;; Darwin) O=macos ;;`,
    `*) echo "herdr: unsupported OS $(uname -s) — install herdr ${v} manually from ${tag}" >&2; exit 1 ;; esac;`,
    `case "$(uname -m)" in x86_64|amd64) A=x86_64 ;; aarch64|arm64) A=aarch64 ;;`,
    `*) echo "herdr: unsupported architecture $(uname -m) — install herdr ${v} manually from ${tag}" >&2; exit 1 ;; esac;`,
    'D="${HERDR_INSTALL_DIR:-$HOME/.local/bin}";',
    // && all the way through the swap: a failed mkdir/chmod/mv must short-circuit, never proceed.
    'mkdir -p "$D" || { echo "herdr: cannot create $D" >&2; exit 1; };',
    'T="$D/.herdr.$$"; OUT="$D/.herdr-version.$$";',
    `curl ${curlFlags(opts.downloadBudget ?? "in-app")} -o "$T" "${url}" || ` +
      `{ rm -f "$T"; echo "herdr: download failed for ${v} ($O-$A) — install manually from ${tag}" >&2; exit 1; };`,
    'chmod +x "$T" || { rm -f "$T"; echo "herdr: cannot chmod $T" >&2; exit 1; };',
    // rc is the BINARY's status; V is the parse. They are different questions with different
    // answers, so they are captured separately.
    '"$T" --version >"$OUT" 2>/dev/null; rc=$?;',
    `V="$(grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' "$OUT" 2>/dev/null | head -n 1)"; rm -f "$OUT";`,
    'if [ "$rc" -ne 0 ]; then',
    `echo "herdr: downloaded ${v} does not run here (exit $rc) — a musl host gets the glibc build; installing it anyway, as the upstream installer would" >&2;`,
    'elif [ -z "$V" ]; then',
    `echo "herdr: could not read a version from the downloaded ${v} binary — installing it anyway, as the upstream installer would" >&2;`,
    `elif [ "$V" != "${v}" ]; then`,
    `rm -f "$T"; echo "herdr: downloaded binary reports $V, expected ${v} — refusing to install it; get ${v} from ${tag}" >&2; exit 1;`,
    "fi;",
    'mv -f "$T" "$D/herdr" || { rm -f "$T"; echo "herdr: cannot install into $D" >&2; exit 1; };',
    // Success is claimed only AFTER the swap is observed to have landed — `echo` exits 0, so an
    // unguarded success line would report a healthy install on a host with no herdr.
    // `-f` as well as `-x`: if `$D/herdr` were a DIRECTORY, `mv -f` would move the temp INSIDE it
    // and exit 0, and a bare `-x` test passes on any traversable directory — reporting a healthy
    // install with no herdr binary anywhere. The guard exists precisely to make the success line
    // a verified fact, so it must not be satisfiable by the failure it guards against.
    `[ -f "$D/herdr" ] && [ -x "$D/herdr" ] || { echo "herdr: $D/herdr is not an executable file after install" >&2; exit 1; };`,
    `echo "herdr ${v} installed to $D/herdr";`,
    ")",
  ].join(" ");
}
