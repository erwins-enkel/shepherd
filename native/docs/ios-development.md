# Shepherd for iOS

The iOS 18 application uses `ShepherdAppCore` and `ShepherdKit`. It registers only
the shared Sidebar, Detail, Herd, Plan, Queues, Merge and recap models. Profiles,
login, activation generations and the single event connection remain owned by
`AppModel`. `IOSTerminalController` owns presentations around the shared PTY state
machine and retains selected Done sessions until navigation leaves them. Session detail
opens on Terminal, with Activity and Info (including the complete prompt) on
separate tabs. The iOS SwiftTerm renderer is pinned to 1.20.0, like the Mac app.
Terminal font size is a per-device setting; the surrounding chrome, metadata and
activity use Dynamic Type. Sessions with a plan phase or gate also expose a Plan tab;
attention entries open it directly. See [plan decisions](ios-plan.md) for request ownership
and question/gate controls. Session actions and ready-PR merge use the shared models; see
[session actions](ios-session-actions.md) for placement, confirmation and parity limits.

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
VoiceOver); Latest output returns to the tail. When the agent tracks the mouse
(Claude Code's default), it repaints its own scrolled transcript, so a vertical
one-finger swipe becomes mouse-wheel input for the agent instead, with fling
momentum, as on the web and Mac. VoiceOver page scrolls take the same path, and
Latest output sends Ctrl+End. This needs a live attachment that permits input;
otherwise, and for agents without mouse tracking, the emulator's own history
scrolls. Tapping the bottom prompt area opens writing; tapping output while
writing dismisses the keyboard and preserves the draft.

At rest, a floating capsule contains Attach, an image-only system paste control,
scrolling saved steers, Keyboard and a 44-point hold-to-talk microphone. Keyboard
opens a one-to-five-line draft with Send inside, above a borderless accessory row
for Attach, Esc, Tab, Ctrl-C and arrows. The remaining keys stay in its menu.
Steers are hidden while writing; the keyboard button shows a dot for a retained
draft or attachments. Reply uses `IOSTerminalPresentation.submitReply` on the
existing `POST /api/sessions/{id}/reply` route.
Input requires a live, visible, foreground attachment. Sending disables editing and dictation; failures retain the
per-session draft. Dictation never sends. The reply microphone reuses the composer's
`HoldToTalkButton`, `IOSDictationSession`, Apple preview and Whisper finalizer. Hold,
slide-left cancel, slide-up lock, haptics and VoiceOver tap-toggle behave the same.
The resting microphone is a filled amber circle; writing uses a plain amber icon.
The control grows while held, with no
scaling animation under Reduce Motion; its gesture identity stays mounted.
Recording dismisses the keyboard; locked recording shows a Stop control and hint.
Scene suspension finalizes captured text; activation teardown rejects late results.

A clean ended terminal offers the web's localized Resume action when the shared
`ActionsModel` rules permit it. `IOSSessionActionState.execute(.resume)` supplies the
same command gate, progress and error copy as session actions. Successful resume
notifies the existing terminal directly from the shared iOS command state, including
when the server keeps an already-live agent idle. Attachment is deferred while the
terminal is offscreen and duplicate status/command notifications are ignored. A
transition to running after an external resume also reattaches it. An unreachable connection offers
Reconnect; a nonresumable clean exit offers no retry that would open a missing PTY.

Normal launches permit terminal input and replies. Isolated launches still disable
input, including emulator protocol replies, and install the read-only request
audit. Attach shares the composer upload queue, using `POST /api/uploads?session=<id>`.
Photo Library, Camera, any file type and explicit system image paste feed that
queue. Uploads never send terminal input. Chips expose progress, failure/retry and
removal; outstanding imports/uploads block Send. Uploaded paths precede the typed
message on separate lines, with the web's video extraction hint. The reply
endpoint removes nested paste markers and bracket-pastes the entire message.
Clipboard visibility probes `hasImages` on appearance, clipboard change and scene
activation; image data is loaded only from an authorized `UIPasteControl` provider.
No new server API or Mac terminal behaviour is introduced. Diff/files/preview tabs
remain outside the terminal stream; session action swipes are described in
[session actions](ios-session-actions.md).

## Steers and swipe gestures

Saved steers come from `GET /api/steers` and are filtered exactly like web's SteerBar:
`inSteerBar`, then `IOSSteerScope` mirrors `ui/src/lib/steer-scope.ts` (an empty allowlist
is universal; a non-empty one with an unresolved repo name hides). Repo names come from
`/api/repos` by `repoPath`. A steer is sent through the same `POST /api/sessions/{id}/reply`
route as a typed reply (`IOSTerminalPresentation.sendSteer`), never touches the draft and,
like web, does not need an attached PTY.

The resting capsule contains scrolling steer chips and a management entry to the
full **Steers** panel. A sideways swipe across the terminal output does the same without
looking: **left** opens the panel, **right** returns to the session list on compact width
(the task keeps running). `IOSSteerSwipe` holds the thresholds (90 pt or a 700 pt/s flick
in the same direction); a `UIPanGestureRecognizer` on the terminal view begins only for a
clearly horizontal start, so vertical scrolling and the scrolling key palette are untouched.
The panel lists every bar steer, Esc/^C/Tab, Stop/Resume when `ActionsModel` offers them,
and **End session**, which archives the session (`DELETE /api/sessions/{id}`: the agent
stops, the row is kept). Ending requires a 1.2 s hold so the swipe that opened the panel can
never end a session; VoiceOver gets an explicit confirmation instead. Read-only and isolated
launches show neither chips nor panel. Editing steers stays in web/Mac.

## Answering Claude's dialogs

A Claude selection dialog (AskUserQuestion, a permission prompt, a picker) is answered with
keys, not text, and the question needs the screen. While one is on screen the terminal shows a
single key row instead of the resting capsule (attach, paste, steers, keyboard, microphone) and
the inline session actions: **↑ ↓ ⏎** large on the right, **Esc ← →** (← → switch the tabs of
a multi-question dialog) and **⌨** on the left. No keyboard opens, and the bottom prompt area
does not open writing (its last line is the dialog's footer). The keys send the palette's
bytes (`IOSTerminalKey`).

Detection is client-side: `IOSTerminalHostView` reads the visible rows once output pauses
(120 ms, at most 500 ms behind streaming output, so a repaint split across chunks cannot
flicker the layout) and `IOSTerminalDialog` looks for the dialog footer ("Enter to select ·
↑/↓ to navigate · Esc to cancel") in the last 15 non-empty rows — the same fragments as the
server's `DIALOG_FOOTER_RE` in `src/blocked.ts`. It does not wait for the server's block
classification. The scan pauses while the operator reads local history and runs again on
the way back to the tail (scrolling or Latest output).

**⌨** is the way to a free-text answer ("Type something", "Chat about this"): it opens the
reply bar's writing state, focused, and carries the same retained-draft dot as the resting
keyboard button. Closing writing — keyboard down, or a sent reply — returns to the key row
while the dialog is open; dictation opens writing as usual. A photo, file or camera picker
closes writing too, but the reply bar that presents it stays until it returns
(`pickingAttachment`). A dialog that appears while writing keeps the draft. When the footer
leaves the screen, the resting capsule and inline actions return. Read-only launches are
unchanged.

## Mobile web references and visual fixtures

`ui/src/routes/+page.svelte` changes `mobileScreen` from list to detail when a
session opens. `ui/src/lib/components/Viewport.svelte` defaults and resets its tab
to `term`, keeps activity separate, and places `SteerBar` and
`viewport/ViewportTermControls.svelte` below the output. `ActionBar.svelte` is the
list's New Task/Backlog bar, not the session's reply bar. The
`docs/design/mobile-herd/README.md` design concerns that list screen; detail uses
the live Viewport flow. iOS mirrors the terminal-first structure with Terminal,
Activity and Info tabs, plus Plan when a plan phase or gate exists. A 52-point
header carries title, status, repo, latency and the complete session actions menu;
the 38-point tabs row includes font size and focus controls. Larger Dynamic Type
expands the layout. Task id and recap remain in Info. Only an eligible Merge or
Ready is repeated above the footer; command feedback and the read-only note remain
visible on every tab. List swipes remain available alongside Plan/Answer badges.

`IOSTerminalTests.testRenderFixtureImages` renders the production detail chrome
with text fixture output via `ImageRenderer`. UIKit terminal rendering cannot be
captured by ImageRenderer; a separate renderer test feeds real SwiftTerm output
and verifies history retention. The fixture PNGs cover Terminal, Info and enlarged
Info text. Info fixtures use the same field layout without UIKit-backed scrolling
or text selection. `IOSSessionChromeTests.testRenderCompactChromeFixtures` renders
resting, clipboard-present, writing and attachment states with production chrome,
static terminal text and a schematic keyboard. These fixtures are visual layout
evidence, not a live-server check.

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

## Push notifications (interim direct APNs)

Until the push relay exists ([#2665](https://github.com/erwins-enkel/shepherd/issues/2665)),
a server that has `SHEPHERD_APNS_KEY`, `SHEPHERD_APNS_KEY_ID` and `SHEPHERD_APNS_TEAM_ID` set
sends straight to Apple. That key belongs to the publisher, so this only works on the publisher's
own servers; everyone else keeps browser Web Push. `IOSPushRegistration` asks for permission once
a server profile is active, then posts the device token to `POST /api/push/apns` on every new
store (launch, login, profile switch). Debug builds register for the APNs sandbox, Release builds
(TestFlight) for production — the `aps-environment` entitlement follows the same split through
`APS_ENVIRONMENT` in `project.yml`, so the App Store profile must include Push Notifications.

The server stores the device as an ordinary push subscription with an `apns:<env>:<token>`
endpoint, so every Web Push gate applies unchanged: nothing is sent while any client reports
presence as active, repeats per session are collapsed for `SHEPHERD_PUSH_COOLDOWN_MS`, reduced
push mode and the per-device categories apply, and the copy is the server's EN/DE text. A
notification groups by session (`thread-id`), replaces an earlier one with the same tag
(`apns-collapse-id`) and opens its session when tapped. A token APNs reports as gone is pruned;
the device registers again on its next launch. In this interim transport title and body pass
through Apple in plain text; the relay adds end-to-end encryption. Isolated launches never prompt
or register.

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

An app-wide iOS recording lease serializes composer and terminal capture. A new
owner finalizes the previous recording before capture is granted; later cleanup
from a former owner cannot deactivate the new owner’s audio session. Pending
holds are cancelled on suspension/input loss and recheck eligibility before capture.

One `AVAudioEngine` tap feeds the Apple preview, level meter and an in-memory WAV
encoder matching web `wav.ts`: 16 kHz, mono, 16-bit PCM. Clips roll over before 55 seconds,
below the optional plugin's 60-second bound; recordings stop at five minutes. No audio
files or background recording are used. Interruptions and route/format changes end
the recording and retain recognized text; recording never resumes automatically.

`GET /api/plugins` discovers `voice-whisper`. Composer and terminal share one
activation-scoped `IOSWhisperStatus` cache; failed discovery remains retryable. When available, its status and multipart
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
`IOSComposeTests` and `IOSTerminalReplyTests` render fixture states with `ImageRenderer`; SwiftUI rendering
substitutions reuse the production layout for UIKit-backed controls. The terminal
key palette renders its production paged ScrollView at default and enlarged text,
including the page containing Tab. Because ImageRenderer omits UIKit-backed scroll
content, the test first rasterizes the production view in a private hosted test
window and passes that image through ImageRenderer. It never screenshots a simulator
or substitutes clipped key content. Real-device acceptance (iOS 18/26, DE/EN, AirPods, incoming call, offline and three-minute recording)
is tracked in the draft PR checklist.
