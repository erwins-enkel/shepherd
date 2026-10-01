# Shepherd for iOS

The iOS 18 application uses `ShepherdAppCore` and `ShepherdKit`. It registers only
the shared Sidebar, Detail, Herd, Plan, Queues, Merge and recap models. Profiles,
login, activation generations and the single event connection remain owned by
`AppModel`. `IOSTerminalController` owns presentations around the shared PTY state
machine and retains selected Done sessions until navigation leaves them. Session detail
opens on Terminal, with Activity and Info (including the complete prompt) on
separate tabs. The iOS SwiftTerm renderer is pinned to 1.20.0, like the Mac app.
Terminal font size is a per-device setting; the surrounding chrome, metadata and
activity use Dynamic Type. Merge and session mutation remain outside this stage.

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

The app also creates tasks through the native composer.

The amber **+ New** action follows Repos in the iPhone bottom bar and follows the
lenses in the iPad top strip. It opens the composer sheet through `IOSComposer.open`.
Its visible and VoiceOver labels reuse the web's localized new-task strings. The
action is hidden during isolated live read-only runs and disabled without a store.
The session-list composer UI tests activate a reserved fixture profile, intercept
its HTTP requests, and tap the same production action; no debug-only button is used.

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

Install the repository's Swift 6.2+ Xcode toolchain and XcodeGen 2.46+. SwiftTerm
1.20.0 also compiles Metal shaders; Xcode installations with optional toolchain
components need `xcodebuild -downloadComponent MetalToolchain` once. From the
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

Reply opens a multiline sheet explicitly and sends through the shared model's
existing `POST /api/sessions/{id}/reply` route. The bottom key bar matches the web
palette: Esc and Enter stay pinned, with arrows, Tab, Space and Ctrl-A/E/U/C/D in
the scrolling middle. Controls require a live, visible, foreground attachment.
Failures preserve the draft; a reply completing after scene suspension cannot
dismiss a fresh sheet. Drafts belong to the shared per-session model.

Normal launches permit terminal input and replies. Isolated launches still disable
input, including emulator protocol replies, and install the read-only request
audit. No new server API or Mac terminal behaviour is introduced. File attachment,
dictation, saved steer chips, diff/files/preview tabs and phone session swipes remain
outside this stream.

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
Info text. Info fixtures use the same field layout without UIKit-backed scrolling
or text selection. These fixtures are visual layout evidence, not a live-server check.

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

## Task composer and dictation

`RootView` presents `IOSComposeSheet` for `app.sheet = .newSession`. The session-list
action opens it through `IOSComposer.open(app)`. Normal launches permit task creation;
isolated live launches retain the read-only audit. The debug-only
`-ShepherdComposeFixture 1` launch flag is honored only with `-ShepherdIsolated 1`,
and uses a client-local fake transport and microphone. Adding
`-ShepherdSessionListFixture 1` instead starts the real session list with a reserved
fixture profile and HTTP interception. `-ShepherdReadOnlyFixture 1` retains the audit
to verify that the production new-task action is absent.

The composer reuses `ComposeModel`, repository/branch selection, issue filters,
commands, attachments, readiness and `ComposeSubmission`. It offers Code, Research,
Epic and Plain, engine/model/effort/capacity, plan gate, autopilot and sandbox controls.
Photos, files and pasted images upload before Start can become available. Starting a
task is explicit; dictation never submits it. Draft restoration and press-and-hold on
the + NEU button are follow-ups.

Hold the microphone to dictate, release to keep text, slide left to discard, or slide
up to continue hands-free. Stop/Done finalizes a locked recording. Accessibility
activation toggles recording without holding. Language is DE/EN and persists per
device. Dictation appends to the prompt, with a five-second Undo action. Locked speech
checkpoints preserve finalized Apple text while the recording continues.

One `AVAudioEngine` tap feeds the Apple preview, level meter and an in-memory WAV
encoder matching web `wav.ts`: 16 kHz, mono, 16-bit PCM. Clips roll over before 55 seconds,
below the optional plugin's 60-second bound; recordings stop at five minutes. No audio
files or background recording are used. Interruptions and route/format changes end
the recording and retain recognized text; recording never resumes automatically.

`GET /api/plugins` discovers `voice-whisper`. When available, its status and multipart
transcription routes provide final text; final uploads omit `mode`. During the
“Transcribing…” state the server text replaces Apple's preview. A failed clip uses its
Apple text, and a 25-second overall finalization deadline retains the latest Apple
result. Late replies cannot mutate a dismissed composer or another recording. Plugin
response schemas document only the web client's expectations: the plugin implementation
is not vendored here. The core listing and routing are covered by real-server ajv tests
with a fixture plugin; the native client is covered by a fake transport.

Microphone permission is always required. Speech permission is requested only for
Apple recognition. iOS 26 selects `SpeechAnalyzer` when supported; iOS 18–25 uses
`SFSpeechRecognizer` with punctuation and on-device recognition where available. Apple
server recognition requires a separate persisted consent. If Apple permission is
refused but Whisper is available, capture can still produce a server transcript.
Permission descriptions are generated from the EN/DE catalogs into app-local
`InfoPlist.strings`; run `native/scripts/gen-strings.sh` after changing them.

On the shared development machine, compile and test this worktree only through
`~/.claude/projects/-Users-kai-osthoff-githubrepos-shepherd/tools/ios-shared-build.sh
<worktree> build|test`. Pass both isolation environment spellings for hosted tests.
`IOSComposeTests` renders fixture states with `ImageRenderer`; SwiftUI rendering
substitutions reuse the production layout for UIKit-backed controls. Real-device
acceptance (iOS 18/26, DE/EN, AirPods, incoming call, offline and three-minute recording)
is tracked in the draft PR checklist.
