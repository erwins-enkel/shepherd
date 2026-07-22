import type { Scenario } from "./types";

/**
 * The messy-environment scenario catalog. Every baseline is assumed bootable
 * (the bun runtime is installed by the seed engine before these seeds run — see
 * seed.ts); defects are layered on top so degraded Shepherd can still boot and
 * self-diagnose.
 *
 * Two classes of scenario:
 *  - **Green-able** — the seeded defect can be coached back to `ok` unattended.
 *    `coaching: "structured"` is release-gate-eligible (LLM-free, deterministic) and
 *    MUST have a matching REMEDIATIONS entry in src/remediations.ts. `coaching: "prose"`
 *    is NON-gating: it still reaches green via whatever apply path fits — either a
 *    verbatim REMEDIATIONS entry it deliberately keeps out of the gate (git: a
 *    cross-distro apt/apk/dnf/pacman install we don't want a mirror flake to block a
 *    release on) or the agent path. Success = the scenario's expected checks are `ok`
 *    after the apply.
 *  - **Detection-only** (`detectionOnly: true`) — the defect is detectable but its
 *    fix needs a human/secret that a throw-away instance cannot supply (`gh auth
 *    login` device-flow; a Tailscale tailnet login + `serve` to reach `ok`). These
 *    verify detection only: no apply, excluded from the green tally and the gate,
 *    reported as DETECTION-ONLY. This is the honest "onboarding still needs the
 *    user here" finding the gap report exists to surface.
 *
 * NOTE: the `herdr-outdated` scenario below covers DETECTION of a live-but-old herdr
 * (warning), but its GREEN-ABLE remediation — `herdr update --handoff` (#1578) — stays
 * deferred: install.sh can't pin an old build, so the harness can't stand up a real old
 * live daemon to hand off from (the remediation's behavior is proved by
 * test/remediations.test.ts + test/diagnostics.test.ts instead). Other scenarios that
 * require provisioning the harness doesn't yet implement (a faked tailnet for the
 * not-serving warning state) remain intentionally OMITTED rather than shipped as permanent
 * gaps — see the deferred follow-ups in docs/superpowers/specs/...-design.md.
 */
