---
title: "CLI reference"
description: "Operator-facing herdr CLI commands, generated from live --help."
---

Shepherd drives the [`herdr`](https://herdr.dev) interactive-pane manager for you, so most herdr commands are internal plumbing you never run by hand. This reference covers the **operator-facing** commands — the ones you might run directly when managing a Shepherd host. Each page below is the command's own `--help` output (command-level, not every leaf flag), pinned to herdr **0.7.0**.

_Generated from live `herdr --help` — do not edit by hand; run `bun run gen:cli` to regenerate._

```text
herdr — terminal workspace manager for AI coding agents

Usage: herdr [options]
       herdr --session <name> [options]
       herdr --remote <ssh-target> [--session <name>]
       herdr session attach <name>
       herdr update [--handoff]
       herdr channel set <stable|preview>
       herdr server stop
       herdr server reload-config
       herdr config <subcommand> ...
       herdr channel <subcommand> ...
       herdr workspace <subcommand> ...
       herdr worktree <subcommand> ...
       herdr tab <subcommand> ...
       herdr notification <subcommand> ...
       herdr agent <subcommand> ...
       herdr pane <subcommand> ...
       herdr wait <subcommand> ...
       herdr session <subcommand> ...
       herdr integration <subcommand> ...

Common commands:
  herdr                            Launch or attach to the persistent session
  herdr status [server|client]     Show local client and running server status
  herdr update                     Download and install the latest version
  herdr server stop                Stop the running server via the API socket
  herdr channel set <stable|preview> Choose the stable or preview update channel
  herdr server reload-config       Reload config.toml in the running server
  herdr config reset-keys          Back up config.toml and remove custom keybindings
  herdr channel <subcommand>       Manage the stable or preview update channel
  herdr workspace <subcommand>     Workspace helpers over the socket API
  herdr worktree <subcommand>      Git worktree helpers over the socket API
  herdr tab <subcommand>           Tab helpers over the socket API
  herdr notification <subcommand>  Notification helpers over the socket API
  herdr agent <subcommand>         Agent/terminal helpers over the socket API
  herdr pane <subcommand>          Pane control helpers over the socket API
  herdr wait <subcommand>          Blocking wait helpers over the socket API
  herdr session <subcommand>       Manage named persistent sessions
  herdr integration <subcommand>   Manage built-in agent integrations

Advanced commands:
  herdr server                     Run as headless server

Options:
  --no-session        Run monolithically (no server/client, escape hatch)
  --session <name>    Use or create a named persistent session
  --remote <target>   Attach through SSH to a remote Herdr server
  --remote-keybindings <local|server>
                      Keybindings for --remote app attach (default: local)
  --handoff           Opt into live handoff for update or remote attach
  --default-config    Print default configuration and exit
  --version, -V       Print version and exit
  --help, -h          Show this help
```
