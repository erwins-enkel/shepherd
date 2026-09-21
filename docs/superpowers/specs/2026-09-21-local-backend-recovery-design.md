# Local backend recovery (#2432)

## Outcome and scope

Choosing **Run on this Mac** can bootstrap the official backend into the configured install directory, then start and connect to it. A healthy unrelated listener never silently becomes the app's managed install. Terminal, composer, and Settings report the same failed backend layer and offer an appropriate action. Settings remains useful while the local server is unavailable.

This is one coherent recovery stage, implemented as three reviewable tasks in one PR. The issue's suggested task split does not require three separate partial releases. No production daemon, socket, database, or remote server is modified during development or automated verification.

## Evidence and uncertainty

- `native/Sources/ShepherdKit/LocalServer/InstallerRun.swift` explicitly requires `<appDirectory>/deploy/install.sh` and returns exit 127 when absent. Its existing process-group cancellation and log plumbing must survive the change.
- `LocalServerEnvironment.swift` fixes `appDirectory` to `~/.shepherd/app` and InstallerRun reconstructs HOME by walking up that directory. Both break custom `SHEPHERD_DIR` support.
- `LocalHealthCheck.swift` checks only `ok`; `App/LocalServerProbe.swift` checks `ok` and `version`. `LocalServerModel.resolveState()` turns any successful probe into `.externallyManaged`, and the panel enables Connect immediately.
- Server `handleHealth` in `src/server.ts` currently returns only `{ok,version}`. There is no evidence from which the native app can truthfully name an old server's DB path.
- `TerminalPane.endedCard` turns `.unreachable` into a generic runner error. Explicit `.gone` and `.superseded` already exist and must retain their meanings.
- `SettingsModel` couples diagnostics to a four-request settings snapshot and reloads it for `diagnostics:status`. One failing unrelated endpoint can hide healthy diagnostics.
- `SettingsFeature.install` already registers SettingsModel unconditionally, and `AppModel.register` installs it against an existing store. The operator's nil-model symptom is reported behavior, not a proven local-only omission. Settings can open independently of the main RootView task that installs model extensions; test both activation orders and make the Settings entry point self-sufficient.
- SettingsScene uses a native TabView with SF Symbol labels, not a sidebar. Reproduce missing icon behavior through the isolated window test; fix the label construction or symbol fallback without adding an unrelated navigation redesign.

## Alternatives

1. **Recommended:** run the official installer, verify local identity conservatively, and introduce one activation-scoped recovery model. This reuses installer behavior and S12 diagnostics while addressing each acceptance criterion.
2. Copy-only bootstrap instructions: acceptable only if download is forbidden. No such policy exists in this task, so this would miss the requested in-app installation.
3. Infer ownership from port, PID, or version: simpler, but repeats the scratch-server adoption bug and risks live agents. Rejected.

## Task 1: bootstrap and ownership

InstallerRun uses the existing readable checkout installer when present. Otherwise it downloads the fixed official HTTPS bootstrap URL into a unique temporary directory, validates HTTP success, then invokes `/bin/bash` on that file. It must never execute an HTML/error body or interpolate environment values into shell source. The script remains authoritative for Bun provisioning, checkout creation, and prerequisite checks. Retain injected script/transport seams for tests, bounded HTTP timeouts, temporary-file cleanup, cancellation, and one log ring. Surface download, file-permission, prerequisite, and installer-exit failures with localized next steps and logs.

Environment resolution uses explicit home plus process environment overlaid by `~/.shepherd/env`, then the default install path if SHEPHERD_DIR is absent. Do not derive home from appDirectory. Install and launch use the same resolved path, DB path, HOME, and executable search paths. Preserve SHEPHERD_REF. A cold checkout offers Install and start; successful install invokes the normal supervised start path. Poll/mirror the ring while installing rather than reading it only after completion.

Add optional `Health.localInstall` metadata contract-first: `{appDirectory,databasePath,instanceID}`. Paths are the actual resolved server paths; instanceID is an unpredictable per-launch marker passed by the supervisor, not an authentication credential. Emit these fields only for explicit local-supervision opt-in with the server bound to loopback. Never expand public remote health metadata by default. HEAD stays bodyless. Unknown/old responses remain decodable. Native probes decode the generated Health schema, replacing handwritten health payload structs. Register any new supervision environment keys in `.env.schema` and the generated environment documentation; the token is ephemeral and never persisted.

The running child's health must match expected version presence, normalized install/DB paths, and this launch's instanceID before the supervisor marks it running. Missing or mismatching metadata from another listener does not certify the child. Symlink normalization is performed consistently on expected and actual existing paths.