export const SCENARIOS: Scenario[] = [
  {
    // gh authentication is interactive (device-flow) — undetectable-to-green in a
    // throw-away instance, so detection-only.
    id: "gh-unauthed",
    image: "images:ubuntu/24.04",
    seed: [
      "type gh >/dev/null 2>&1 || (apt-get update && apt-get install -y gh)",
      "rm -rf ~/.config/gh", // installed but never logged in
      // Since #819 (lightweight repo mode) the gh probe only surfaces a failure as
      // `error` when a FORGE-mode repo is configured — with zero repos it downgrades
      // to `warning` (diagnostics_hint_gh_not_required, gh genuinely optional). A
      // bare dir under repoRoot ($HOME=/root) is enough: listRepos() enumerates any
      // non-dot subdir and repoMode defaults to "forge", so anyForgeRepo()→true and
      // the unauthed gh surfaces as `error`. (The inverse no-forge-repo→warning path
      // stays covered by test/diagnostics.test.ts, not a harness scenario.)
      "mkdir -p ~/forge-repo",
    ],
    expect: [{ id: "gh", state: "error" }],
    coaching: "prose",
    detectionOnly: true,
  },
  {
    // gh install is distro-specific AND auth is interactive → detection-only.
    id: "gh-missing",
    image: "images:debian/12",
    seed: [
      "apt-get remove -y gh 2>/dev/null || true",
      "rm -f /usr/bin/gh /usr/local/bin/gh",
      // See gh-unauthed: post-#819 a configured forge repo is required for the gh
      // probe to report `error` rather than the no-repo `warning`. A bare dir under
      // repoRoot suffices (repoMode defaults to "forge").
      "mkdir -p ~/forge-repo",
    ],
    expect: [{ id: "gh", state: "error" }],
    coaching: "prose",
    detectionOnly: true,
  },
  {
    // tailscale=ok requires a logged-in tailnet AND `serve` — neither is reachable
    // unattended without a tailnet auth key, so detection-only (installing the
    // binary alone never clears the check).
    id: "tailscale-missing",
    image: "images:ubuntu/24.04",
    seed: ["rm -f /usr/bin/tailscale /usr/sbin/tailscaled /usr/local/bin/tailscale"],
    expect: [{ id: "tailscale", state: "error" }],
    coaching: "prose",
    detectionOnly: true,
  },
  {
    // Since #1313 a missing herdr fail-fasts (banner + exit 78) BEFORE the HTTP
    // server binds, so the boot+probe path can't detect it. The baseline installs a
    // herdr STUB (seed.ts) which this seed removes, restoring the real fail-fast;
    // `preflightFailFast` selects the runner that asserts the banner/exit, then
    // applies the verbatim REMEDIATIONS herdr install and re-boots to green. Stays
    // `structured` (gate-eligible) — it exercises the real new first-run UX.
    id: "herdr-missing",
    image: "images:archlinux",
    seed: ["rm -f /usr/local/bin/herdr ~/.local/bin/herdr"],
    expect: [{ id: "herdr", state: "error" }],
    coaching: "structured",
    preflightFailFast: true,
  },
  {
    // A live-but-OUTDATED herdr: `herdr --version` reports below HERDR_MIN_VERSION → `warning`,
    // while the daemon still answers `agent list` (liveness ok) so it reads outdated, NOT
    // offline. The baseline stub reports HERDR_LAST_SUPPORTED_VERSION (ok); this seed overwrites
    // it to report an old version. Present-but-old passes the boot preflight (it fail-fasts only
    // on a MISSING binary, src/preflight.ts), so the instance boots and self-diagnoses.
    //
    // DETECTION-ONLY: applies no remediation, so it exercises NONE of the #1578
    // `herdr update --handoff` remediation and largely duplicates the outdated→warning unit
    // coverage (test/diagnostics.test.ts); its only marginal value is the real boot+probe
    // classification of a live-but-old herdr end-to-end. A green-able E2E stays deferred — see
    // the header NOTE (no install.sh version pinning → no real old daemon to hand off from).
    id: "herdr-outdated",
    image: "images:archlinux",
    seed: [
      "mkdir -p ~/.local/bin",
      "cat > ~/.local/bin/herdr <<'HERDR_STUB'\n#!/bin/sh\necho '{\"version\":\"0.6.5\"}'\nHERDR_STUB",
      "chmod +x ~/.local/bin/herdr",
    ],
    expect: [{ id: "herdr", state: "warning" }],
    coaching: "prose",
    detectionOnly: true,
  },
  {
    // claudeProbe is PRESENCE-ONLY (a successful `claude --version` ⇒ ok; there is
    // NO auth/login probe, so there is deliberately no "claude-unauthed" scenario —
    // an unauthed-but-installed claude reports ok by design). Removing claude
    // disables the agent path (the agent IS claude in-instance), but verbatim-first
    // dispatch reinstalls claude deterministically, so this IS green-able;
    // `agentIncompatible` is only the fallback if the verbatim fix were ever absent.
    id: "claude-missing",
    image: "images:rockylinux/9",
    seed: ["rm -f /usr/local/bin/claude ~/.local/bin/claude"],
    expect: [{ id: "claude", state: "error" }],
    coaching: "structured",
    agentIncompatible: true,
  },
  {
    id: "git-missing",
    image: "images:alpine/3.21",
    seed: ["apk del git 2>/dev/null || true", "rm -f /usr/bin/git"],
    expect: [{ id: "git", state: "error" }],
    // git now has a deterministic cross-distro verbatim remediation
    // (apt||apk||dnf||pacman, src/remediations.ts GIT_INSTALL), so the verbatim-first
    // dispatch reaches green LLM-free. Kept coaching:"prose" — NOT "structured" —
    // deliberately, so it stays OUT of the release gate: installing git is a
    // privileged system-package op we don't want a transient mirror flake to gate a
    // release on. (Reaching green also needs the alpine bash baseline fix, PR #732.)
    coaching: "prose",
  },
  {
    id: "node-too-old",
    image: "images:debian/12",
    // Debian 12's archive node is well below NODE_MIN_VERSION → warning.
    seed: ["apt-get update", "apt-get install -y nodejs"],
    expect: [{ id: "node", state: "warning" }],
    coaching: "structured",
  },
  {
    // Installer end-to-end regression: a BARE instance (no Bun, no checkout, no
    // baseline) where the real deploy/install.sh must bring the host to green.
    // `expect` is the TARGET-ok set, not a seeded defect (seed is empty). gh +
    // tailscale are intentionally out — a throw-away instance has no gh login /
    // tailnet, so they stay non-ok; success is scoped to the auto-fixable set,
    // same as every other scenario.
    id: "install-e2e",
    image: "images:ubuntu/24.04", // apt (covered by install.sh distro detection for git) + x86_64 node-pty prebuilt → no node-gyp rebuild
    seed: [],
    expect: [
      { id: "herdr", state: "ok" },
      { id: "bun", state: "ok" },
      { id: "node", state: "ok" },
      { id: "git", state: "ok" },
      { id: "claude", state: "ok" },
    ],
    coaching: "structured",
    installE2E: true,
  },
  {
    // Same inverse-flow installer scenario as install-e2e (bare host → real
    // deploy/install.sh → assert green), PLUS the full systemd USER-UNIT lifecycle
    // that install-e2e deliberately skips: install-e2e runs install.sh with
    // SHEPHERD_NO_SERVICE=1 (no systemd in a fresh exec session); this one establishes
    // the per-user systemd manager (loginctl enable-linger root + wait for the user
    // bus socket), runs install.sh THROUGH the service path (no SHEPHERD_NO_SERVICE),
    // then asserts `systemctl --user is-active shepherd` and health-checks Shepherd
    // THROUGH the running unit. `expect` is the same TARGET-ok set as install-e2e.
    id: "install-e2e-service",
    // ubuntu/24.04: apt + x86_64 node-pty prebuilt (no node-gyp rebuild), and
    // `git init -b main` needs git ≥2.28 — ubuntu/24.04 ships git ≥2.43, so it's fine.
    image: "images:ubuntu/24.04",
    seed: [],
    expect: [
      { id: "herdr", state: "ok" },
      { id: "bun", state: "ok" },
      { id: "node", state: "ok" },
      { id: "git", state: "ok" },
      { id: "claude", state: "ok" },
    ],
    coaching: "structured",
    installE2E: true,
    serviceLifecycle: true,
  },
];
