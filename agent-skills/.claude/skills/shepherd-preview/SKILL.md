---
name: shepherd-preview
description: How to expose a long-running local dev/test server from a Shepherd worktree so the operator's live preview finds it, by writing the port to a `.shepherd-preview` file. Load when starting a dev server, test server, or any other long-running local preview in this session.
---

# Shepherd live preview

Shepherd can proxy a dev server running in this worktree to the operator's browser (and, when
enabled, onto the tailnet). It finds the server by port.

## Pointing the preview at a specific port

If you start a long-running dev server in this worktree and want Shepherd's live preview to target
a specific port, write that port — a bare number, nothing else — to a file named
`.shepherd-preview` in the repository root.

Shepherd uses that value only when the port is actually listening; otherwise it auto-detects the
port. So this is optional: skip it if you have no dev server, or if the default detection already
targets the right port.

## What Shepherd does and does not do

- Shepherd **never starts or stops your dev server**. Starting it is on you; keep it in a managed
  or background terminal, not as a blocking foreground command.
- Shepherd owns tailnet exposure — do not run `tailscale serve` yourself.
- The hint only applies to **isolated** sessions, which have their own worktree. A session sharing
  the main repo directory has no dedicated worktree for the file to live in.

## If no preview appears

Verify, in this order:

1. the dev server process is still running;
2. `.shepherd-preview` contains the actual listening port (a bare number);
3. the port is genuinely bound (e.g. `ss -ltnp | grep <port>`).

Remember that a backgrounded server outlives the step that needed it: kill what you spawn in the
same shell once you are done with it.
