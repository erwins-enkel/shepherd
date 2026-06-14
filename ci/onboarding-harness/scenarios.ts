import type { Scenario } from "./types";

/**
 * The messy-environment scenario catalog. Every baseline is assumed bootable
 * (the bun runtime is installed by the seed engine before these seeds run — see
 * seed.ts); defects are layered on top so degraded Shepherd can still boot and
 * self-diagnose.
 *
 * Two classes of scenario:
 *  - **Green-able** — the seeded defect can be coached back to `ok` unattended.
 *    `coaching: "structured"` uses the deterministic verbatim-remediation path
 *    (LLM-free, release-gate-eligible) and MUST have a matching REMEDIATIONS entry
 *    in remediations.ts; `coaching: "prose"` uses the agent path (e.g. git, whose
 *    install is distro-specific with no single one-liner — the agent picks apt/
 *    apk/dnf). Success = the scenario's expected checks are `ok` after the apply.
 *  - **Detection-only** (`detectionOnly: true`) — the defect is detectable but its
 *    fix needs a human/secret that a throw-away instance cannot supply (`gh auth
 *    login` device-flow; a Tailscale tailnet login + `serve` to reach `ok`). These
 *    verify detection only: no apply, excluded from the green tally and the gate,
 *    reported as DETECTION-ONLY. This is the honest "onboarding still needs the
 *    user here" finding the gap report exists to surface.
 *
 * NOTE: scenarios that require provisioning the harness doesn't yet implement
 * (a pinned outdated herdr build; a faked tailnet for the not-serving warning
 * state) are intentionally OMITTED rather than shipped as permanent gaps — see
 * the deferred follow-ups in docs/superpowers/specs/...-design.md.
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
    ],
    expect: [{ id: "gh", state: "error" }],
    coaching: "prose",
    detectionOnly: true,
  },
  {
    // gh install is distro-specific AND auth is interactive → detection-only.
    id: "gh-missing",
    image: "images:debian/12",
    seed: ["apt-get remove -y gh 2>/dev/null || true", "rm -f /usr/bin/gh /usr/local/bin/gh"],
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
    id: "herdr-missing",
    image: "images:archlinux",
    seed: ["rm -f /usr/local/bin/herdr ~/.local/bin/herdr"],
    expect: [{ id: "herdr", state: "error" }],
    coaching: "structured",
  },
  {
    // claudeProbe is PRESENCE-ONLY (a successful `claude --version` ⇒ ok; there is
    // NO auth/login probe, so there is deliberately no "claude-unauthed" scenario —
    // an unauthed-but-installed claude reports ok by design). Removing claude
    // disables the agent path (the agent IS claude in-instance), but verbatim-first
    // dispatch reinstalls claude deterministically, so this IS green-able;
    // `agentIncompatible` is only the fallback if the verbatim fix were ever absent.
    id: "claude-missing",
    image: "images:fedora/42",
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
    // prose: git install is distro-specific; no single verbatim one-liner covers
    // ubuntu/debian/alpine/arch/fedora → agent path picks the right installer.
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
];
