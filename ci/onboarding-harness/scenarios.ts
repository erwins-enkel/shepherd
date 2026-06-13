import type { Scenario } from "./types";

/**
 * The messy-environment scenario catalog. Every baseline is assumed bootable
 * (the bun runtime is installed by the seed engine before these seeds run — see
 * seed.ts); defects are layered on top so degraded Shepherd can still boot and
 * self-diagnose. `coaching: "structured"` scenarios use the deterministic
 * verbatim-remediation path (LLM-free gate); every such scenario MUST have a
 * matching REMEDIATIONS entry in remediations.ts. `coaching: "prose"` scenarios
 * are agent-path only (e.g. distro-specific installs with no single one-liner).
 */
export const SCENARIOS: Scenario[] = [
  {
    id: "gh-unauthed",
    image: "images:ubuntu/24.04",
    seed: [
      "type gh >/dev/null 2>&1 || (apt-get update && apt-get install -y gh)",
      "rm -rf ~/.config/gh", // installed but never logged in
    ],
    expect: [{ id: "gh", state: "error" }],
    coaching: "prose",
  },
  {
    id: "gh-missing",
    image: "images:debian/12",
    seed: ["apt-get remove -y gh 2>/dev/null || true", "rm -f /usr/bin/gh /usr/local/bin/gh"],
    expect: [{ id: "gh", state: "error" }],
    // prose: gh install is distro-specific; no single verbatim one-liner covers
    // ubuntu/debian/alpine/arch/fedora → agent path only, not the deterministic gate.
    coaching: "prose",
  },
  {
    id: "tailscale-missing",
    image: "images:ubuntu/24.04",
    seed: ["rm -f /usr/bin/tailscale /usr/sbin/tailscaled /usr/local/bin/tailscale"],
    expect: [{ id: "tailscale", state: "error" }],
    coaching: "structured",
  },
  {
    id: "tailscale-not-serving",
    image: "images:ubuntu/24.04",
    // tailscaled up + logged in but no `serve` mapping for the HUD port → warning.
    // Uses a faked tailnet so no real login is required (see seed.ts notes).
    seed: ["systemctl start tailscaled || true", "tailscale serve reset 2>/dev/null || true"],
    expect: [{ id: "tailscale", state: "warning" }],
    coaching: "prose",
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
    // an unauthed-but-installed claude reports ok by design, which the gap report
    // notes as a known non-detection, not a discovered gap). Removing claude also
    // disables the agent apply path (the agent IS claude running in-instance), so
    // this scenario is detection-only in Phase 1 and verbatim-reinstalled in Phase 2.
    id: "claude-missing",
    image: "images:fedora/40",
    seed: ["rm -f /usr/local/bin/claude ~/.local/bin/claude"],
    expect: [{ id: "claude", state: "error" }],
    coaching: "structured",
    agentIncompatible: true,
  },
  {
    id: "git-missing",
    image: "images:alpine/3.20",
    seed: ["apk del git 2>/dev/null || true", "rm -f /usr/bin/git"],
    expect: [{ id: "git", state: "error" }],
    // prose: git install is distro-specific; no single verbatim one-liner covers
    // ubuntu/debian/alpine/arch/fedora → agent path only, not the deterministic gate.
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
    id: "herdr-too-old",
    image: "images:ubuntu/24.04",
    // Seed engine installs a pinned old herdr build at this path (see seed.ts).
    seed: ["echo 'placeholder: old herdr pinned by baseline' >/dev/null"],
    expect: [{ id: "herdr", state: "warning" }],
    coaching: "structured",
  },
];
