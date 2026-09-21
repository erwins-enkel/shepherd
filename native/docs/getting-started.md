# Get started with Shepherd for Mac

[← Shepherd for Mac](../README.md) · [Get started](getting-started.md) · [Development](development.md) · [Screenshots](screenshots.md)

Run commands from the repository root.

[Prerequisites](#prerequisites) · [Build and connect](#build-and-connect) · [Build](#build) · [Run](#run) · [Find your way around](#find-your-way-around)

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

4. Build and run:

   ```
   native/scripts/build-app.sh Release
   open native/Apps/ShepherdMac/.build/Build/Products/Release/Shepherd.app
   ```

   See [Build](#build) and [Run](#run).

5. Connect to a server. On first launch the app offers two ways in:
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
     A server already answering locally is shown with its reported install and database paths.
     Older servers that do not report paths are explicitly marked unknown. Choose **Keep using
     this server** before connecting; a changed identity or a failed recheck clears that choice.
     To stop an external server, use the terminal or service manager that started it, then
     **Recheck**. Only an app-owned child with matching launch identity gets Stop and Restart.
     The native supervisor supplies ephemeral local-health metadata only on loopback; ordinary
     server health responses do not disclose install or database paths.
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

## Find your way around

1. Select a session in the sidebar. Use the repo and state filters to focus the list.
2. Read **Activity** to see what the agent has been doing, then inspect **Diff** or **Files**
   for the changes and their context.
3. Open **Terminal** to follow the live session or send the agent a message.
4. Check **Pull request** for the PR state, checks and available actions.
5. Start another task with the new-task sheet: choose the repo, base branch, agent and model,
   then describe the work.

The [screenshot tour](screenshots.md) shows these views with real sessions. For workflows not yet
available in the app, open the web UI of the same Shepherd server. To work on the app itself,
continue with the [development guide](development.md).

## Install a tester release

Download the DMG from the [Mac releases](https://github.com/erwins-enkel/shepherd/releases?q=macos-),
open it, and drag Shepherd.app into Applications. Open Shepherd from Applications, then eject
the image. A direct launch from the image or Downloads also offers to install the app, with
an option for your account only. See [first installation and updates](app-updates.md#first-installation)
for existing installations and the ad-hoc beta's Gatekeeper limitations.
