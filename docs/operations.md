# Running and using Shepherd

[← Shepherd](../README.md) · [Install](getting-started.md) · [Configuration](configuration.md) · [Operations](operations.md) · [Development](development.md)

Commands use the repository root as the working directory unless noted otherwise.

[Deployment](#deployment) · [Sharing a repo's queue across people](#sharing-a-repos-queue-across-people)

## Deployment

Shepherd runs as a **systemd user service** (as your own user, so it keeps your `claude`
subscription login, `~/Work`, and herdr). It binds to **loopback only**
(`SHEPHERD_HOST=127.0.0.1`); reach it over the network by putting it behind a trusted proxy —
e.g. Tailscale:

```bash
tailscale serve --bg 7330        # → https://<host>.<tailnet>.ts.net proxies to 127.0.0.1:7330
```

Add the public hostname to `SHEPHERD_ALLOWED_HOSTS` (the unit ships with the Tailscale name).
Access control is layered: the trusted proxy/tailnet admits the device, then Shepherd requires the
single-operator password and stores browser access in a signed session cookie. Set
`SHEPHERD_PASSWORD` in `~/.shepherd/env`, or use the first-boot generated password from the server
log; machine clients can use `SHEPHERD_TOKEN` as a bearer alternative.

### herdr server lifecycle & "Update Herd"

Shepherd drives herdr but **does not own the herdr server's lifecycle** — the daemon is
normally auto-spawned on demand by any `herdr` CLI call. **"Update Herd"** swaps the herdr
binary (`herdr update --handoff`), which stops the running server for the swap. Afterwards
Shepherd makes a best-effort attempt to bring it back: it runs `herdr agent list` (which
auto-spawns the daemon) with a short grace+retry, and only if that still fails does it
relaunch a detached server so orphaned panes reattach.

If you run the herdr **server** under your own systemd unit, use **`Restart=always`**, not
`Restart=on-failure`. The stop during an update is a _clean_ exit (status 0), which
`Restart=on-failure` does **not** treat as a restart trigger — so the server would stay down
after "Update Herd", leaving a stale `~/.config/herdr/herdr.sock` and clients looping on
`ConnectionRefused`. `Restart=always` survives that clean stop and is the durable fix;
Shepherd's post-update recovery above is a subordinate best-effort belt (its relaunched
server is a child of Shepherd's cgroup and is not durable across a `systemctl restart
shepherd`).

### Host tuning — tmpfs inodes

Shepherd keeps spawned agents' Node compile cache **off** the `/tmp` tmpfs (it points
`NODE_COMPILE_CACHE` at a disk dir) and runs an inode-guard sweep on **startup + daily** that, once
a temp root crosses a pressure threshold, drops the compile cache and stale regenerable tool caches
(bunx / fallow / agent-browser / leftover browser profiles) — but never a live session's scratch,
which is reclaimed on archival instead. So a long-lived host doesn't ENOSPC on inodes (with bytes
to spare).

Pressure is measured **per temp root**, and by two different signals. Where the filesystem caps
inodes (tmpfs, ext4) it is the inode use percentage. Where it allocates them on demand (btrfs, XFS,
ZFS) there is no percentage to read, so Shepherd counts how many leftover top-level entries have
piled up in that root instead and acts at `SHEPHERD_TMP_ENTRY_LIMIT`. Per-root matters because an
entry count is specific to a directory: since agents were pointed at a disk-backed `TMPDIR`, the
session-scratch root and the bare agent temp root beside it fill at completely different rates, and
a single reading taken off one says nothing about the other.

The in-app guard bounds Shepherd's _own_ churn; as a host-level belt, raise `/tmp`'s `nr_inodes` in
`/etc/fstab` on long-uptime hosts (e.g. `tmpfs /tmp tmpfs nr_inodes=4194304 0 0`) so a higher inode
ceiling protects against any tmpfs consumer.

Settings → Diagnose carries a **Temp filesystem inodes** row so this is visible before it bites:
inode exhaustion otherwise reads as "disk full" while `df -h` shows plenty free (`df -i` is what
shows it). It reports the worst root in whichever signal that root supports — ranked by the state
each would classify to, so a healthy tmpfs can never mask a disk root that is already past the band
where the sweeper acts. It measures the roots a sweep can actually **reclaim** (the bare agent temp
root and the tmpfs), deliberately not the session-scratch roots: those hold live sessions' scratch,
which is reclaimed at archival and which the row's Fix cannot touch, so counting them would raise an
alarm no action could clear. On the percentage signal the row warns at `SHEPHERD_TMP_INODE_PCT` — the same threshold
that gates the sweep, so raising the knob moves both — and errors at 95%; on the entry-count signal
it warns at `SHEPHERD_TMP_ENTRY_LIMIT` and errors at ten times that, with copy of its own (a
filesystem with no inode table cannot meaningfully have "plenty of inodes free"). The row's
percentage bands are kept ordered and in range: a
knob above 95 raises the error band with it (so the row never alarms below the line you set), and a
value outside `(0, 100]` — including the legitimate `0` "always sweep" gate setting, which as a
display band would mean "always warn" — falls back to 80 for the row only; the sweep itself still
honours it. Its one-click fix runs the sweep immediately,
ignoring the threshold; it reclaims the caches Shepherd owns, so the row can legitimately stay
non-OK afterwards when the pressure is a package-manager store or a leftover worktree an agent left
in the temp filesystem (not reclaimed yet).

Override env vars: `SHEPHERD_NODE_COMPILE_CACHE` (compile-cache dir), `SHEPHERD_TMP_INODE_PCT`
(sweep threshold % **and** the Diagnose row's warning band, default `80`),
`SHEPHERD_TMP_ENTRY_LIMIT` (the same pair for the entry-count signal, used where the filesystem has
no inode ceiling, default `1000`), `SHEPHERD_TMP_STALE_HOURS` (scratch staleness cutoff, default
`24`), `SHEPHERD_TMP_SWEEP_DIR` (override the swept tmp root).

### Live preview

When an agent's dev server is listening in its worktree, a **Preview** badge appears on its herd
row. Clicking it opens the running app in an in-HUD Preview pane, reachable from desktop or phone
through Tailscale. Shepherd detects the port automatically (frontend servers like Vite/SvelteKit
take priority) and proxies HTTP and WebSocket (HMR) traffic through a dedicated loopback listener.
Shepherd never starts or stops the agent's dev server — it is detect-and-proxy only.

**Declaring the preview port explicitly:** A project or agent can drop a file named `.shepherd-preview`
in the repo/worktree root containing a single bare port number (e.g. `3000`). Shepherd uses it
only when that port is actually listening and answers HTTP — a stale or wrong hint self-heals by
falling back to automatic detection. Useful for multi-listener apps or apps on uncommon ports. The
file is optional; Shepherd is detect-and-proxy only regardless.

**Routing: one port per agent, distinct origin.** Each preview is served on its own port
(`SHEPHERD_PREVIEW_PORT_BASE`..+`COUNT`) via `tailscale serve`. Because each preview is a distinct
web origin (`https://host.ts.net:8001` ≠ `https://host.ts.net:8002` ≠ the HUD at `:443`), the
agent's own app fetches (reads, writes, storage, HMR) are same-origin and work without any path
rewriting. The HUD's origin check rejects preview-port origins for state-changing requests, so a
previewed app cannot forge `/api` calls.

**Tailscale exposure is automatic and dynamic** (default on — `SHEPHERD_PREVIEW_AUTO_SERVE`, set `0`
to opt out). As each preview listener binds a slot, Shepherd registers a
`tailscale serve --bg --https=<port> 127.0.0.1:<port>` mapping for it and removes it on teardown —
zero operator setup, and only in-use ports are exposed. Stale mappings are cleared at startup and on
shutdown. Prerequisites: tailnet HTTPS certificates enabled, and the service's user set as the
Tailscale operator (`tailscale set --operator=$USER`) so it can run `tailscale serve` without sudo.
When the node's tailnet host can't be resolved (tailscale absent/down), Shepherd skips registration
and logs a warning — previews still work on loopback.

To map the range manually instead, set `SHEPHERD_PREVIEW_AUTO_SERVE=0` and run the loop once:

```bash
for p in $(seq 8001 8016); do tailscale serve --bg --https=$p 127.0.0.1:$p; done
```

> **Funnel vs Serve:** the 443/8443/10000 port restriction applies to **Funnel** only. `tailscale serve`
> (tailnet-internal) accepts arbitrary HTTPS ports — the snippet above uses that.
> **Never add the preview slot range (8001–8016) to a Tailscale Service's advertised port list.**
> A Service requires every member host to advertise all listed ports; ephemeral preview ports
> would silently drop the node from rotation and take the HUD down.

**Split-front / `previewHost`:** the preview iframe URL is built from the **agent node's own
tailnet hostname** (server-reported `previewHost`), not the operator's connection host. This means
the preview works when the HUD is fronted under a different Tailscale identity than the agent node
— e.g. a Tailscale Service `svc:shepherd` at `:443` while agents run on `agentnode`. The slot is
served at the node, so the iframe correctly targets `https://agentnode.<tailnet>.ts.net:<port>`
rather than the Service address. On localhost dev and single-host tailnets behavior is unchanged.

**Scope / precondition:** the operator's browser must be on the tailnet, and tailnet ACLs must
permit operator→agent-node traffic on the slot ports. This does **not** help a Funnel /
public-fronted HUD — the agent node's MagicDNS hostname is unresolvable off-tailnet.

**Startup validation:** Shepherd hard-fails at startup if the configured preview range overlaps the
HUD's local listen port (`SHEPHERD_PORT`, default 7330) or its public served port (443). Choose a
range that does not conflict.

**Security:** previews run on a distinct origin, behind the same Tailscale gate. The `checkOrigin`
guard explicitly rejects any request origin whose port falls in the preview range, even when the
hostname is allowlisted — closing the blind-mutation vector. The preview `<iframe>` is sandboxed
`allow-same-origin allow-scripts …` (everything the app needs to run) but withholds every
`allow-top-navigation*` token, so untrusted agent JS can't redirect the operator's HUD tab.
Residual: cookies are host-scoped (shared across ports on one host), so a same-host preview can make
the browser attach the HUD session cookie to requests. The cookie is `HttpOnly`/`SameSite=Strict` and
the HUD rejects preview-range origins for writes, but full per-origin cookie isolation is tracked in
[#398](https://github.com/erwins-enkel/shepherd/issues/398).

**Caveats:**

- **Blank pane?** With auto-registration on (the default), a failed `tailscale serve` registration
  shows a degraded (amber) Preview badge and a note in the pane — the app is still reachable on
  loopback, so use the **Open in new tab** link. (With `SHEPHERD_PREVIEW_AUTO_SERVE=0`, ensure the
  port is mapped manually.)
- **App refuses to frame?** Some apps emit a `frame-ancestors` CSP via an in-HTML `<meta>` tag
  (SvelteKit can do this); response-header stripping cannot remove it. Use the **Open in new tab**
  link — safe because the preview runs on its own origin, not the HUD's.
- **HMR not updating?** Some dev servers (e.g. Vite) hardcode the HMR WebSocket port. Set
  `hmr.clientPort` in the app's Vite config to the preview port Shepherd assigned. Page-load and
  manual refresh always work regardless.

**Follow-ups:** multi-port apps (#396), idle-stop (#399), subdomain/full isolation (#398).

Install the unit (`deploy/shepherd.service`):

```bash
mkdir -p ~/.config/systemd/user
cp deploy/shepherd.service ~/.config/systemd/user/
loginctl enable-linger "$USER"          # start at boot without an active login
systemctl --user daemon-reload
systemctl --user enable --now shepherd
```

Operate it:

```bash
systemctl --user status shepherd
journalctl --user -u shepherd -f        # unit lifecycle; app log: ~/.shepherd/shepherd.log
```

### Shipping a code change

The unit runs straight from the working tree, so **whatever is checked out is what runs**. To
deploy local changes in one shot (install deps → build UI → restart → health check):

```bash
bun run update          # deploy the current working tree (warns if dirty / off main)
bun run update --pull   # fast-forward main from origin first (skip on a dev==prod box)
```

It's idempotent and safe to re-run — sessions survive the restart (herdr owns the PTYs). UI-only
changes don't strictly need it: a fresh `cd ui && bun run build` is served on the next request,
since the core reads `ui/build` from disk per request.

Per-deployment overrides (token, repo root, alternate hosts) go in `~/.shepherd/env`
(`KEY=value` lines), read by the unit if present.

## Sharing a repo's queue across people

Several people can drive the same repo's auto-drain queue together, each on their own Claude
subscription. This is the multi-person form of the [interactive-session model](development.md#tos-compliance-model) — not one shared account but N
independent single-operator instances, each running against its own `~/.claude` login (no token
relay, no impersonation). The shared git-host repo is the only thing in common; the `shepherd:active`
label keeps two instances off the same issue.

How the work splits: each instance drains greedily up to its own `maxAuto` and `usageCeilingPct`,
claiming issues first-come by polling timing (whoever pumps first stamps `shepherd:active` first).
It is not a capacity-weighted load balancer — below the ceiling, issues split by when each instance
happens to poll, not by who has more headroom. `usageCeilingPct` is a hard per-operator stop: an
instance that hits its ceiling stops spawning and leaves the rest to the others. So "Patrick is at
80%, Kai isn't" just means Patrick's ceiling stops his instance (or he turns auto-drain off) and
Kai's keeps pulling up to Kai's own ceiling — nobody lends capacity.

Setup, per person:

1. Run your own instance logged into your own `~/.claude`.
2. Use a separate `~/.claude` login (in practice: a separate machine or `HOME`). Usage is scraped
   locally from `~/.claude` (`src/usage.ts`), so two instances sharing one login see the same usage
   and their ceilings move in lockstep — the per-person hand-off then doesn't work.
3. Register the same repo with auto-drain on and the same `autoLabel` (default `shepherd:auto`),
   pointed at the shared git host (see [Git host integration](configuration.md#git-host-integration)).
4. Set your own `usageCeilingPct` and `maxAuto`.

Done for the day? Turn auto-drain off (or shut the machine down) and your instance pulls nothing.

Known edge: if two instances grab the exact same issue in the same instant — before either claim is
visible to the other — both can spawn against it (two PRs; a human closes one). A pre-spawn re-check
narrows this to the truly-simultaneous case but does not eliminate it.
