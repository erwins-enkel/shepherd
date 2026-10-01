# Shepherd for iOS

The iOS 18 application uses `ShepherdAppCore` and `ShepherdKit`. It registers only
the shared Sidebar, Detail, Herd, Plan, Queues, Merge and recap models. Profiles,
login, activation generations and the single event connection remain owned by
`AppModel`. `TerminalController` adds the shared PTY state machine. Session detail
opens on Terminal, with Activity and Info (including the complete prompt) on
separate tabs. The iOS SwiftTerm renderer is pinned to 1.20.0, like the Mac app.
Terminal font size is a per-device setting; the surrounding chrome, metadata and
activity use Dynamic Type. Composition, merge and session mutation remain outside
this stage.

The session list defaults to **All**, with the web/Mac lifecycle groups and
collapsible headings. Shared native relevance ordering puts working and blocked
rows ahead of parked rows within a group, then uses latest server activity; it
never sorts by task designation. Ready uses `HerdPartition`'s operator-turn filter.
Next displays `UpNextPresentation`'s issue queue, Done displays the archived queue,
and Open displays outstanding post-merge records with the same repo-scoped count
as Mac. These panels remain read-only. Next consumes server snapshots and cannot
request a new computation from iOS; when none has arrived, its waiting message
explains how to compute one in web/Mac.

Cards map shared badges, recap/activity summaries and `HerdStepper` into flat dark
terminal panels with uncapped Dynamic Type, wrapping badges and VoiceOver summaries.
The list keeps Shepherd's default dark appearance. Titles preserve supplied emoji;
project configuration emoji and cold-resume estimates have no automatic shared
sidebar data path and are not inferred. Shared usage warnings are shown when known.

## Local simulator workflow

For the fast incremental dev loop, from the repository root:

```bash
native/scripts/uitest-lock.sh native/scripts/ios-dev.sh
# Optional destination (defaults shown):
native/scripts/uitest-lock.sh native/scripts/ios-dev.sh --device "iPhone 17 Pro" --os 26.5
```

This generates the Xcode project only when `project.yml` changes (or the project is
missing), reuses `Apps/ShepherdIOS/.build`, builds Debug, boots the selected simulator
if needed, then terminates, installs in place and launches. It never uninstalls the
app or erases the simulator, preserving saved servers and tokens. Simulator builds
explicitly use ad-hoc signing (`CODE_SIGNING_ALLOWED=YES CODE_SIGN_STYLE=Manual
CODE_SIGN_IDENTITY=-`): the project's unsigned CI default prevents Keychain token
storage in the simulator. Tests remain isolated and keep their existing CI defaults.
Xcode 27's simulator window is **DeviceHub.app**.

If Xcode 27 refuses to launch an unsigned unit-test host, use the same signature
without changing test isolation or CI defaults:

```bash
SHEPHERD_IOS_SIMULATOR_SIGNING=1 native/scripts/uitest-lock.sh native/scripts/test-ios-app.sh unit
```

Install the repository's Swift 6.2+ Xcode toolchain and XcodeGen 2.46+. From the
repository root, wrap each entire script once. Scripts never acquire another lock.

```bash
LOCK=/Users/kai.osthoff/.claude/projects/-Users-kai-osthoff-githubrepos-shepherd/tools/uitest-lock.sh
"$LOCK" native/scripts/build-ios-app.sh Debug
"$LOCK" native/scripts/test-ios-app.sh unit
"$LOCK" native/scripts/test-ios-app.sh ui --family iPhone
"$LOCK" native/scripts/test-ios-app.sh ui --family iPad
```

CI uses `native/scripts/uitest-lock.sh`. Tests select available iOS 18+ devices by
numeric runtime version, then name and UDID. The family selector refuses to replace
an unavailable family with another. A missing toolchain/device is an unmet gate.
`--result-bundle-path` accepts a fresh absolute path. The test script retains the
xcresult plus summary/tests JSON and requires every discovered test identity to
execute successfully; zero tests, missing cases, skips and malformed results fail.
Keep one top-level nonparameterized test suite per test source; changes to this
convention require an explicit expected inventory and validator coverage.

