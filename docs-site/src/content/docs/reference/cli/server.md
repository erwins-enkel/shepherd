---
title: "herdr server"
description: "Control the herdr server lifecycle (stop, reload config)."
---

Control the herdr server lifecycle (stop, reload config).

_Generated from live `herdr --help` — do not edit by hand; run `bun run gen:cli` to regenerate._ _(herdr 0.7.0.)_

```text
herdr server commands:
  herdr server                run as headless server
  herdr server stop           stop the running server via the API socket
  herdr server live-handoff   hand off live panes to a new local server
  herdr server reload-config  reload config.toml in the running server
  herdr server agent-manifests [--json]  show agent detection manifest status
  herdr server update-agent-manifests [--json]  fetch and reload agent detection manifests
  herdr server reload-agent-manifests  reload agent detection manifests in the running server
```
