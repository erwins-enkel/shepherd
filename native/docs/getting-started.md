# Get started with Shepherd for Mac

[← Shepherd for Mac](../README.md) · [Get started](getting-started.md) · [Development](development.md) · [Screenshots](screenshots.md)

Run commands from the repository root.

[Prerequisites](#prerequisites) · [Build and connect](#build-and-connect) · [Build](#build) · [Run](#run) · [Reach the local server from your tailnet](#reach-the-local-server-from-your-tailnet) · [Find your way around](#find-your-way-around)

## Prerequisites

- macOS 15 or newer
- A Shepherd server on your Mac or a remote machine — see [server setup](../../docs/getting-started.md).

- Xcode 26.6 or newer (`xcodebuild -version`)
- `brew install xcodegen`
- [`bun`](https://bun.sh) (generates the string catalog and runs the sync/contract scripts)

## Build and connect

1. Clone the repo (or fork it if you want to contribute). Then, from the repo root:

   ```
   bun install
   ```

   Root's `bun` install is required even though this package is Swift — the string-catalog
   generator (`native/scripts/gen-strings.ts`) and the contract scripts
   (`bun run gen:contract-swift`, `bun run check:contract-swift`, `bun run test:contract`) are
   TypeScript, run from the repo root. You also need Xcode 26.6+ and `xcodegen` — see
   [Prerequisites](#prerequisites).

2. First build only: SwiftTerm (see the `SwiftTerm` package dependency in
   `Apps/ShepherdMac/project.yml`) needs Metal to compile its shaders. If a fresh Xcode 26
   install has not downloaded that component yet, the first build fails complaining about a
   missing Metal toolchain. If that happens, run:

   ```
   xcodebuild -downloadComponent MetalToolchain
   ```

   then re-run the build.

3. Optional but recommended, once per machine:

   ```
   native/scripts/dev-signing-identity.sh
   ```

   Without it, every local build is ad-hoc signed and every rebuild is a new signer as far as
   the Keychain is concerned — macOS re-prompts for Keychain access on each rebuild, and an
   unattended run falls back to the login sheet after an 8 s timeout. See
   [Local code signing (stable Keychain access)](development.md#local-code-signing-stable-keychain-access) for
   why, and what the script does.

4. Optional, once per Mac, if you run the UI tests — in an administrator's Terminal:

   ```
   automationmodetool enable-automationmode-without-authentication
   ```

   Without it, macOS asks for UI Automation authentication again after about 8 hours, and
   `native/scripts/test-app.sh` stops a run with UI tests before it builds rather than wait on
   that dialog. See [UI Automation mode](development.md#ui-automation-mode) for the status check,
   the scope and how to revert it.

5. Build and run:

   ```
   native/scripts/build-app.sh Release
   open native/Apps/ShepherdMac/.build/Build/Products/Release/Shepherd.app
   ```

   See [Build](#build) and [Run](#run).

6. Connect to a server. On first launch the app offers two ways in:
   - **Run on this Mac** — choose **Install and start** for a cold install. The app downloads
     the official HTTPS bootstrap when no checkout installer exists, shows its progress in
     the log, then starts the installed server. The bootstrap provisions Bun and checks its
     prerequisites; Bun does not need to be installed before choosing this action.
     The default install directory is `~/.shepherd/app`. `SHEPHERD_DIR` and `SHEPHERD_DB`
     from the process environment, overlaid by `~/.shepherd/env`, select another install or
     database. `SHEPHERD_PORT` selects the local endpoint for health checks and sign-in;
     a different port gets its own saved profile and credential. HOME remains your home
     directory; `SHEPHERD_REF` is preserved. These settings
     are resolved when the app's local supervisor is created, so relaunch after changing them.
     When closing the window or quitting, choose whether to keep the local backend running
     or stop it too. Update relaunches and dev rebuilds leave the server and sessions running.
     The next launch adopts the recorded server when its live pid, process group and health
     identity match. **Stop** and **Restart** explicitly
     stop the server; a generated password is offered only for a new boot in this app run.
     A foreign server already answering locally is shown with its reported install and database paths.
     Older servers that do not report paths are explicitly marked unknown. Choose **Keep using
     this server** before connecting; a changed identity or a failed recheck clears that choice.
     To stop an external server, use the terminal or service manager that started it, then
     **Recheck**. Only an app-managed server with matching ownership and identity gets Stop and Restart.
     The native supervisor supplies ephemeral local-health metadata only to direct loopback
     requests; ordinary server health responses, and any request forwarded by `tailscale serve` or
     another proxy, do not disclose install or database paths.
   - **A remote profile** — the server URL must be `https`, or `http` to loopback or a
     `.ts.net` (Tailscale) name; anything else is rejected. Enter the operator password once —
     the app signs in and mints its own access token, which it stores itself rather than
     reusing the password.

## Build

```
native/scripts/build-app.sh Release
```

Produces `native/Apps/ShepherdMac/.build/Build/Products/Release/Shepherd.app`.

## Run

```
open native/Apps/ShepherdMac/.build/Build/Products/Release/Shepherd.app
```

## Reach the local server from your tailnet

Off by default, the app's local server answers only on `127.0.0.1`. To let another Shepherd — for
example the Linux coordinator — reach it, turn on **Reachable in your tailnet** in the local-server
panel (Welcome, or **Settings → Local server**).

**What the switch does.** It runs
`tailscale serve --bg --yes --https=<port> http://127.0.0.1:<port>`, where `<port>` is
`SHEPHERD_PORT` (default 7330). Tailscale terminates HTTPS at this Mac's MagicDNS name and forwards
to the loopback listener. The server keeps binding loopback only (`SHEPHERD_HOST=127.0.0.1`) and is
not restarted, so loopback keeps working throughout. The agent-ingress port is never served.
Turning the switch off runs `tailscale serve --yes --https=<port> off`. The switch shows the serve
configuration as it is; `--bg` mappings survive reboots and app quits, the same as the server.

**Requirements.** The switch is disabled, with the reason and **Recheck**, when one is missing:

- **Tailscale CLI:** `tailscale` on the app's search path (Homebrew, or the **CLI integration** in
  Tailscale's settings), or the Tailscale.app bundle in `/Applications`.
- **Connection:** Tailscale signed in and connected.
- **HTTPS:** MagicDNS and HTTPS Certificates on, on the DNS page of the Tailscale admin console.
  Without them `tailscale serve` waits for consent instead of serving.
- **Free port:** no other serve mapping on the same HTTPS port. The app never overwrites one.

**Connecting the other Shepherd.** With the switch on, the panel shows the URL
(`https://<mac>.<tailnet>.ts.net:<port>`) to enter under **Settings → Machines** on the other
Shepherd, and **Create access token…**. That opens **Settings → Access** when the app is connected
to this local server, and this server's web UI otherwise, so the token is never minted on a
different server. Create a token with **Full access** for all repositories. A Full token lets the
other Shepherd do everything you can do here — start agents, steer sessions and their live
terminals, administer this Shepherd — so connect only a Shepherd you control. Revoke the token
under **Settings → Access** to cut the connection.

**What stays protected.** Apart from signing in, `GET /api/health` is the only API route that answers
without the password or a token, and for a forwarded request it never includes this Mac's install or
database paths.

**Mappings made outside the app.** If you already serve this port yourself (for example
`tailscale serve --bg 7330` on 443), the panel lists that address under "Also reachable through…"
and the switch never removes it.

**Signing in from a browser over the tailnet URL.** The server trusts its own tailnet name as a
browser origin only when it finds `tailscale` on its `PATH` at startup (Homebrew or the CLI
integration). With only the app bundle installed, set
`SHEPHERD_ALLOWED_HOSTS=localhost,127.0.0.1,::1,[::1],<mac>.<tailnet>.ts.net` in `~/.shepherd/env`
(the value replaces the loopback defaults, so keep them) and restart. Calls without a browser
origin, such as another Shepherd's server or `curl`, are unaffected.

**Two-machine test from a branch checkout.** A released install does not know endpoints still in
review, so run the branch on the Mac:

1. Check the branch out in its own worktree, then install and build it:

   ```
   git worktree add ~/shepherd-branch <branch>
   cd ~/shepherd-branch && bun install && (cd ui && bun install && bun run build)
   ```

2. **Stop** the running server in the panel first. Once `SHEPHERD_DIR` changes, the app treats a
   server from the old directory as someone else's and no longer offers Stop.
3. Point the app at the checkout in `~/.shepherd/env`. The file is read as plain data, so use
   absolute paths. A separate database and herdr session keep the branch away from your real
   sessions and state:

   ```
   SHEPHERD_DIR=/Users/<you>/shepherd-branch
   SHEPHERD_DB=/Users/<you>/.shepherd/branch.db
   HERDR_SESSION=branch
   ```

4. Quit and reopen the app (these settings are read at launch), choose **Start** and turn on
   **Reachable in your tailnet**. A fresh database starts with first-run setup and offers a new
   generated password; mint the token for the other Shepherd on this server.
5. From the other machine, check that health answers and that authentication is enforced:

   ```
   curl -s https://<mac>.<tailnet>.ts.net:7330/api/health
   curl -s -o /dev/null -w '%{http_code}\n' https://<mac>.<tailnet>.ts.net:7330/api/sessions   # 401
   curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer <token>' \
     https://<mac>.<tailnet>.ts.net:7330/api/sessions                                    # 200
   ```

Do not apply the panel's backend update to a branch checkout: it updates toward `main`. To return
to the installed server, **Stop**, remove the three lines from `~/.shepherd/env`, relaunch the app
and choose **Start**.

## Find your way around

1. Select a session in the sidebar. Use the repo and state filters to focus the list.
2. Read **Activity** to see what the agent has been doing, then inspect **Diff** or **Files**
   for the changes and their context.
3. Open **Terminal** to follow the live session or send the agent a message.
4. Open **Pre-execution plan** to answer or approve a plan gate. Check **PR** for the pull
   request's state, checks and review requests, and **Merge & automation** for auto-merge and
   autopilot.
5. Start another task with the new-task sheet: start from an issue or describe the work, then
   choose the repo, base branch, agent and model.
6. Keep an eye on held tasks, Up Next and the Done panel to see what is waiting, what runs next
   and what has finished.

The [screenshot tour](screenshots.md) shows these views with real sessions. For the backlog and epic
management, open the web UI of the same Shepherd server. To work on the app itself,
continue with the [development guide](development.md).

## Install a tester release

Download the DMG from the [Mac releases](https://github.com/erwins-enkel/shepherd/releases?q=macos-),
open it, and drag Shepherd.app into Applications. Open Shepherd from Applications, then eject
the image. A direct launch from the image or Downloads also offers to install the app, with
an option for your account only. See [first installation and updates](app-updates.md#first-installation)
for existing installations. Releases are signed with Developer ID and notarized by Apple.