Discovery distinguishes verified install identity from process ownership. A listener without the current launch marker is external even if its paths match. Show its reported paths when available; otherwise explicitly say the path is unavailable. Require **Keep using this server** acknowledgment, scoped to the observed identity; do not persist blanket approval for port 7330. Provide **How to stop this server** with owner-directed instructions and a recheck action. Only app-owned child processes get direct Stop/Restart. Never kill by port or touch the operator's existing herdr daemon.

Task 1 also supplies `LocalServerModel.startRunner() async` for task 2. It delegates to a supervisor operation, uses the configured HERDR_BIN and socket, probes before starting, logs progress, and returns success only after the daemon answers. A live daemon is a no-op. A stale socket is not proof of a live daemon and is never unlinked blindly. Bound waits and give actionable failure; no stop/restart of unknown daemons. Reuse the established `herdr server` launch convention and liveness semantics rather than inventing CLI flags.

## Task 2: shared recovery data

Add an activation-scoped `BackendRecoveryModel: AppExtension` registered before consumer extensions. It owns the latest diagnostics snapshot, explicit health probe status, request generation, and one diagnostics event subscription. Decode the existing `diagnostics:status` payload directly; keep a GET refresh fallback. Do not require settings, repos, or usage requests to succeed before diagnostics can render. Local state can be available even without an activated store through LocalServerModel; remote recovery must never operate local processes.

A pure classifier returns one of: serverUnavailable, runnerUnavailable, sessionGone, sessionSuperseded, undetermined. Explicit PTY gone/superseded frames win over network guesses. On `.unreachable` or a compatible create failure, a failed health probe means serverUnavailable; successful health plus the herdr check's explicit missing/offline hint means runnerUnavailable. Successful server and runner checks with an unclassified close remain undetermined rather than falsely claiming session deletion. Unknown diagnostic hint keys, auth failures, timeouts and old servers keep a useful generic diagnostics action.

Recovery actions are explicit: local server unavailable → start through the supervisor; runner unavailable → supervisor startRunner; gone → reopen/reload the session; superseded → existing takeover; remote or undetermined → open Diagnose/recheck. Missing runner binary may require installation rather than a useless repeated start. Version/protocol mismatch is distinct from an offline daemon and must not trigger an automatic destructive restart.

Terminal attaches recovery presentation to its existing phase machine; preserve parked terminal semantics and generation guards. Composer preserves the submitted draft and existing cancellation/error behavior and adds recovery only for connectivity/runner failures, not validation failures. Settings Diagnose consumes the same snapshot and recovery presentation. UI actions do not auto-retry task creation, avoiding duplicate sessions after an ambiguous response.

## Task 3: local Settings and window quality

Register model factories idempotently before Settings can need them, including Settings-first and already-active-store ordering. Do not fabricate a connected store when authentication is absent. A selected local profile with an unavailable backend shows the supervisor status, progress/log disclosure, and recovery action. An unactivated remote profile shows a titled, explanatory Connect action. General appearance remains available offline.

Every blocked/empty recovery surface has a descriptive title, one-sentence summary, and labeled action in EN and DE through L.t(). Preserve the existing native tabbed Settings presentation, ensure all six icons resolve, keep one Settings window under repeated Command-comma, and add accessibility identifiers for title, summary, and action.

## Constraints

- Swift 6 strict concurrency; no unchecked Sendable workaround.
- Contract-first: edit contracts/openapi.yaml before server or generated-client integration.
- User-facing copy uses L.t() with EN and DE catalog entries.
- Automated tests use temporary homes, fake installers/transports, in-memory credentials and isolated app launches.
- No Keychain prompts; set SHEPHERD_CODESIGN_IDENTITY=- for app build/test commands.
- Serialize every xcodebuild/XCUITest invocation through the existing uitest-lock.sh wrapper.
- Do not stop live herdr, unlink real sockets, change the operator's real install, or write to remote servers.
- One PR for this coherent stage; squash-merge only after every required CI check is green.
- Never git add -f under .superpowers/.

## Verification and residual risks

Automated coverage: absent checkout bootstrap/progress/cancel; custom install path and preserved HOME; download errors; owned versus external identity; wrong listener during child startup; stale async completion; all three required diagnoses plus explicit gone/superseded and unknown fallback; shared event snapshot; Settings local activation both orders; Settings offline explanatory surface and six toolbar icons.

Manual operator verification remains a distinct handoff: cold install, existing proper install, and stale socket using a disposable environment first. Real-Mac verification must preserve currently running agents. Old servers cannot disclose unknown paths, and health metadata is consistency evidence, not protection from a malicious same-user process.
