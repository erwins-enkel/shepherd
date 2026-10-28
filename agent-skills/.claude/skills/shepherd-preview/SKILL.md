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

Prototyping from your scratchpad works too — e.g. a throwaway comparison page to decide something
before planning. Shepherd finds a server you start there by the session marker every process you
spawn inherits, so there is no need to move it into the worktree. It is still the second-best
option for real work — nothing in the scratchpad ends up in the PR.

## Getting the preview URL

Wait a few seconds after the server is listening (Shepherd sweeps every few seconds), then call
the `self_status` MCP tool and read its `preview` block:

- `bound: true`, `url` set — the preview is live. Hand the operator **`preview.url`**; it is the
  same link the HUD's Preview badge opens. `devPort` is the port it proxies — check it is yours.
- `bound: false` — not picked up yet, or not at all; see below.
- `unavailable` — why there is no tailnet URL (`not_served`, `serve_pending`, `serve_failed`,
  `serve_denied`). The HUD Preview pane may still work.

The preview lives on a Shepherd **slot port** (e.g. `:8001` proxying to your server), never on your
dev port. Never search `tailscale serve status` for your dev port and conclude the preview failed.

## Pointing the preview at a specific port

If you start a long-running dev server and want Shepherd's live preview to target a specific port,
write that port — a bare number, nothing else — to a file named `.shepherd-preview` in the
repository root. If you started the server from the scratchpad instead, put that file in the
directory you started it from; the repository root still wins if both exist.

Shepherd uses that value only when the port is actually listening; otherwise it auto-detects the
port. In an autonomous session the file is required for the Shared Browser to reach your server:
Shepherd cannot see your sandbox's ports without it. So this is optional: skip it if you have no dev server, or if the default detection already
targets the right port.

A server on an OS-ephemeral port (one picked with `listen(0)` / `--port 0`; on Linux usually
32768–60999) is never auto-detected, because that is where test suites' throwaway servers live.
To preview such a server, declare its port in `.shepherd-preview`.

Debugger endpoints are never chosen as the preview, so a Node inspector or a CDP port on 9222 /
9229 / 9230 cannot be picked up by mistake.

## What Shepherd does and does not do

- Shepherd **never starts or stops your dev server**. Starting it is on you; keep it in a managed
  or background terminal, not as a blocking foreground command.
- Shepherd owns tailnet exposure — do not run `tailscale serve` yourself.
- Preview only applies to **isolated** sessions, which have their own worktree. A session sharing
  the main repo directory gets no preview at all.

## If no preview appears

`self_status` → `preview.bound` stays false. Verify, in this order:

1. the dev server process is still running;
2. `.shepherd-preview` contains the actual listening port (a bare number);
3. the port is genuinely bound (e.g. `ss -ltnp | grep <port>`).

Remember that a backgrounded server outlives the step that needed it: kill what you spawn in the
same shell once you are done with it.
