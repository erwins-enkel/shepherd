---
name: shepherd-preview
description: How to expose a long-running local dev/test server from a Shepherd worktree so the operator's live preview finds it, by writing the port to a `.shepherd-preview` file. Load when starting a dev server, test server, or any other long-running local preview in this session.
---

# Shepherd live preview

Shepherd can proxy a dev server running in this worktree to the operator's browser (and, when
enabled, onto the tailnet). It finds the server by port.

## Where to start the server

Start it **from this worktree**. That is the case the preview is built around, and it keeps the
server next to the code you are changing.

Prototyping from your scratchpad works too — Shepherd recognises a server you started there by the
session marker every process you spawn inherits, so it is no longer invisible. It is still the
second-best option: nothing in the scratchpad ends up in the PR.

## Pointing the preview at a specific port

If you start a long-running dev server and want Shepherd's live preview to target a specific port,
write that port — a bare number, nothing else — to a file named `.shepherd-preview` in the
repository root. If you started the server from the scratchpad instead, put that file in the
directory you started it from; the repository root still wins if both exist.

Shepherd uses that value only when the port is actually listening; otherwise it auto-detects the
port. So this is optional: skip it if you have no dev server, or if the default detection already
targets the right port.

Debugger endpoints are never chosen as the preview, so a Node inspector or a CDP port on 9222 /
9229 / 9230 cannot be picked up by mistake.

## What Shepherd does and does not do

- Shepherd **never starts or stops your dev server**. Starting it is on you; keep it in a managed
  or background terminal, not as a blocking foreground command.
- Shepherd owns tailnet exposure — do not run `tailscale serve` yourself.
- Preview only applies to **isolated** sessions, which have their own worktree. A session sharing
  the main repo directory gets no preview at all.

## If no preview appears

Verify, in this order:

1. the dev server process is still running;
2. `.shepherd-preview` contains the actual listening port (a bare number);
3. the port is genuinely bound (e.g. `ss -ltnp | grep <port>`).

Remember that a backgrounded server outlives the step that needed it: kill what you spawn in the
same shell once you are done with it.