Automated launches pass `-ShepherdIsolated 1` and use private defaults and memory
credentials. Unit runners also receive both isolation environment spellings.
Neither local nor simulator CI enables Keychain tests. Native tests remain serialized
across worktrees; Mac authorization dialogs belong to #2434.

## Lifecycle and recovery

Temporary inactivity forwards presence through `SessionStore.setActive(false)`;
it does not stop and restart the store. Foreground entry refreshes session state and
visible activity. Current-store transitions to `.live` trigger another visible
activity refresh so a failed earlier attempt cannot leave the screen stale. No
background execution or timer is promised. Profile changes replace the activation
and invalidate old selections and detail tasks. The visible terminal attaches only
with an active scene and mounted renderer, and detaches on inactivity, background,
tab changes and navigation away. Foreground entry clears the emulator before the
new scrollback replay. The shared core handles reconnects and parked ownership/
ended states; its connecting overlay uses the same 400 ms debounce as Mac.

Output follows the tail until the operator scrolls into history (including with
VoiceOver); Latest output returns to the tail. Tapping output never opens a
keyboard or forwards touch gestures to the agent.

## Mobile web references and visual fixtures

`ui/src/routes/+page.svelte` changes `mobileScreen` from list to detail when a
session opens. `ui/src/lib/components/Viewport.svelte` defaults and resets its tab
to `term`, keeps activity separate, and places `SteerBar` and
`viewport/ViewportTermControls.svelte` below the output. `ActionBar.svelte` is the
list's New Task/Backlog bar, not the session's reply bar. The
`docs/design/mobile-herd/README.md` design concerns that list screen; detail uses
the live Viewport flow. iOS mirrors the terminal-first structure with three tabs
for the currently supported native surfaces.

`IOSTerminalTests.testRenderFixtureImages` renders the production detail chrome
with text fixture output via `ImageRenderer`. UIKit terminal rendering cannot be
captured by ImageRenderer; a separate renderer test feeds real SwiftTerm output
and verifies history retention. The fixture PNGs cover Terminal, Info and enlarged
Info text. These fixtures are visual layout evidence, not a live-server check.

## Live acceptance

Only `native/scripts/live-ios-smoke.sh --config
~/.config/shepherd/codex/live-smoke.json`, wrapped in the same native lock, may read
the operator-supplied live configuration. The harness accepts the existing
`base_url`/`operator_password` fields (and the equivalent `baseURL`/`password`
spellings); the file must be owned by the current user and have mode `0600`.
Ordinary CI never reads it. The live
harness owns one uniquely named token, records ownership before activation, performs
audited reads and verifies that the exact token receives HTTP 401 after revocation.
An empty server cannot pass the detail gate. Missing cleanup proof fails the run.
Do not print secrets, put them on command lines, upload live xcresults, or sweep
tokens by a shared name. Production sign-out only confirms local removal because
the current logout API does not reliably report remote revocation.

The harness creates a private `0700` run directory. The isolated app atomically
writes a `0600` handoff containing `runID`, `tokenID`, `token` and `baseURL` before
activation; UI/status records contain no token. The verifier checks run and origin
ownership, rejects redirects, revokes only that ID, then probes the authenticated
sessions route. Verified cleanup deletes the token handoff. Unverified cleanup
retains private evidence and reports an unmet gate with the nonsecret run ID.
Never publish those private diagnostics or xcresults as CI artifacts.

## Adaptive and Duo validation

The ordinary iPhone/iPad lanes verify the deployment-floor layout. Apple documents
the iPhone Duo simulator in Xcode 27.1 and Reserved Region APIs in iOS 27.1.
([Apple preparation guidance](https://developer.apple.com/videos/play/tech-talks/111461/))
The separate `DuoOuter` and `DuoInner` selectors require explicitly available
surface destinations. If installed simulator metadata does not expose them, the
lane fails as unmet; a generic iPhone run is not Duo evidence. DeviceHub surface
configuration and hardware keyboard/hinge validation must be recorded separately.
Preserve the size-class fallback on iOS 18.

Release distribution has separate signing inputs and gates; see
[TestFlight preparation](testflight-ios.md). No simulator test implies a signed
archive, tested hardware, uploaded build or approved external beta.
