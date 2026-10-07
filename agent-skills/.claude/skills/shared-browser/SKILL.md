---
name: shared-browser
description: How to drive the operator's logged-in Shared Browser for this repo over `agent-browser`. Applies only when `$SHEPHERD_BROWSER_CONFIG` is set. Load when you need a logged-in browser, need to test the app in a real browser, or hit a login wall.
---

# Shared Browser

Shepherd runs one real Chromium per repo on its host, with a persistent profile the operator logs
in to. Sessions on this repo can drive it through a Shepherd-brokered CDP WebSocket. Its URL sits in
an `agent-browser` config file whose path is in `$SHEPHERD_BROWSER_CONFIG`.

## 1. Check it is available

```bash
[ -n "$SHEPHERD_BROWSER_CONFIG" ] && [ -r "$SHEPHERD_BROWSER_CONFIG" ] && echo available || echo unavailable
```

Unavailable means this session has no Shared Browser. The operator's logins live only in that
profile, so a Chrome you launch yourself starts logged out: use one for logged-out work, and ask
the operator when a task needs their logins.

## 2. Open your own tab

Pick one `agent-browser` session name and pass it, together with
`--config "$SHEPHERD_BROWSER_CONFIG"`, on every command (shell state does not carry
between commands, so write it out each time). Get a stable one with:

```bash
agent-browser session id --scope worktree --prefix shared-browser
```

Then, with `<session>` being that name:

```bash
agent-browser --session <session> --config "$SHEPHERD_BROWSER_CONFIG" tab new --label mine http://localhost:<devPort>
```

The config makes `agent-browser` attach to the Shared Browser itself, so no `connect` step is
needed. Work in your `mine` tab (`snapshot`, `click`, `open`, …, all with the same `--session` and
`--config`). When you are done, close only that tab:
`agent-browser --session <session> --config "$SHEPHERD_BROWSER_CONFIG" tab close mine`. Leave the browser itself running, so skip
`agent-browser close` here.

Point the tab at the app's **real dev origin**, `http://localhost:<port>`: the port from
`.shepherd-preview` or the one your dev server printed. OAuth callbacks are registered for that
port, so the Shepherd preview slot URL breaks login flows.

## Autonomous sessions

An autonomous session gets a **confined** attach: its own browser window, separate from the
operator's tabs, which it cannot see. That window reaches only:

- the hosts in this repo's `browserAllowedHosts` (ports 80/443);
- this session's own Shepherd Preview, at `http://localhost:<previewPort>`. Use the preview port,
  not the raw dev port, which is refused.

Everything else fails with `net::ERR_SOCKS_CONNECTION_FAILED`. Do not retry it; tell the operator
which host you needed.

The window starts with only the operator's logins for those hosts. Logins you create there are
dropped when you disconnect.

## Etiquette

This is the operator's real browser, shared with every session on this repo. Treat it as a guest:

- work in tabs you opened; tabs you did not open belong to someone else and stay open;
- stay logged in: no logging out, no account-settings or password changes;
- leave cookies, storage and site data as you found them.

## Login wall

When a page needs a login, stop and ask the operator to log in: from anywhere through your
session's **Browser** tab in Shepherd, or at the Shepherd host via **Open shared browser** in the
repo settings. Name the tab or URL to sign in on. Once they confirm, reload your tab and continue.

## The config file is a secret

The file at `$SHEPHERD_BROWSER_CONFIG` holds a token that grants control of every login in the
profile. Pass it only by path to `--config`: never `cat`, print, copy or commit it, and keep its
contents out of output, logs, files and PR text.

## Errors

- Connection closed with code `1013` or a "cap" reason: too many Shared Browsers are open on the
  host. Tell the operator; retry after they close one.
- Connection closed with code `1008` and reason `no-login` (autonomous only): the profile holds
  no login for an allowlisted host. You cannot wait for one. Stop and tell the operator to log in
  via **Open shared browser** and, if needed, add the host to `browserAllowedHosts`.
- HTTP `403`: the Shared Browser is disabled for this repo. Tell the operator; they can enable it
  in the repo settings.
