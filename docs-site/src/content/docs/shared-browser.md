---
title: Shared browser
description: Log in once in a real browser on the Shepherd host and let that repo's agents continue in the same logged-in browser.
---

The **Shared Browser** is a real, headful Chromium running on the Shepherd host,
one per repo, with a persistent per-repo **Browser Profile** (cookies, storage,
logins). You log in to the app you're building, or any service it needs, once.
That repo's agents then drive the same browser and keep working as that
logged-in user when they test or confirm a change.

It is **off by default** and turned on per repo.

## Requirements

- **Chromium or Google Chrome on the Shepherd host.** Shepherd uses the first of
  `chromium`, `google-chrome-stable`, `google-chrome` or `chromium-browser` it
  finds on `PATH`; set `SHEPHERD_CHROMIUM_BIN` to point at another binary (see
  [Configuration](/reference/configuration/)). The **Diagnose** panel shows a
  **Chromium (shared browser)** row, which shows a warning when a repo has the
  Shared Browser on but no binary was found.
- **A desktop session on the host** only if you want to log in at the host
  itself. Logging in remotely from the HUD works without one.

## Turn it on

Open the repo's automation settings (the automation pill) and switch on
**Shared browser**. From the CLI:

```bash
shepherd repo-config set sharedBrowserEnabled true
```

The browser starts on demand: when you open it, when you open a session's
**Browser** tab, or when an agent attaches. It is stopped after **15 minutes**
with nothing attached, and at most **3** run on the host at once (opening
another stops the longest-idle one nothing is attached to, or is refused when
every one is in use). The profile lives under `~/.shepherd/browser-profiles/`
and survives those stops and Shepherd restarts, so your logins stay.

## What agents can see

:::caution[Every agent on the repo can read every login in its profile]
An attached agent drives the whole browser, not just its own tab. The isolation
boundary is the **per-repo profile**: agents on one repo never reach another
repo's logins, but every agent on a repo can read every login in that repo's
profile. Only log in with accounts you're willing to share with that repo's
agents.
:::

What keeps the rest of the host out:

- There is **no TCP debug port**. Chromium runs with `--remote-debugging-pipe`
  and agents reach it only through a per-session, token-gated connection that
  Shepherd brokers and can revoke.
- The broker forwards only what page automation needs. It refuses browser
  process control, extensions, file inputs, file choosers and non-web pages.
- Downloads land inside the profile, never in your `~/Downloads`.

The full posture and its accepted residuals are in
[Security → Shared browser](/reference/security/#shared-browser).

## Log in for your agents

Signing in inside the Shared Browser so an agent can continue as you is a
**Handoff Login**. There are three ways to do one.

### At the host

In the repo's automation settings, press **Open shared browser**. The window
opens on the host's desktop; log in there as you normally would.

### Remotely, from the HUD

Open a session on the repo and switch to its **Browser** tab (the Browser
View). It shows a live picture of the Shared Browser: click and type into it,
use the address bar, reload, or open a new tab. For passwords, use the
**Paste** field: the text is typed into the page's focused field and never
stored.

### When an agent asks

An agent that hits a login wall can ask you for a **Login Request**. It
opens the login page in the Shared Browser and waits. The session shows up as
needing you (_"Wants you to log in at …"_) with an **Open browser** button that
takes you straight to its Browser tab. Log in, then press **Done**, or
**Cancel** if you won't. Only you can answer a Login Request; an agent cannot
mark its own request done. Autonomous sessions can't make one.

## Autonomous sessions

An autonomous session gets a **confined** attach: its own browser window,
separate from your tabs, which it cannot see. That window reaches only:

- the hosts in the repo's **browser origin allowlist** (`browserAllowedHosts`:
  exact host names on ports 80/443, and only when they resolve to public
  addresses);
- the session's own **Preview** port on `localhost`;
- the dev server the session runs inside its own sandbox, at
  `http://localhost:<devPort>` — the port in its `.shepherd-preview` file,
  while that server is listening. Shepherd forwards it out of the sandbox, so
  the origin stays `localhost:<devPort>` and never reaches a different local
  service on that port. The server must listen on `127.0.0.1` or all
  interfaces; one bound only to `::1` is not reachable.

Everything else is refused: other local ports, private and Tailscale
addresses, IP literals. Set the allowlist with:

```bash
shepherd repo-config set browserAllowedHosts '["accounts.example.com"]'
```

At attach, the window is seeded with your existing logins **for those hosts
only**. With none, the attach is refused: an autonomous session can't wait for
a Handoff Login, so log in first. Known gaps: WebRTC traffic is not confined,
logins the confined window refreshes are not written back (a rotated session
cookie can log your own window out).

## Use the real dev origin

Agents should open the app at its real dev address,
`http://localhost:<devPort>`, not the Preview slot URL: OAuth callbacks are
registered for the real port, so login flows break on the Preview URL.
Autonomous sessions too: their dev port is forwarded once it is in
`.shepherd-preview`.
