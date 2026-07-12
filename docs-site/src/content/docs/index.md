---
title: Shepherd
description: Documentation for Shepherd — interactive mission control for Claude Code agents.
template: splash
hero:
  tagline: Interactive mission control for fleets of Claude Code agents.
  actions:
    - text: Getting started
      link: /getting-started/
      icon: right-arrow
    - text: View on GitHub
      link: https://github.com/erwins-enkel/shepherd
      icon: external
      variant: minimal
---

Shepherd runs sessions, drains backlogs into pull requests, and keeps a human in
the loop where it matters — a single mission control for fleets of Claude Code
agents.

## Start here

- **[Getting started](/getting-started/)** — install Shepherd and sign in.
- **[Operating Shepherd](/operating/)** — run it as a service, expose it over
  Tailscale, and deploy code changes.
- **[Authoring an epic](/authoring-epics/)** — structure a GitHub epic Shepherd
  recognizes: native sub-issues, the epic-dag fence, and dependency edges.
- **[Hands-off epics](/hands-off-epics/)** — the automation settings that let an
  epic drain end-to-end, and what still stops it.
- **[Configuration](/reference/configuration/)** — every environment variable.
- **[Concepts & glossary](/reference/glossary/)** — the terms Shepherd uses.
- **[Plugins](/reference/plugins/)** — extend Shepherd with server-side spawn
  hooks, routes, and UI.
- **[External Task API](/reference/external-task-api/)** — queue work over HTTP.
- **[Security](/reference/security/)** — the sandbox membrane and egress firewall.

## Acknowledgements

Shepherd is built on [herdr](https://herdr.dev), the agent multiplexer by
[Can Celik](https://github.com/ogulcancelik) — it owns the real interactive PTYs
that every Shepherd session runs in, and without it this whole project wouldn't
be possible. Thank you, Can.
