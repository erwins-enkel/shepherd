---
status: accepted
---

# Shared Browser CDP is brokered by Shepherd, never a raw debug port

The per-repo Shared Browser runs with `--remote-debugging-pipe` (no TCP debug port), and agents reach it only through a per-session, token-gated CDP WebSocket that Shepherd serves on the existing agent-ingress listener. A raw loopback debug port would hand every local process root-equivalent access to all of the operator's logins and is unreachable from autonomous sessions without a new netns hole; the broker gives one revocable chokepoint that already reaches all three sandbox profiles and lets Shepherd enforce the per-repo browser origin allowlist on autonomous attaches.

## Consequences

- Attach is browser-level: an attached agent can read every login in that repo's Browser Profile. The isolation boundary is the per-repo profile, not the tab.
- Tools that insist on spawning their own Chrome or on `--remote-debugging-port` must be pointed at the broker URL instead. That URL carries the session's token, so it never rides env or argv (both reach `/proc/<pid>/cmdline`): it lives in a per-session 0600 config file outside every working tree, whose path is in `SHEPHERD_BROWSER_CONFIG` and which a sandboxed session sees through a single-file read-only bind.
