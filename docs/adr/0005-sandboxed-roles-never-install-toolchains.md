---
status: accepted
---

# Sandboxed agents never install toolchains; only version-manager scratch is writable, as throwaway tmpfs

The sandbox membrane (`bwrap`) binds the host's version-manager roots read-only (`~/.local/share/mise`, `~/.nvm`, `~/.local/share/fnm`, linuxbrew), because the node, bun and claude binaries the agent runs live under them. Some managers rewrite part of their tree on every invocation: a mise-managed `claude` is reached through a launcher that rebuilds `shims/`. Under the read-only bind that rebuild failed with EROFS, mise exited non-zero and the agent never started. Nothing reported it: the role's verdict file just never appeared, so every membrane-wrapped role (plan gate, PR critic, doc agent, standalone critic) waited out its timeout and recorded `no-verdict` (#2110). The fix is deliberately narrow: a `--tmpfs` over just the sub-path the manager rewrites (mise: `shims/`), so the rewrite succeeds against storage that is thrown away and never reaches the host. The rest of the tree, `installs/` in particular, stays read-only. Making it writable would let an untrusted agent download and run arbitrary tool versions, and plant a binary that a later trusted session would execute.

## Consequences

- A tool version the host has not installed yet cannot be installed from inside the membrane; that still fails. Installing toolchains is a host-side job for a trusted session or the operator.
- Adding a version manager that rewrites state on launch needs its own scratch entry next to mise's (`managerScratch` in `src/sandbox.ts`). The scratch list never names an install directory.
- Order matters in the bwrap argv: each tmpfs must come after the `--ro-bind` it punches through.
- The sandbox backend self-test deliberately does not launch the agent binary: its failure means "run unconfined", so folding a launcher fault into it would strip the sandbox on exactly the hosts that can sandbox. Whether the agent starts inside the membrane is a separate launch probe (`probeMembraneLaunch`, #2111), whose failure blocks the wrapped spawn and raises a DIAGNOSE row without touching confinement.
